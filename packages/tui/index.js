#!/usr/bin/env node
// @dsh-pi/tui — v2: pi-style terminal UI for dsh-pi.
//
// v2 additions over v1: slash commands, theme switching, tool-call folding,
// Ctrl-L clear, and session continuity (persisted session id + /new).
//
// Env:
//   DSH_BIN              dsh binary (default: PATH, then npx @deepseek-ai/dsh)
//   DSH_PI_PROVIDER/DSH_PI_MODEL  model route override (default: settings.yaml)
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
const isBun = typeof Bun !== 'undefined' || !!process.versions?.bun
const pkgRunner = isBun ? ['bunx', '--yes', 'pnpm'] : ['npx', '--yes', 'pnpm']
const STATE_DIR = path.join(home, 'dsh-pi-tui')
const plain = (s) => s

// ---- themes -----------------------------------------------------------------

const THEMES = {
  default: {
    name: 'default',
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
    },
    editor: { borderColor: (s) => `\x1b[90m${s}\x1b[0m`, selectList: {} },
    user: (s) => `\x1b[90m❯\x1b[0m ${s}`,
    tool: (s) => `\x1b[36m⚙ ${s}\x1b[0m`,
    result: (s) => `\x1b[32m✓\x1b[0m ${s}`,
    sys: (s) => `\x1b[33m${s}\x1b[0m`,
  },
  light: {
    name: 'light',
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
    },
    editor: { borderColor: (s) => `\x1b[34m${s}\x1b[0m`, selectList: {} },
    user: (s) => `\x1b[34m❯\x1b[0m ${s}`,
    tool: (s) => `\x1b[34m⚙ ${s}\x1b[0m`,
    result: (s) => `\x1b[32m✓\x1b[0m ${s}`,
    sys: (s) => `\x1b[33m${s}\x1b[0m`,
  },
}

// ---- model route ------------------------------------------------------------

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

// ---- profile setup -----------------------------------------------------------

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
  const r = spawnSync(pkgRunner[0], [...pkgRunner.slice(1), 'install', '--registry', REGISTRY], {
    cwd: profDir,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('[dsh-pi-tui] profile install failed — check network access to registry.npmjs.org')
    process.exit(1)
  }
}

// ---- session id persistence ---------------------------------------------------

function sessionStatePath() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const slug = process.cwd().replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'root'
  return path.join(STATE_DIR, `session-${slug}.id`)
}

function loadSessionId() {
  try {
    const v = fs.readFileSync(sessionStatePath(), 'utf8').trim()
    if (v) return v
  } catch {
    /* first run */
  }
  return null
}

function saveSessionId(id) {
  try {
    fs.writeFileSync(sessionStatePath(), id)
  } catch {
    /* best effort */
  }
}

// ---- JSON-RPC runtime ----------------------------------------------------------

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

// ---- UI ------------------------------------------------------------------------

