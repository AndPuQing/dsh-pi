#!/usr/bin/env node
// @dsh-pi/web — the web surface for dsh-pi: one runtime, N surfaces.
//
// Mounts an HTTP+SSE surface on a @dsh-pi/runtime. The browser is a SECOND
// renderer of the same live session/event stream — no polling, no separate
// process, no ownership conflicts (the process that owns the runtime stays
// the session's single live writer; the browser just renders and forwards
// input). On connect the client gets a full history replay; afterwards live
// events are pushed as they happen; the page can send prompts, interrupt,
// switch sessions, rename and change the model.
//
// Two entry modes:
//   createWebSurface(runtime, opts)  — mount on an existing runtime
//                                      (used by `dsh-pi tui --serve` so the
//                                      terminal and the browser share one
//                                      live session)
//   bin (dsh-pi-web)                 — headless hub: boots its own runtime
//                                      and serves the web UI
//                                      (used by `dsh-pi serve`)
//
// Env: DSH_HOME (default ~/.dsh) — must match the TUI's so sessions are shared.
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import {
  createPiRuntime,
  normalizeSessionId,
  projectEvent,
  saveSessionId,
  scanSessionsOnDisk,
  tuiLastSessionId,
} from '@dsh-pi/runtime'

const MAX_BODY = 1 << 20 // 1 MiB body cap
const DEFAULT_PORT = 8123

// ---- tiny JSON helpers ---------------------------------------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) return resolve({})
      try { resolve(JSON.parse(raw)) } catch { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

// ---- the web surface -------------------------------------------------------------

// runtime contract (what @dsh-pi/runtime provides):
//   sessionId (getter) · currentEvents() · sessionMeta() · currentTitle()
//   onEvent(cb) · onSwitched(cb) · prompt(text) · interrupt()
//   listSessions() · switchSession(id) · newSession() · renameSession(title)
//   listModels() · setModel(provider, model) · provider · model
export function createWebSurface(runtime, { host = '127.0.0.1', port = DEFAULT_PORT, name = 'dsh-pi' } = {}) {
  const clients = new Set()
  let busy = false
  let title = runtime.currentTitle?.() ?? null
  const model = { provider: runtime.provider, model: runtime.model }

  function snapshot() {
    return {
      sessionId: runtime.sessionId,
      meta: runtime.sessionMeta?.(),
      title: title ?? runtime.currentTitle?.() ?? null,
      model: { ...model },
      busy,
    }
  }

  function broadcast(event, data) {
    for (const res of [...clients]) {
      if (res.destroyed) { clients.delete(res); continue }
      try { sseWrite(res, event, data) } catch { clients.delete(res) }
    }
  }

  function helloTo(res) {
    sseWrite(res, 'hello', { ...snapshot(), events: runtime.currentEvents?.() ?? [] })
  }
  function helloAll() {
    broadcast('hello', { ...snapshot(), events: runtime.currentEvents?.() ?? [] })
  }

  // live events: forward every session event; fold turn/title state into
  // lightweight `state` pushes so the page never needs to poll
  const offEvent = runtime.onEvent((session, e) => {
    switch (e.type) {
      case 'turn/start':
        if (!busy) { busy = true; broadcast('state', { busy: true }) }
        break
      case 'turn/end':
        if (busy) { busy = false; broadcast('state', { busy: false }) }
        break
      case 'session/title': {
        const t = e.data?.title
        if (t && t !== title) { title = t; broadcast('state', { title: t }) }
        break
      }
      default: break
    }
    broadcast('event', { events: [projectEvent(e)] })
  })
  // the current session changed (from this surface or the TUI) — every client
  // gets a full fresh replay instead of incremental cross-session events
  const offSwitched = runtime.onSwitched?.(() => {
    busy = false
    title = null
    helloAll()
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE)
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        json(res, snapshot())
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        runtime.listSessions().then((list) => json(res, { sessions: list })).catch((e) => json(res, { error: String(e?.message || e) }, 500))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/models') {
        runtime.listModels().then((list) => json(res, { models: list, current: model })).catch((e) => json(res, { error: String(e?.message || e) }, 500))
        return
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        res.write('retry: 1000\n\n')
        clients.add(res)
        helloTo(res)
        // periodic keep-alive pings also drop dead connections
        const hb = setInterval(() => {
          if (res.destroyed) { clearInterval(hb); clients.delete(res); return }
          sseWrite(res, 'ping', { t: Date.now() })
        }, 15000)
        res.on('close', () => { clearInterval(hb); clients.delete(res) })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/prompt') {
        readJson(req).then((b) => {
          const text = String(b?.text ?? '').trim()
          if (!text) throw new Error('empty prompt')
          runtime.prompt(text)
          json(res, { ok: true })
        }).catch((e) => json(res, { error: String(e?.message || e) }, 400))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/interrupt') {
        runtime.interrupt()
        json(res, { ok: true })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        readJson(req).then(async (b) => {
          const action = b?.action
          if (action === 'new') {
            await runtime.newSession()
            json(res, { ok: true, sessionId: runtime.sessionId })
          } else if (action === 'rename') {
            const t = await runtime.renameSession(String(b?.title ?? '').trim())
            json(res, { ok: true, title: t })
          } else if (b?.id) {
            await runtime.switchSession(normalizeSessionId(b.id))
            json(res, { ok: true, sessionId: runtime.sessionId })
          } else {
            throw new Error('need { id } or { action: "new" | "rename" }')
          }
        }).catch((e) => json(res, { error: String(e?.message || e) }, 400))
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/model') {
        readJson(req).then(async (b) => {
          const r = await runtime.setModel(b.provider, b.model)
          model.provider = r.provider
          model.model = r.model
          broadcast('state', { model: { ...model } })
          json(res, { ok: true })
        }).catch((e) => json(res, { error: String(e?.message || e) }, 400))
        return
      }
      json(res, { error: 'not found' }, 404)
    } catch (e) {
      try { json(res, { error: String(e?.message || e) }, 500) } catch { /* connection gone */ }
    }
  })

  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({
      server,
      url,
      port,
      close() {
        offEvent()
        offSwitched?.()
        server.close()
      },
    }))
  })
}

