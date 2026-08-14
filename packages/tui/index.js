#!/usr/bin/env node
// @dsh-pi/tui — v1: pi-style terminal UI for dsh-pi.
//
// Renders with @earendil-works/pi-tui (Editor input, Markdown messages,
// auto-scrolling ScrollView) while driving the dsh-pi SDK runtime
// (`pi-sdk` profile) over stdio JSON-RPC.
//
// Env:
//   DSH_BIN              dsh binary (default: PATH, then npx @deepseek-ai/dsh)
//   DSH_PI_PROVIDER/DSH_PI_MODEL  model route override (default: settings.yaml
//                                  agent-default-model, else opencode-go/…)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  Editor,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiMainScreen,
  VStack,
} from '@earendil-works/pi-tui'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROF = 'pi-sdk'
const profDir = path.join(home, 'profiles', PROF)
const REGISTRY = 'https://registry.npmjs.org'

// ---- model route ----------------------------------------------------------

function defaultModel() {
  const envP = process.env.DSH_PI_PROVIDER
  const envM = process.env.DSH_PI_MODEL
  try {
    const s = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8')
    const m = s.match(/agent-default-model:\s*\n(\s+provider:\s*(\S+)\s*\n)?(\s+model:\s*(\S+))/)
    return {
      provider: envP || m?.[2] || 'opencode-go',
      model: envM || m?.[4] || 'deepseek-v4-flash',
    }
  } catch {
    return { provider: envP || 'opencode-go', model: envM || 'deepseek-v4-flash' }
  }
}

// ---- profile setup ---------------------------------------------------------

