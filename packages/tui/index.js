#!/usr/bin/env node
// @dsh-pi/tui — pi-style terminal UI for dsh-pi, IN-PROCESS.
//
// No spawned runtime, no JSON-RPC: the dsh runtime boots inside this process
// (like pi's single-process design). The pi-sdk profile trick is gone; we
// compose the pi-embed profile (base + prompt + fff + tools) in-process,
// create an Agent directly, and render its session events live.
//
// Commands: /help /clear /theme (picker) /tools [on|off|full] /new /stop /quit
// Shortcuts: Esc interrupt · Ctrl+N new session · Ctrl+T reasoning expand/collapse · Ctrl+O tool output expand · Ctrl+K clear · Ctrl+Q quit
// Env: DSH_BIN unused here; DSH_PI_PROVIDER/DSH_PI_MODEL override the route.
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import {
  boot,
  healProfilesModuleFallback,
  loadOptionalPatches,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { zstdDecompressSync } from 'node:zlib'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CombinedAutocompleteProvider,
  Editor,
  getKeybindings,
  Image,
  KeybindingsManager,
  Loader,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  setKeybindings,
  Spacer,
  Text,
  TuiMainScreen,
  TUI_KEYBINDINGS,
  VStack,
} from '@earendil-works/pi-tui'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROF = 'pi-embed'
const profDir = path.join(home, 'profiles', PROF)
const REGISTRY = 'https://registry.npmjs.org'
const STATE_DIR = path.join(home, 'dsh-pi-tui')
const ANCHOR = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const PROFILE_ROOT_CONFIG = '# dsh profile root — empty entry list; tree composed as patches.\n[]\n'
const plain = (s) => s
// pi-tui Image: cap the rendered width at ~60 cells (the component parses
// dimensions from the image headers and derives rows from cell aspect ratio)
const IMAGE_MAX_WIDTH_CELLS = 60
// Image theme: pi-tui's built-in text fallback on terminals without
// Kitty/iTerm2 graphics support — dim gray like the status/dim accents
const IMAGE_THEME = { fallbackColor: (s) => `\x1b[90m${s}\x1b[0m` }

const LOGO = [
  '  ██████╗ ███████╗██╗  ██╗    ██████╗ ██╗',
  '  ██╔══██╗██╔════╝██║  ██║    ██╔══██╗██║',
  '  ██████╔╝███████╗███████║    ██████╔╝██║',
  '  ██╔═══╝ ╚════██║██╔══██║    ██╔═══╝ ██║',
  '  ██║     ███████║██║  ██║    ██║     ██║',
  '  ╚═╝     ╚══════╝╚═╝  ╚═╝    ╚═╝     ╚═╝',
].join('\n')

// ---- themes -----------------------------------------------------------------

function createHighlightCode(codeBlock) {
  return (text, lang) => {
    const lines = text.split('\n')
    const isDiff =
      lang === 'diff' ||
      lines.some((l) => /^[+\-@]/.test(l) || /^(diff --git|Index:|--- |\+\+\+ )/.test(l))
    if (!isDiff) return lines.map((l) => codeBlock(l))
    return lines.map((l) => {
      if (/^\+\+\+ /.test(l)) return '\x1b[1m' + l + '\x1b[0m'
      if (/^--- /.test(l)) return '\x1b[1m' + l + '\x1b[0m'
      if (/^diff --git|^Index:/.test(l)) return '\x1b[35m\x1b[1m' + l + '\x1b[0m'
      if (l.startsWith('+')) return '\x1b[32m' + l + '\x1b[0m'
      if (l.startsWith('-')) return '\x1b[31m' + l + '\x1b[0m'
      if (l.startsWith('@@')) return '\x1b[36m' + l + '\x1b[0m'
      return codeBlock(l)
    })
  }
}

