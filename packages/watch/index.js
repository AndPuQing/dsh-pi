#!/usr/bin/env node
// @dsh-pi/watch — TUI→Web real-time session mirror (Route A: tail the shared log).
//
// Boots the same in-process dsh runtime as the TUI (the `pi-embed` profile),
// then serves a small self-contained web page that streams a target session's
// events in near-real-time over SSE. The TUI (or any dsh surface) stays the
// single live writer; this process only READS the durable log through the
// persistence seam — `listSnapshots()` (cheap revision tokens) plus
// `readFrom(id, fromSeq)` (incremental tail) — so it never contends for
// session ownership and works even after the TUI process exits (full replay).
//
// Usage:
//   dsh-pi-watch [session-id] [--port 8123] [--poll 500] [--host 127.0.0.1]
//   dsh-pi-watch                      # latest session for this cwd (TUI's last session)
//   dsh-pi-watch <uuid>               # explicit session (bare uuid or session-<uuid>)
//
// Env: DSH_HOME (default ~/.dsh) — must match the TUI's so the logs are shared.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import {
  boot,
  healProfilesModuleFallback,
  loadOptionalPatches,
  loadProfile,
} from '@deepseek-ai/dsh-app-boot'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROF = 'pi-embed'
const profDir = path.join(home, 'profiles', PROF)
const REGISTRY = 'https://registry.npmjs.org'
const STATE_DIR = path.join(home, 'dsh-pi-tui')
const ANCHOR = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const PROFILE_ROOT_CONFIG = '# dsh profile root — empty entry list; tree composed as patches.\n[]\n'
const PAGE = htmlPage()

// ---- arg parsing -------------------------------------------------------------

