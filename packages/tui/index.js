#!/usr/bin/env node
// @dsh-pi/tui — pi-style terminal UI for dsh-pi, IN-PROCESS.
//
// No spawned runtime, no JSON-RPC: the dsh runtime boots inside this process
// (like pi's single-process design). The pi-sdk profile trick is gone; we
// compose the pi-embed profile (base + prompt + fff + tools) in-process,
// create an Agent directly, and render its session events live.
//
// Commands: /help /clear /theme <name> /tools [on|off] /new /quit
// Env: DSH_BIN unused here; DSH_PI_PROVIDER/DSH_PI_MODEL override the route.
import { spawnSync } from 'node:child_process'
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
import { SessionId } from '@deepseek-ai/dsh-session'
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
const PROF = 'pi-embed'
const profDir = path.join(home, 'profiles', PROF)
const REGISTRY = 'https://registry.npmjs.org'
const STATE_DIR = path.join(home, 'dsh-pi-tui')
const ANCHOR = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
const PROFILE_ROOT_CONFIG = '# dsh profile root — empty entry list; tree composed as patches.\n[]\n'
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
    user: (s) => `\x1b[94m❯\x1b[0m ${s}`,
    tool: (s) => `\x1b[36m⚙ ${s}\x1b[0m`,
    result: (s) => `\x1b[32m✓\x1b[0m ${s}`,
    sys: (s) => `\x1b[33m${s}\x1b[0m`,
    status: (s) => `\x1b[90m${s}\x1b[0m`,
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
    status: (s) => `\x1b[90m${s}\x1b[0m`,
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
    console.error('[dsh-pi-tui] profile install failed — check network access to registry.npmjs.org')
    process.exit(1)
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

// ---- UI ------------------------------------------------------------------------

function setupUi(runtime) {
  const terminal = new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)
  let theme = THEMES[process.env.DSH_PI_THEME] || THEMES.default
  let showTools = true
  const messages = []
  let currentAsst = null
  let asstText = ''
  let inText = false
  let ready = false
  const queue = []

  const container = new VStack([])
  const scroll = new ScrollView(container, { follow: 'end', primary: true })
  const editor = new Editor(tui, theme.editor)
  tui.addChild(new VStack([scroll, editor]))
  tui.start()
  tui.setFocus(editor)

  function addMessage(kind, text) {
    const t = theme
    const comp =
      kind === 'asst'
        ? new Markdown(text, 1, 0, t.markdown, {})
        : new Text(kind === 'user' ? t.user(text) : kind === 'tool' ? t.tool(text) : kind === 'result' ? t.result(text) : t.sys(text))
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

  // live session-event stream from the in-process runtime
  runtime.onEvent((session, event) => {
    const d = event.data || {}
    if (event.type === 'assistant/chunk') {
      const chunk = d.chunk || {}
      if (chunk.type === 'block-start' && chunk.blockType === 'text') inText = true
      else if (chunk.type === 'text-delta' && inText) {
        asstText += chunk.text
        upsertAsst()
      } else if (chunk.type === 'block-end') inText = false
    } else if (event.type === 'tool/call') {
      let a = d.arguments || ''
      try { a = JSON.stringify(JSON.parse(a)).slice(0, 140) } catch { a = String(a).slice(0, 140) }
      addMessage('tool', `${d.name}\n  ${a}`)
    } else if (event.type === 'tool/result') {
      const parts = d.message?.content || []
      const txt = parts.find((p) => p.type === 'text' && p.text)?.text || ''
      if (txt) addMessage('result', txt.split('\n')[0].slice(0, 140))
    }
  })

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
      case '/help': addMessage('sys', HELP); return true
      case '/clear':
        messages.length = 0; currentAsst = null; asstText = ''; rebuild(); return true
      case '/theme': {
        const t = THEMES[arg]
        if (!t) addMessage('sys', `unknown theme '${arg}' — ${Object.keys(THEMES).join(', ')}`)
        else { theme = t; rebuild(); addMessage('sys', `theme: ${t.name}`) }
        return true
      }
      case '/tools':
        if (arg === 'off') showTools = false
        else if (arg === 'on') showTools = true
        else showTools = !showTools
        rebuild(); addMessage('sys', `tool details: ${showTools ? 'on' : 'off'}`)
        return true
      case '/new':
        runtime.newSession(); addMessage('sys', 'new session'); return true
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
    if (!ready) {
      queue.push(t)
      addMessage('sys', '… runtime still starting, prompt queued')
      return
    }
    addMessage('user', t)
    runtime.prompt(t)
  }

  editor.onSubmit = (text) => {
    submit(text)
    tui.requestRender()
  }

  tui.addInputListener((data) => {
    if (data === '\x0c') {
      messages.length = 0; currentAsst = null; asstText = ''; rebuild()
    }
  })

  let shutting = false
  const shutdown = () => {
    if (shutting) return
    shutting = true
    tui.stop()
    runtime.dispose()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return {
    tui,
    setReady() {
      ready = true
      addMessage('sys', 'ready — type a prompt')
      for (const q of queue.splice(0)) submit(q)
    },
  }
}

// ---- main ----------------------------------------------------------------------

async function main() {
  ensureProfile()
  const { provider, model } = defaultModel()

  const runtime = await (async () => {
    const ctx = await bootRuntime()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    if (!agents || !defaultModel) throw new Error('runtime missing agents/defaultModel')

    const selection = defaultModel.currentSelection()
    let agent = null

    function createAgent() {
      return agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 })
        },
      })
    }

    const created = await createAgent()
    agent = created.agent
    await agent.whenIdle()

    const sessionId = agent.session.id
    return {
      ctx,
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
      newSession() {
        createAgent().then((c) => { agent = c.agent; return agent.whenIdle() })
      },
      dispose() {
        try { ctx.fiber?.dispose?.() } catch { /* best effort */ }
      },
    }
  })()

  const ui = setupUi(runtime)
  // session continuity: reuse the persisted id when it matches nothing wedged —
  // for the in-process rewrite, always start fresh but remember the id.
  const persisted = loadSessionId()
  saveSessionId(runtime.sessionId)
  ui.setReady()
}

main().catch((e) => {
  console.error('[dsh-pi-tui] startup failed:', e.message)
  process.exit(1)
})
