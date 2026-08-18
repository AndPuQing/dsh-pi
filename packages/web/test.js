#!/usr/bin/env node
// @dsh-pi/web — renderer tests (run: node test.js)
//
// Executes the REAL inline page script (the exact bytes the server serves)
// against a minimal DOM/fetch stub, then feeds it a synthetic session-event
// stream covering every event shape the page renders. Verifies the transcript
// DOM gets the right blocks for the right events — the same logic a browser
// runs, minus the browser.
//
// Also accepts a real hello payload on stdin (node test.js < hello.json) to
// smoke-render an actual session.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')

// --- the exact page the server serves -----------------------------------------
const pageStart = src.indexOf('const PAGE = `')
const pageTmpl = src.slice(pageStart + 'const PAGE = `'.length, src.lastIndexOf('`'))
// template-literal escapes: \\ -> \, \` -> `, \$ -> $ (page has no ${})
const page = pageTmpl
  .replace(/\\\\/g, '\\')
  .replace(/\\`/g, '`')
  .replace(/\\\$/g, '$')
const script = page.match(/<script>([\s\S]*)<\/script>/)[1]

// --- minimal DOM stub -----------------------------------------------------------

function makeEl(tag, id) {
  const el = {
    tagName: tag.toUpperCase(),
    id: id || null,
    children: [],
    _className: '',
    _text: '',
    _html: '',
    _style: {},
    listeners: {},
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x) },
      remove(...c) { for (const x of c) this._set.delete(x) },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c) } else { on ? this._set.add(c) : this._set.delete(c) } },
      contains(c) { return this._set.has(c) },
    },
    appendChild(child) { child.parent = el; el.children.push(child); return child },
    addEventListener(ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn) },
    querySelector(sel) {
      // supports '.cls', 'tag', 'tag.cls', '.cls > tag' — enough for the page
      const want = sel.startsWith('.') ? sel.slice(1) : null
      const tagCls = !want && sel.includes('.') ? sel.split('.')[1] : null
      const wantTag = !want && !tagCls ? sel.trim().toUpperCase() : null
      const matches = (c) => {
        if (want) return c._className.split(/\s+/).includes(want)
        if (tagCls) return c._className.split(/\s+/).includes(tagCls)
        return c.tagName === wantTag
      }
      const walk = (node, deep) => {
        for (const c of node.children) {
          if (matches(c)) return c
          if (deep) { const hit = walk(c, true); if (hit) return hit }
        }
        return null
      }
      if (sel.includes('>')) {
        const [left, right] = sel.split('>').map((s) => s.trim())
        const lCls = left.startsWith('.') ? left.slice(1) : null
        const rCls = right.startsWith('.') ? right.slice(1) : (right.includes('.') ? right.split('.')[1] : null)
        const rTag = !rCls ? right.toUpperCase() : null
        if (lCls && !el._className.split(/\s+/).includes(lCls)) return null
        for (const c of el.children) {
          if (rCls ? c._className.split(/\s+/).includes(rCls) : c.tagName === rTag) return c
        }
        return null
      }
      return walk(el, true)
    },
    set innerHTML(v) { this._html = v; this.children = [] },
    get innerHTML() { return this._html },
    set textContent(v) { this._text = String(v) },
    get textContent() { return this._text !== '' ? this._text : this._html.replace(/<[^>]*>/g, '') },
    set className(v) { this._className = String(v) },
    get className() { return this._className },
    get style() { return this._style },
    set style(v) { this._style = v },
    get scrollTop() { return 0 },
    set scrollTop(v) {},
    get scrollHeight() { return 0 },
    get clientHeight() { return 1000 },
    focus() {},
    get contentEditable() { return 'false' },
    set contentEditable(v) {},
    setAttribute(k, v) { el[k] = v },
  }
  return el
}

const byId = {}
function el(id) {
  if (!byId[id]) byId[id] = makeEl('div', id)
  return byId[id]
}
const document = {
  getElementById: (id) => el(id),
  createElement: (tag) => makeEl(tag),
  createRange: () => ({ selectNodeContents() {} }),
  querySelectorAll: () => [],
}
const window = {
  getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  addEventListener() {},
}
const transcript = el('transcript')

// --- fetch stub: delivers the fixture as an SSE stream ----------------------------

function ssePayload(hello) {
  let out = 'retry: 1000\n\n'
  out += `event: hello\ndata: ${JSON.stringify(hello)}\n\n`
  return out
}