function parseArgs(argv) {
  const args = { port: 8123, poll: 500, host: '127.0.0.1', sessionId: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--poll') args.poll = Number(argv[++i])
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--help' || a === '-h') args.help = true
    else if (a.startsWith('-')) throw new Error(`unknown flag '${a}'`)
    else if (!args.sessionId) args.sessionId = a
    else throw new Error(`unexpected argument '${a}'`)
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('--port must be 1..65535')
  if (!Number.isInteger(args.poll) || args.poll < 100 || args.poll > 60000) throw new Error('--poll must be 100..60000 ms')
  return args
}

const HELP = `dsh-pi-watch — TUI→Web real-time session mirror

usage:
  dsh-pi-watch [session-id] [--port 8123] [--poll 500] [--host 127.0.0.1]
  dsh-pi-watch --help

Serves a self-contained web page that streams a dsh-pi TUI session's events
in near-real-time (log tailing: listSnapshots + readFrom — no ownership of
the session is taken, the TUI keeps writing). Without a session-id, watches
the TUI's last session for the current working directory; otherwise the most
recent session in this DSH_HOME. DSH_HOME must match the TUI's.`

// ---- profile + in-process boot (same pattern as @dsh-pi/tui) -----------------

const isBun = typeof Bun !== 'undefined' || !!process.versions?.bun
const pkgRunner = isBun ? ['bunx', '--yes', 'pnpm'] : ['npx', '--yes', 'pnpm']

function ensureProfile() {
  if (fs.existsSync(profDir)) return
  console.error(`[dsh-pi-watch] creating profile ${PROF}...`)
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
  fs.writeFileSync(path.join(profDir, 'cordis.patch.yml'), '# dsh-pi watch: no hot-reload.\n- id: hmr\n  disabled: true\n')
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

// ---- session resolution --------------------------------------------------------

function normalizeSessionId(id) {
  const s = String(id).trim()
  return /^session-/.test(s) ? s : `session-${s}`
}

// The TUI remembers its last session per working directory; reuse that when no
// explicit id was given (same cwd → the session the TUI was just using).
function tuiLastSessionId() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const slug = process.cwd().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'root'
  try {
    const v = fs.readFileSync(path.join(STATE_DIR, `session-${slug}.id`), 'utf8').trim()
    if (v) return v
  } catch { /* first run */ }
  return null
}

async function snapshotMap(ctx) {
  const snaps = await ctx.sessionPersistence.listSnapshots()
  const m = new Map()
  for (const s of snaps) m.set(s.header.id, s)
  return m
}

async function resolveSession(ctx, arg) {
  const snaps = await snapshotMap(ctx)
  if (arg) {
    const id = normalizeSessionId(arg)
    if (snaps.has(id)) return { id, snap: snaps.get(id) }
    const ids = [...snaps.keys()]
    throw new Error(
      `session '${id}' not found in ${home}/sessions. Available (${ids.length}): ` +
      (ids.slice(0, 12).join(', ') || 'none') + (ids.length > 12 ? ', …' : ''),
    )
  }
  const tuiLast = tuiLastSessionId()
  if (tuiLast && snaps.has(tuiLast)) return { id: tuiLast, snap: snaps.get(tuiLast) }
  const fallback = [...snaps.values()].sort((a, b) => b.header.createdAt - a.header.createdAt)[0]
  if (fallback) return { id: fallback.header.id, snap: fallback }
  throw new Error('no sessions found in this DSH_HOME — start a TUI/web session first, or pass a session id')
}

// ---- event helpers -------------------------------------------------------------

function projectEvent(e) {
  return { seq: e.seq, type: e.type, time: e.time, data: e.data }
}

function lastSeq(events) {
  let n = -1
  for (const e of events) if (Number.isInteger(e.seq) && e.seq > n) n = e.seq
  return n
}

// ---- tail engine ---------------------------------------------------------------

// Reads the durable log like a follower: initial full view via `inspect`, then
// incremental appends via `listSnapshots` revision + `readFrom(fromSeq)`.
// Never resumes the session, so it never collides with the TUI's ownership.
function createTailer(ctx, id, pollMs) {
  const state = {
    id,
    revision: null,      // last seen durable revision (opaque token)
    lastSeq: 0,          // last broadcast event seq (client dedupes overlaps)
    writerActiveAt: Date.now(), // last time the log changed (live detection)
    timer: null,
    polling: false,
    closed: false,
    pollMs,
    hello: null,         // cached initial snapshot, replayed per connection
  }
  let emit = () => {}

  async function refresh() {
    if (state.closed || state.polling) return
    state.polling = true
    try {
      const snaps = await snapshotMap(ctx)
      const snap = snaps.get(state.id)
      if (!snap) {
        emit('state', { kind: 'gone', sessionId: state.id, pollMs })
        return
      }
      if (snap.revision === state.revision) return // unchanged — cheap path
      const r = await ctx.sessionPersistence.readFrom(state.id, state.lastSeq)
      const fresh = r.events.filter((e) => e.seq > state.lastSeq)
      if (fresh.length) {
        state.lastSeq = lastSeq(r.events)
        state.writerActiveAt = Date.now()
        emit('events', { sessionId: state.id, events: fresh.map(projectEvent) })
      }
      state.revision = snap.revision
    } catch (e) {
      emit('state', { kind: 'error', sessionId: state.id, error: String(e?.message || e) })
    } finally {
      state.polling = false
    }
  }

  return {
    state,
    setEmit(fn) { emit = fn },
    async start() {
      // Initial view: inspect handles torn tails / interrupted turns and gives
      // the balanced logical log; its last seq anchors the incremental tail.
      const { meta, events } = await ctx.sessionPersistence.inspect(state.id)
      state.lastSeq = lastSeq(events)
      state.revision = (await snapshotMap(ctx)).get(state.id)?.revision ?? null
      state.hello = {
        sessionId: state.id,
        meta: { id: meta.id, createdAt: meta.createdAt, cwd: meta.cwd, version: meta.version },
        events: events.map(projectEvent),
        pollMs,
      }
      emit('hello', state.hello)
      state.timer = setInterval(refresh, pollMs)
      state.timer.unref?.()
    },
    async poll() { await refresh() },
    close() {
      state.closed = true
      if (state.timer) clearInterval(state.timer)
      try { ctx.fiber?.dispose?.() } catch { /* best effort */ }
    },
  }
}

// ---- HTTP + SSE ----------------------------------------------------------------

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function startServer(host, port, tailer) {
  const clients = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    if (url.pathname === '/api/session') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ sessionId: tailer.state.id, pollMs: tailer.state.pollMs }))
      return
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write('retry: 1000\n\n')
      clients.add(res)
      // replay the cached initial snapshot so a late connection still gets the
      // full history (the boot-time hello broadcast is not retained by SSE)
      if (tailer.state.hello) sseWrite(res, 'hello', tailer.state.hello)
      const hb = setInterval(() => {
        if (res.destroyed) { clearInterval(hb); clients.delete(res); return }
        const idle = Date.now() - tailer.state.writerActiveAt > 5000
        sseWrite(res, 'state', { kind: idle ? 'idle' : 'live', sessionId: tailer.state.id, pollMs: tailer.state.pollMs })
      }, 5000)
      res.on('close', () => { clearInterval(hb); clients.delete(res) })
      tailer.poll().catch(() => {})
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })

  // broadcast to every connected browser
  const emit = (event, data) => {
    for (const res of [...clients]) {
      if (res.destroyed) { clients.delete(res); continue }
      try { sseWrite(res, event, data) } catch { clients.delete(res) }
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({ server, emit }))
  })
}

