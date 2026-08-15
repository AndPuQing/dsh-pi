# @dsh-pi/tui

Terminal UI for dsh-pi. **v0**: a readline-based interactive shell that drives the dsh-pi SDK runtime over stdio JSON-RPC — prompt → stream assistant text + tool calls → repeat.

## Usage

```sh
dsh-pi-tui            # requires dsh on PATH
```

First run auto-creates the `pi-sdk` profile (`$DSH_HOME/profiles/pi-sdk`: base + @dsh-pi/prompt + fff + tools + the SDK JSON-RPC server) and installs its dependencies via `npx pnpm`.

Controls: type a prompt and Enter; `exit` / `/quit` / Ctrl-C to leave. Each run uses a fresh session (interrupted runs can leave a wedged resume state — session continuity is a v2 item).

Shortcuts (registered via pi-tui `KeybindingsManager`, ids mirror pi's `app.*` defaults):

| Key | Action |
|-----|--------|
| `Ctrl+N` | new session |
| `Ctrl+T` | switch theme (cycles); `/theme` picks from a list |
| `Ctrl+K` | clear the conversation view (shadows the editor's kill-to-line-end) |
| `Ctrl+Q` | quit |
| `Ctrl+L` | clear (legacy alias) |
| `↑` / `↓` | browse input history (per-session, in-memory) |

## Images

When a tool result or the model output carries image blocks (durable dsh
attachment refs, pi-style inline base64, or `data:` URIs), the TUI renders them
inline with pi-tui's `Image` component using the Kitty graphics protocol (Kitty,
Ghostty, WezTerm) or iTerm2 inline images. On terminals without either protocol
it falls back to a text placeholder (`[Image: …]`). http(s) image URLs are not
fetched from the TUI — they show as `[image: <url>]`.

Images from tool results fold with `/tools off`; image rendering survives
`/clear` and session switches (images are rebuilt from the session log).

## Env

- `DSH_PI_PROVIDER` / `DSH_PI_MODEL` — override the model route (default: `agent-default-model` from `$DSH_HOME/settings.yaml`, else `opencode-go` / `deepseek-v4-flash`)
- `DSH_HOME` — harness home (default `~/.dsh`)

## Roadmap

- v2 (done): slash commands, theme switching (default/light), tool-call folding, Ctrl-L clear, session continuity with self-heal

## License

MIT
