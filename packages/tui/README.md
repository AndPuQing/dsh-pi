# @dsh-pi/tui

Terminal UI for dsh-pi. **v0**: a readline-based interactive shell that drives the dsh-pi SDK runtime over stdio JSON-RPC — prompt → stream assistant text + tool calls → repeat.

## Usage

```sh
dsh-pi-tui            # requires dsh on PATH
```

First run auto-creates the `pi-embed` profile (`$DSH_HOME/profiles/pi-embed`: base + @dsh-pi/prompt + fff + tools) and installs its dependencies via `bunx pnpm` / `npx pnpm`.

Controls: type a prompt and Enter; `exit` / `/quit` / Ctrl-C to leave.

## Commands

| Command | Action |
|---------|--------|
| `/help` | show help |
| `/clear` | clear the conversation view (session stays) |
| `/theme <name>` | switch theme (`default`, `light`) |
| `/tools [on|off]` | fold/unfold tool-call details |
| `/sessions` | open the session picker (tree view — select to switch, `d`/`x` deletes with confirmation, `Esc` cancels) |
| `/sessions <n>` | switch to session #n (tree order) |
| `/sessions delete <n>` | delete session #n (the current session is never deletable) |
| `/fork` | branch a child session from this one (shown as a tree child in `/sessions`) |
| `/new` | start a fresh session |
| `/quit`, `exit` | leave |

Sessions are displayed by their runtime-generated title (deterministic first-prompt fallback, then LLM-refined); forked sessions render indented under their parent so the picker navigates the session tree.

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

## Errors & help

Tool failures and model/provider errors render as red `✗` blocks (with a dim
failure-code detail line), instead of being swallowed or shown as plain text;
successful tool results keep the green `✓` line. `/help` prints a structured,
aligned command/key reference.

## Env

- `DSH_PI_PROVIDER` / `DSH_PI_MODEL` — override the model route (default: `agent-default-model` from `$DSH_HOME/settings.yaml`, else `opencode-go` / `deepseek-v4-flash`)
- `DSH_HOME` — harness home (default `~/.dsh`)

## Roadmap

- v2 (done): slash commands, theme switching (default/light), tool-call folding, Ctrl-L clear, session continuity with self-heal
- v2.1 (done): loader spinner, app shortcuts, input history, session titles / delete / tree navigation

## License

MIT