function setupUi({ request, onMessage, sessionId, setSessionId }) {
  const terminal = new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)

  let theme = THEMES[process.env.DSH_PI_THEME] || THEMES.default
  let showTools = true
  const messages = []
  let currentAsst = null
  let asstText = ''
  let inText = false
  let busy = false
  // resume self-heal: a resumed session whose first turn spends no step is
  // wedged — switch to a fresh session automatically.
  let firstTurn = true
  let turnSawStep = false
  let lastPrompt = ''

  const container = new VStack([])
  const scroll = new ScrollView(container, { follow: 'end', primary: true })
  const editor = new Editor(tui, theme.editor)
  tui.addChild(new VStack([scroll, editor]))
  tui.start()
  tui.setFocus(editor)

  function addMessage(kind, text) {
    const t = theme
    let comp
    if (kind === 'asst') comp = new Markdown(text, 1, 0, t.markdown, {})
    else comp = new Text(kind === 'user' ? t.user(text) : kind === 'tool' ? t.tool(text) : kind === 'result' ? t.result(text) : t.sys(text))
    messages.push({ kind, text, comp })
    container.addChild(comp)
    tui.requestRender()
  }

  function rebuild() {
    container.clear()
    for (const m of messages) {
      const t = theme
      if (m.kind === 'asst') m.comp = new Markdown(m.text, 1, 0, t.markdown, {})
      else if (m.kind === 'user') m.comp = new Text(t.user(m.text))
      else if (m.kind === 'tool') m.comp = new Text(showTools ? t.tool(m.text) : t.tool(m.text.split('\n')[0]))
      else if (m.kind === 'result') m.comp = new Text(showTools ? t.result(m.text) : t.sys('…'))
      else m.comp = new Text(t.sys(m.text))
      container.addChild(m.comp)
    }
    tui.requestRender()
  }

  function upsertAsst() {
    if (currentAsst) container.removeChild(currentAsst)
    if (asstText) {
      currentAsst = new Markdown(asstText, 1, 0, theme.markdown, {})
      container.addChild(currentAsst)
    } else {
      currentAsst = null
    }
    tui.requestRender()
  }

  const HELP = `commands:
  /help          this help
  /clear         clear the conversation view (session stays)
  /theme <name>  switch theme: ${Object.keys(THEMES).join(', ')}
  /tools [on|off]  fold/unfold tool-call details
  /new           start a fresh session
  /quit, exit    leave`

  function runCommand(text) {
    const [cmd, arg] = text.split(/\s+/, 2)
    switch (cmd) {
      case '/help':
        addMessage('sys', HELP)
        return true
      case '/clear':
        messages.length = 0
        currentAsst = null
        asstText = ''
        rebuild()
        return true
      case '/theme': {
        const t = THEMES[arg]
        if (!t) {
          addMessage('sys', `unknown theme '${arg}' — ${Object.keys(THEMES).join(', ')}`)
        } else {
          theme = t
          rebuild()
          addMessage('sys', `theme: ${t.name}`)
        }
        return true
      }
      case '/tools':
        if (arg === 'off') showTools = false
        else if (arg === 'on') showTools = true
        else showTools = !showTools
        rebuild()
        addMessage('sys', `tool details: ${showTools ? 'on' : 'off'}`)
        return true
      case '/new':
        setSessionId('tui-' + Date.now())
        addMessage('sys', `new session: ${sessionId}`)
        return true
      case '/quit':
      case 'exit':
        shutdown()
        return true
      default:
        addMessage('sys', `unknown command '${cmd}' — /help`)
        return true
    }
  }

  editor.onSubmit = (text) => {
    const t = text.trim()
    if (!t) return
    if (t.startsWith('/') || t === 'exit') {
      if (runCommand(t)) return
    }
    addMessage('user', t)
    lastPrompt = t
    busy = true
    request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: t }] }).catch(
      (e) => {
        addMessage('sys', `! ${e.message}`)
        busy = false
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
    if (ev.type === 'turn/start') {
      turnSawStep = false
    } else if (ev.type === 'step/start') {
      turnSawStep = true
    } else if (ev.type === 'turn/end') {
      busy = false
      if (firstTurn && !turnSawStep) {
        firstTurn = false
        const fresh = 'tui-' + Date.now()
        setSessionId(fresh)
        saveSessionId(fresh)
        addMessage('sys', 'previous session state unusable — started a fresh session')
        if (lastPrompt) {
          addMessage('sys', 're-sending your last prompt…')
          request('session/prompt', {
            sessionId: fresh,
            contentBlocks: [{ type: 'text', text: lastPrompt }],
          }).catch((e) => addMessage('sys', `! ${e.message}`))
        }
      }
    }
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
      addMessage('tool', `${d.name}\n  ${a}`)
    } else if (ev.type === 'tool/result') {
      const parts = d.message?.content || []
      const txt = parts.find((p) => p.type === 'text' && p.text)?.text || ''
      if (txt) addMessage('result', txt.split('\n')[0].slice(0, 140))
    }
  })
  tui.addInputListener((data) => {
    if (data === '\x0c') {
      // Ctrl-L: clear the view (session stays)
      messages.length = 0
      currentAsst = null
      asstText = ''
      rebuild()
    }
  })

  let shutting = false
  const shutdown = () => {
    if (shutting) return
    shutting = true
    tui.stop()
    request('shutdown').catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return { tui, shutdown }
}

// ---- main ----------------------------------------------------------------------

async function main() {
  ensureProfile()
  const { child, request, onMessage } = startRuntime()
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

  let sessionId = loadSessionId() || 'tui-' + Date.now()
  saveSessionId(sessionId)
  setupUi({ request, onMessage, sessionId, setSessionId: (id) => (sessionId = id) })
}

main()