// ---- standalone headless mode (`dsh-pi serve`) -----------------------------------

const HELP = `dsh-pi-web — headless dsh-pi web hub (dsh-pi serve)

usage:
  dsh-pi-web [session-id] [--port 8123] [--host 127.0.0.1] [--new] [--help]

Boots the pi-embed runtime in this process and serves the web UI. The browser
is the only surface: it can chat, switch sessions, rename, interrupt — this
process owns the session (the single live writer). Without a session-id it
resumes the TUI's last session for this working directory, else the newest
one; with --new it starts a fresh session.

If the session is live in another process (e.g. a running TUI), attach a web
surface to it instead: dsh-pi tui --serve`

function parseArgs(argv) {
  const args = { sessionId: null, port: DEFAULT_PORT, host: '127.0.0.1', fresh: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') args.help = true
    else if (a === '--port') args.port = Number(argv[++i]) || DEFAULT_PORT
    else if (a === '--host') args.host = argv[++i]
    else if (a === '--new' || a === '-n') args.fresh = true
    else if (a.startsWith('--port=')) args.port = Number(a.slice(7)) || DEFAULT_PORT
    else if (a.startsWith('--host=')) args.host = a.slice(7)
    else if (!a.startsWith('--') && !args.sessionId) args.sessionId = a
  }
  return args
}

// Default target: explicit id → the TUI's last session for this cwd → the
// newest session on disk for this cwd → a fresh session.
function resolveInitialSession(args) {
  if (args.fresh) return null
  if (args.sessionId) return normalizeSessionId(args.sessionId)
  const last = tuiLastSessionId()
  if (last) return last
  return scanSessionsOnDisk(null)[0]?.id ?? null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(HELP); return }
  const runtime = await createPiRuntime({ initialSessionId: resolveInitialSession(args) })
  saveSessionId(runtime.sessionId)
  const web = await createWebSurface(runtime, { host: args.host, port: args.port, name: 'dsh-pi serve' })
  console.log(`\x1b[36mdsh-pi serve\x1b[0m — session \x1b[1m${runtime.sessionId}\x1b[0m (${runtime.provider}/${runtime.model})`)
  console.log(`  \x1b[90mopen\x1b[0m  ${web.url}`)
  console.log(`  \x1b[90mCtrl+C to stop\x1b[0m`)
  if (args.host !== '127.0.0.1' && args.host !== 'localhost') {
    console.log(`  \x1b[33m⚠ bound to ${args.host} — no auth; keep it on a trusted network\x1b[0m`)
  }
  const shutdown = () => {
    web.close()
    runtime.dispose()
    setTimeout(() => process.exit(0), 300).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

// headless hub entry — only when this file is executed directly (importing
// createWebSurface from the TUI must NOT boot a second runtime)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\x1b[31mdsh-pi serve\x1b[0m: ${e?.message || e}`)
    process.exit(1)
  })
}

