#!/usr/bin/env node
// @dsh-pi/tui — exit tests for the pure helpers (run: DSH_PI_TUI_TEST=1 node test.js)
//
// Verifies the /tools full feature contract: full tool-call arguments and
// tool-result payloads are retained on the message (no 140-char truncation),
// and each message carries a first-line summary for the collapsed /tools on
// view. Also covers the nested content walkers used by image rendering and
// history rebuilds.
import { collectImageBlocks, contentText, reasoningBlocks, reasoningSummary, toolCallInfo, toolResultMessage, cycleModelSelection, resolveModelArg, formatTokens, shortenPath, pickImageMime, recentSessions, exportSessionMarkdown, exportSessionJson, exportFileName, sessionTitleFromEvents } from './index.js'

let failed = 0
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok - ${name}`)
  } else {
    failed++
    console.error(`FAIL - ${name}${detail !== undefined ? `\n  got: ${JSON.stringify(detail)}` : ''}`)
  }
}
const eq = (a, b) => a === b

// ---- tool/call ---------------------------------------------------------------

const callInfo = toolCallInfo({
  name: 'bash',
  callId: 'c1',
  arguments: '{"cmd":"ls -la","timeout":30}',
})
check('toolCallInfo keeps full pretty text', eq(callInfo.text, 'bash\n{\n  "cmd": "ls -la",\n  "timeout": 30\n}'), callInfo.text)
check('toolCallInfo summary is name + compact args', eq(callInfo.summary, 'bash  {"cmd":"ls -la","timeout":30}'), callInfo.summary)

const bigArgs = '{"payload":"' + 'x'.repeat(1000) + '"}'
const bigCall = toolCallInfo({ name: 'write', callId: 'c2', arguments: bigArgs })
check('toolCallInfo keeps full args beyond 140 chars', bigCall.text.length > 1000, bigCall.text.length)
check('toolCallInfo summary caps at 300 with ellipsis', eq(bigCall.summary.length, 300 + 1 + 'write  '.length) && bigCall.summary.endsWith('…'), bigCall.summary)
check('toolCallInfo full text contains the whole payload', bigCall.text.includes('x'.repeat(1000)), bigCall.text.length)

const rawCall = toolCallInfo({ name: 'fff', callId: 'c3', arguments: 'not json' })
check('toolCallInfo falls back to raw non-JSON args', eq(rawCall.text, 'fff\nnot json'), rawCall.text)

const emptyCall = toolCallInfo({ name: 'noop', callId: 'c4' })
check('toolCallInfo handles missing args', eq(emptyCall.text, 'noop'), emptyCall.text)

// ---- tool/result -------------------------------------------------------------

const payload = (blocks) => ({ message: { content: blocks } })
const txtBlock = (text) => ({ type: 'text', text })

const okInfo = toolResultMessage(payload([
  txtBlock('line one\nline two\nline three'),
]))
check('toolResult success keeps full payload text', eq(okInfo.text, 'line one\nline two\nline three'), okInfo.text)
check('toolResult success summary is first line', eq(okInfo.kind, 'result') && eq(okInfo.summary, 'line one'), okInfo)

const longLine = 'y'.repeat(500)
const okLong = toolResultMessage(payload([txtBlock(longLine + '\nz')]))
check('toolResult summary caps long first line', okLong.summary.length < 400 && okLong.summary.endsWith('…'), okLong.summary.length)
check('toolResult full text uncapped', eq(okLong.text, longLine + '\nz'), okLong.text.length)

const emptyResult = toolResultMessage(payload([]))
check('empty toolResult -> null', emptyResult === null, emptyResult)

// nested tool-result block (the payload nests inside a tool-result block)
const nested = toolResultMessage({
  message: {
    content: [
      { type: 'tool-result', content: [txtBlock('nested a\nnested b')] },
    ],
  },
})
check('nested tool-result block is walked', eq(nested.text, 'nested a\nnested b'), nested.text)

// failure via d.error
const errInfo = toolResultMessage({
  callId: 'c5',
  error: { name: 'ToolError', code: 'E_TIMEOUT' },
  message: { content: [txtBlock('command timed out after 30s')] },
}, new Map([['c5', 'bash']]))
check('failed result -> error kind with tool name', eq(errInfo.kind, 'error') && errInfo.summary.startsWith('bash: command timed out'), errInfo)
check('error summary keeps the dim failure-code line', errInfo.summary.includes('E_TIMEOUT'), errInfo.summary)
check('error full text includes full payload', errInfo.text.includes('command timed out after 30s'), errInfo.text)

// failure via nested isError block
const isErr = toolResultMessage({
  callId: 'c6',
  message: { content: [{ type: 'tool-result', isError: true, content: [txtBlock('boom')] }] },
}, new Map([['c6', 'read']]))
check('nested isError -> error kind', eq(isErr.kind, 'error') && isErr.text.startsWith('read: boom'), isErr)

// failure with no message text
const noMsgErr = toolResultMessage({
  callId: 'c7',
  error: { name: 'ToolError' },
  message: { content: [] },
}, new Map([['c7', 'grep']]))
check('failure without text falls back to no-message', noMsgErr.summary.includes('no message'), noMsgErr)

// ---- content walkers ---------------------------------------------------------

check('contentText joins nested blocks', eq(contentText([txtBlock('a'), { type: 'tool-result', content: [txtBlock('b')] }]), 'ab'))
const img = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
check('collectImageBlocks walks nested tool-result', eq(collectImageBlocks([{ type: 'tool-result', content: [img] }]).length, 1))
check('collectImageBlocks skips plain text', eq(collectImageBlocks([txtBlock('x')]).length, 0))

// ---- reasoning (thinking) helpers -------------------------------------------------

check('reasoningSummary collapsed = first line + hidden count', eq(JSON.stringify(reasoningSummary('step one\nstep two\nstep three')), JSON.stringify({ summary: 'step one', hidden: 2 })), reasoningSummary('step one\nstep two\nstep three'))
check('reasoningSummary skips leading blank lines', eq(reasoningSummary('\n\n  the thought  \nmore').summary, 'the thought'), reasoningSummary('\n\n  the thought  \nmore'))
const longThought = 'z'.repeat(500)
check('reasoningSummary caps long first line', reasoningSummary(longThought + '\nrest').summary.length <= 241 && reasoningSummary(longThought).summary.endsWith('…'), reasoningSummary(longThought).summary.length)
check('reasoningSummary empty -> ellipsis', eq(reasoningSummary('  \n').summary, '…'), reasoningSummary('  \n'))
check('reasoningSummary single line -> no hidden', eq(reasoningSummary('only').hidden, 0), reasoningSummary('only'))

const reasBlock = (text) => ({ type: 'reasoning', text })
check('reasoningBlocks picks reasoning blocks in order', eq(reasoningBlocks([txtBlock('a'), reasBlock('think'), { type: 'image', data: 'x', mimeType: 'image/png' }, reasBlock('more')]).map((b) => b.text).join('|'), 'think|more'))
check('reasoningBlocks ignores empty reasoning', eq(reasoningBlocks([reasBlock('')]).length, 0))
check('reasoningBlocks ignores non-reasoning', eq(reasoningBlocks([txtBlock('a')]).length, 0))

// ---- model switching ---------------------------------------------------------

const MODELS = [
  { provider: 'opencode-go', model: 'deepseek-v4-flash' },
  { provider: 'opencode-go', model: 'deepseek-v4-pro' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
]

check('cycle forward wraps to the first entry', eq(cycleModelSelection(MODELS, 'opencode-go', 'deepseek-v4-pro', 'forward'), MODELS[2]), cycleModelSelection(MODELS, 'opencode-go', 'deepseek-v4-pro', 'forward'))
check('cycle backward wraps to the last entry', eq(cycleModelSelection(MODELS, 'opencode-go', 'deepseek-v4-flash', 'backward'), MODELS[3]), cycleModelSelection(MODELS, 'opencode-go', 'deepseek-v4-flash', 'backward'))
check('cycle forward moves within the list', eq(cycleModelSelection(MODELS, 'deepseek-official', 'deepseek-v4-flash', 'forward'), MODELS[3]), cycleModelSelection(MODELS, 'deepseek-official', 'deepseek-v4-flash', 'forward'))
check('cycle on a one-model list is undefined', cycleModelSelection([MODELS[0]], 'opencode-go', 'deepseek-v4-flash', 'forward') === undefined)
check('cycle on an unknown current pair is undefined', cycleModelSelection(MODELS, 'opencode-go', 'nope', 'forward') === undefined)

check('resolve provider/model arg', eq(resolveModelArg(MODELS, 'opencode-go/deepseek-v4-pro'), MODELS[1]), resolveModelArg(MODELS, 'opencode-go/deepseek-v4-pro'))
check('resolve bare model id (unique across providers)', eq(resolveModelArg(MODELS, 'deepseek-v4-pro'), undefined), resolveModelArg(MODELS, 'deepseek-v4-pro')) // appears twice -> ambiguous
check('resolve bare model id unique', eq(resolveModelArg([MODELS[0], MODELS[1]], 'deepseek-v4-pro'), MODELS[1]), resolveModelArg([MODELS[0], MODELS[1]], 'deepseek-v4-pro'))
check('resolve unknown model is undefined', resolveModelArg(MODELS, 'gpt-99') === undefined)
check('resolve unknown provider is undefined', resolveModelArg(MODELS, 'nope/deepseek-v4-flash') === undefined)

// ---- status display helpers -----------------------------------------------------

check('formatTokens small numbers stay raw', eq(formatTokens(0), '0') && eq(formatTokens(999), '999'), formatTokens(999))
check('formatTokens k suffix with one decimal', eq(formatTokens(1234), '1.2k'), formatTokens(1234))
check('formatTokens drops trailing .0', eq(formatTokens(2000), '2k'), formatTokens(2000))
check('formatTokens rounds up', eq(formatTokens(1999), '2k'), formatTokens(1999))
check('formatTokens M suffix', eq(formatTokens(2300000), '2.3M'), formatTokens(2300000))
check('formatTokens clamps negatives', eq(formatTokens(-5), '0'), formatTokens(-5))

check('shortenPath keeps short paths', eq(shortenPath('/a/b/c'), '/a/b/c'))
const longPath = '/home/user/projects/very/long/path/to/somewhere/deep'
const short = shortenPath(longPath)
check('shortenPath truncates long paths', short.length <= 48 && short.startsWith('…'), short)
check('shortenPath keeps the meaningful tail', short.endsWith('deep') && short.includes('/somewhere'), short)
check('shortenPath wide max is a no-op', eq(shortenPath('/a/b', 1000), '/a/b'))

// ---- clipboard mime picking ------------------------------------------------------

check('pickImageMime picks the first supported', eq(pickImageMime(['text/plain', 'image/png', 'image/jpeg']), 'image/png'), pickImageMime(['text/plain', 'image/png', 'image/jpeg']))
check('pickImageMime lowercases + trims', eq(pickImageMime(['IMAGE/PNG ']), 'image/png'), pickImageMime(['IMAGE/PNG ']))
check('pickImageMime handles CRLF listings', eq(pickImageMime(['text/plain\r', 'image/webp\r']), 'image/webp'), pickImageMime(['text/plain\r', 'image/webp\r']))
check('pickImageMime skips mime params', eq(pickImageMime(['image/png; charset=utf-8']), 'image/png'), pickImageMime(['image/png; charset=utf-8']))
check('pickImageMime none -> null', pickImageMime(['text/plain']) === null)
check('pickImageMime empty -> null', pickImageMime([]) === null)

// ---- session resume (/resume) -------------------------------------------------

const SESSIONS = [
  { id: 's-old', title: 'old', createdAt: 100, current: false },
  { id: 's-cur', title: 'current', createdAt: 300, current: true },
  { id: 's-mid', title: 'mid', createdAt: 200, current: false },
  { id: 's-new', title: 'new', createdAt: 400, current: false },
]

check('recentSessions excludes the current session', eq(recentSessions(SESSIONS, 10).map((s) => s.id).join(','), 's-new,s-mid,s-old'), recentSessions(SESSIONS, 10))
check('recentSessions newest-first', eq(recentSessions(SESSIONS, 10)[0].id, 's-new'), recentSessions(SESSIONS, 10))
check('recentSessions caps at n', eq(recentSessions(SESSIONS, 2).length, 2), recentSessions(SESSIONS, 2))
check('recentSessions defensive sort (unsorted input)', eq(recentSessions([SESSIONS[2], SESSIONS[3], SESSIONS[1], SESSIONS[0]], 10).map((s) => s.id).join(','), 's-new,s-mid,s-old'), recentSessions([SESSIONS[2], SESSIONS[3], SESSIONS[1], SESSIONS[0]], 10))
check('recentSessions empty when only current', eq(recentSessions([SESSIONS[1]], 10).length, 0), recentSessions([SESSIONS[1]], 10))
check('recentSessions does not mutate input', eq(SESSIONS.length, 4), SESSIONS)

// ---- session export ---------------------------------------------------------
// A realistic event log: title, a user turn with a tool call + result, and a
// second user turn with reasoning + answer. Shapes mirror the live dsh log.
const EXPORT_EVENTS = [
  { type: 'session/title', seq: 0, time: 1700000000000, data: { title: 'My session' } },
  { type: 'turn/start', seq: 1, time: 1700000001000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1700000001000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'list files' }] } },
  { type: 'assistant/message', seq: 3, time: 1700000002000, data: { message: { content: [{ type: 'tool-call', name: 'bash', arguments: '{"cmd":"ls"}' }] } } },
  { type: 'tool/call', seq: 4, time: 1700000002000, data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
  { type: 'tool/result', seq: 5, time: 1700000003000, data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: 'a.txt' }] }] } } },
  { type: 'turn/end', seq: 6, time: 1700000004000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'user/message', seq: 7, time: 1700000005000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'now summarize' }] } },
  { type: 'assistant/message', seq: 8, time: 1700000006000, data: { message: { content: [
    { type: 'reasoning', text: 'line one\nline two' },
    { type: 'text', text: 'here is the summary' },
  ] } } },
]

const md = exportSessionMarkdown({ id: 'session-12345678-abcd', title: 'My session', createdAt: 1700000000000, events: EXPORT_EVENTS })
check('export markdown has title header', md.startsWith('# My session\n'), md.slice(0, 60))
check('export markdown lists session id', md.includes('session: `session-12345678-abcd`'), md)
check('export markdown includes user prompt', md.includes('## You') && md.includes('list files'), md)
check('export markdown includes assistant answer', md.includes('## Assistant') && md.includes('here is the summary'), md)
check('export markdown includes reasoning blockquote', md.includes('> **thinking**') && md.includes('> line one'), md)
check('export markdown includes tool call with args', md.includes('### ⚙ bash') && md.includes('"cmd":"ls"'), md)
check('export markdown includes tool result', md.includes('✓ tool result') && md.includes('a.txt'), md)
check('export markdown skips log-only rows', !md.includes('turn/start') && !md.includes('reason:'), md)
check('export markdown collapses blank runs', !md.includes('\n\n\n'), md)

// title fallback from the log when no title arg is passed
check('sessionTitleFromEvents picks the latest title', eq(sessionTitleFromEvents(EXPORT_EVENTS), 'My session'), sessionTitleFromEvents(EXPORT_EVENTS))
const noTitle = exportSessionMarkdown({ id: 'session-x', events: [] })
check('export markdown falls back for untitled/empty', noTitle.startsWith('# Untitled session') && noTitle.includes('events: 0'), noTitle)

const json = JSON.parse(exportSessionJson({ id: 'session-12345678-abcd', title: 'My session', createdAt: 1, events: EXPORT_EVENTS }))
check('export json round-trips all events', json.events.length === EXPORT_EVENTS.length && json.session.id === 'session-12345678-abcd', json)
check('export json keeps raw event data', eq(json.events[1].data.turn, 1) && eq(json.events[4].data.callId, 'c1'), json.events)

const base = exportFileName('session-12345678-abcd', new Date(2026, 0, 2, 3, 4, 5)) // local time
check('export file name is dsh-session-<short>-<stamp>', eq(base, 'dsh-session-12345678-20260102-030405'), base)

// a compaction checkpoint lands as a user/Context message (surface replace) and
// renders as a Context section, not a prompt
const compacted = exportSessionMarkdown({ id: 'session-x', events: [
  { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: '<compacted-summary>…' }] } },
] })
check('export markdown labels compacted checkpoint as Context', compacted.includes('## Context') && compacted.includes('<compacted-summary>…'), compacted)

console.log(failed ? `\n${failed} failure(s)` : '\nall tests passed')
process.exit(failed ? 1 : 0)
