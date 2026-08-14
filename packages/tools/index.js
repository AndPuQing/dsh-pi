// @dsh-pi/tools: pi-compatible tool surface for DeepSeek Harness.
// 1) Registers a pi-interface `edit` tool (path + edits[] with oldText/
//    newText, unique + non-overlapping match against the ORIGINAL file)
//    on every agent's scoped context — the official per-agent variant
//    path — shadowing dsh's global single-replacement `edit` for that
//    agent. `agent/created` carries `{ agent }`; agent.ctx.tools is the
//    agent's scope layer (agent → preset → global, nearest shadows).
// 2) Aligns the model-visible descriptions of read/write/bash with pi's
//    wording via the system-prompt assemble waterfall.
import fs from 'node:fs'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PI_EDIT_DESC =
  'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.'

const PI_READ_DESC =
  'Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.'

const PI_WRITE_DESC =
  'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does. Automatically creates parent directories.'

// dsh's own bash description carries sandbox/escalation policy that must not
// be lost; keep pi's concise opener but retain the one critical rule.
const PI_BASH_DESC =
  'Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the tail; full output is saved to a file when available. A denied command is final unless escalated with sandbox_permissions (see parameters).'

const DESCRIPTIONS = {
  read: PI_READ_DESC,
  write: PI_WRITE_DESC,
  bash: PI_BASH_DESC,
}

function editToolDefinition() {
  return defineTool({
    name: 'edit',
    description: PI_EDIT_DESC,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path of the file to edit.',
      },
      edits: {
        type: 'array',
        required: true,
        description:
          'List of precise replacements. Each edits[].oldText must match a unique, non-overlapping region of the original file.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            oldText: {
              type: 'string',
              description: 'Exact text to find (must appear exactly once in the original file).',
            },
            newText: {
              type: 'string',
              description: 'Replacement text.',
            },
          },
        },
      },
    },
    timeoutMs: 30000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          applied: { type: 'integer' },
          diff: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.diff }],
    },
    async execute(args, exec) {
      const p = path.resolve(exec?.agent?.session?.header?.cwd ?? process.cwd(), args.path)
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error('edit: edits must be a non-empty array of { oldText, newText }')
      }
      for (const e of args.edits) {
        if (typeof e?.oldText !== 'string' || typeof e?.newText !== 'string') {
          throw new Error('edit: every edit needs string oldText and newText')
        }
      }
      let original
      try {
        original = fs.readFileSync(p, 'utf8')
      } catch (e) {
        throw new Error(`edit: cannot read ${p}: ${e.message}`)
      }
      // pi semantics: match every oldText against the ORIGINAL file; each
      // must be unique, and regions must not overlap.
      const found = []
      for (const [i, e] of args.edits.entries()) {
        let count = 0
        let at = -1
        let idx = 0
        while ((idx = original.indexOf(e.oldText, idx)) !== -1) {
          count++
          if (at === -1) at = idx
          idx += Math.max(e.oldText.length, 1)
        }
        if (count === 0) {
          throw new Error(`No matches found for edits[${i}].oldText: ${JSON.stringify(e.oldText.slice(0, 60))}`)
        }
        if (count > 1) {
          throw new Error(`Multiple matches (${count}) for edits[${i}].oldText: ${JSON.stringify(e.oldText.slice(0, 60))}`)
        }
        found.push({ e, at })
      }
      const sorted = [...found].sort((a, b) => a.at - b.at)
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]
        const cur = sorted[i]
        if (cur.at < prev.at + prev.e.oldText.length) {
          throw new Error('Overlapping edits: regions must not overlap')
        }
      }
      // apply from the end so earlier positions stay valid
      const ordered = [...found].sort((a, b) => b.at - a.at)
      let result = original
      for (const { e, at } of ordered) {
        result = result.slice(0, at) + e.newText + result.slice(at + e.oldText.length)
      }
      fs.writeFileSync(p, result)
      return {
        path: p,
        applied: args.edits.length,
        diff: `Edited ${p}: ${args.edits.length} change${args.edits.length > 1 ? 's' : ''} applied.`,
      }
    },
  })
}

export default {
  name: 'dsh-pi-tools',
  apply(ctx, config = {}) {
    // Per-agent pi-interface `edit` (official per-agent variant path:
    // agent/created carries { agent }; agent.ctx.tools shadows the global).
    ctx.on('agent/created', ({ agent }) => {
      const tools = agent?.ctx?.tools
      if (!tools) return
      try {
        tools.register(editToolDefinition())
      } catch {
        /* another variant already registered for this agent */
      }
    })

    // Align model-visible descriptions of the core tools with pi's wording.
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const assembled = await next()
      if (config.alignDescriptions === false) return assembled
      const tools = assembled?.tools
      if (!Array.isArray(tools)) return assembled
      return {
        ...assembled,
        tools: tools.map((t) =>
          DESCRIPTIONS[t.name] ? { ...t, description: DESCRIPTIONS[t.name] } : t,
        ),
      }
    })
  },
}