// ---- browser page ----------------------------------------------------------------
// A single self-contained document (no external assets): subscribes to the
// /events SSE stream and renders the session the same way the TUI does —
// streaming assistant chunks, reasoning blocks, tool calls/results, compaction
// markers, titles. Plus the parts the old mirror lacked: a session list with
// switching/new, an input box (the browser can chat), interrupt, rename and a
// model picker — all against the same live runtime.

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-pi</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --border: #2d333b; --fg: #d7dce2;
    --dim: #8b949e; --accent: #58a6ff; --user: #79c0ff; --tool: #d2a8ff;
    --ok: #3fb950; --err: #f85149; --sys: #d29922; --reason: #8b949e;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; flex-direction: column; }
  header { flex: none; background: var(--panel); border-bottom: 1px solid var(--border);
    padding: 8px 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  header .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dim);
    flex: none; transition: background .2s; }
  header.live .dot { background: var(--ok); box-shadow: 0 0 6px var(--ok); animation: pulse 1.6s infinite; }
  header.busy .dot { background: var(--sys); box-shadow: 0 0 8px var(--sys); animation: pulse .8s infinite; }
  @keyframes pulse { 50% { opacity: .45; } }
  header .title { font-weight: 700; cursor: text; border-radius: 4px; padding: 1px 6px; }
  header .title:hover { background: var(--border); }
  header .title.editing { background: var(--border); outline: 1px solid var(--accent); }
  header .meta { color: var(--dim); font-size: 12px; }
  header .grow { flex: 1; }
  #model { background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; font: inherit; font-size: 12px; padding: 2px 6px; max-width: 260px; }
  #busy-chip { display: none; color: var(--sys); font-size: 12px; }
  #busy-chip.on { display: inline; }
  #interrupt { display: none; background: none; border: 1px solid var(--err); color: var(--err);
    border-radius: 6px; font: inherit; font-size: 12px; padding: 2px 10px; cursor: pointer; }
  #interrupt.on { display: inline; }
  #interrupt:hover { background: var(--err); color: #fff; }
  button.icon { background: none; border: 1px solid var(--border); color: var(--dim);
    border-radius: 6px; cursor: pointer; font-size: 13px; padding: 2px 8px; }
  button.icon:hover { color: var(--fg); border-color: var(--dim); }
  .layout { flex: 1; display: flex; min-height: 0; }
  aside { flex: none; width: 210px; background: var(--panel); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; overflow: hidden; }
  aside h3 { margin: 10px 12px 4px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--dim); }
  aside .new { margin: 6px 12px 8px; }
  #sessions { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 0 6px 10px; }
  #sessions li { padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 12.5px;
    color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #sessions li:hover { background: var(--border); }
  #sessions li.current { background: rgba(88,166,255,.12); color: var(--accent); }
  #sessions li .sub { color: var(--dim); font-size: 11px; }
  main { flex: 1; overflow-y: auto; padding: 14px 16px; min-width: 0; }
  .block { margin: 6px 0; padding: 8px 12px; border-radius: 8px;
    background: var(--panel); border: 1px solid var(--border); }
  .block .who { font-size: 11px; letter-spacing: .05em; text-transform: uppercase;
    color: var(--dim); margin-bottom: 2px; }
  .block.user { border-left: 3px solid var(--user); }
  .block.user .who { color: var(--user); }
  .block.assistant { border-left: 3px solid var(--accent); }
  .block.assistant .who { color: var(--accent); }
  .block.tool { border-left: 3px solid var(--tool); }
  .block.tool .who { color: var(--tool); }
  .block.result { border-left: 3px solid var(--ok); }
  .block.result .who { color: var(--ok); }
  .block.error { border-left: 3px solid var(--err); }
  .block.error .who { color: var(--err); }
  .block.sys { border-left: 3px solid var(--sys); }
  .block.sys .who { color: var(--sys); }
  .block .text { white-space: pre-wrap; word-break: break-word; }
  .reasoning { color: var(--reason); font-style: italic; }
  .reasoning summary { cursor: pointer; }
  details.tool { margin-top: 4px; }
  details.tool summary { cursor: pointer; color: var(--dim); }
  details.tool pre { background: #0b0e13; border: 1px solid var(--border);
    border-radius: 6px; padding: 8px; overflow-x: auto; margin: 6px 0 0; }
  .img-ph { color: var(--dim); }
  .empty { color: var(--dim); text-align: center; margin-top: 48px; }
  footer { flex: none; border-top: 1px solid var(--border); background: var(--panel);
    padding: 10px 14px; display: flex; gap: 10px; align-items: flex-end; }
  #input { flex: 1; background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 8px; font: inherit; padding: 8px 10px; resize: none; min-height: 44px; max-height: 180px; }
  #input:focus { outline: none; border-color: var(--accent); }
  #send { background: var(--accent); color: #fff; border: none; border-radius: 8px;
    font: inherit; font-weight: 600; padding: 8px 18px; cursor: pointer; flex: none; }
  #send:hover { filter: brightness(1.1); }
  #send:disabled { opacity: .5; cursor: default; }
  .hint { color: var(--dim); font-size: 11px; flex: none; padding-bottom: 6px; }
  @media (max-width: 720px) { aside { display: none; } }
