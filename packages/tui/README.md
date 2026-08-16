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
| `/model` | open the model picker (all registered providers/models; select to switch) |
| `/model <provider>/<model>` | switch model directly (a bare model id works when it resolves to exactly one provider) |
| `/tools [on|off|full]` | tool details: `on` = first-line summaries (default), `full` = complete output, `off` = folded (bare `/tools` cycles) |
| `/sessions` | open the session picker (tree view — select to switch, `d`/`x` deletes with confirmation, `Esc` cancels) |
| `/sessions <n>` | switch to session #n (tree order) |
| `/sessions delete <n>` | delete session #n (the current session is never deletable) |
| `/resume` | pick a recent session to switch to — the N newest non-current sessions, flat list (newest first); selecting one switches immediately |
| `/resume <n>` | switch to the n-th most recent session |
| `/fork` | branch a child session from this one (shown as a tree child in `/sessions`) |
| `/new` | start a fresh session |
| `/stop` | interrupt the running turn (same as `Esc`) |
| `/quit`, `exit` | leave |

Sessions are displayed by their runtime-generated title (deterministic first-prompt fallback, then LLM-refined); forked sessions render indented under their parent so the picker navigates the session tree. **Ctrl+R** renames the current session: the title is written through dsh's own title service (`session/title` event with a `user` source), which pins it — later prompts stop re-titling — and persists with the session log, so the new title shows in the status line, `/sessions` and `/resume` everywhere. `/resume` is the quick-switch entry: the most recent non-current sessions in a flat, newest-first list (current excluded — it is already active).

Shortcuts (registered via pi-tui `KeybindingsManager`, ids mirror pi's `app.*` defaults):

| Key | Action |
|-----|--------|
| `Esc` | interrupt the running turn (no-op when idle) |
| `Ctrl+N` | new session |
| `Ctrl+T` | expand/collapse reasoning (thinking); `/theme` switches themes |
| `Ctrl+R` | rename the current session (Enter saves, Esc cancels) |
| `Ctrl+P` | cycle to the next model (`Shift+Ctrl+P` = previous); `/model` picks from a list |
| `Ctrl+O` | toggle tool output expansion (`on` <-> `full`) |
| `Ctrl+K` | clear the conversation view (shadows the editor's kill-to-line-end) |
| `Ctrl+Q` | quit |
| `Ctrl+L` | clear (legacy alias) |
| `↑` / `↓` | browse input history (per-session, in-memory) |

## Tool details

Tool calls and results keep their **complete** text (pretty-printed arguments,
full result payload) — nothing is truncated. What you see depends on the
`/tools` mode:

| Mode | Tool call | Tool result |
|------|-----------|-------------|
| `on` (default) | tool name + one-line compact arguments | first line of the result |
| `full` | full pretty-printed arguments | entire result payload |
| `off` | tool name only | `…` |

When a summary hides content, a dim `… N more lines — Ctrl+O expands` hint
shows under the entry. `Ctrl+O` (pi-style) toggles between `on` and `full`;
bare `/tools` cycles `off → on → full`. Failed tool results stay visible in
`error` style in every mode — `full` only expands their payload.

## Reasoning

Reasoning (thinking) blocks — common with DeepSeek-family models, where they
can dominate the output — stream into the TUI as their own block instead of
being dropped. They render like pi's thinking blocks: **collapsed to a one-line
summary by default**, dim-italic via the theme's `reasoning` style, with a
`… N more lines — Ctrl+T expands` hint when content is hidden. `Ctrl+T`
toggles every reasoning block between collapsed and expanded.

Reasoning is kept separate from the answer text: `contentText`/history rebuilds
skip it, so restoring a session shows the same collapsed summary.

## Images

When a tool result or the model output carries image blocks (durable dsh
attachment refs, pi-style inline base64, or `data:` URIs), the TUI renders them
inline with pi-tui's `Image` component using the Kitty graphics protocol (Kitty,
Ghostty, WezTerm) or iTerm2 inline images. On terminals without either protocol
it falls back to a text placeholder (`[Image: …]`). http(s) image URLs are not
fetched from the TUI — they show as `[image: <url>]`.

Images from tool results fold with `/tools off`; image rendering survives
`/clear` and session switches (images are rebuilt from the session log).

## Models

The model route is fixed at startup unless you switch it in-session: `/model`
opens a picker over every registered provider route and their models (from the
same `ctx.llm` catalog the web Models page uses), and `Ctrl+P` / `Shift+Ctrl+P`
cycle forward/backward through that list (pi's `app.model.cycleForward` /
`cycleBackward` semantics). The switch applies to the **next** prompt of the
current session and to every new/restored session — new agents are created and
resumed with the new `provider`/`model`, and the status line updates
immediately. The selection is persisted to `agent-default-model` in
`$DSH_HOME/settings.yaml` (best-effort; without a settings provider it stays
in-memory), so the next TUI run starts on the last model you chose.

## Errors & help

Tool failures and model/provider errors render as red `✗` blocks (with a dim
failure-code detail line), instead of being swallowed or shown as plain text;
successful tool results keep the green `✓` line. `/help` prints a structured,
aligned command/key reference.

## Env

- `DSH_PI_PROVIDER` / `DSH_PI_MODEL` — override the model route (default: `agent-default-model` from `$DSH_HOME/settings.yaml`, else `opencode-go` / `deepseek-v4-flash`); in-session `/model` / `Ctrl+P` switches override this for the rest of the run and persist to `settings.yaml`
- `DSH_HOME` — harness home (default `~/.dsh`)

## Roadmap

- v2 (done): slash commands, theme switching (default/light), tool-call folding, Ctrl-L clear, session continuity with self-heal
- v2.1 (done): loader spinner, app shortcuts, input history, session titles / delete / tree navigation
- v2.2 (done): reasoning (thinking) blocks — collapsed one-line summary, Ctrl+T expand/collapse
- v2.3 (done): session rename (Ctrl+R) + quick resume (`/resume`)

## License

MIT
