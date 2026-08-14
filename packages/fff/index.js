// @dsh-pi/fff: pi-style frecency-ranked search tools for DeepSeek Harness.
// Registers `ffgrep` (content search) and `fffind` (fuzzy file search) on
// ctx.tools, powered by the FFF engine (@ff-labs/fff-node), whose native
// frecency tracking orders results most-accessed-first. The frecency DB is
// persisted per workspace under $DSH_HOME/dsh-pi/, so rankings build up
// across sessions exactly like pi's ffgrep/fffind.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileFinder } from '@ff-labs/fff-node'
import { defineTool } from '@deepseek-ai/dsh-tools'

const DEFAULT_GREP_LIMIT = 20
const DEFAULT_FIND_LIMIT = 30
const SCAN_WAIT_MS = 5000
const HOT_FRECENCY = 25
const WARM_FRECENCY = 20
const FIND_WEAK_SAMPLE_SIZE = 5
const MAX_LINE_LENGTH = 500

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function frecencyDbPath(base) {
  const dir = path.join(dshHome(), 'dsh-pi')
  fs.mkdirSync(dir, { recursive: true })
  const slug =
    base
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'root'
  return path.join(dir, `fff-${slug}.db`)
}

function annotation(item) {
  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0
  if (frecency >= HOT_FRECENCY) return '  [VERY often touched file]'
  if (frecency >= WARM_FRECENCY) return '  [often touched file]'
  return ''
}

function truncateLine(line) {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '…' : line
}

function formatGrep(items) {
  if (items.length === 0) return 'No matches found'
  const lines = []
  let current = ''
  for (const m of items) {
    if (m.path !== current) {
      if (lines.length > 0) lines.push('')
      current = m.path
      lines.push(`${current}${annotation(m)}`)
    }
    lines.push(` ${m.line}: ${truncateLine(m.content)}`)
  }
  return lines.join('\n')
}

function hasRegexSyntax(pattern) {
  return pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default {
  name: 'dsh-pi-fff',
  inject: ['tools'],
  apply(ctx, _config = {}) {
    const finders = new Map()
    let creating = null

    async function getFinder(base) {
      const key = path.resolve(base)
      const existing = finders.get(key)
      if (existing) return existing
      if (creating) await creating
      creating = (async () => {
        const created = FileFinder.create({
          basePath: key,
          frecencyDbPath: frecencyDbPath(key),
        })
        if (!created.ok) throw new Error(created.error)
        const finder = created.value
        const ready = finder.waitForScan(SCAN_WAIT_MS).catch(() => {})
        finders.set(key, { finder, ready })
        return { finder, ready }
      })()
      try {
        return await creating
      } finally {
        creating = null
      }
    }

    function workdir(exec) {
      return exec?.agent?.session?.header?.cwd ?? process.cwd()
    }

    function resolveBase(args, exec) {
      const wd = workdir(exec)
      return args.path ? path.resolve(wd, args.path) : wd
    }

    ctx.tools.register(
      defineTool({
        name: 'ffgrep',
        description: `Grep file contents. Smart-case, auto-detects regex vs literal. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
        parameters: {
          pattern: {
            type: 'string',
            required: true,
            description:
              'Search pattern. Bare identifiers are most efficient; a pattern containing regex metacharacters that parses as valid regex is treated as regex, otherwise as a literal.',
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Defaults to the session workspace.',
          },
          limit: {
            type: 'number',
            description: `Maximum number of matches to return (default: ${DEFAULT_GREP_LIMIT})`,
          },
        },
        timeoutMs: 30000,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              root: { type: 'string' },
              count: { type: 'integer' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string' },
                    line: { type: 'integer' },
                    content: { type: 'string' },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{ type: 'text', text: formatGrep(value.items) }],
        },
        async execute(args, exec) {
          const base = resolveBase(args, exec)
          const { finder, ready } = await getFinder(base)
          await ready
          let mode = hasRegexSyntax(args.pattern) ? 'regex' : 'plain'
          if (mode === 'regex') {
            try {
              new RegExp(args.pattern)
            } catch {
              mode = 'plain'
            }
          }
          const limit = Math.max(1, args.limit ?? DEFAULT_GREP_LIMIT)
          const res = finder.grep(args.pattern, { mode, pageSize: limit })
          if (!res.ok) throw new Error(res.error)
          const items = res.value.items.map((m) => ({
            path: m.relativePath,
            line: m.lineNumber,
            content: m.lineContent,
          }))
          return { root: base, count: items.length, items }
        },
      }),
    )

    ctx.tools.register(
      defineTool({
        name: 'fffind',
        description: `Find files by fuzzy name pattern. Typo-resistant. Results are ranked by frecency (most-accessed files first). Default limit ${DEFAULT_FIND_LIMIT}.`,
        parameters: {
          pattern: {
            type: 'string',
            required: true,
            description: 'Fuzzy filename pattern (e.g. "typescropt.ts" matches "typescript.ts").',
          },
          path: {
            type: 'string',
            description: 'Directory to search in. Defaults to the session workspace.',
          },
          limit: {
            type: 'number',
            description: `Maximum number of paths to return (default: ${DEFAULT_FIND_LIMIT})`,
          },
        },
        timeoutMs: 30000,
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              root: { type: 'string' },
              count: { type: 'integer' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string' },
                    frecency: { type: 'number' },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            if (value.items.length === 0) {
              return [{ type: 'text', text: 'No files found matching pattern' }]
            }
            const text = value.items
              .map((i) => `${i.path}${annotation({ accessFrecencyScore: i.frecency })}`)
              .join('\n')
            return [{ type: 'text', text }]
          },
        },
        async execute(args, exec) {
          const base = resolveBase(args, exec)
          const { finder, ready } = await getFinder(base)
          await ready
          const limit = Math.max(1, args.limit ?? DEFAULT_FIND_LIMIT)
          const res = finder.fileSearch(args.pattern, { pageSize: limit })
          if (!res.ok) throw new Error(res.error)
          const topScore = res.value.scores?.[0]?.total ?? 0
          const perfect = args.pattern.length * 12
          const weak = topScore < Math.floor((perfect * 50) / 100)
          const shown = weak
            ? Math.min(FIND_WEAK_SAMPLE_SIZE, res.value.items.length)
            : res.value.items.length
          const items = res.value.items.slice(0, shown).map((i) => ({
            path: i.relativePath,
            frecency: i.accessFrecencyScore ?? 0,
          }))
          return { root: base, count: items.length, items }
        },
      }),
    )

    ctx.on('dispose', () => {
      for (const { finder } of finders.values()) {
        try {
          finder.destroy()
        } catch {
          /* best effort */
        }
      }
    })
  },
}
