# @dsh-pi/runtime

The shared in-process pi runtime for dsh-pi surfaces. **One dsh runtime, N
rendering surfaces**: the TUI (`@dsh-pi/tui`) and the web surface
(`@dsh-pi/web`) both mount on the same `createPiRuntime()` — a single live
agent whose `session/event` stream every surface subscribes to. The process
that owns the runtime is the session's one live writer; surfaces are
renderers plus input forwarders, so a terminal and a browser can operate one
session simultaneously with zero latency and no "session is in use" conflicts.

```js
import { createPiRuntime } from '@dsh-pi/runtime'

const runtime = await createPiRuntime()
runtime.prompt('hello')
runtime.onEvent((session, event) => console.log(event.type))
```

## API

- `createPiRuntime({ onSubagent, onSwitched, initialSessionId })` — boot the
  `pi-embed` profile in-process and own one live agent. `initialSessionId`
  resumes a persisted session (headless serve); `null` (default) creates a
  fresh one.
- Runtime surface: `sessionId` (getter), `sessionMeta()`, `currentEvents()`
  (projected replay), `currentTitle()`, `onEvent(cb)`, `onSwitched(cb)`,
  `prompt(text)`, `interrupt()`, `listSessions()`, `switchSession(id)`,
  `newSession()`, `forkSession()`, `deleteSession(id)`, `renameSession(title)`,
  `listModels()`, `setModel(provider, model)`, `conversationHistory(agent)`,
  `exportSession(dir)`, `compact()`, `readImage(ref)`, `dispose()`.
- Shared helpers: content-block walkers, tool-call/result shaping, session
  export (markdown + JSON), on-disk session scan, per-cwd "last session"
  state, model-route resolution (`defaultModel()`).

## Env

- `DSH_HOME` — harness home (default `~/.dsh`)
- `DSH_PI_PROVIDER` / `DSH_PI_MODEL` — model route override (default:
  `settings.yaml` `agent-default-model`)

## License

MIT