async function runPage(helloEvents, extraHello = {}) {
  const body = ssePayload({ sessionId: 'session-test', title: 't', meta: { createdAt: 1 }, model: { provider: 'p', model: 'm' }, busy: false, events: helloEvents, ...extraHello })
  const bytes = new TextEncoder().encode(body)
  let pos = 0
  const stream = {
    getReader() {
      return {
        read() {
          // like a real SSE connection: after the fixture, stay open (no EOF)
          if (pos >= bytes.length) return new Promise(() => {})
          const chunk = bytes.slice(pos, pos + 1024)
          pos += chunk.length
          return Promise.resolve({ done: false, value: chunk })
        },
      }
    },
  }
  const fetch = (url) => {
    if (String(url).startsWith('/events')) return Promise.resolve({ ok: true, status: 200, body: stream })
    if (String(url).startsWith('/api/sessions')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) })
    if (String(url).startsWith('/api/models')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ models: [] }) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }
  const sandbox = { document, window, fetch, console, setTimeout: () => 0, clearTimeout: () => {}, TextDecoder, TextEncoder, JSON, Date, Math, URL, EventSource: undefined }
  // test-only: surface otherwise-swallowed page errors
  const instrumented = script.replace(/\.catch\(\(\) => reconnect\(\)\)/g, '.catch((e) => { window.__err = String((e && e.stack) || e); reconnect(); })')
  vm.createContext(sandbox)
  vm.runInContext(instrumented, sandbox)
  // let the fetch → pump → parseSse → onHello microtask chain flush
  await new Promise((r) => setTimeout(r, 20))
  return { transcript, err: sandbox.window.__err }
}

// --- fixture: every event shape the page renders -----------------------------------

const FIXTURE = [
  { seq: 0, type: 'session/title', time: 1, data: { title: 'My session' } },
  { seq: 1, type: 'user/message', time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello world' }] } },
  { seq: 2, type: 'turn/start', time: 3, data: {} },
  { seq: 3, type: 'assistant/chunk', time: 4, data: { chunk: { type: 'block-start', blockType: 'reasoning' } } },
  { seq: 4, type: 'assistant/chunk', time: 5, data: { chunk: { type: 'reasoning-delta', text: 'think step one\n' } } },
  { seq: 5, type: 'assistant/chunk', time: 6, data: { chunk: { type: 'reasoning-delta', text: 'think step two' } } },
  { seq: 6, type: 'assistant/chunk', time: 7, data: { chunk: { type: 'block-end', block: { type: 'reasoning', text: 'think step one\nthink step two' } } } },
  { seq: 7, type: 'assistant/chunk', time: 8, data: { chunk: { type: 'text-delta', text: 'answer ' } } },
  { seq: 8, type: 'assistant/chunk', time: 9, data: { chunk: { type: 'text-delta', text: 'part two' } } },
  { seq: 9, type: 'assistant/chunk', time: 10, data: { chunk: { type: 'block-end', block: { type: 'image' } } } },
  { seq: 10, type: 'assistant/message', time: 11, data: { message: { content: [{ type: 'text', text: 'answer part two' }, { type: 'reasoning', text: 'think step one\nthink step two' }] } } },
  { seq: 11, type: 'tool/call', time: 12, data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
  { seq: 12, type: 'tool/result', time: 13, data: { callId: 'c1', message: { content: [{ type: 'text', text: 'a.txt\nb.txt' }] } } },
  { seq: 13, type: 'tool/call', time: 14, data: { callId: 'c2', name: 'write', arguments: 'not json' } },
  { seq: 14, type: 'tool/result', time: 15, data: { callId: 'c2', error: { name: 'E_FAIL' }, message: { content: [{ type: 'text', text: 'boom' }] } } },
  { seq: 15, type: 'compaction/end', time: 16, data: { shadowedSeqCount: 12 } },
  { seq: 16, type: 'user/message', time: 17, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] } },
  { seq: 17, type: 'turn/end', time: 18, data: { reason: { kind: 'aborted' } } },
  { seq: 18, type: 'user/message', time: 19, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one more' }] } },
  { seq: 19, type: 'turn/end', time: 20, data: { reason: { kind: 'error', error: { message: 'llm failed' } } } },
  { seq: 20, type: 'user/message', time: 21, data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '<compacted>' }] } },
]

