// @dsh-pi/preset: installs the dsh-pi agent preset and makes it the default.
//
// At boot this plugin ensures the preset composition exists at the
// auto-discovered user root ($DSH_HOME/.agent-presets/dsh-pi/agent.cordis.yml),
// copying it from the packaged copy (the package stays the source of truth).
// The bundle patch (cordis.patch.yml) sets the agent-presets default to
// dsh-pi, so new web sessions run the pi prompt + fff tools + pi edit.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'agent-presets',
  'dsh-pi',
  'agent.cordis.yml',
)

export default {
  name: 'dsh-pi-preset',
  apply(ctx, config = {}) {
    if (config.install === false) return
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const destDir = path.join(home, '.agent-presets', 'dsh-pi')
      fs.mkdirSync(destDir, { recursive: true })
      fs.copyFileSync(SRC, path.join(destDir, 'agent.cordis.yml'))
      ctx.logger?.debug?.('dsh-pi-preset: preset installed to', destDir)
    } catch (e) {
      ctx.logger?.warn?.(`dsh-pi-preset: could not install preset: ${e.message}`)
    }
  },
}
