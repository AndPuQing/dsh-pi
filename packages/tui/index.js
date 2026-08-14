#!/usr/bin/env node
// @dsh-pi/tui — v0 terminal shell for dsh-pi.
//
// Drives the dsh-pi SDK runtime (profile `pi-sdk`) over stdio JSON-RPC:
//   - self-contained: creates the pi-sdk profile + installs deps on first run
//   - readline loop: prompt → session/prompt → stream assistant text & tool calls
//
// Env:
//   DSH_PI_PROVIDER / DSH_PI_MODEL — override the model route (default: read
//   from $DSH_HOME/settings.yaml agent-default-model, else opencode-go /
//   deepseek-v4-flash).
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROF = 'pi-sdk'
const profDir = path.join(home, 'profiles', PROF)
const REGISTRY = 'https://registry.npmjs.org'

function defaultModel() {
  const envP = process.env.DSH_PI_PROVIDER
  const envM = process.env.DSH_PI_MODEL
  try {
    const s = fs.readFileSync(path.join(home, 'settings.yaml'), 'utf8')
    const m = s.match(/agent-default-model:\s*\n(\s+provider:\s*(\S+)\s*\n)?(\s+model:\s*(\S+))/)
    const provider = envP || m?.[2] || 'opencode-go'
    const model = envM || m?.[4] || 'deepseek-v4-flash'
    return { provider, model }
  } catch {
    return { provider: envP || 'opencode-go', model: envM || 'deepseek-v4-flash' }
  }
}

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
        bundles: [
          '@deepseek-ai/dsh-base',
          '@dsh-pi/prompt',
          '@dsh-pi/fff',
          '@dsh-pi/tools',
        ],
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

function resolveDsh() {
  if (process.env.DSH_BIN) return { cmd: process.env.DSH_BIN, args: [] }
  const onPath = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  if (onPath.status === 0 && onPath.stdout.trim()) return { cmd: onPath.stdout.trim(), args: [] }
  // fallback: fetch the published dsh binary via npx
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

function makeRenderer() {
  let inText = false
  return {
    onEvent(msg) {
      if (msg.method !== 'session.event') return
      const ev = msg.params.event
      if (ev.type === 'assistant/chunk') {
        const chunk = ev.data.chunk || {}
        if (chunk.type === 'block-start' && chunk.blockType === 'text') inText = true
        else if (chunk.type === 'text-delta' && inText) process.stdout.write(chunk.text)
        else if (chunk.type === 'block-end') {
          inText = false
          process.stdout.write('\n')
        }
      } else if (ev.type === 'tool/call') {
        let a = ev.data.arguments || ''
        try {
          a = JSON.stringify(JSON.parse(a)).slice(0, 140)
        } catch {
          a = String(a).slice(0, 140)
        }
        process.stdout.write(`\n  ⚙ ${ev.data.name} ${a}\n`)
      } else if (ev.type === 'tool/result') {
        const parts = ev.data.message?.content || []
        const txt = parts.find((p) => p.type === 'text' && p.text)?.text || ''
        if (txt) process.stdout.write(`  ✓ ${txt.split('\n')[0].slice(0, 140)}\n`)
      } else if (ev.type === 'turn/end') {
        process.stdout.write('\n')
      }
    },
  }
}

async function main() {
  ensureProfile()
  const { child, request, onMessage } = startRuntime()
  const renderer = makeRenderer()
  onMessage(renderer.onEvent)

  const { provider, model } = defaultModel()
  let init = null
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      init = await request('initialize', { cwd: process.cwd(), provider, model })
      break
    } catch (e) {
      if (attempt === 30) {
        console.error(`[dsh-pi-tui] initialize failed: ${e.message}`)
        child.kill()
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, 1000)) // runtime still booting
    }
  }
  console.error(`[dsh-pi-tui] runtime ${init.serverInfo.name} ready (${provider}/${model}) — type a prompt, Ctrl-C to exit`)
  // settle: let the agent + adapter finish booting before the first prompt
  // (an early prompt can be swallowed as an empty turn)
  await new Promise((r) => setTimeout(r, 2500))

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  // unique session per run: interrupted runs leave a wedged resume state
  const sessionId = 'tui-' + Date.now()
  let turnActive = false
  let inputClosed = false
  let shutting = false
  const shutdown = async () => {
    if (shutting) return
    shutting = true
    const deadline = Date.now() + 60000
    while (turnActive && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    request('shutdown').catch(() => {})
    setTimeout(() => child.kill(), 500)
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  rl.on('close', () => {
    inputClosed = true
    shutdown()
  })
  onMessage((msg) => {
    if (process.env.DSH_PI_DEBUG && msg.method === 'session.event') {
      process.stderr.write(`[dbg] ${msg.params.event.type}\n`)
    }
    if (msg.method !== 'session.event') return
    const ev = msg.params.event
    if (ev.type === 'turn/start') turnActive = true
    if (ev.type === 'turn/end') turnActive = false
  })

  const ask = () => {
    if (inputClosed) return
    rl.question('❯ ', async (line) => {
      const text = line.trim()
      if (!text) return ask()
      if (text === '/quit' || text === 'exit') return shutdown()
      turnActive = true
      await request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text }],
      }).catch((e) => {
        console.error('prompt error:', e.message)
        turnActive = false
      })
      ask()
    })
  }
  ask()
}

main()
