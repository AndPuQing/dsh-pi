#!/usr/bin/env node
// @dsh-pi/tui — pi-style terminal UI for dsh-pi, IN-PROCESS.
//
// No spawned runtime, no JSON-RPC: the dsh runtime boots inside this process
// (like pi's single-process design). The pi-sdk profile trick is gone; we
// compose the pi-embed profile (base + prompt + fff + tools) in-process,
// create an Agent directly, and render its session events live.
//
// Commands: /help /clear /theme <name> /tools [on|off] /new /quit
// Shortcuts: Ctrl+N new session · Ctrl+T theme · Ctrl+K clear · Ctrl+Q quit
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
import { zstdDecompressSync } from 'node:zlib'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CombinedAutocompleteProvider,
  Editor,
  getKeybindings,
  KeybindingsManager,
  Loader,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  setKeybindings,
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
    sys: (s) => `\x1b[33m${s}\x1b[0m`,
    status: (s) => `\x1b[90m${s}\x1b[0m`,
    logo: (s) => `\x1b[36m${s}\x1b[0m`,
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

// ---- UI ------------------------------------------------------------------------

function setupUi(runtimeRef, modelInfo) {
  const terminal = new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)
  let theme = THEMES[process.env.DSH_PI_THEME] || THEMES.default
  // model/session info is always visible in the status line
  const runtimeInfo = { provider: modelInfo?.provider || '', model: modelInfo?.model || '' }
  let showTools = true
  const messages = []
  let currentAsst = null
  let asstText = ''
  let inText = false
  const queue = []

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
      { name: 'theme', description: 'switch theme', argumentHint: '<name>', getArgumentCompletions: () => Object.keys(THEMES).map((n) => ({ value: n, label: n })) },
      { name: 'tools', description: 'fold/unfold tool details', argumentHint: '[on|off]' },
      { name: 'sessions', description: 'list or switch sessions', argumentHint: '<n>' },
      { name: 'new', description: 'start a fresh session' },
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
      'app.session.new': { defaultKeys: 'ctrl+n', description: 'Start a fresh session' },
      'app.theme.next': { defaultKeys: 'ctrl+t', description: 'Switch theme' },
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
      const short = String(runtimeRef.sessionId).replace(/^session-/, '').slice(0, 8)
      parts.push(`session ${short}`)
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

  function addMessage(kind, text) {
    const t = theme
    const comp =
      kind === 'asst'
        ? new Markdown(text, 1, 0, t.markdown, {})
        : new Text(
            kind === 'user'
              ? t.user(text)
              : kind === 'tool'
                ? t.tool(text)
                : kind === 'result'
                  ? t.result(text)
                  : kind === 'logo'
                    ? t.logo(text)
                    : t.sys(text),
          )
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
      else if (m.kind === 'logo') m.comp = new Text(t.logo(m.text))
      else m.comp = new Text(t.sys(m.text))
      container.addChild(m.comp)
    }
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

  // live session-event stream from the in-process runtime
  function renderEvent(session, event) {
    const d = event.data || {}
    if (event.type === 'turn/start') setBusy('busy…')
    if (event.type === 'turn/end') {
      flushAsst()
      setStatus('ready')
    }
    if (event.type === 'assistant/chunk') {
      const chunk = d.chunk || {}
      if (chunk.type === 'block-start' && chunk.blockType === 'text') inText = true
      else if (chunk.type === 'text-delta' && inText) {
        asstText += chunk.text
        scheduleAsst()
      } else if (chunk.type === 'block-end') inText = false
    } else if (event.type === 'tool/call') {
      // surface the running tool in the spinner line (animation keeps going)
      if (busy) {
        statusLoader.setMessage(composeStatus(`⚙ ${d.name}…`))
        tui.requestRender()
      }
      let a = d.arguments || ''
      try { a = JSON.stringify(JSON.parse(a)).slice(0, 140) } catch { a = String(a).slice(0, 140) }
      addMessage('tool', `${d.name}\n  ${a}\n`)
    } else if (event.type === 'tool/result') {
      const parts = d.message?.content || []
      const txt = parts.find((p) => p.type === 'text' && p.text)?.text || ''
      if (txt) addMessage('result', txt.split('\n')[0].slice(0, 140))
    }
  }

  const HELP = `commands:
  /help          this help
  /clear         clear the conversation view (session stays)
  /theme <name>  switch theme: ${Object.keys(THEMES).join(', ')}
  /tools [on|off]  fold/unfold tool-call details
  /new           start a fresh session
  /quit, exit    leave

keys:
  Ctrl+N  new session
  Ctrl+T  switch theme (cycles: ${Object.keys(THEMES).join(' -> ')})
  Ctrl+K  clear the conversation view
  Ctrl+Q  quit
  Ctrl+L  clear (alias of Ctrl+K)
  Ctrl+C  copy selection / cancel
  ↑/↓     browse input history`

  function clearView() {
    cancelAsst(); messages.length = 0; currentAsst = null; asstText = ''; rebuild()
  }
  function cycleTheme() {
    const names = Object.keys(THEMES)
    const next = names[(names.indexOf(theme.name) + 1) % names.length]
    runCommand('/theme ' + next)
  }

  function runCommand(text) {
    const [cmd, arg] = text.split(/\s+/, 2)
    switch (cmd) {
      case '/help': addMessage('sys', HELP); return true
      case '/clear': clearView(); return true
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
      case '/sessions': {
        const n = Number(arg)
        if (n && Number.isInteger(n) && n >= 1) {
          runtimeRef.listSessions?.().then(async (list) => {
            const pick = list[n - 1]
            if (!pick) { addMessage('sys', 'no session #' + n); return }
            setStatus('… switching to ' + pick.title + '…')
            try {
              const r = await runtimeRef.switchSession(pick.id)
              if (r.already) { addMessage('sys', 'already on this session'); setStatus('ready'); return }
              cancelAsst()
              messages.length = 0
              currentAsst = null
              asstText = ''
              for (const m of runtimeRef.conversationHistory(r.agent)) addMessage(m.kind, m.text)
              addMessage('sys', 'switched to: ' + pick.title)
              setStatus('ready')
            } catch (e) {
              addMessage('sys', 'switch failed: ' + e.message)
              setStatus('ready')
            }
          })
        } else {
          runtimeRef.listSessions?.().then((list) => {
            if (!list.length) { addMessage('sys', 'no sessions yet'); return }
            const dim = (s) => `\x1b[90m${s}\x1b[0m`
            const sel = new SelectList(
              list.map((x) => ({ label: x.title + (x.current ? ' (current)' : ''), value: x.id, description: x.id })),
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
              submit('/sessions ' + (list.findIndex((x) => x.id === item.value) + 1))
            }
            sel.onCancel = () => {
              tui.hideOverlay()
              tui.setFocus(editor)
            }
            tui.showOverlay(sel)
            tui.setFocus(sel)
          })
        }
        return true
      }
      case '/new':
        cancelAsst(); runtimeRef.newSession?.(); addMessage('sys', 'new session'); return true
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
      addMessage('sys', '! ' + e.message)
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
    if (kb.matches(data, 'app.theme.next')) { cycleTheme(); return { consume: true } }
    if (kb.matches(data, 'app.clear')) { clearView(); return { consume: true } }
    if (kb.matches(data, 'app.quit')) { shutdown(); return { consume: true } }
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
    fail(message) {
      addMessage('sys', '! startup failed: ' + message)
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

    function createAgentWithId(sessionId) {
      return agents.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 })
        },
      })
    }
    function createAgent() {
      return createAgentWithId(`session-${randomUUID()}`)
    }

    const created = await createAgent()
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
      newSession() {
        createAgent().then((c) => {
          agent = c.agent
          return agent.whenIdle()
        }).then(() => {
          runtimeRef.sessionId = agent.session.id
          runtimeRef.refreshStatus?.()
        })
      },
      async listSessions() {
        // dsh's project-key: separators -> '-', unsafe chars -> ~XXXX, wrapped in --..--
        const cwd = process.cwd()
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
        const key = `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
        const root = path.join(home, 'sessions', key)
        let dirs = []
        try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
        const out = []
        for (const dir of dirs) {
          const file = path.join(root, dir, 'session.jsonl.zstd')
          let title = dir
          let createdAt = 0
          try {
            const raw = zstdDecompressSync(fs.readFileSync(file))
            const text = raw.toString('utf8')
            const first = text.indexOf('\n')
            const head = JSON.parse(text.slice(0, first))
            createdAt = head.createdAt || 0
            const ti = text.indexOf('"type":"session/title"')
            if (ti !== -1) {
              const tm = text.indexOf('"title":"', ti)
              if (tm !== -1) {
                const start = tm + 9
                const end = text.indexOf('"', start)
                if (end !== -1 && end > start) title = text.slice(start, end)
              }
            }
          } catch { /* skip unreadable */ }
          out.push({ id: dir, title, createdAt, current: agent?.session?.id === dir })
        }
        out.sort((a, b) => b.createdAt - a.createdAt)
        return out
      },
      async switchSession(sessionId) {
        if (agent && agent.session.id === sessionId) return { agent, already: true }
        let created
        try {
          created = await createAgentWithId(sessionId)
        } catch (e) {
          if (String(e.message).includes('already exists')) throw new Error('session is in use (current or another live one)')
          throw e
        }
        agent = created.agent
        await agent.whenIdle()
        runtimeRef.sessionId = agent.session.id
        runtimeRef.refreshStatus?.()
        return { agent }
      },
      conversationHistory(agentObj) {
        const msgs = []
        for (const e of agentObj.session.events) {
          if (e.type === 'user/message') {
            const txt = (e.data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
            if (txt) msgs.push({ kind: 'user', text: txt })
          } else if (e.type === 'assistant/message') {
            const txt = (e.data.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
            if (txt) msgs.push({ kind: 'asst', text: txt })
          }
        }
        return msgs
      },
      dispose() {
        try { ctx.fiber?.dispose?.() } catch { /* best effort */ }
      },
    }
  }

  // UI first: instant; boot the runtime in the background
  const runtimeRef = { ready: false, sessionId: null, prompt: null, newSession: null, listSessions: null, switchSession: null, conversationHistory: null, dispose: null, onEvent: null, refreshStatus: null }
  const ui = setupUi(runtimeRef, { provider, model })
  runtimeRef.refreshStatus = () => ui.refreshStatus()
  ui.setStarting()
  ;(async () => {
    try {
      ensureProfile()
      const runtime = await buildRuntime()
      runtimeRef.prompt = runtime.prompt
      runtimeRef.newSession = runtime.newSession
      runtimeRef.listSessions = runtime.listSessions
      runtimeRef.switchSession = runtime.switchSession
      runtimeRef.conversationHistory = runtime.conversationHistory
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

main().catch((e) => {
  console.error('[dsh-pi-tui] startup failed:', e.message)
  process.exit(1)
})