// ---- entry ----------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }

  ensureProfile()
  const ctx = await bootRuntime()
  const { id, snap } = await resolveSession(ctx, args.sessionId)

  const tailer = createTailer(ctx, id, args.poll)
  const { server, emit } = await startServer(args.host, args.port, tailer)
  tailer.setEmit(emit)

  console.log(`\x1b[36mdsh-pi watch\x1b[0m — session \x1b[1m${id}\x1b[0m (created ${snap.header.createdAt ? new Date(snap.header.createdAt).toISOString() : '?'})`)
  console.log(`  \x1b[90mopen\x1b[0m  http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}/`)
  console.log(`  \x1b[90mpoll\x1b[0m  ${args.poll} ms — Ctrl+C to stop\x1b[0m`)

  const shutdown = () => {
    tailer.close()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await tailer.start()
}

main().catch((e) => {
  console.error(`\x1b[31mdsh-pi watch\x1b[0m: ${e?.message || e}`)
  process.exit(1)
})

// ---- browser page ----------------------------------------------------------------
// A single self-contained HTML document: no external assets. Subscribes to the
// /events SSE stream and assembles the transcript from session events the same
// way the TUI renders them (streaming assistant chunks, reasoning blocks, tool
// calls/results, compaction markers, session titles).

function htmlPage() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-pi watch</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #2d333b; --fg: #d7dce2;
    --dim: #8b949e; --accent: #58a6ff; --user: #79c0ff; --tool: #d2a8ff;
    --ok: #3fb950; --err: #f85149; --sys: #d29922; --reason: #8b949e;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  header { position: sticky; top: 0; z-index: 5; background: var(--panel);
    border-bottom: 1px solid var(--border); padding: 8px 16px;
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  header .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%;
    background: var(--dim); margin-right: 6px; vertical-align: 1px; }
  header.live .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
  header.idle .dot { background: var(--dim); }
  header.gone .dot { background: var(--err); }
  header .title { font-weight: 700; }
  header .meta { color: var(--dim); font-size: 12px; }
  main { max-width: 980px; margin: 0 auto; padding: 16px; }
  .block { margin: 6px 0; padding: 8px 12px; border-radius: 8px;
    background: var(--panel); border: 1px solid var(--border); }
  .block .who { font-size: 11px; letter-spacing: .05em; text-transform: uppercase;
    color: var(--dim); margin-bottom: 2px; }
  .block.user { border-left: 3px solid var(--user); }
  .block.user .who { color: var(--user); }
  .block.tool { border-left: 3px solid var(--tool); }
  .block.tool .who { color: var(--tool); }
  .block.result { border-left: 3px solid var(--ok); }
  .block.result .who { color: var(--ok); }
  .block.error { border-left: 3px solid var(--err); }
  .block.error .who { color: var(--err); }
  .block.sys { border-left: 3px solid var(--sys); }
  .block.sys .who { color: var(--sys); }
  .block.assistant .text { white-space: pre-wrap; }
  .block .text { white-space: pre-wrap; word-break: break-word; }
  .reasoning { color: var(--reason); font-style: italic; }
  .reasoning summary { cursor: pointer; color: var(--reason); }
  details.tool { margin-top: 4px; }
  details.tool summary { cursor: pointer; color: var(--dim); }
  details.tool pre { background: #0b0e13; border: 1px solid var(--border);
    border-radius: 6px; padding: 8px; overflow-x: auto; margin: 6px 0 0; }
  .img-ph { color: var(--dim); }
  .empty { color: var(--dim); text-align: center; margin-top: 40px; }
  #status-line { color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<header id="hd"><span class="dot"></span><span class="title">dsh-pi watch</span>
  <span class="meta" id="meta">connecting…</span><span class="meta" id="status-line"></span></header>
