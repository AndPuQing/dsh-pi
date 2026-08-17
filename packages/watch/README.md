# @dsh-pi/watch

Real-time **TUI→Web** session mirror for dsh-pi. Boots the same in-process dsh
runtime as the TUI (`pi-embed` profile), then serves a self-contained web page
that streams a target session's events in near-real-time over SSE.

The TUI (or any dsh surface) remains the **single live writer** — `watch` only
**reads** the durable log through the persistence seam, so it never contends
for session ownership ("session is in use") and keeps working after the TUI
process exits (the page shows the full history and continues to tail any new
appends).

## How it works (Route A: log tailing)

Sessions are event-sourced append-only logs (`$DSH_HOME/sessions/…`). The
watcher follows the log like a database replica:

1. **Initial view** — `ctx.sessionPersistence.inspect(id)` returns the balanced
   logical log (handles torn tails / interrupted turns).
2. **Incremental tail** — every `--poll` ms it calls `listSnapshots()` (cheap
   per-log revision tokens: device / inode / size / timestamps) and only when
   the target's revision changed does it call `readFrom(id, lastSeq)` to pull
   the new events.
3. Events are pushed to browsers over SSE (`/events`); the page assembles the
   transcript the same way the TUI renders it (streaming assistant chunks,
   collapsible reasoning, tool calls/results, compaction markers, titles).

Latency ≈ poll interval + the persistence write-batch window (hundreds of ms),
i.e. sub-second. Note the JSONL persistence backend parses the whole artifact
on `readFrom` and skips forward (a documented backend property); a SQLite
persistence backend would bound the physical read to the suffix.

## Usage

```sh
dsh-pi watch                # watch the TUI's last session for this working directory
dsh-pi watch <session-id>   # explicit session (bare uuid or session-<uuid>)
dsh-pi watch --port 9000 --poll 300 <session-id>
dsh-pi-watch <session-id>   # same, via the bin directly
```

Then open the printed URL (default `http://127.0.0.1:8123/`). The page shows
the live transcript, a live/idle indicator (turns idle ~5 s after the writer
stops appending), and keeps scrolling with new events.

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `8123` | HTTP port (loopback only by default) |
| `--poll` | `500` | tail poll interval in ms (100..60000) |
| `--host` | `127.0.0.1` | bind address — keep loopback unless you need LAN access |

## Env

- `DSH_HOME` — harness home (default `~/.dsh`); **must match the TUI's** so the
  session logs are shared.
- `DSH_BIN` is not used — like the TUI, the runtime boots in-process.

## Notes & limits

- Read-only by design: watching a session never blocks the writer and never
  takes ownership. Sending messages to the watched session still belongs to the
  TUI.
- Sessions are resolved from the same `$DSH_HOME` regardless of working
  directory; the TUI's per-cwd "last session" file is used only as the default
  pick when no id is given.
- No auth — the HTTP server binds `127.0.0.1` by default; do not expose
  `--host 0.0.0.0` to untrusted networks.

## License

MIT
