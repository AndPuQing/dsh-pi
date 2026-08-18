# @dsh-pi/web

The web surface for dsh-pi: a **second renderer of the same live runtime**. One
dsh runtime (the `pi-embed` profile) is booted once per process; the browser
subscribes to its session/event stream over SSE — no polling, no separate
process, no ownership conflicts. The process that owns the runtime stays the
session's single live writer; the browser just renders and forwards input.

## Two entry modes

```sh
dsh-pi tui --serve [port]      # TUI + web on the SAME session (default port 8123)
dsh-pi serve [session-id]      # headless hub — the browser is the only surface
dsh-pi-web [session-id] [--port 8123] [--host 127.0.0.1] [--new]
```

Open the printed URL (default `http://127.0.0.1:8123/`). The page shows the
session transcript — user/assistant messages, streaming chunks, collapsible
reasoning blocks, tool calls/results, compaction markers, titles — and can:

- **chat** (send prompts into the live agent),
- **switch / new sessions** (sidebar list, same as the TUI's `/sessions`),
- **rename** (double-click the title),
- **interrupt** a running turn,
- **switch model** (applies from the next reply).

`serve` without a session id resumes the TUI's last session for the working
directory (then the newest one on disk); `--new` starts a fresh session. If the
target session is live in another process (e.g. a running TUI), attach a web
surface to it instead with `dsh-pi tui --serve`.

## API

| Route | Purpose |
|---|---|
| `GET /` | the page |
| `GET /api/state` | session snapshot (id/title/model/busy) |
| `GET /api/sessions` | session list for this cwd |
| `GET /api/models` | available models |
| `GET /events` | SSE: `hello` (full replay + meta), `event` (live), `state` (busy/title/model), `ping` |
| `POST /api/prompt` | `{ text }` — send a message |
| `POST /api/interrupt` | stop the running turn |
| `POST /api/session` | `{ id }` switch · `{ action: 'new' }` · `{ action: 'rename', title }` |
| `POST /api/model` | `{ provider, model }` |

## Security

The server binds `127.0.0.1` by default and has **no auth** — don't expose it
with `--host 0.0.0.0` to an untrusted network.

## License

MIT