const THEMES = {
  default: {
    name: 'default',
    description: 'dark · cyan accents',
    markdown: {
      heading: (s) => `\x1b[1m${s}\x1b[0m`,
      link: plain,
      linkUrl: plain,
      code: (s) => `\x1b[36m${s}\x1b[0m`,
      codeBlock: (s) => `\x1b[36m${s}\x1b[0m`,
      codeBlockBorder: plain,
      quote: plain,
      quoteBorder: plain,
      hr: plain,
      listBullet: (s) => `\x1b[90m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      italic: (s) => `\x1b[3m${s}\x1b[0m`,
      strikethrough: plain,
      underline: (s) => `\x1b[4m${s}\x1b[0m`,
      highlightCode: createHighlightCode((s) => `\x1b[36m${s}\x1b[0m`),
    },
    editor: { borderColor: (s) => `\x1b[90m${s}\x1b[0m`, selectList: {
      selectedPrefix: (s) => `\x1b[36m❯ ${s}\x1b[0m`,
      selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
      description: (s) => `\x1b[90m${s}\x1b[0m`,
      scrollInfo: (s) => `\x1b[90m${s}\x1b[0m`,
      noMatch: (s) => `\x1b[90m${s}\x1b[0m`,
    } },
    user: (s) => `\x1b[94m❯\x1b[0m ${s}`,
    tool: (s) => `\x1b[36m⚙ ${s}\x1b[0m`,
    result: (s) => `\x1b[32m✓\x1b[0m ${s}`,
    error: (s) => `\x1b[31m✗ ${s}\x1b[0m`,
    reasoning: (s) => `\x1b[3m\x1b[90m${s}\x1b[0m`, // dim italic — thinking is secondary to the answer
    help: {
      header: (s) => `\x1b[1m\x1b[90m${s}\x1b[0m`,
      cmd: (s) => `\x1b[36m${s}\x1b[0m`,
      key: (s) => `\x1b[36m${s}\x1b[0m`,
      desc: plain,
    },
    sys: (s) => `\x1b[33m${s}\x1b[0m`,
    status: (s) => `\x1b[90m${s}\x1b[0m`,
    logo: (s) => `\x1b[36m${s}\x1b[0m`,
  },
  light: {
    name: 'light',
    description: 'light · blue accents',
    markdown: {
      heading: (s) => `\x1b[1m${s}\x1b[0m`,
      link: plain,
      linkUrl: plain,
      code: (s) => `\x1b[34m${s}\x1b[0m`,
      codeBlock: (s) => `\x1b[34m${s}\x1b[0m`,
      codeBlockBorder: plain,
      quote: plain,
      quoteBorder: plain,
      hr: plain,
      listBullet: (s) => `\x1b[90m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      italic: (s) => `\x1b[3m${s}\x1b[0m`,
      strikethrough: plain,
      underline: (s) => `\x1b[4m${s}\x1b[0m`,
      highlightCode: createHighlightCode((s) => `\x1b[34m${s}\x1b[0m`),
    },
    editor: { borderColor: (s) => `\x1b[34m${s}\x1b[0m`, selectList: {
      selectedPrefix: (s) => `\x1b[36m❯ ${s}\x1b[0m`,
      selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
      description: (s) => `\x1b[90m${s}\x1b[0m`,
      scrollInfo: (s) => `\x1b[90m${s}\x1b[0m`,
      noMatch: (s) => `\x1b[90m${s}\x1b[0m`,
    } },
    user: (s) => `\x1b[34m❯\x1b[0m ${s}`,
    tool: (s) => `\x1b[34m⚙ ${s}\x1b[0m`,
    result: (s) => `\x1b[32m✓\x1b[0m ${s}`,
    error: (s) => `\x1b[31m✗ ${s}\x1b[0m`,
    reasoning: (s) => `\x1b[3m\x1b[34m${s}\x1b[0m`, // italic blue — thinking is secondary to the answer
    help: {
      header: (s) => `\x1b[1m\x1b[90m${s}\x1b[0m`,
      cmd: (s) => `\x1b[34m${s}\x1b[0m`,
      key: (s) => `\x1b[34m${s}\x1b[0m`,
      desc: plain,
    },
    sys: (s) => `\x1b[33m${s}\x1b[0m`,
    status: (s) => `\x1b[90m${s}\x1b[0m`,
    logo: (s) => `\x1b[36m${s}\x1b[0m`,
  },
}

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
  console.error(`[dsh-pi-tui] creating profile ${PROF}...`)
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
  fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), '# dsh-pi TUI: no hot-reload (avoids the --expose-internals requirement bun cannot satisfy).\n- id: hmr\n  disabled: true\n')
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
// one-line summary by default, Ctrl+T expands/collapses (theme.reasoning style).
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
// first-line summary drives the collapsed view (/tools on) — /tools full or
// Ctrl+O expand to the complete text.
const TOOL_SUMMARY_CAP = 300 // summary lines longer than this get an ellipsis
const TOOLS_MODE_LABEL = { on: 'summary', full: 'full', off: 'off' } // status labels for /tools

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
// so /tools full can expand either. `names` maps callId -> tool name for
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

// ---- UI ------------------------------------------------------------------------

// ---- UI ------------------------------------------------------------------------

function setupUi(runtimeRef, modelInfo) {
  const terminal = new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)
  let theme = THEMES[process.env.DSH_PI_THEME] || THEMES.default
  // model/session info is always visible in the status line
  const runtimeInfo = { provider: modelInfo?.provider || '', model: modelInfo?.model || '' }
  let toolsMode = 'on' // /tools state: on (summaries) | full (everything) | off (folded)
  const messages = []
  const toolNames = new Map() // callId -> tool name, for correlating error results
  let currentAsst = null
  let asstText = ''
  let inText = false
  // reasoning (thinking) block streaming: deltas accumulate into reasoningText,
  // rendered as a 'reasoning' message collapsed to one line; Ctrl+T toggles
  // reasoningExpanded for every reasoning block (pi-style thinking fold).
  let reasoningOpen = false
  let reasoningText = ''
  let reasoningExpanded = false
  let reasoningMsg = null // live { kind:'reasoning', live:true } message while streaming
  const queue = []
  // attachment ids already shown — the same image can arrive twice (streamed
  // chunk block-end + assembled assistant/message, or tool result + history)
  const renderedImages = new Set()

  const container = new VStack([])
  const scroll = new ScrollView(container, { follow: 'end', primary: true })
  const editor = new Editor(tui, theme.editor)
  // pi-tui Loader: spins while a turn is in flight, static text when idle
  const statusLoader = new Loader(
    tui,
    (s) => `\x1b[36m${s}\x1b[0m`, // spinner in accent (matches logo/user accents)
    theme.status, // message in the dim status gray
    'starting…',
  )
  tui.addChild(new VStack([scroll, editor, statusLoader]))
  tui.start()
  tui.setFocus(editor)

  // pi-tui built-ins: slash-command + file-path autocomplete on the editor
  const autocomplete = new CombinedAutocompleteProvider(
    [
      { name: 'help', description: 'show help' },
      { name: 'clear', description: 'clear the conversation view' },
      { name: 'theme', description: 'switch theme (picker)', argumentHint: '<name>', getArgumentCompletions: () => Object.keys(THEMES).map((n) => ({ value: n, label: n })) },
      { name: 'tools', description: 'fold/unfold/expand tool details', argumentHint: '[on|off|full]', getArgumentCompletions: () => ['on', 'off', 'full'].map((v) => ({ value: v, label: v })) },
      { name: 'sessions', description: 'pick, switch or delete sessions', argumentHint: '[<n>|delete <n>]' },
      { name: 'fork', description: 'branch a child session from this one' },
      { name: 'new', description: 'start a fresh session' },
      { name: 'stop', description: 'interrupt the running turn (Esc)' },
      { name: 'quit', description: 'leave' },
    ],
    process.cwd(),
  )
  editor.setAutocompleteProvider(autocomplete)

  // ---- app-level shortcuts via pi-tui's KeybindingsManager -------------------
  // ids follow pi's `app.*` convention; Ctrl+K deliberately shadows the
  // editor's `tui.editor.deleteToLineEnd` (pi default) — clear beats kill-line
  // here. Ctrl+L stays as the legacy clear alias.
  setKeybindings(
    new KeybindingsManager({
      ...TUI_KEYBINDINGS,
      'app.interrupt': { defaultKeys: 'escape', description: 'Interrupt the running turn' },
      'app.session.new': { defaultKeys: 'ctrl+n', description: 'Start a fresh session' },
      'app.reasoning.toggle': { defaultKeys: 'ctrl+t', description: 'Expand/collapse reasoning (thinking)' },
      'app.tools.expand': { defaultKeys: 'ctrl+o', description: 'Toggle tool output expansion' },
      'app.clear': { defaultKeys: ['ctrl+k', 'ctrl+l'], description: 'Clear the conversation view' },
      'app.quit': { defaultKeys: 'ctrl+q', description: 'Quit' },
    }),
  )

  let busy = false
  let statusState = ''
  function composeStatus(str) {
    const parts = []
    if (runtimeInfo.model) parts.push(`${runtimeInfo.provider}/${runtimeInfo.model}`)
    if (runtimeRef.sessionId) {
      const title = runtimeRef.currentTitle?.()
      parts.push(title ? `“${title}”` : `session ${String(runtimeRef.sessionId).replace(/^session-/, '').slice(0, 8)}`)
    }
    parts.push(str)
    return parts.join(' · ')
  }
  function setStatus(str) {
    // idle/static status: hide the spinner, show plain text
    busy = false
    statusState = str
    statusLoader.setIndicator({ frames: [] })
    statusLoader.setMessage(composeStatus(str))
    tui.requestRender()
  }
  function setBusy(str) {
    // turn in flight: pi-tui spinner + message
    busy = true
    statusState = str
    statusLoader.setIndicator()
    statusLoader.setMessage(composeStatus(str))
    tui.requestRender()
  }
  function refreshStatus() {
    if (busy) setBusy(statusState)
    else setStatus(statusState)
  }
  function setModelInfo(provider, model) {
    runtimeInfo.provider = provider
    runtimeInfo.model = model
    refreshStatus()
  }

  // render one stored message per the current /tools mode — shared by live
  // addMessage and rebuild() so folding is consistent mid-turn and after /tools
  function renderText(m, t) {
    if (m.kind === 'tool') return toolRender(m, t)
    if (m.kind === 'result') return resultRender(m, t)
    if (m.kind === 'error') return errorRender(m, t)
    if (m.kind === 'reasoning') return reasoningRender(m, t)
    if (m.kind === 'user') return t.user(m.text)
    if (m.kind === 'help') return m.text // already styled by the help builder
    if (m.kind === 'logo') return t.logo(m.text)
    return t.sys(m.text)
  }
  function addMessage(kind, text, opts = {}) {
    const t = theme
    const m = { kind, text, summary: opts.summary }
    m.comp = kind === 'asst' ? new Markdown(m.text, 1, 0, t.markdown, {}) : new Text(renderText(m, t))
    messages.push(m)
    container.addChild(m.comp)
    tui.requestRender()
  }

  function addImageMessage(base64, mimeType, opts = {}) {
    const comp = new Image(base64, mimeType, IMAGE_THEME, {
      maxWidthCells: IMAGE_MAX_WIDTH_CELLS,
      filename: opts.name,
    })
    messages.push({ kind: 'image', base64, mimeType, name: opts.name, fromTool: !!opts.fromTool, comp })
    if (opts.fromTool && toolsMode === 'off') return // folded with tool details — mounted by rebuild() on unfold
    container.addChild(new Spacer(1))
    container.addChild(comp)
    tui.requestRender()
  }

  // Resolve one image block and mount it: durable attachment ref (dsh), inline
  // base64 (pi-style blocks), or a data: URI. http(s) URLs are not fetched from
  // the TUI — the terminal shows where the image lives instead. Deduped by a
  // stable key so the same image renders exactly once.
  function addImageFromBlock(block, fromTool) {
    const ref = block.attachment
    let base64 = null
    let mimeType = null
    let dedupeKey = null
    const name = block.name || ref?.name
    if (ref?.attachmentId) dedupeKey = ref.attachmentId
    else if (block.data && block.mimeType) {
      base64 = block.data; mimeType = block.mimeType
      dedupeKey = `${block.mimeType}:${base64.slice(0, 40)}`
    } else if (typeof block.url === 'string' && block.url.startsWith('data:')) {
      const m = block.url.match(/^data:([^;,]+);base64,(.+)$/s)
      if (m) { base64 = m[2]; mimeType = m[1]; dedupeKey = `${m[1]}:${base64.slice(0, 40)}` }
    }
    if (!dedupeKey) {
      if (typeof block.url === 'string') addMessage('sys', `[image: ${block.url}]`)
      return
    }
    if (renderedImages.has(dedupeKey)) return
    renderedImages.add(dedupeKey)
    if (base64) { addImageMessage(base64, mimeType, { name, fromTool }); return }
    if (!runtimeRef.readImage) return
    runtimeRef.readImage(ref)
      .then((stored) => {
        addImageMessage(Buffer.from(stored.data).toString('base64'), stored.ref?.mediaType || ref.mediaType, {
          name: stored.ref?.name || name,
          fromTool,
        })
      })
      .catch((e) => {
        renderedImages.delete(dedupeKey)
        addMessage('sys', 'image unavailable: ' + e.message)
      })
  }

  // per-kind render for the current /tools mode. The dim hint mirrors pi's
  // "... N more lines (Ctrl+O to expand)" affordance so collapsed entries stay
  // discoverable.
  const dimHint = (lines) =>
    lines > 0 ? `\n  \x1b[90m… ${lines} more line${lines === 1 ? '' : 's'} — Ctrl+O expands\x1b[0m` : ''
  function toolRender(m, t) {
    if (toolsMode === 'off') return t.tool(m.text.split('\n')[0]) // tool name only
    if (toolsMode === 'full') return t.tool(m.text)
    return t.tool(m.summary || m.text) + dimHint(m.text.split('\n').length - 1)
  }
  function resultRender(m, t) {
    if (toolsMode === 'off') return t.sys('…')
    if (toolsMode === 'full') return t.result(m.text)
    return t.result(m.summary || m.text) + dimHint(m.text.split('\n').length - 1)
  }
  function errorRender(m, t) {
    // failures stay visible in every mode; full expands their full payload
    if (toolsMode === 'full' && m.summary) return t.error(m.text)
    return t.error(m.summary || m.text)
  }

  function rebuild() {
    container.clear()
    for (const m of messages) {
      const t = theme
      if (m.kind === 'asst') m.comp = new Markdown(m.text, 1, 0, t.markdown, {})
      else if (m.kind === 'image') {
        if (m.fromTool && toolsMode === 'off') continue // folded with tool details
        container.addChild(new Spacer(1))
        m.comp = new Image(m.base64, m.mimeType, IMAGE_THEME, { maxWidthCells: IMAGE_MAX_WIDTH_CELLS, filename: m.name })
      }
      else m.comp = new Text(renderText(m, t))
      container.addChild(m.comp)
    }
    // a mid-stream rebuild (theme change, /clear, /tools…) recreates comps —
    // re-link the live reasoning message so deltas keep updating it
    reasoningMsg = messages.find((m) => m.kind === 'reasoning' && m.live) || null
    tui.requestRender()
  }
  function upsertAsst() {
    // reuse the mounted component (setText) — only create/remove on transitions
    if (asstText) {
      if (currentAsst) {
        currentAsst.setText(asstText)
      } else {
        currentAsst = new Markdown(asstText, 1, 0, theme.markdown, {})
        container.addChild(currentAsst)
      }
    } else if (currentAsst) {
      container.removeChild(currentAsst)
      currentAsst = null
    }
    tui.requestRender()
  }

  // Markdown re-parse on every text-delta is the streaming hot path; coalesce
  // bursts into at most ~30 rebuilds/sec and always flush the final frame.
  let asstTimer = null
  function scheduleAsst() {
    if (asstTimer) return
    asstTimer = setTimeout(() => {
      asstTimer = null
      upsertAsst()
    }, 33)
  }
  function flushAsst() {
    if (!asstTimer) return
    clearTimeout(asstTimer)
    asstTimer = null
    upsertAsst()
  }
  function cancelAsst() {
    if (asstTimer) {
      clearTimeout(asstTimer)
      asstTimer = null
    }
  }

  // ---- reasoning (thinking) streaming ---------------------------------------
  // reasoningRender styles one reasoning message per the global fold state:
  // collapsed -> first-line summary + dim '… N more lines — Ctrl+T expands' hint,
  // expanded -> the full text. The dim hint mirrors the tool-detail affordance.
  function reasoningRender(m, t) {
    const { summary, hidden } = reasoningSummary(m.text)
    if (reasoningExpanded) return t.reasoning(m.text)
    const hint = hidden > 0 ? `\n  \x1b[90m… ${hidden} more line${hidden === 1 ? '' : 's'} — Ctrl+T expands\x1b[0m` : ''
    return t.reasoning(summary) + hint
  }

  // mount/update the live reasoning message (deltas coalesced like asst text)
  function upsertReasoning() {
    if (!reasoningText) return
    if (reasoningMsg) {
      reasoningMsg.text = reasoningText
      reasoningMsg.comp.setText(reasoningRender(reasoningMsg, theme))
    } else {
      reasoningMsg = { kind: 'reasoning', text: reasoningText, live: true, comp: null }
      messages.push(reasoningMsg)
      reasoningMsg.comp = new Text(reasoningRender(reasoningMsg, theme))
      container.addChild(reasoningMsg.comp)
    }
    tui.requestRender()
  }
  let reasoningTimer = null
  function scheduleReasoning() {
    if (reasoningTimer) return
    reasoningTimer = setTimeout(() => {
      reasoningTimer = null
      upsertReasoning()
    }, 33)
  }
  function flushReasoning() {
    if (!reasoningTimer) return
    clearTimeout(reasoningTimer)
    reasoningTimer = null
    upsertReasoning()
  }
  function cancelReasoning() {
    if (reasoningTimer) {
      clearTimeout(reasoningTimer)
      reasoningTimer = null
    }
  }
  // close the open reasoning block: keep whatever text streamed (the block-end
  // carries the authoritative full text) and detach it from the live stream
  function finishReasoning(finalText) {
    if (finalText) reasoningText = finalText
    reasoningOpen = false
    if (reasoningMsg) {
      reasoningMsg.text = reasoningText
      reasoningMsg.live = false
      reasoningMsg.comp.setText(reasoningRender(reasoningMsg, theme))
    }
    reasoningMsg = null
    reasoningText = ''
  }

  function toggleReasoning() {
    reasoningExpanded = !reasoningExpanded
    for (const m of messages) {
      if (m.kind === 'reasoning' && m.comp) m.comp.setText(reasoningRender(m, theme))
    }
    tui.requestRender()
    flashStatus(reasoningExpanded ? 'reasoning: expanded' : 'reasoning: collapsed')
  }

  // live session-event stream from the in-process runtime
  function renderEvent(session, event) {
    const d = event.data || {}
    if (event.type === 'turn/start') setBusy('busy…')
    if (event.type === 'turn/end') {
      flushAsst()
      flushReasoning()
      if (reasoningOpen) finishReasoning() // interrupted mid-thinking: keep what streamed
      const reason = d.reason || {}
      if (reason.kind === 'error' && reason.error) {
        // model/provider failure: structured LlmFailure facts, rendered as an error block
        const f = reason.error
        const detail = [
          f.code,
          f.status ? `status ${f.status}` : '',
          f.requestId ? `request ${f.requestId}` : '',
        ].filter(Boolean).join(' · ')
        addMessage('error', `model: ${f.message}${detail ? `\n  \x1b[90m${detail}\x1b[0m` : ''}`)
        setStatus('error')
      } else if (reason.kind === 'max-tokens') {
        addMessage('sys', '⏹ output token limit reached')
        setStatus('ready')
      } else if (reason.kind === 'aborted' && reason.reason?.kind === 'user') {
        // live user interrupt (Escape / /stop): agent.cancel({ kind: 'user' })
        addMessage('sys', '⏹ turn interrupted')
        setStatus('ready')
      } else if (reason.kind === 'interrupted') {
        addMessage('sys', '⏹ turn interrupted (session restored)')
        setStatus('ready')
      } else {
        setStatus('ready')
      }
    }
    if (event.type === 'assistant/chunk') {
      const chunk = d.chunk || {}
      if (chunk.type === 'block-start') {
        if (chunk.blockType === 'text') inText = true
        else if (chunk.blockType === 'reasoning') {
          // a fresh thinking block (defensive: close any orphaned one first)
          if (reasoningOpen && reasoningMsg) finishReasoning()
          reasoningOpen = true
          reasoningText = ''
        }
      } else if (chunk.type === 'text-delta' && inText) {
        asstText += chunk.text
        scheduleAsst()
      } else if (chunk.type === 'reasoning-delta' && reasoningOpen) {
        reasoningText += chunk.text
        scheduleReasoning()
      } else if (chunk.type === 'block-end') {
        // image output streams as one assembled block — mount it immediately;
        // reasoning blocks finalize with the full text the adapter assembled
        if (chunk.block?.type === 'image') addImageFromBlock(chunk.block, false)
        else if (chunk.block?.type === 'reasoning' && reasoningOpen) finishReasoning(chunk.block.text)
        inText = false
      }
    } else if (event.type === 'assistant/message') {
      // assembled step message may carry image blocks (deduped against block-end)
      for (const b of collectImageBlocks(d.message?.content || [])) addImageFromBlock(b, false)
    } else if (event.type === 'tool/call') {
      // surface the running tool in the spinner line (animation keeps going)
      if (busy) {
        statusLoader.setMessage(composeStatus(`⚙ ${d.name}…`))
        tui.requestRender()
      }
      toolNames.set(d.callId, d.name)
      const info = toolCallInfo(d)
      addMessage('tool', info.text, { summary: info.summary })
    } else if (event.type === 'tool/result') {
      // tool results nest their payload inside a tool-result block — walk it
      const r = toolResultMessage(d, toolNames)
      if (r) addMessage(r.kind, r.text, { summary: r.summary })
      for (const b of collectImageBlocks(d.message?.content || [])) addImageFromBlock(b, true)
    }
  }

  // structured /help: section headers + aligned command/key rows (theme-aware)
  const pad = (s, n) => (s.length < n ? s + ' '.repeat(n - s.length) : s)
  function buildHelp() {
    const t = theme.help
    const themeNames = Object.keys(THEMES)
    const cmdRow = (cmd, desc) => `  ${t.cmd(pad(cmd, 20))} ${t.desc(desc)}`
    const keyRow = (key, desc) => `  ${t.key(pad(key, 12))} ${t.desc(desc)}`
    return [
      t.header('commands'),
      cmdRow('/help', 'this help'),
      cmdRow('/clear', 'clear the conversation view (session stays)'),
      cmdRow('/theme [name]', `switch theme from a list (${themeNames.join(', ')})`),
      cmdRow('/tools [on|off|full]', 'tool details: on = first-line summaries, full = everything, off = folded'),
      cmdRow('/sessions', 'pick a session from the tree (d = delete, Esc = cancel)'),
      cmdRow('/sessions <n>', 'switch to session #n'),
      cmdRow('/sessions delete <n>', 'delete session #n (never the current one)'),
      cmdRow('/fork', 'branch a child session from this one'),
      cmdRow('/new', 'start a fresh session'),
      cmdRow('/stop', 'interrupt the running turn (Esc)'),
      cmdRow('/quit, exit', 'leave'),
      '',
      t.header('keys'),
      keyRow('Esc', 'interrupt the running turn'),
      keyRow('Ctrl+N', 'new session'),
      keyRow('Ctrl+T', 'expand/collapse reasoning (thinking)'),
      keyRow('Ctrl+O', 'toggle tool output expansion (on <-> full)'),
      keyRow('Ctrl+K', 'clear the conversation view'),
      keyRow('Ctrl+Q', 'quit'),
      keyRow('Ctrl+L', 'clear (alias of Ctrl+K)'),
      keyRow('Ctrl+C', 'copy selection / cancel'),
      keyRow('↑ / ↓', 'browse input history'),
    ].join('\n')
  }

  function clearView() {
    cancelAsst(); cancelReasoning(); renderedImages.clear(); messages.length = 0; currentAsst = null; asstText = ''; reasoningMsg = null; reasoningText = ''; reasoningOpen = false; rebuild()
  }
  // transient notice: keep the spinner running if a turn is in flight
  function flashStatus(str) {
    if (busy) {
      statusLoader.setMessage(composeStatus(str))
      tui.requestRender()
    } else setStatus(str)
  }
  function toggleToolsExpand() {
    // pi-style Ctrl+O: expand/collapse tool output (on <-> full)
    toolsMode = toolsMode === 'full' ? 'on' : 'full'
    rebuild()
    flashStatus(`tool output: ${TOOLS_MODE_LABEL[toolsMode]}`)
  }
  // Escape / /stop: abort the running turn via the dsh agent's cancel. The
  // cause flows into the turn/end reason ({ kind: 'aborted', reason: { kind:
  // 'user' } }) which renderEvent surfaces as "⏹ turn interrupted". Idle
  // turns are never cancelled (cancel is a no-op without active activity).
  function interruptTurn() {
    if (!busy) return
    if (!runtimeRef.interrupt) {
      addMessage('sys', 'interrupt unavailable — runtime still starting')
      return
    }
    try {
      runtimeRef.interrupt()
      flashStatus('⏹ interrupting…')
    } catch (e) {
      addMessage('error', `interrupt: ${e.message}`)
    }
  }

  // ---- session picker (tree) ----------------------------------------------------
  let pickerState = null  // { sel, flat } while the /sessions overlay is open
  let confirmingDelete = false

  // Flatten sessions into a display tree: roots (no parent in the corpus) first,
  // each followed by its descendants, siblings newest-first. The flat order is
  // what /sessions <n> and the picker numbering address.
  function buildSessionTree(list) {
    const byId = new Map(list.map((x) => [x.id, x]))
    const childrenOf = new Map()
    const roots = []
    for (const x of list) {
      if (x.parent && byId.has(x.parent)) {
        if (!childrenOf.has(x.parent)) childrenOf.set(x.parent, [])
        childrenOf.get(x.parent).push(x)
      } else roots.push(x)
    }
    const sortNewest = (a, b) => b.createdAt - a.createdAt
    roots.sort(sortNewest)
    for (const kids of childrenOf.values()) kids.sort(sortNewest)
    const flat = []
    const walk = (node, depth) => {
      flat.push({ node, depth })
      for (const c of childrenOf.get(node.id) || []) walk(c, depth + 1)
    }
    for (const r of roots) walk(r, 0)
    return flat
  }

  const dim = (s) => `\x1b[90m${s}\x1b[0m`
  const pickerTheme = {
    selectedPrefix: (s) => `\x1b[36m❯ ${s}\x1b[0m`,
    selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  }

  function closePicker() {
    pickerState = null
    tui.hideOverlay()
    tui.setFocus(editor)
  }

  function openSessionPicker() {
    runtimeRef.listSessions?.().then((list) => {
      if (!list.length) { addMessage('sys', 'no sessions yet'); return }
      const flat = buildSessionTree(list)
      const items = flat.map(({ node, depth }) => {
        const indent = '  '.repeat(depth)
        const branch = depth ? '└ ' : ''
        const label = `${indent}${branch}${node.title}${node.current ? ' (current)' : ''}`
        const desc = shortSessionId(node.id) + (node.parent ? ' · fork of ' + shortSessionId(node.parent) : '')
        return { label, value: node.id, description: desc }
      })
      const sel = new SelectList(items, 10, pickerTheme)
      pickerState = { sel, flat }
      sel.onSelect = (item) => {
        closePicker()
        const n = flat.findIndex((f) => f.node.id === item.value) + 1
        submit('/sessions ' + n)
      }
      sel.onCancel = () => closePicker()
      tui.showOverlay(sel)
      tui.setFocus(sel)
    })
  }

  function confirmDeleteSession(node) {
    confirmingDelete = true
    const confirm = new SelectList(
      [
        { value: 'no', label: 'cancel' },
        { value: 'yes', label: `delete “${node.title}” (${shortSessionId(node.id)})` },
      ],
      5,
      pickerTheme,
    )
    const done = () => {
      confirmingDelete = false
      tui.hideOverlay()  // pop the confirm overlay; focus returns to the picker
    }
    confirm.onSelect = async (c) => {
      if (c.value !== 'yes') { done(); tui.setFocus(pickerState?.sel); return }
      done()
      closePicker()
      setStatus('… deleting…')
      try {
        await runtimeRef.deleteSession(node.id)
        addMessage('sys', 'deleted session: ' + node.title)
      } catch (e) {
        addMessage('sys', '! delete failed: ' + e.message)
      }
      setStatus('ready')
    }
    confirm.onCancel = () => { done(); tui.setFocus(pickerState?.sel) }
    tui.showOverlay(confirm)
    tui.setFocus(confirm)
  }

  function restoreMessage(m) {
    if (m.kind === 'image') addImageMessage(m.base64, m.mimeType, { name: m.name, fromTool: m.fromTool })
    else addMessage(m.kind, m.text, { summary: m.summary })
  }
  function switchToPick(list, n) {
    const pick = buildSessionTree(list)[n - 1]?.node
    if (!pick) { addMessage('sys', 'no session #' + n); return }
    setStatus('… switching to ' + pick.title + '…')
    runtimeRef.switchSession(pick.id).then(async (r) => {
      if (r.already) { addMessage('sys', 'already on this session'); setStatus('ready'); return }
      cancelAsst()
      cancelReasoning()
      renderedImages.clear()
      messages.length = 0
      currentAsst = null
      asstText = ''
      reasoningMsg = null
      reasoningText = ''
      reasoningOpen = false
      rebuild() // unmount the old session's view before restoring the new one
      for (const m of await runtimeRef.conversationHistory(r.agent)) restoreMessage(m)
      addMessage('sys', 'switched to: ' + pick.title)
      setStatus('ready')
    }).catch((e) => {
      addMessage('error', `switch: ${e.message}`)
      setStatus('ready')
    })
  }

  function deletePick(list, n) {
    const pick = buildSessionTree(list)[n - 1]?.node
    if (!pick) { addMessage('sys', 'no session #' + n); return }
    if (pick.current) { addMessage('sys', "can't delete the current session"); return }
    setStatus('… deleting…')
    runtimeRef.deleteSession(pick.id).then(() => {
      addMessage('sys', 'deleted session: ' + pick.title)
      setStatus('ready')
    }).catch((e) => {
      addMessage('sys', '! delete failed: ' + e.message)
      setStatus('ready')
    })
  }

  function runCommand(text) {
    // split on the first space only so multi-word args survive (e.g. 'delete 2')
    const sp = text.indexOf(' ')
    const cmd = sp === -1 ? text : text.slice(0, sp)
    const arg = sp === -1 ? '' : text.slice(sp + 1).trim()
    switch (cmd) {
      case '/help': addMessage('help', buildHelp()); return true
      case '/clear': clearView(); return true
      case '/theme': {
        const t = THEMES[arg]
        if (t) { theme = t; rebuild(); addMessage('sys', `theme: ${t.name}`) }
        else if (arg) addMessage('sys', `unknown theme '${arg}' — ${Object.keys(THEMES).join(', ')}`)
        else {
          // interactive picker, same pattern as /sessions
          const dim = (s) => `\x1b[90m${s}\x1b[0m`
          const sel = new SelectList(
            Object.entries(THEMES).map(([name, th]) => ({
              label: name + (name === theme.name ? ' (current)' : ''),
              value: name,
              description: th.description || '',
            })),
            10,
            {
              selectedPrefix: (s) => `\x1b[36m❯ ${s}\x1b[0m`,
              selectedText: (s) => `\x1b[1m${s}\x1b[0m`,
              description: dim,
              scrollInfo: dim,
              noMatch: dim,
            },
          )
          sel.onSelect = (item) => {
            tui.hideOverlay()
            tui.setFocus(editor)
            submit('/theme ' + item.value)
          }
          sel.onCancel = () => {
            tui.hideOverlay()
            tui.setFocus(editor)
          }
          tui.showOverlay(sel)
          tui.setFocus(sel)
        }
        return true
      }
      case '/tools':
        if (arg === 'off') toolsMode = 'off'
        else if (arg === 'on') toolsMode = 'on'
        else if (arg === 'full') toolsMode = 'full'
        else toolsMode = toolsMode === 'off' ? 'on' : toolsMode === 'on' ? 'full' : 'off' // bare /tools cycles
        rebuild(); addMessage('sys', `tool details: ${TOOLS_MODE_LABEL[toolsMode]}`)
        flashStatus(`tool output: ${TOOLS_MODE_LABEL[toolsMode]}`)
        return true
      case '/sessions': {
        const del = String(arg || '').match(/^delete\s+(\d+)$/i)
        const n = Number(arg)
        if (del) {
          runtimeRef.listSessions?.().then((list) => deletePick(list, Number(del[1])))
        } else if (n && Number.isInteger(n) && n >= 1) {
          runtimeRef.listSessions?.().then((list) => switchToPick(list, n))
        } else {
          openSessionPicker()
        }
        return true
      }
      case '/fork': {
        if (busy) { addMessage('sys', 'wait for the current turn to finish before forking'); return true }
        setStatus('… forking…')
        runtimeRef.forkSession?.().then(async (r) => {
          cancelAsst()
          cancelReasoning()
          renderedImages.clear()
          messages.length = 0
          currentAsst = null
          asstText = ''
          reasoningMsg = null
          reasoningText = ''
          reasoningOpen = false
          rebuild() // unmount the parent session's view before restoring the child's
          for (const m of await runtimeRef.conversationHistory(r.agent)) restoreMessage(m)
          addMessage('sys', `forked — child session, shared ${r.seedLength} events`)
          setStatus('ready')
        }).catch((e) => {
          addMessage('error', `fork: ${e.message}`)
          setStatus('ready')
        })
        return true
      }
      case '/new':
        cancelAsst(); renderedImages.clear()
        setStatus('… new session…')
        runtimeRef.newSession?.().then(() => setStatus('ready')).catch((e) => {
          addMessage('error', `new session: ${e.message}`)
          setStatus('ready')
        })
        return true
      case '/stop':
        interruptTurn()
        return true
      case '/quit':
      case 'exit':
        shutdown(); return true
      default:
        addMessage('sys', `unknown command '${cmd}' — /help`); return true
    }
  }

  function submit(text) {
    const t = text.trim()
    if (!t) return
    if (t.startsWith('/') || t === 'exit') { if (runCommand(t)) return }
    if (!runtimeRef.ready) {
      queue.push(t)
      addMessage('sys', '… runtime still starting, prompt queued')
      return
    }
    addMessage('user', t)
    try {
      runtimeRef.prompt(t)
    } catch (e) {
      addMessage('error', `prompt: ${e.message}`)
    }
  }

  editor.onSubmit = (text) => {
    // feed the editor's built-in prompt history (↑/↓ browsable, pi-style)
    editor.addToHistory(text)
    submit(text)
    tui.requestRender()
  }

  // app-level shortcuts: listeners run before the focused editor, so a match
  // consumes the key (e.g. Ctrl+K clears instead of kill-to-line-end).
  tui.addInputListener((data) => {
    const kb = getKeybindings()
    if (kb.matches(data, 'app.session.new')) { runCommand('/new'); return { consume: true } }
    if (kb.matches(data, 'app.reasoning.toggle')) { toggleReasoning(); return { consume: true } }
    if (kb.matches(data, 'app.tools.expand')) { toggleToolsExpand(); return { consume: true } }
    if (kb.matches(data, 'app.clear')) { clearView(); return { consume: true } }
    if (kb.matches(data, 'app.quit')) { shutdown(); return { consume: true } }
    // Escape interrupts the running turn; while idle, or when a picker or the
    // editor autocomplete is up, Escape keeps its normal role (close/cancel).
    if (kb.matches(data, 'app.interrupt') && busy && !tui.hasOverlay() && !editor.isShowingAutocomplete()) {
      interruptTurn()
      return { consume: true }
    }
    // session picker: d/x deletes the selected session (confirmation follows)
    if (pickerState && !confirmingDelete && (data === 'd' || data === 'x')) {
      const item = pickerState.sel.getSelectedItem()
      if (item) {
        const entry = pickerState.flat.find((f) => f.node.id === item.value)
        if (entry) confirmDeleteSession(entry.node)
      }
      return { consume: true }
    }
  })

  let shutting = false
  const shutdown = () => {
    if (shutting) return
    shutting = true
    tui.stop()
    runtimeRef.dispose?.()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return {
    tui,
    renderEvent,
    setStarting() {
      addMessage('logo', LOGO)
      setStatus('… starting dsh-pi runtime…')
    },
    setReady() {
      runtimeRef.ready = true
      setStatus('ready — type a prompt')
      for (const q of queue.splice(0)) submit(q)
    },
    refreshStatus,
    setModelInfo,
    onSessionSwitched() {
      // the agent changed — the old turn's busy state is stale; settle on ready
      cancelAsst()
      cancelReasoning()
      reasoningOpen = false
      reasoningMsg = null
      reasoningText = ''
      setStatus('ready')
    },
    fail(message) {
      addMessage('error', `startup: ${message}`)
    },
  }
}

// ---- main ----------------------------------------------------------------------

async function main() {
  const { provider, model } = defaultModel()

  async function buildRuntime() {
    const ctx = await bootRuntime()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    if (!agents || !defaultModel) throw new Error('runtime missing agents/defaultModel')

    const selection = defaultModel.currentSelection()
    let agent = null
    // Owned AgentHandle for the live agent. Replacing it disposes the previous
    // handle — dispose() stops the old loop and removes its session from the
    // live store (the persisted log stays on disk) — so at most the current
    // session is ever live and deleting persisted sessions is safe.
    let handle = null

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
    }

    const created = await createAgent()
    handle = created
    agent = created.agent
    await agent.whenIdle()

    const sessionId = agent.session.id
    return {
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
      prompt(text) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      },
      interrupt() {
        // user-initiated abort of the active turn; the 'user' cause flows into
        // the turn/end reason ({ kind: 'aborted', reason: { kind: 'user' } })
        // so renderEvent can surface "⏹ turn interrupted". cancel is a no-op
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
      newSession() {
        return createAgent().then((c) => {
          adoptHandle(c)
          return agent.whenIdle()
        }).then(() => {
          runtimeRef.sessionId = agent.session.id
          runtimeRef.sessionSwitched?.()
        })
      },
      async forkSession() {
        // seed = balanced completed-turn prefix of the current log; the child
        // keeps parentSession lineage so /sessions renders a real tree
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
        runtimeRef.sessionId = agent.session.id
        runtimeRef.sessionSwitched?.()
        return { agent, seedLength: seed.length }
      },
      async listSessions() {
        // sessionQuery corpus is live-preferred and newest-first; filter to the
        // sessions this TUI created (same cwd) and fold their latest titles.
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
            resumeSessionId: SessionId(sessionId),
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
        runtimeRef.sessionId = agent.session.id
        runtimeRef.sessionSwitched?.()
        return { agent }
      },
      async conversationHistory(agentObj) {
        const msgs = []
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
            // reasoning precedes the answer in stream order — restore it first
            for (const b of reasoningBlocks(content)) msgs.push({ kind: 'reasoning', text: b.text })
            const txt = contentText(content)
            if (txt) msgs.push({ kind: 'asst', text: txt })
            for (const b of collectImageBlocks(content)) msgs.push(await imageOf(b, false))
          } else if (e.type === 'tool/call') {
            // restore the full call (same shape as live render) so /tools full
            // still works after a session switch / fork
            names.set(e.data?.callId, e.data?.name)
            const info = toolCallInfo(e.data || {})
            msgs.push({ kind: 'tool', text: info.text, summary: info.summary })
          } else if (e.type === 'tool/result') {
            const r = toolResultMessage(e.data || {}, names)
            if (r) msgs.push({ kind: r.kind, text: r.text, summary: r.summary })
            for (const b of collectImageBlocks(e.data.message?.content || [])) msgs.push(await imageOf(b, true))
          }
        }
        return msgs
      },
      dispose() {
        retireHandle()
        try { ctx.fiber?.dispose?.() } catch { /* best effort */ }
      },
    }
  }

  // UI first: instant; boot the runtime in the background
  const runtimeRef = { ready: false, sessionId: null, prompt: null, interrupt: null, newSession: null, listSessions: null, switchSession: null, deleteSession: null, forkSession: null, currentTitle: null, conversationHistory: null, readImage: null, dispose: null, onEvent: null, refreshStatus: null, sessionSwitched: null }
  const ui = setupUi(runtimeRef, { provider, model })
  runtimeRef.refreshStatus = () => ui.refreshStatus()
  // a switched agent invalidates the old turn's busy state — settle on ready
  runtimeRef.sessionSwitched = () => ui.onSessionSwitched()
  ui.setStarting()
  ;(async () => {
    try {
      ensureProfile()
      const runtime = await buildRuntime()
      runtimeRef.prompt = runtime.prompt
      runtimeRef.interrupt = runtime.interrupt
      runtimeRef.newSession = runtime.newSession
      runtimeRef.listSessions = runtime.listSessions
      runtimeRef.switchSession = runtime.switchSession
      runtimeRef.deleteSession = runtime.deleteSession
      runtimeRef.forkSession = runtime.forkSession
      runtimeRef.currentTitle = runtime.currentTitle
      runtimeRef.conversationHistory = runtime.conversationHistory
      runtimeRef.readImage = runtime.readImage
      runtimeRef.dispose = runtime.dispose
      runtimeRef.sessionId = runtime.sessionId
      runtime.onEvent((session, event) => ui.renderEvent(session, event))
      saveSessionId(runtime.sessionId)
      ui.setModelInfo(runtime.provider, runtime.model)
      ui.setReady()
    } catch (e) {
      ui.fail(e.message)
      ui.setReady()
    }
  })()
}

if (process.env.DSH_PI_TUI_TEST !== '1') {
  main().catch((e) => {
    console.error('[dsh-pi-tui] startup failed:', e.message)
    process.exit(1)
  })
}

// pure content-block helpers, exported for tests (DSH_PI_TUI_TEST=1 skips main)
export { collectImageBlocks, contentText, reasoningBlocks, reasoningSummary, toolCallInfo, toolResultMessage }