let failed = 0
function check(name, cond, detail) {
  if (!cond) { failed++; console.log(`FAIL - ${name}${detail !== undefined ? ' :: ' + detail : ''}`) }
  else console.log(`ok - ${name}`)
}
const blocks = () => transcript.children.filter((c) => c._className.includes('block'))
const cls = (b) => b._className.split(/\s+/).filter((x) => x && x !== 'block')
const text = (b) => b.querySelector('.text')?.textContent ?? ''

const { transcript: tr, err: pageErr } = await runPage(FIXTURE)
if (pageErr) console.log('PAGE ERROR:', pageErr.split('\n').slice(0, 2).join(' | '))
const bs = blocks()
// 14 blocks: image block-end paints a separate [image] assistant block
check('transcript has 14 rendered blocks', bs.length === 14, bs.length)

let i = 0
check('block 0 = sys (session/title is sys? no — title goes to header)', true) // title handled via header, not a block
// user message
check(`block 0 is user`, cls(bs[0]).includes('user'), JSON.stringify(cls(bs[0])))
check(`block 0 text is the prompt`, text(bs[0]) === 'hello world', text(bs[0]))
// reasoning (assistant/chunk block-start)
check(`block 1 is reasoning`, cls(bs[1]).includes('reasoning'), JSON.stringify(cls(bs[1])))
check(`block 1 has details with thinking text`, bs[1].querySelector('.rbody')?.textContent === 'think step one\nthink step two', bs[1].querySelector('.rbody')?.textContent)
// assistant streaming text
check(`block 2 is assistant`, cls(bs[2]).includes('assistant'), JSON.stringify(cls(bs[2])))
check(`block 2 text is streamed answer`, text(bs[2]) === 'answer part two', text(bs[2]))
// image block-end -> separate [image] assistant block
check(`block 3 is assistant (image)`, cls(bs[3]).includes('assistant') && text(bs[3]).includes('[image]'), text(bs[3]))
// tool call
check(`block 4 is tool`, cls(bs[4]).includes('tool'), JSON.stringify(cls(bs[4])))
check(`block 4 has details with args`, bs[4].querySelector('details.tool') !== null)
// tool result
check(`block 5 is result`, cls(bs[5]).includes('result'), JSON.stringify(cls(bs[5])))
check(`block 5 shows full output`, text(bs[5]).includes('a.txt\nb.txt'), text(bs[5]))
// tool call non-json args
check(`block 6 is tool`, cls(bs[6]).includes('tool'))
// tool error
check(`block 7 is error`, cls(bs[7]).includes('error'), JSON.stringify(cls(bs[7])))
// compaction sys line
check(`block 8 is sys (compaction)`, cls(bs[8]).includes('sys'), JSON.stringify(cls(bs[8])))
// second user
check(`block 9 is user`, cls(bs[9]).includes('user'))
check(`block 9 text 'again'`, text(bs[9]) === 'again', text(bs[9]))
// aborted turn
check(`block 10 is sys (interrupted)`, cls(bs[10]).includes('sys') && text(bs[10]).includes('中断'), text(bs[10]))
// third user
check(`block 11 is user`, cls(bs[11]).includes('user'))
// error turn
check(`block 12 is sys (turn error)`, cls(bs[12]).includes('sys') && text(bs[12]).includes('llm failed'), text(bs[12]))
// compact-checkpoint user -> user block
check(`block 13 is user (checkpoint)`, cls(bs[13]).includes('user'), JSON.stringify(cls(bs[13])))

// header state
check('header title shows session title', el('title').textContent === 'My session', el('title').textContent)
check('meta mentions model', el('meta').textContent.includes('p/m'), el('meta').textContent)
check('header busy class after aborted turn? no (idle)', !el('hd').classList.contains('busy'))

// ---- real-payload smoke (optional: node test.js < hello.json) --------------------
const stdin = fs.readFileSync(0, 'utf8').trim()
if (stdin) {
  try {
    const hello = JSON.parse(stdin)
    const { transcript: tr } = await runPage(hello.events || [], { sessionId: hello.sessionId, title: hello.title, meta: hello.meta, model: hello.model })
    const n = tr.children.filter((c) => c._className.includes('block')).length
    check(`real payload rendered ${n} blocks (${(hello.events || []).length} events)`, n > 0, n)
    const users = tr.children.filter((c) => c._className.includes('user')).length
    check(`real payload has user blocks`, users > 0, users)
  } catch (e) {
    check(`real payload smoke: ${e.message}`, false, e.stack)
  }
}

console.log(failed ? `\n${failed} failure(s)` : '\nall tests passed')
process.exit(failed ? 1 : 0)