<main id="transcript"><div class="empty" id="empty">等待事件流…</div></main>
<script>
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hd = document.getElementById('hd');
  const meta = document.getElementById('meta');
  const status = document.getElementById('status-line');
  const transcript = document.getElementById('transcript');
  let lastSeq = -1; let evCount = 0; let title = null;
  let openAsst = null;   // {block, text}
  let openReason = null; // {block, text}
  let asstChunksSeen = false; // text-delta arrived since last message boundary

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function block(kind, who, bodyHtml) {
    const b = el('div', 'block ' + kind);
    if (who) b.appendChild(el('div', 'who', esc(who)));
    if (bodyHtml) b.appendChild(el('div', 'text', bodyHtml));
    transcript.appendChild(b);
    return b;
  }
  function sysLine(text) { block('sys', 'sys', esc(text)); }
  function stick() { const r = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 80; if (r) transcript.scrollTop = transcript.scrollHeight; }
  function commitAsst() {
    if (openAsst) { const t = openAsst.text.trimEnd(); if (t) openAsst.block.querySelector('.text').textContent = t; openAsst = null; }
    if (openReason) { const t = openReason.text.trim(); openReason.block.querySelector('.reasoning > div').textContent = t; openReason = null; }
  }
  function asstTextEl() {
    if (!openAsst) { const b = block('assistant', 'pi', ''); openAsst = { block: b, text: '' }; }
    return openAsst.block.querySelector('.text');
  }
  function updateMeta() {
    meta.textContent = (title ? '“' + title + '” · ' : '') + 'session ' + lastSeq + ' · ' + evCount + ' 事件';
  }
  function toolCall(d) {
    let args = d.arguments || '';
    try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
    const b = block('tool', '⚙ ' + esc(d.name || 'tool'), esc((d.summary ?? '').slice(0, 200)));
    const det = el('details', 'tool');
    det.appendChild(el('summary', null, esc('参数')));
    det.appendChild(el('pre', null, esc(args)));
    b.appendChild(det); stick();
  }
  function toolResult(d) {
    const text = textOf(d.message?.content ?? d.content ?? []);
    const isErr = d.isError;
    const b = block(isErr ? 'error' : 'result', isErr ? '✗ tool' : '✓ tool', esc(text.slice(0, 300)));
    const det = el('details', 'tool');
    det.appendChild(el('summary', null, esc('完整输出')));
    det.appendChild(el('pre', null, esc(text)));
    b.appendChild(det); stick();
  }
  function textOf(content) {
    const out = [];
    const walk = (blocks) => {
      for (const b of blocks || []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) out.push(b.text);
        else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content);
        else if (b.type === 'image') out.push('[image: ' + (b.name || b.url || '') + ']');
      }
    };
    walk(content); return out.join('\n');
  }

  function handle(e) {
    if (e.seq > lastSeq) { lastSeq = e.seq; evCount++; updateMeta(); }
    switch (e.type) {
      case 'user/message': commitAsst(); asstChunksSeen = false; block('user', '你', esc(textOf(e.data?.content))); stick(); break;
      case 'assistant/chunk': {
        const c = e.data?.chunk || {};
        if (c.type === 'block-start') {
          if (c.blockType === 'reasoning') {
            commitAsst(); // close any dangling text block first
            const rb = block('reasoning', 'thinking');
            const inner = el('details', null);
            const sum = el('summary', null, '展开思考…');
            const body = el('div', null, '');
            inner.appendChild(sum); inner.appendChild(body);
            rb.appendChild(inner);
            openReason = { block: rb, text: '' };
          }
        } else if (c.type === 'text-delta') {
          asstChunksSeen = true;
          if (!openAsst) { const b = block('assistant', 'pi', ''); openAsst = { block: b, text: '' }; }
          openAsst.text += c.text || '';
          asstTextEl().textContent = openAsst.text; // live-update while streaming
        } else if (c.type === 'reasoning-delta' && openReason) {
          openReason.text += c.text || '';
          openReason.block.querySelector('.reasoning > div').textContent = openReason.text;
        } else if (c.type === 'block-end') {
          if (c.block?.type === 'reasoning' && openReason) {
            openReason.block.querySelector('.reasoning > div').textContent = openReason.text.trim();
            openReason = null;
          } else if (c.block?.type === 'image') {
            block('assistant', 'pi', '<span class="img-ph">[image]</span>');
          }
        }
        break;
      }
      case 'assistant/message': {
        commitAsst();
        const content = e.data?.message?.content || [];
        // chunk stream already painted the text — only render the assembled
        // message when no chunks were seen (compacted/pruned sessions)
        const t = textOf(content);
        if (t && !asstChunksSeen) block('assistant', 'pi', esc(t));
        asstChunksSeen = false;
        break;
      }
      case 'tool/call': commitAsst(); toolCall(e.data || {}); break;
      case 'tool/result': commitAsst(); toolResult(e.data || {}); break;
      case 'reasoning': block('reasoning', 'thinking', esc(String(e.data?.text ?? ''))); break;
      case 'session/title': { const t = e.data?.title; if (t) { title = t; updateMeta(); } break; }
      case 'compaction/end':
        sysLine(e.data?.error ? '♻ compaction failed: ' + e.data.error : '♻ 已压缩历史（' + (e.data?.shadowedSeqCount ?? '') + '）');
        break;
      case 'turn/end': {
        const r = e.data?.reason;
        if (r?.kind === 'aborted') sysLine('⏹ 回合中断');
        else if (r?.kind === 'error') sysLine('⏹ 回合错误: ' + (r?.error?.message ?? ''));
        break;
      }
      default: break;
    }
  }

  const es = new EventSource('/events');
  es.addEventListener('hello', (m) => {
    const d = JSON.parse(m.data);
    lastSeq = -1; transcript.innerHTML = ''; evCount = 0;
    if (d.meta) { hd.classList.add('live'); meta.textContent = 'session ' + d.sessionId + (d.meta.createdAt ? ' · created ' + new Date(d.meta.createdAt).toLocaleString() : ''); }
    for (const ev of d.events) handle(ev);
    status.textContent = '轮询 ' + d.pollMs + ' ms · 实时';
  });
  es.addEventListener('events', (m) => {
    const d = JSON.parse(m.data);
    for (const ev of d.events) handle(ev);
    stick();
  });
  es.addEventListener('state', (m) => {
    const d = JSON.parse(m.data);
    if (d.kind === 'live') { hd.classList.add('live'); hd.classList.remove('idle', 'gone'); status.textContent = '● 实时（TUI 正在写入）'; }
    else if (d.kind === 'idle') { hd.classList.add('idle'); hd.classList.remove('live', 'gone'); status.textContent = '○ 静止（等待 TUI 写入）'; }
    else if (d.kind === 'gone') { hd.classList.add('gone'); hd.classList.remove('live', 'idle'); status.textContent = '✕ 会话日志不存在'; }
    else if (d.kind === 'error') status.textContent = '⚠ ' + d.error;
  });
  es.onerror = () => { hd.classList.add('gone'); hd.classList.remove('live', 'idle'); status.textContent = '连接断开，重试中…'; };
  const idleTimer = setInterval(() => { if (lastSeq >= 0) updateMeta(); }, 1000);
})();
</script>
</body>
</html>`
}