function ensureProfile() {
  if (fs.existsSync(profDir)) return
  console.error(`[dsh-pi-tui] creating profile ${PROF}...`)
  fs.mkdirSync(profDir, { recursive: true })
  const pkg = {
    name: `dsh-profile-${PROF}`,
    private: true,
    dependencies: {
      '@dsh-pi/fff': '^0.1.0',
      '@dsh-pi/prompt': '^0.1.0',
      '@dsh-pi/tools': '^0.1.0',
      '@deepseek-ai/dsh-sdk-jsonrpc-server': '^0.1.0-rc.6',
      '@deepseek-ai/dsh-sdk-protocol': '^0.1.0-rc.6',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@dsh-pi/prompt', '@dsh-pi/fff', '@dsh-pi/tools'],
      },
    },
  }
  fs.writeFileSync(path.join(profDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  fs.writeFileSync(
    path.join(profDir, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )
  fs.writeFileSync(
    path.join(profDir, 'cordis.patch.yml'),
    '# dsh-pi SDK runtime: serves stdio JSON-RPC for the terminal UI.\n- insert:\n    - id: sdk-jsonrpc-server\n      name: \'@deepseek-ai/dsh-sdk-jsonrpc-server\'\n      config: {}\n',
  )
  const r = spawnSync('npx', ['--yes', 'pnpm', 'install', '--registry', REGISTRY], {
    cwd: profDir,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('[dsh-pi-tui] profile install failed — check network access to registry.npmjs.org')
    process.exit(1)
  }
}

// ---- JSON-RPC runtime -------------------------------------------------------

function resolveDsh() {
  if (process.env.DSH_BIN) return { cmd: process.env.DSH_BIN, args: [] }
  const onPath = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  if (onPath.status === 0 && onPath.stdout.trim()) return { cmd: onPath.stdout.trim(), args: [] }
  return { cmd: 'npx', args: ['--yes', '@deepseek-ai/dsh'] }
}

function startRuntime() {
  const { cmd, args } = resolveDsh()
  const child = spawn(cmd, [...args, '--profile', PROF], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let nextId = 1
  const pending = new Map()
  const handlers = []
  child.stdout.on('data', (c) => {
    buf += c
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
        }
      } else {
        for (const h of handlers) h(msg)
      }
    }
  })
  child.stderr.on('data', (c) => process.stderr.write(c))
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { child, request, onMessage: (h) => handlers.push(h) }
}

// ---- themes ----------------------------------------------------------------

const plain = (s) => s
const markdownTheme = {
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
}
const editorTheme = {
  borderColor: (s) => `\x1b[90m${s}\x1b[0m`,
  selectList: {},
}
const defaultTextStyle = {}

// ---- UI ---------------------------------------------------------------------

function setupUi({ request, onMessage, sessionId }) {
  const terminal = new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)

  const messages = new VStack([])
  const scroll = new ScrollView(messages, { follow: 'end', primary: true })
  const editor = new Editor(tui, editorTheme)
  tui.addChild(new VStack([scroll, editor]))
  tui.start()
  tui.setFocus(editor)

  let busy = false
  let currentAsst = null
  let asstText = ''
  let inText = false

  function upsertAsst() {
    // replace the in-progress assistant message with the accumulated text
    if (currentAsst) messages.removeChild(currentAsst)
    if (asstText) {
      currentAsst = new Markdown(asstText, 1, 0, markdownTheme, defaultTextStyle)
      messages.addChild(currentAsst)
    } else {
      currentAsst = null
    }
    tui.requestRender()
  }

  editor.onSubmit = (text) => {
    const t = text.trim()
    if (!t) return
    if (t === 'exit' || t === '/quit') {
      shutdown()
      return
    }
    messages.addChild(new Text(`\x1b[90m❯\x1b[0m ${t}`))
    busy = true
    request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: t }] }).catch(
      (e) => {
        messages.addChild(new Text(`\x1b[31m! ${e.message}\x1b[0m`))
        busy = false
        tui.requestRender()
      },
    )
    tui.requestRender()
  }

  onMessage((msg) => {
    if (process.env.DSH_PI_DEBUG && msg.method === 'session.event') {
      process.stderr.write(`[dbg] ${msg.params.event.type}\n`)
    }
    if (msg.method !== 'session.event') return
    const ev = msg.params.event
    const d = ev.data || {}
    if (ev.type === 'assistant/chunk') {
      const chunk = d.chunk || {}
      if (chunk.type === 'block-start' && chunk.blockType === 'text') inText = true
      else if (chunk.type === 'text-delta' && inText) {
        asstText += chunk.text
        upsertAsst()
      } else if (chunk.type === 'block-end') {
        inText = false
      }
    } else if (ev.type === 'tool/call') {
      let a = d.arguments || ''
      try {
        a = JSON.stringify(JSON.parse(a)).slice(0, 140)
      } catch {
        a = String(a).slice(0, 140)
      }
      messages.addChild(new Text(`\x1b[36m⚙ ${d.name}\x1b[0m ${a}`))
      tui.requestRender()
    } else if (ev.type === 'tool/result') {
      const parts = d.message?.content || []
      const txt = parts.find((p) => p.type === 'text' && p.text)?.text || ''
      if (txt) {
        messages.addChild(new Text(`\x1b[32m✓\x1b[0m ${txt.split('\n')[0].slice(0, 140)}`))
        tui.requestRender()
      }
    } else if (ev.type === 'turn/end') {
      busy = false
    }
  })

  let shutting = false
  const shutdown = () => {
    if (shutting) return
    shutting = true
    tui.stop()
    request('shutdown').catch(() => {})
    setTimeout(() => terminal.release?.() ?? 0, 0)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  tui.start()
  return { tui, shutdown }
}

// ---- main -------------------------------------------------------------------

async function main() {
  ensureProfile()
  const { child, request, onMessage } = startRuntime()
  const sessionId = 'tui-' + Date.now()
  const { provider, model } = defaultModel()

  let init = null
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      init = await request('initialize', { cwd: process.cwd(), provider, model })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  if (!init) {
    console.error('[dsh-pi-tui] initialize failed — runtime did not come up')
    child.kill()
    process.exit(1)
  }
  // settle so the first prompt is not swallowed as an empty turn
  await new Promise((r) => setTimeout(r, 2500))

  setupUi({ request, onMessage, sessionId })
}

main()
