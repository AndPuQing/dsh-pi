#!/usr/bin/env node
// @dsh-pi/runtime — the shared in-process pi runtime for dsh-pi surfaces.
//
// One dsh runtime (the `pi-embed` profile), N rendering surfaces. The TUI
// (@dsh-pi/tui) and the web surface (@dsh-pi/web) both drive the SAME
// createPiRuntime(): a single live agent whose session/event stream every
// surface subscribes to. The process that owns the runtime is the session's
// one live writer; surfaces are renderers plus input forwarders — so a
// browser and a terminal can operate one session simultaneously with zero
// latency and no ownership conflicts.
//
// This module also owns the content/session helpers the surfaces share
// (content-block walkers, tool-call/result shaping, session export, on-disk
// session scan, per-cwd "last session" state) so the TUI and web surface
// never drift.
//
// Env: DSH_HOME (default ~/.dsh), DSH_PI_PROVIDER / DSH_PI_MODEL override the
// model route (falls back to $DSH_HOME/settings.yaml agent-default-model).
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { zstdDecompressSync } from 'node:zlib'
import {
  boot,
  healProfilesModuleFallback,
  loadOptionalPatches,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROF = 'pi-embed'
const profDir = path.join(home, 'profiles', PROF)
const REGISTRY = 'https://registry.npmjs.org'
const STATE_DIR = path.join(home, 'dsh-pi-tui')
const ANCHOR = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const PROFILE_ROOT_CONFIG = '# dsh profile root — empty entry list; tree composed as patches.\n[]\n'

// ---- model route ------------------------------------------------------------

function defaultModel() {
  const envP = process.env.DSH_PI_PROVIDER
  const envM = process.env.DSH_PI_MODEL
  try {
    const s = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8')
    const m = s.match(/agent-default-model:\s*\n(\s+provider:\s*(\S+)\s*\n)?(\s+model:\s*(\S+))/)
    return { provider: envP || m?.[2] || 'opencode-go', model: envM || m?.[4] || 'deepseek-v4-flash' }
  } catch {
    return { provider: envP || 'opencode-go', model: envM || 'deepseek-v4-flash' }
  }
}

// ---- profile + in-process boot -------------------------------------------------

const isBun = typeof Bun !== 'undefined' || !!process.versions?.bun
const pkgRunner = isBun ? ['bunx', '--yes', 'pnpm'] : ['npx', '--yes', 'pnpm']

function ensureProfile() {
  if (fs.existsSync(profDir)) return
  console.error(`[dsh-pi] creating profile ${PROF}...`)
  fs.mkdirSync(profDir, { recursive: true })
  fs.writeFileSync(
    path.join(profDir, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${PROF}`,
      private: true,
      dependencies: { '@dsh-pi/fff': '^0.1.0', '@dsh-pi/prompt': '^0.1.0', '@dsh-pi/tools': '^0.1.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@dsh-pi/prompt', '@dsh-pi/fff', '@dsh-pi/tools'] } },
    }, null, 2) + '\n',
  )
  fs.writeFileSync(path.join(profDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), '# dsh-pi: no hot-reload (avoids the --expose-internals requirement bun cannot satisfy).\n- id: hmr\n  disabled: true\n')
  const r = spawnSync(pkgRunner[0], [...pkgRunner.slice(1), 'install', '--registry', REGISTRY], {
    cwd: profDir,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    throw new Error('profile dependency install failed — check network access to registry.npmjs.org')
  }
}

async function bootRuntime() {
  healProfilesModuleFallback(ANCHOR)
  const profile = loadProfile('dsh', PROF, ANCHOR, void 0, { userLayer: true })
  const rootConfig = path.join(profile.dir, 'cordis.yml')
  fs.writeFileSync(rootConfig, PROFILE_ROOT_CONFIG)
  const bundlePatches = profile.layers.flatMap((l) => l.patches)
  const homePatches = loadOptionalPatches('dsh', path.join(home, 'cordis.patch.yml')) ?? []
  const ctx = await boot('dsh', rootConfig, structuredClone([...bundlePatches, ...profile.patches, ...homePatches]), () => {})
  await ctx.get('loader')?.await()
  return ctx
}

// ---- session state ------------------------------------------------------------
// The per-working-directory "last session" pointer shared by every surface:
// the TUI writes it on boot, `dsh-pi serve` reads it to continue where the
// TUI left off (and writes it back so the next TUI/serve picks up the web
// session).

function sessionStatePath() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const slug = process.cwd().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'root'
  return path.join(STATE_DIR, `session-${slug}.id`)
}
function loadSessionId() {
  try {
    const v = fs.readFileSync(sessionStatePath(), 'utf8').trim()
    if (v) return v
  } catch { /* first run */ }
  return null
}
function saveSessionId(id) {
  try { fs.writeFileSync(sessionStatePath(), id) } catch { /* best effort */ }
}
function tuiLastSessionId() {
  return loadSessionId()
}

// ---- session id normalization ------------------------------------------------

function normalizeSessionId(id) {
  const s = String(id).trim()
  return /^session-/.test(s) ? s : `session-${s}`
}

// ---- content blocks ---------------------------------------------------------

// Walk nested content (tool-result blocks nest their payload) and collect every
// renderable image block in order: dsh durable attachment refs, pi-style inline
// base64 blocks, or data: URIs.
function collectImageBlocks(content, out = []) {
  for (const b of content || []) {
    if (!b || typeof b !== 'object') continue
    if (
      b.type === 'image' &&
      (b.attachment || (b.data && b.mimeType) || (typeof b.url === 'string' && b.url.startsWith('data:')))
    ) out.push(b)
    else if (b.type === 'tool-result' && Array.isArray(b.content)) collectImageBlocks(b.content, out)
  }
  return out
}

// Join every text block (nested included) — the text counterpart of the image
// walk. Used for tool-result summaries and conversation-history text.
function contentText(content) {
  let s = ''
  const walk = (blocks) => {
    for (const b of blocks || []) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && b.text) s += b.text
      else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content)
    }
  }
  walk(content)
  return s
}

// ---- reasoning (thinking) block helpers ---------------------------------------
// Reasoning streams arrive as assistant/chunk reasoning blocks (block-start with
// blockType 'reasoning', reasoning-delta text, block-end carrying the full text)
// and assemble into { type: 'reasoning', text } content blocks on
// assistant/message. They render like pi's thinking blocks: collapsed to a
// one-line summary by default.
const REASONING_SUMMARY_CAP = 240 // summary lines longer than this get an ellipsis

// Collapsed view of one reasoning block: the first non-empty line, capped, plus
// how many further lines the expand hides.
function reasoningSummary(text) {
  const lines = String(text ?? '').split('\n')
  const idx = lines.findIndex((l) => l.trim().length > 0)
  if (idx === -1) return { summary: '…', hidden: 0 }
  let summary = lines[idx].trim()
  if (summary.length > REASONING_SUMMARY_CAP) summary = summary.slice(0, REASONING_SUMMARY_CAP) + '…'
  return { summary, hidden: lines.length - idx - 1 }
}

// The reasoning blocks embedded in one assistant message's content (stream
// order: they precede the answer's text blocks).
function reasoningBlocks(content) {
  const out = []
  for (const b of content || []) {
    if (b?.type === 'reasoning' && b.text) out.push({ text: b.text })
  }
  return out
}

// ---- tool detail helpers -----------------------------------------------------
// Tool calls/results used to be truncated at 140 chars when the message was
// stored, so the detail was lost forever. Both live render and history rebuild
// go through these helpers instead: FULL text is kept on the message and a
// first-line summary drives the collapsed view.
const TOOL_SUMMARY_CAP = 300 // summary lines longer than this get an ellipsis

// tool/call -> { text, summary }. text = name + pretty-printed (multi-line)
// arguments; summary = name + compact one-line args.
function toolCallInfo(d) {
  const name = d.name || 'tool'
  const raw = d.arguments ?? ''
  let pretty = ''
  let compact = ''
  try {
    const parsed = JSON.parse(raw)
    pretty = JSON.stringify(parsed, null, 2)
    compact = JSON.stringify(parsed)
  } catch {
    pretty = String(raw)
    compact = String(raw)
  }
  const argSummary = compact.length > TOOL_SUMMARY_CAP ? compact.slice(0, TOOL_SUMMARY_CAP) + '…' : compact
  return {
    text: pretty ? `${name}\n${pretty}` : name,
    summary: `${name}${argSummary ? '  ' + argSummary : ''}`,
  }
}

// tool/result -> { kind, text, summary } | null. Success renders as a 'result'
// message (full payload text + first-line summary); failures render as an
// 'error' message (tool name + message + dim failure code) with the same shape
// so surfaces can expand either. `names` maps callId -> tool name for
// correlating errors.
function toolResultMessage(d, names) {
  const content = d.message?.content || []
  const txt = contentText(content)
  const first = content[0]
  const failed = !!(d.error || first?.isError)
  if (failed) {
    const name = names?.get(d.callId) || 'tool'
    const code = d.error ? `${d.error.name}${d.error.code ? ` (${d.error.code})` : ''}` : ''
    const head = txt.split('\n')[0].trim() || 'no message'
    const headLine = head.length > TOOL_SUMMARY_CAP ? head.slice(0, TOOL_SUMMARY_CAP) + '…' : head
    const codeLine = code ? `\n  \x1b[90m${code}\x1b[0m` : ''
    return {
      kind: 'error',
      text: `${name}: ${txt.trim() || 'no message'}${codeLine}`,
      summary: `${name}: ${headLine}${codeLine}`,
    }
  }
  if (!txt) return null
  const firstLine = txt.split('\n')[0].trim() || '…'
  return {
    kind: 'result',
    text: txt,
    summary: firstLine.length > TOOL_SUMMARY_CAP ? firstLine.slice(0, TOOL_SUMMARY_CAP) + '…' : firstLine,
  }
}

// ---- session export --------------------------------------------------------------
// /export (TUI) writes the live session log to a readable markdown transcript
// plus a full-fidelity JSON copy. The markdown keeps surface events only (what
// surfaces render); JSON keeps the raw log verbatim.

// Latest session/title event in the log — the same source the runtime's title
// service folds. Used for the markdown header.
function sessionTitleFromEvents(events) {
  let title = ''
  for (const e of events || []) {
    if (e.type === 'session/title' && e.data?.title) title = e.data.title
  }
  return title
}

// HH:MM:SS timestamp for markdown section headers.
function exportTime(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// The markdown transcript: user prompts, assistant answers (reasoning as a
// blockquote, images as placeholders), and tool calls/results — in log order,
// mirroring the rendered conversation. `names` correlates error results to
// their tool names (same map the live render keeps).
function exportSessionMarkdown({ id, title, createdAt, events }) {
  const out = []
  out.push(`# ${title || 'Untitled session'}`)
  out.push('')
  out.push(`- session: \`${id}\``)
  if (createdAt) out.push(`- created: ${new Date(createdAt).toISOString()}`)
  out.push(`- exported: ${new Date().toISOString()}`)
  out.push(`- events: ${events?.length || 0}`)
  out.push('')
  const names = new Map() // callId -> tool name, for correlating error results
  for (const e of events || []) {
    const t = exportTime(e.time)
    if (e.type === 'user/message') {
      const txt = contentText(e.data?.content)
      if (!txt) continue
      const src = e.data?.source?.kind
      out.push(`## ${src === 'user' ? 'You' : 'Context'} — ${t}`)
      out.push('')
      out.push(txt)
      out.push('')
    } else if (e.type === 'assistant/message') {
      // reasoning precedes the answer in stream order; tool-call blocks inside
      // the message are skipped — the standalone tool/call events render them
      for (const b of e.data?.message?.content || []) {
        if (b?.type === 'reasoning' && b.text) {
          out.push(`> **thinking** — ${t}`)
          out.push('>')
          for (const l of String(b.text).split('\n')) out.push('> ' + l)
          out.push('')
        } else if (b?.type === 'text' && b.text) {
          out.push(`## Assistant — ${t}`)
          out.push('')
          out.push(b.text)
          out.push('')
        } else if (b?.type === 'image') {
          out.push(`[image: ${b.name || 'attachment'}]`)
          out.push('')
        }
      }
    } else if (e.type === 'tool/call') {
      names.set(e.data?.callId, e.data?.name)
      out.push(`### ⚙ ${e.data?.name || 'tool'} — ${t}`)
      out.push('')
      out.push('```json')
      out.push(e.data?.arguments ?? '')
      out.push('```')
      out.push('')
    } else if (e.type === 'tool/result') {
      const r = toolResultMessage(e.data || {}, names)
      if (!r) continue
      out.push(`### ${r.kind === 'error' ? '✗ tool error' : '✓ tool result'} — ${t}`)
      out.push('')
      out.push(r.text.replace(/\x1b\[[0-9;]*m/g, '')) // strip ANSI styling
      out.push('')
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// Full-fidelity JSON copy: the raw event log (surface + log-only rows) plus a
// small session envelope. Parseable straight back into the dsh storage format.
function exportSessionJson({ id, title, createdAt, events }) {
  return JSON.stringify({
    session: {
      id,
      title: title || null,
      createdAt: createdAt || null,
      exportedAt: new Date().toISOString(),
    },
    events: events || [],
  }, null, 2) + '\n'
}

// File-name base for one export: dsh-session-<shortId>-<YYYYMMDD-HHMMSS>. Callers
// append the extension (.md / .json).
function exportFileName(id, when = new Date()) {
  const short = String(id).replace(/^session-/, '').slice(0, 8)
  const p = (n) => String(n).padStart(2, '0')
  const stamp =
    `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  return `dsh-session-${short}-${stamp}`
}

// ---- sessions --------------------------------------------------------------------

// dsh's project-key normalization for the on-disk sessions root: separators ->
// '-', unsafe chars -> ~XXXX, wrapped in --..--. Mirrors the dsh persistence
// encoding so we can locate/delete session dirs ourselves (the persistence
// seam deliberately has no deletion API).
function projectKey(cwd) {
  let readable = ''
  let sep = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = cwd[i]
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!sep) readable += '-'
      sep = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      sep = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      sep = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function shortSessionId(id) {
  return '#' + String(id).replace(/^session-/, '').slice(0, 8)
}

// Raw on-disk fallback listing (used only when sessionQuery is unavailable):
// reads the header line for createdAt/parentSession and the LATEST session/title
// event (latest wins) per session.
function scanSessionsOnDisk(currentId) {
  const root = path.join(home, 'sessions', projectKey(process.cwd()))
  let dirs = []
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  const out = []
  for (const dir of dirs) {
    const file = path.join(root, dir, 'session.jsonl.zstd')
    let title = shortSessionId(dir)
    let createdAt = 0
    let parent = null
    try {
      const raw = zstdDecompressSync(fs.readFileSync(file))
      const text = raw.toString('utf8')
      const head = JSON.parse(text.slice(0, text.indexOf('\n')))
      createdAt = head.createdAt || 0
      parent = head.parentSession || null
      for (const line of text.split('\n')) {
        if (!line.includes('session/title')) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'session/title' && ev.data?.title) title = ev.data.title
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable */ }
    out.push({ id: dir, title, createdAt, parent, current: currentId === dir })
  }
  out.sort((a, b) => b.createdAt - a.createdAt)
  return out
}

// ---- event projection -----------------------------------------------------------
// Surface-facing shape of one durable session event. `currentEvents()` replays
// the live log in this shape so a surface can re-render it identically to the
// live stream (raw data kept verbatim — the surface owns its own rendering).
function projectEvent(e) {
  return { seq: e.seq, type: e.type, time: e.time, data: e.data }
}

// ---- the runtime ----------------------------------------------------------------
// Boots the in-process pi-embed runtime and owns exactly one live agent. All
// dsh-pi surfaces mount on the returned object: they subscribe to the same
// session/event stream, forward input through the same agent, and are notified
// when the current session changes. The owning process is the session's single
// live writer — surfaces never contend for ownership.
//
// opts:
//   onSubagent(count)     background-subagent count changed (status-line feed)
//   onSwitched()          current session changed (surface must re-render)
//   initialSessionId      resume this persisted session instead of creating a
//                         fresh one (headless serve mode; `null` = fresh)
async function createPiRuntime({ onSubagent, onSwitched, initialSessionId = null } = {}) {
  ensureProfile()
  const ctx = await bootRuntime()
  const agents = ctx.get('agents')
  const defaultModelSvc = ctx.get('agentDefaultModel')
  if (!agents || !defaultModelSvc) throw new Error('runtime missing agents/defaultModel')

  const selection = defaultModelSvc.currentSelection()
  let agent = null
  // Owned AgentHandle for the live agent. Replacing it disposes the previous
  // handle — dispose() stops the old loop and removes its session from the
  // live store (the persisted log stays on disk) — so at most the current
  // session is ever live and deleting persisted sessions is safe.
  let handle = null
  let subagentCount = 0

  function createAgentWithId(sessionId, opts = {}) {
    return agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: process.cwd(), ...(opts.meta || {}) },
      ...(opts.seed ? { seed: opts.seed } : {}),
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 })
      },
    })
  }
  function createAgent() {
    return createAgentWithId(`session-${randomUUID()}`)
  }
  function retireHandle() {
    const old = handle
    handle = null
    if (old) old.dispose().catch(() => { /* best effort */ })
  }
  function adoptHandle(h) {
    retireHandle()
    handle = h
    agent = h.agent
    // the new agent's subagents start from zero; late end events for the old
    // agent's children are clamped
    subagentCount = 0
    onSubagent?.(0)
  }

  const switchedListeners = new Set()
  function notifySwitched() {
    for (const cb of switchedListeners) {
      try { cb() } catch { /* a surface listener must never break the runtime */ }
    }
  }

  if (initialSessionId) {
    // persisted sessions must be resumed (not created): create() refuses to
    // publish over state the persistence layer already owns
    let created
    try {
      created = await agents.resume({
        resumeSessionId: SessionId(normalizeSessionId(initialSessionId)),
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 })
        },
      })
    } catch (e) {
      if (String(e.message).includes('in use') || String(e.message).includes('already exists')) {
        throw new Error(
          `session '${initialSessionId}' is live in another process — attach a web surface to it with: dsh-pi tui --serve`,
        )
      }
      throw e
    }
    adoptHandle(created)
  } else {
    const created = await createAgent()
    adoptHandle(created)
  }
  await agent.whenIdle()

  // dsh subagent lifecycle: surfaces background subagent runs in the status
  // line even after the delegating turn settles (run_in_background default).
  ctx.on('subagent/start', () => { subagentCount++; onSubagent?.(subagentCount) })
  ctx.on('subagent/end', () => { subagentCount = Math.max(0, subagentCount - 1); onSubagent?.(subagentCount) })

  // /compact forwards this into ctx.llm.stream() (via command-compact), so a
  // shutdown tears down an in-flight summarization call.
  const compactSignal = new AbortController()
  const runtime = {
    ctx,
    provider: selection.provider,
    model: selection.model,
    get sessionId() { return agent.session.id },
    onEvent(cb) {
      ctx.on('session/event', (session, event) => {
        if (session.id !== agent.session.id) return
        cb(session, event)
      })
    },
    onSwitched(cb) {
      switchedListeners.add(cb)
      return () => switchedListeners.delete(cb)
    },
    currentEvents() {
      return agent.session.events.map(projectEvent)
    },
    sessionMeta() {
      const h = agent.session.header || {}
      return { id: h.id ?? agent.session.id, createdAt: h.createdAt ?? null, cwd: h.cwd ?? null, version: h.version ?? null }
    },
    prompt(text) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    },
    interrupt() {
      // user-initiated abort of the active turn; the 'user' cause flows into
      // the turn/end reason ({ kind: 'aborted', reason: { kind: 'user' } })
      // so surfaces can surface "⏹ turn interrupted". cancel is a no-op
      // when the agent has no active activity (idle turns are untouched).
      agent.cancel({ kind: 'user' })
    },
    async readImage(ref) {
      const store = ctx.attachments
      if (!store?.readImage) throw new Error('attachment store unavailable')
      return store.readImage(ref)
    },
    currentTitle() {
      // synchronous fold of the live log's latest session/title event
      try { return ctx.sessionTitle?.get(agent.session)?.title } catch { return undefined }
    },
    async renameSession(title) {
      // dsh owns titles: rename() normalizes the input, supersedes in-flight
      // automatic generation, appends a user-sourced session/title event and
      // persists with the log — no surface-side override file needed. The user
      // title pins the session (later prompts stop re-titling it).
      const svc = ctx.sessionTitle
      if (!svc?.rename) throw new Error('session titles unavailable in this runtime')
      const snapshot = svc.rename(agent.session, title)
      return snapshot.title
    },
    newSession() {
      return createAgent().then((c) => {
        adoptHandle(c)
        return agent.whenIdle()
      }).then(() => {
        notifySwitched()
      })
    },
    async forkSession() {
      // seed = balanced completed-turn prefix of the current log; the child
      // keeps parentSession lineage so session trees render a real tree
      const events = agent.session.events
      let cut = 0
      for (let i = 0; i < events.length; i++) {
        if (events[i].type === 'turn/end') cut = i + 1
      }
      const seed = events.slice(0, cut)
      const c = await createAgentWithId(`session-${randomUUID()}`, {
        meta: { parentSession: agent.session.id, seedLength: seed.length },
        ...(seed.length ? { seed } : {}),
      })
      adoptHandle(c)
      await agent.whenIdle()
      notifySwitched()
      return { agent, seedLength: seed.length }
    },
    async listSessions() {
      // sessionQuery corpus is live-preferred and newest-first; filter to the
      // sessions this surface created (same cwd) and fold their latest titles.
      let records = []
      try { records = await ctx.sessionQuery.listSessions() } catch { /* fall through to the raw scan */ }
      const mine = records.filter((r) => r.header.cwd === process.cwd())
      if (!mine.length) return scanSessionsOnDisk(agent?.session?.id)
      const ids = mine.map((r) => r.header.id)
      const titleById = new Map()
      try {
        const obs = await ctx.sessionQuery.readTitleSnapshots(ids)
        for (const o of obs) {
          if (o.status === 'fulfilled' && o.value.title) titleById.set(o.sessionId, o.value.title.title)
        }
      } catch { /* titles are a nice-to-have */ }
      return mine.map((r) => ({
        id: r.header.id,
        title: titleById.get(r.header.id) || shortSessionId(r.header.id),
        createdAt: r.header.createdAt,
        parent: r.header.parentSession || null,
        current: agent?.session?.id === r.header.id,
      }))
    },
    async deleteSession(sessionId) {
      if (agent && agent.session.id === sessionId) throw new Error('cannot delete the current session')
      const records = await ctx.sessionQuery.listSessions().catch(() => [])
      if (records.some((r) => r.header.id === sessionId && r.live)) {
        throw new Error('session is loaded in this runtime — switch away and retry')
      }
      const root = path.resolve(home, 'sessions')
      const dir = path.resolve(root, projectKey(process.cwd()), sessionId)
      if (!/^session-[0-9a-f-]+$/i.test(sessionId)) throw new Error('invalid session id')
      if (!dir.startsWith(root + path.sep)) throw new Error('refusing to delete outside the sessions root')
      if (!fs.existsSync(dir)) throw new Error('session files not found on disk')
      fs.rmSync(dir, { recursive: true, force: true })
      return true
    },
    async switchSession(sessionId) {
      if (agent && agent.session.id === sessionId) return { agent, already: true }
      // persisted sessions must be resumed (not created): create() refuses to
      // publish over state the persistence layer already owns
      let created
      try {
        created = await agents.resume({
          resumeSessionId: SessionId(normalizeSessionId(sessionId)),
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
          },
        })
      } catch (e) {
        if (String(e.message).includes('in use') || String(e.message).includes('already exists')) {
          throw new Error('session is in use (current or another live one)')
        }
        throw e
      }
      adoptHandle(created)
      await agent.whenIdle()
      notifySwitched()
      return { agent }
    },
    async listModels() {
      // every registered provider route, flat: { provider, model, name, providerName }
      const llm = ctx.get('llm')
      if (!llm?.listModels) return [{ provider: selection.provider, model: selection.model, name: selection.model, providerName: selection.provider }]
      const out = []
      for (const p of llm.listProviders()) {
        try {
          for (const m of await llm.listModels(p.id)) {
            out.push({ provider: p.id, model: m.id, name: m.name || m.id, providerName: p.name || p.id })
          }
        } catch { /* a provider that cannot enumerate models is skipped */ }
      }
      return out
    },
    async setModel(provider, model) {
      // mutate the live selection object the agent model-selection listeners
      // read at prompt-assembly time — the switch lands on the next turn
      selection.provider = provider
      selection.model = model
      try {
        await defaultModelSvc.saveSelection({
          provider,
          model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        })
      } catch { /* no settings provider — in-memory selection only */ }
      return { provider, model, reasoningEffort: selection.reasoningEffort }
    },
    async conversationHistory(agentObj) {
      const msgs = []
      let usageTotal = 0 // cumulative input+output tokens, restored into the status line
      const names = new Map() // callId -> tool name, for correlating error results
      const imageOf = async (b, fromTool) => {
        if (b.data && b.mimeType) return { kind: 'image', base64: b.data, mimeType: b.mimeType, name: b.name, fromTool }
        if (typeof b.url === 'string' && b.url.startsWith('data:')) {
          const m = b.url.match(/^data:([^;,]+);base64,(.+)$/s)
          if (m) return { kind: 'image', base64: m[2], mimeType: m[1], name: b.name, fromTool }
        }
        const stored = await ctx.attachments.readImage(b.attachment)
        return {
          kind: 'image',
          base64: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref?.mediaType || b.attachment.mediaType,
          name: stored.ref?.name || b.attachment.name,
          fromTool,
        }
      }
      for (const e of agentObj.session.events) {
        if (e.type === 'user/message') {
          const txt = contentText(e.data.content)
          if (txt) msgs.push({ kind: 'user', text: txt })
        } else if (e.type === 'assistant/message') {
          const content = e.data.message?.content || []
          const u = e.data.usage
          if (u) usageTotal += (u.inputTokens || 0) + (u.outputTokens || 0)
          // reasoning precedes the answer in stream order — restore it first
          for (const b of reasoningBlocks(content)) msgs.push({ kind: 'reasoning', text: b.text })
          const txt = contentText(content)
          if (txt) msgs.push({ kind: 'asst', text: txt })
          for (const b of collectImageBlocks(content)) msgs.push(await imageOf(b, false))
        } else if (e.type === 'tool/call') {
          // restore the full call (same shape as live render) so surfaces can
          // still expand after a session switch / fork
          names.set(e.data?.callId, e.data?.name)
          const info = toolCallInfo(e.data || {})
          msgs.push({ kind: 'tool', text: info.text, summary: info.summary })
        } else if (e.type === 'tool/result') {
          const r = toolResultMessage(e.data || {}, names)
          if (r) msgs.push({ kind: r.kind, text: r.text, summary: r.summary })
          for (const b of collectImageBlocks(e.data.message?.content || [])) msgs.push(await imageOf(b, true))
        }
      }
      return { msgs, usageTotal }
    },
    async exportSession(dirArg) {
      // write the live session log to markdown + JSON in <dirArg> (or cwd).
      // The events snapshot is frozen per append, so this is safe mid-turn.
      const events = agent.session.events
      const id = agent.session.id
      let title
      try { title = ctx.sessionTitle?.get(agent.session)?.title } catch { title = undefined }
      const base = exportFileName(id)
      const dir = dirArg ? path.resolve(dirArg) : process.cwd()
      fs.mkdirSync(dir, { recursive: true })
      const mdPath = path.join(dir, base + '.md')
      const jsonPath = path.join(dir, base + '.json')
      fs.writeFileSync(mdPath, exportSessionMarkdown({ id, title, createdAt: agent.session.header?.createdAt, events }))
      fs.writeFileSync(jsonPath, exportSessionJson({ id, title, createdAt: agent.session.header?.createdAt, events }))
      return { mdPath, jsonPath, count: events.length }
    },
    async compact() {
      // manual compaction through the dsh-native /compact command (command-compact
      // over ctx.compaction.compactNow) — proper command/run + command/done
      // lifecycle, exact result text, and the UI signal forwarded into the
      // summarization call.
      if (!ctx.commands) throw new Error('command registry unavailable')
      if (!ctx.compaction) throw new Error('compaction backend unavailable — dsh-base without compaction')
      const r = await ctx.commands.execute(agent, '/compact', compactSignal.signal)
      if (!r) return { ok: false, text: '/compact is not registered in this runtime' }
      return { ok: r.result?.kind === 'success', text: r.result?.text || 'compacted' }
    },
    dispose() {
      retireHandle()
      compactSignal.abort()
      try { ctx.fiber?.dispose?.() } catch { /* best effort */ }
    },
  }

  return runtime
}

export {
  createPiRuntime,
  defaultModel,
  ensureProfile,
  bootRuntime,
  sessionStatePath,
  loadSessionId,
  saveSessionId,
  tuiLastSessionId,
  normalizeSessionId,
  projectEvent,
  collectImageBlocks,
  contentText,
  reasoningSummary,
  reasoningBlocks,
  toolCallInfo,
  toolResultMessage,
  sessionTitleFromEvents,
  exportSessionMarkdown,
  exportSessionJson,
  exportFileName,
  projectKey,
  shortSessionId,
  scanSessionsOnDisk,
}