</style>
</head>
<body>
<header id="hd">
  <span class="dot"></span>
  <span class="title" id="title" title="双击重命名">…</span>
  <span class="meta" id="meta"></span>
  <span class="grow"></span>
  <span id="busy-chip">⚙ 思考中…</span>
  <button id="interrupt">⏹ 停止</button>
  <select id="model" title="模型（下次回复生效）"></select>
</header>
<div class="layout">
  <aside>
    <h3>会话</h3>
    <button class="icon new" id="new-session">＋ 新建会话</button>
    <ul id="sessions"></ul>
  </aside>
  <main id="transcript"><div class="empty" id="empty">正在连接…</div></main>
</div>
<footer>
  <textarea id="input" rows="1" placeholder="发消息（Enter 发送，Shift+Enter 换行）"></textarea>
  <button id="send">发送</button>
  <span class="hint">同一会话，终端与浏览器实时同步</span>
</footer>
<script>
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (id) => document.getElementById(id);
  const hd = $('hd'), meta = $('meta'), titleEl = $('title'), transcript = $('transcript');
  const sessionsEl = $('sessions'), input = $('input'), send = $('send');
  const busyChip = $('busy-chip'), interrupt = $('interrupt'), modelSel = $('model');
  let sessionId = null, title = null, busy = false, model = { provider: '', model: '' };
  let createdAt = null;
  let lastSeq = -1, evCount = 0;
  let openAsst = null, openReason = null, asstChunksSeen = false;

  // ---- transcript rendering ----------------------------------------------------

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
  function nearBottom() { return transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 80; }
  function stick() { if (nearBottom()) transcript.scrollTop = transcript.scrollHeight; }
  function commitAsst() {
    if (openAsst) { const t = openAsst.text.trimEnd(); if (t) openAsst.block.querySelector('.text').textContent = t; openAsst = null; }
    if (openReason) { const t = openReason.text.trim(); openReason.block.querySelector('.rbody').textContent = t; openReason = null; }
  }
  function asstTextEl() {
    if (!openAsst) {
      const b = block('assistant', 'pi', '');
      b.appendChild(el('div', 'text', ''));
      openAsst = { block: b, text: '' };
    }
    return openAsst.block.querySelector('.text');
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
    walk(content); return out.join('\\n');
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
    // failure = d.error (dsh tool-error) | d.isError | nested isError block
    const isErr = Boolean(d.error || d.isError || d.message?.content?.[0]?.isError);
    const b = block(isErr ? 'error' : 'result', isErr ? '✗ tool' : '✓ tool', esc(text.slice(0, 300)));
    const det = el('details', 'tool');
    det.appendChild(el('summary', null, esc('完整输出')));
    det.appendChild(el('pre', null, esc(text)));
    b.appendChild(det); stick();
  }

  function handle(e) {
    if (e.seq > lastSeq) { lastSeq = e.seq; evCount++; }
    switch (e.type) {
      case 'user/message': commitAsst(); asstChunksSeen = false; block('user', '你', esc(textOf(e.data?.content))); stick(); break;
      case 'assistant/chunk': {
        const c = e.data?.chunk || {};
        if (c.type === 'block-start' && c.blockType === 'reasoning') {
          commitAsst();
          const rb = block('reasoning', 'thinking');
          const inner = el('details', null);
          inner.appendChild(el('summary', null, '展开思考…'));
          const body = el('div', 'rbody', '');
          inner.appendChild(body);
          rb.appendChild(inner);
          openReason = { block: rb, text: '' };
        } else if (c.type === 'text-delta') {
          asstChunksSeen = true;
          const t = asstTextEl(); // creates the block + .text child when needed
          openAsst.text += c.text || '';
          t.textContent = openAsst.text;
        } else if (c.type === 'reasoning-delta' && openReason) {
          openReason.text += c.text || '';
          openReason.block.querySelector('.rbody').textContent = openReason.text;
        } else if (c.type === 'block-end') {
          if (c.block?.type === 'reasoning' && openReason) {
            openReason.block.querySelector('.rbody').textContent = openReason.text.trim();
            openReason = null;
          } else if (c.block?.type === 'image') {
            block('assistant', 'pi', '<span class="img-ph">[image]</span>');
          }
        }
        break;
      }
      case 'assistant/message': {
        commitAsst();
        const t = textOf(e.data?.message?.content || []);
        if (t && !asstChunksSeen) block('assistant', 'pi', esc(t));
        asstChunksSeen = false;
        break;
      }
      case 'tool/call': commitAsst(); toolCall(e.data || {}); break;
      case 'tool/result': commitAsst(); toolResult(e.data || {}); break;
      case 'reasoning': block('reasoning', 'thinking', esc(String(e.data?.text ?? ''))); break;
      case 'session/title': { const t = e.data?.title; if (t) { title = t; renderHeader(); } break; }
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

  // ---- header / sidebar ----------------------------------------------------------

  function shortId(id) { return '#' + String(id || '').replace(/^session-/, '').slice(0, 8); }
  function renderHeader() {
    titleEl.textContent = title || shortId(sessionId);
    meta.textContent = (sessionId ? shortId(sessionId) : '') +
      (createdAt ? ' · ' + new Date(createdAt).toLocaleString() : '') +
      (model.provider ? ' · ' + model.provider + '/' + model.model : '') +
      ' · ' + evCount + ' 事件';
    hd.classList.toggle('live', !busy);
    hd.classList.toggle('busy', busy);
    busyChip.classList.toggle('on', busy);
    interrupt.classList.toggle('on', busy);
  }
  function renderSessions(list) {
    sessionsEl.innerHTML = '';
    for (const s of list || []) {
      const li = el('li', s.current ? 'current' : '');
      const t = s.title || shortId(s.id);
      li.textContent = t;
      const sub = el('span', 'sub', '');
      sub.textContent = ' ' + shortId(s.id) + (s.parent ? ' ↳' : '');
      li.appendChild(sub);
      li.addEventListener('click', () => { if (!s.current) switchSession(s.id); });
      sessionsEl.appendChild(li);
    }
  }
  function refreshSessions() {
    fetch('/api/sessions').then((r) => r.json()).then((d) => {
      if (d.sessions) renderSessions(d.sessions);
    }).catch(() => {});
  }

  // ---- actions -------------------------------------------------------------------

  function setBusy(b) { busy = b; renderHeader(); }
  function sendPrompt() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      .then((r) => r.json())
      .then((d) => { if (d.error) sysLine('⚠ 发送失败: ' + d.error); })
      .catch((e) => sysLine('⚠ 发送失败: ' + e));
  }
  function switchSession(id) {
    fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      .then((r) => r.json())
      .then((d) => { if (d.error) sysLine('⚠ 切换失败: ' + d.error); })
      .catch((e) => sysLine('⚠ 切换失败: ' + e));
  }
  function newSession() {
    fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'new' }) })
      .then((r) => r.json())
      .then((d) => { if (d.error) sysLine('⚠ 新建失败: ' + d.error); })
      .catch((e) => sysLine('⚠ 新建失败: ' + e));
  }
  function renameSession(t) {
    fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rename', title: t }) })
      .then((r) => r.json())
      .catch(() => {});
  }
  function loadModels() {
    fetch('/api/models').then((r) => r.json()).then((d) => {
      modelSel.innerHTML = '';
      for (const m of d.models || []) {
        const opt = document.createElement('option');
        opt.value = m.provider + '/' + m.model;
        opt.textContent = (m.providerName || m.provider) + ' / ' + m.name;
        if (m.provider === model.provider && m.model === model.model) opt.selected = true;
        modelSel.appendChild(opt);
      }
      if (d.models && !d.models.length) modelSel.style.display = 'none';
    }).catch(() => {});
  }

  // ---- SSE ------------------------------------------------------------------------
  // fetch-stream based SSE reader (EventSource is flaky in some sandboxed
  // Chromium builds; fetch + ReadableStream is universally supported and
  // gives us explicit reconnect control). Same wire protocol: 'hello'
  // (full replay + meta) · 'event' (live events) · 'state' (busy/title/model)
  // · 'ping' (keep-alive).

  function resetTranscript() {
    lastSeq = -1; evCount = 0; commitAsst(); openAsst = null; openReason = null;
    transcript.innerHTML = '';
    transcript.appendChild(el('div', 'empty', '没有消息 — 在下方输入开始对话'));
  }
  function parseSse(raw) {
    let event = 'message', data = '';
    for (const line of raw.split('\\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).replace(/^ /, '') + '\\n';
    }
    if (!data.trim()) return;
    let parsed;
    try { parsed = JSON.parse(data.trim()); } catch { return; }
    if (event === 'hello') onHello(parsed);
    else if (event === 'event') onEvents(parsed);
    else if (event === 'state') onState(parsed);
  }
  let sseTimer = null;
  function connect() {
    if (sseTimer) { clearTimeout(sseTimer); sseTimer = null; }
    fetch('/events').then((r) => {
      if (!r.ok || !r.body) throw new Error('status ' + r.status);
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) throw new Error('stream closed');
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\\n\\n')) !== -1) {
            parseSse(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
          }
          pump();
        }).catch(() => reconnect());
      };
      pump();
    }).catch(() => reconnect());
  }
  function reconnect() {
    hd.classList.add('busy');
    meta.textContent = '连接断开，重试中…';
    sseTimer = setTimeout(connect, 1500);
  }

  function onHello(d) {
    resetTranscript();
    sessionId = d.sessionId;
    title = d.title;
    model = d.model || model;
    createdAt = d.meta?.createdAt ?? null;
    for (const ev of d.events) handle(ev);
    const empty = transcript.querySelector('.empty');
    if (evCount === 0 && empty) empty.textContent = '没有消息 — 在下方输入开始对话';
    setBusy(!!d.busy);
    renderHeader();
    refreshSessions();
    loadModels();
    stick();
  }
  function onEvents(d) {
    for (const ev of d.events) handle(ev);
    stick();
  }
  function onState(d) {
    if (typeof d.busy === 'boolean') setBusy(d.busy);
    if (d.title) { title = d.title; renderHeader(); }
    if (d.model) { model = d.model; renderHeader(); }
  }
  connect();

  // ---- input ----------------------------------------------------------------------

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
  });
  send.addEventListener('click', sendPrompt);
  interrupt.addEventListener('click', () => {
    fetch('/api/interrupt', { method: 'POST' }).catch(() => {});
  });
  $('new-session').addEventListener('click', newSession);

  // click-to-rename the title (commit on Enter/blur, Escape cancels)
  titleEl.addEventListener('dblclick', () => {
    if (titleEl.classList.contains('editing')) return;
    const old = titleEl.textContent;
    titleEl.classList.add('editing');
    titleEl.contentEditable = 'true';
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('editing');
      const t = titleEl.textContent.trim();
      if (t && t !== old) renameSession(t);
      else titleEl.textContent = old;
    };
    const cancel = () => {
      if (done) return; done = true;
      titleEl.contentEditable = 'false';
      titleEl.classList.remove('editing');
      titleEl.textContent = old;
    };
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    }, { once: true });
    titleEl.addEventListener('blur', commit, { once: true });
  });
  modelSel.addEventListener('change', () => {
    const [provider, modelId] = modelSel.value.split('/');
    fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, model: modelId }) })
      .catch(() => {});
  });
})();
</script>
</body>
</html>`
