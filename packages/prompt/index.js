// @dsh-pi/prompt: pi-style system prompt for DeepSeek Harness (dsh-pi).
// Cordis plugin. Builds the system prompt dynamically at every assembly:
//   - "Available tools:" one-liners are rendered from the ACTUAL assembled
//     tool schemas (never a hardcoded list), like pi's prompt.
//   - By default the assembled sections are replaced with this single
//     persona section (complete behavior), with pi's guidelines + cwd line.
//
// Runtime behavior is configurable through the mounted row's `config`:
//   - complete: true (default)  replace the whole system prompt with ours
//   - persona:  "<text>"        override the persona text (skips the tool list)
//   - includeCwd: false         skip the "Current working directory" line

const PERSONA_HEAD = `You are an expert coding assistant operating inside dsh-pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`

const GUIDELINES = `Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Prefer small, precise changes; do not rewrite code you were not asked to touch
- Verify your work with the project's existing tests or build commands`

/** First sentence of a tool description, capped — the one-liner for the list. */
function oneLiner(tool) {
  const text = (tool?.description || '').trim()
  const firstLine = text.split(/\r?\n/)[0].trim()
  const first = firstLine.split(/(?<=\.)\s/)[0]?.trim() || firstLine
  const capped = first.length > 100 ? first.slice(0, 97) + '...' : first
  return `- ${tool.name}: ${capped}`
}

function toolsSection(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 'Available tools:\n(none)'
  return `Available tools:\n${tools.map(oneLiner).join('\n')}`
}

function buildPersona(config, tools) {
  if (config.persona) {
    return config.includeCwd === false
      ? config.persona
      : `${config.persona}\n\nCurrent working directory: ${process.cwd()}`
  }
  const parts = [
    PERSONA_HEAD,
    toolsSection(tools),
    'In addition to the tools above, you may have access to other custom tools depending on the project.',
    GUIDELINES,
  ]
  if (config.includeCwd !== false) {
    parts.push(`Current working directory: ${process.cwd()}`)
  }
  return parts.join('\n\n')
}

export default {
  name: 'dsh-pi-prompt',
  inject: ['systemPrompt'],
  apply(ctx, config = {}) {
    const sp = ctx.systemPrompt
    if (!sp) return
    // pi-like minimalism: suppress dsh's dynamic runtime-context snapshots.
    if (config.suppressRuntimeContext !== false) {
      sp.suppressRuntimeContext()
    }
    // Registered WITHOUT the complete flag: complete semantics are applied in
    // the waterfall below (the complete-restore would otherwise clobber the
    // dynamically rendered tool list with this static registration).
    sp.section({
      name: 'dsh-pi:persona',
      order: 0,
      text: () => buildPersona(config, []),
    })

    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next()
      const text = buildPersona(config, assembled?.tools)
      const persona = { name: 'dsh-pi:persona', order: 0, text }
      if (config.complete === false) {
        const sections = (assembled?.sections ?? []).filter((s) => s?.name !== 'dsh-pi:persona')
        return { ...assembled, sections: [...sections, persona] }
      }
      return { ...assembled, sections: [persona] }
    })
  },
}
