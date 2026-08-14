# dsh-pi

pi on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a plugin suite that transplants pi's prompt philosophy, tool behavior, and search ergonomics into dsh.

## Packages

| Package | What it does | Install |
|---|---|---|
| [`@dsh-pi/prompt`](packages/prompt) | pi-style system prompt: complete-mode persona, tool one-liners, guidelines, cwd line | `dsh plugin --profile <name> add @dsh-pi/prompt` |
| [`@dsh-pi/fff`](packages/fff) | `ffgrep` / `fffind` — frecency-ranked content & fuzzy file search (FFF engine) | `dsh plugin --profile <name> add @dsh-pi/fff` |
| [`@dsh-pi/tools`](packages/tools) | pi-interface `edit` (multi-edit `edits[]` with oldText/newText) + pi wording for read/write/bash descriptions | `dsh plugin --profile <name> add @dsh-pi/tools` |

Each package is a dsh bundle: install with `dsh plugin add`, it auto-registers in the profile manifest, restart the profile, done.

## Quick start

```sh
dsh plugin --profile web add @dsh-pi/prompt
dsh plugin --profile web add @dsh-pi/fff
dsh plugin --profile web add @dsh-pi/tools
dsh web
```

## Pre-made profile (one command)

Instead of installing bundles one by one, create a ready-made dsh-pi profile:

```sh
./scripts/setup-profile.sh pi web          # registry mode (after npm publish)
./scripts/setup-profile.sh pi web --local  # dev mode: point at this repo's packages/
dsh --profile pi                            # boot the web UI with all three bundles
```

Also ships a headless variant: `./scripts/setup-profile.sh pi-headless headless` → `dsh --profile pi-headless "task"`.

The generated profile lives in `$DSH_HOME/profiles/<name>`; override the persona via its `cordis.patch.yml`.

Override the persona per-profile via `cordis.patch.yml`:

```yaml
- id: dsh-pi-prompt
  config:
    persona: "Your custom persona text"
```

## Requirements

- dsh ≥ 0.1.0-rc.6 (`@deepseek-ai/dsh-tools` must resolve from the profile module tree)
- `@dsh-pi/fff` pulls `@ff-labs/fff-node` (native FFF engine) as a dependency

## License

MIT — see [LICENSE](LICENSE).
