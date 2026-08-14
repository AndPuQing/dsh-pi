# dsh-pi

The main package: pi on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — one command to set up, run and drive dsh-pi.

```sh
dsh-pi setup pi            # create a web profile; new sessions default to pi
dsh-pi setup job headless  # headless (one-shot task) profile
dsh-pi tui                 # launch the terminal UI (@dsh-pi/tui)
dsh-pi web [name]          # boot a web profile (default: pi)
```

## How it works

- `setup` (web) installs **`@dsh-pi/preset`** — which pulls `prompt` / `fff` / `tools`, makes `dsh-pi` the default agent preset (pi prompt + frecency search + pi edit), and installs the preset composition into the auto-discovered user root. New sessions are pi out of the box.
- `setup` (headless) wires the three bundles directly (headless has no agent-preset machinery).
- `tui` launches the pi-style terminal chat (Editor + Markdown + ScrollView) driving a local `pi-sdk` runtime over stdio JSON-RPC.

Requires `dsh` (on PATH or `DSH_BIN`; otherwise auto-fetched via `npx @deepseek-ai/dsh`).

## Environment

- `DSH_HOME` — harness home (default `~/.dsh`)
- `DSH_BIN` — dsh binary override
- `DSH_PI_PROVIDER` / `DSH_PI_MODEL` — model route override for the TUI (default: `settings.yaml` `agent-default-model`)

## Packages

| Package | Role |
|---|---|
| `dsh-pi` | this entry point |
| `@dsh-pi/preset` | default agent preset + installer |
| `@dsh-pi/prompt` | pi-style system prompt |
| `@dsh-pi/fff` | ffgrep/fffind (frecency search) |
| `@dsh-pi/tools` | pi-interface edit + tool descriptions |
| `@dsh-pi/tui` | terminal UI |

## License

MIT
