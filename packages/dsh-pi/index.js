#!/usr/bin/env node
// dsh-pi — main entry: one command to set up, run and drive dsh-pi.
//
// Commands:
//   dsh-pi setup <name> [web|headless]  create a profile wired for dsh-pi
//   dsh-pi tui                          launch the terminal UI (@dsh-pi/tui)
//   dsh-pi watch [session-id] [opts]    real-time web mirror of a TUI session (@dsh-pi/watch)
//   dsh-pi web [name] [dsh args...]     boot a web profile (default: pi)
//   dsh-pi version
//   dsh-pi help
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const REGISTRY = 'https://registry.npmjs.org'
const isBun = typeof Bun !== 'undefined' || !!process.versions?.bun
const pkgRunner = isBun ? ['bunx', '--yes', 'pnpm'] : ['npx', '--yes', 'pnpm']

const HELP = `dsh-pi — pi on DeepSeek Harness

usage:
  dsh-pi setup <name> [web|headless]   create a profile wired for dsh-pi
  dsh-pi tui                           launch the terminal UI
  dsh-pi watch [session-id] [opts]     real-time web mirror of a TUI session
  dsh-pi web [name] [args...]          boot a web profile (default: pi)
  dsh-pi version
  dsh-pi help

web profiles install @dsh-pi/preset, which makes dsh-pi the default agent
preset (pi prompt + ffgrep/fffind + pi edit) — new sessions are pi out of
the box. headless profiles wire the three bundles directly.

watch serves a self-contained web page that streams a TUI session's events
in near-real-time by tailing the shared session log (listSnapshots +
readFrom) — the TUI keeps writing, the browser watches. Options: --port
(default 8123), --poll (default 500 ms), --host (default 127.0.0.1).`

function writeProfile(dest, pkg, patch) {
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  fs.writeFileSync(
    path.join(dest, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )
  fs.writeFileSync(path.join(dest, 'cordis.patch.yml'), patch)
}

function setup(name, kind, opts = {}) {
  const dest = path.join(home, 'profiles', name)
  if (fs.existsSync(dest)) {
    if (opts.silent) return dest
    console.error(`profile '${name}' already exists at ${dest}`)
    process.exit(1)
  }
  const headless = kind === 'headless'
  if (!headless && kind !== 'web') {
    console.error(`unknown kind '${kind}' (web|headless)`)
    process.exit(1)
  }
  console.log(`creating ${headless ? 'headless' : 'web'} profile '${name}'...`)

  if (headless) {
    writeProfile(dest, {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {
        '@dsh-pi/fff': '^0.1.0',
        '@dsh-pi/prompt': '^0.1.0',
        '@dsh-pi/tools': '^0.1.0',
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-headless',
            '@dsh-pi/prompt',
            '@dsh-pi/fff',
            '@dsh-pi/tools',
          ],
        },
      },
    }, '[]\n')
  } else {
    writeProfile(dest, {
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {
        '@dsh-pi/preset': '^0.1.0',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-pi/preset'],
        },
      },
    }, '# dsh-pi profile. Override the persona here:\n# - id: dsh-pi-prompt\n#   config:\n#     persona: "Your custom persona"\n[]\n')
  }

  const r = spawnSync(pkgRunner[0], [...pkgRunner.slice(1), 'install', '--registry', REGISTRY], {
    cwd: dest,
    stdio: opts.silent ? 'ignore' : 'inherit',
  })
  if (r.status !== 0) {
    if (!opts.silent) console.error('dependency install failed — check network access to registry.npmjs.org')
    process.exit(1)
  }
  if (!opts.silent) {
    console.log(`✅ profile '${name}' ready — boot with: dsh --profile ${name}${headless ? ' "your task"' : ''}`)
  }
  return dest
}

function resolveDsh() {
  if (process.env.DSH_BIN) return { cmd: process.env.DSH_BIN, args: [] }
  const onPath = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  if (onPath.status === 0 && onPath.stdout.trim()) return { cmd: onPath.stdout.trim(), args: [] }
  return { cmd: 'npx', args: ['--yes', '@deepseek-ai/dsh'] }
}

function tui() {
  let entry
  try {
    entry = require.resolve('@dsh-pi/tui')
  } catch {
    console.error('@dsh-pi/tui not found — install it with: npm i -g @dsh-pi/tui')
    process.exit(1)
  }
  const child = spawn(process.execPath, [entry], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}

function watch(args) {
  let entry
  try {
    entry = require.resolve('@dsh-pi/watch')
  } catch {
    console.error('@dsh-pi/watch not found — install it with: npm i -g @dsh-pi/watch')
    process.exit(1)
  }
  const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 0))
}

function web(name, args) {
  // auto-provision: create the profile on first use — no explicit setup step
  if (!fs.existsSync(path.join(home, 'profiles', name))) {
    console.error(`[dsh-pi] profile '${name}' not found — creating it (web)…`)
    setup(name, 'web', { silent: true })
  }
  const { cmd, args: pre } = resolveDsh()
  const r = spawnSync(cmd, [...pre, '--profile', name, ...args], { stdio: 'inherit' })
  process.exit(r.status ?? 0)
}

const cmd = process.argv[2]
switch (cmd) {
  case 'setup': {
    const name = process.argv[3] || 'pi'
    const kind = process.argv[4] || 'web'
    setup(name, kind)
    break
  }
  case 'tui':
    tui()
    break
  case 'watch':
    watch(process.argv.slice(3))
    break
  case 'web': {
    const name = process.argv[3] || 'pi'
    const args = process.argv.slice(4)
    web(name, args)
    break
  }
  case 'version':
    console.log(require('./package.json').version)
    break
  case 'help':
  case '-h':
  case '--help':
    console.log(HELP)
    break
  default:
    // no command → just run the terminal UI (auto-provisions pi-sdk on first use)
    if (!cmd) {
      tui()
      break
    }
    console.log(HELP)
    console.error(`\nunknown command '${cmd}'`)
    process.exit(1)
}
