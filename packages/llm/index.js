// @dsh-pi/llm — bridge pi's model configuration into dsh.
//
// Reads ~/.pi/agent/models.json (pi's custom providers) and mirrors each
// provider into $DSH_HOME/settings.yaml's llm-pi-ai section (the dsh
// multi-provider adapter backed by pi-ai), migrating inline API keys into
// the dsh credential store. pi's models become dsh's model routes — one
// config across both tools. Non-destructive: existing routes (matched by
// baseURL) and existing keys are never overwritten.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const piHome = () => process.env.PI_HOME || path.join(os.homedir(), '.pi', 'agent')
const home = () => process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

function envName(providerId) {
  return providerId.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase() + '_API_KEY'
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export default {
  name: 'dsh-pi-llm',
  apply(ctx) {
    try {
      const piModels = readJson(path.join(piHome(), 'models.json'))
      if (!piModels?.providers) {
        ctx.logger?.debug?.('dsh-pi-llm: no pi models.json found')
        return
      }
      const piSettings = readJson(path.join(piHome(), 'settings.json')) || {}

      const settingsFile = path.join(home(), 'settings.yaml')
      const credFile = path.join(home(), '.credentials.yaml')
      let settings = {}
      let creds = {}
      try { settings = YAML.parse(fs.readFileSync(settingsFile, 'utf8')) || {} } catch { settings = {} }
      try { creds = YAML.parse(fs.readFileSync(credFile, 'utf8')) || {} } catch { creds = {} }

      const providers = settings['llm-pi-ai']?.providers || {}
      const norm = (u) => (u || '').replace(/\/+$/, '')
      const knownBases = new Set(Object.values(providers).map((p) => norm(p?.baseURL)).filter(Boolean))
      let added = 0
      let keysAdded = 0

      for (const [id, p] of Object.entries(piModels.providers)) {
        if (!p?.baseUrl || !p?.api) continue
        if (knownBases.has(norm(p.baseUrl))) continue // already covered
        const keyName = envName(id)
        providers[id] = {
          apiKeyEnv: keyName,
          baseURL: p.baseUrl,
          api: p.api,
          models: (p.models || []).map((m) => ({ id: m.id })),
        }
        knownBases.add(norm(p.baseUrl))
        added++
        if (p.apiKey && creds[keyName] === undefined) {
          creds[keyName] = p.apiKey
          keysAdded++
        }
      }

      let changed = false
      if (added > 0) {
        settings['llm-pi-ai'] = settings['llm-pi-ai'] || {}
        settings['llm-pi-ai'].providers = providers
        changed = true
      }
      if (!settings['agent-default-model'] && piSettings.defaultProvider && piSettings.defaultModel) {
        settings['agent-default-model'] = { provider: piSettings.defaultProvider, model: piSettings.defaultModel }
        changed = true
      }
      if (changed) {
        fs.writeFileSync(settingsFile, YAML.stringify(settings))
      }
      if (keysAdded > 0) {
        fs.writeFileSync(credFile, YAML.stringify(creds))
        try { fs.chmodSync(credFile, 0o600) } catch { /* best effort */ }
      }
      ctx.logger?.info?.(
        `dsh-pi-llm: mirrored ${added} pi provider(s) into dsh (${keysAdded} credential(s) migrated)`,
      )
    } catch (e) {
      ctx.logger?.warn?.(`dsh-pi-llm: ${e.message}`)
    }
  },
}
