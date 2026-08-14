# @dsh-pi/fff

pi-style frecency-ranked search tools for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh-pi).

Registers two tools on `ctx.tools`, powered by the [FFF engine](https://github.com/dmtrKovalenko/fff) (`@ff-labs/fff-node`, native Rust core):

- **`ffgrep`** — grep file contents. Smart-case, auto-detects regex vs literal. **Results ranked by frecency (most-accessed files first)**; matches within a file stay in source order.
- **`fffind`** — fuzzy, typo-resistant file search by name pattern. **Frecency-ranked**.

The FFF engine's frecency DB is persisted per workspace under `$DSH_HOME/dsh-pi/fff-<workspace>.db`, so access rankings build up across sessions — same behavior as pi's `ffgrep`/`fffind` (from `@ff-labs/pi-fff`).

## Install into a profile

```sh
dsh plugin --profile web add @dsh-pi/fff        # published, or:
dsh plugin --profile web add file:/abs/path/to/dsh-pi-fff
```

The bundle auto-registers in the profile manifest (adds a `dsh-pi-tools` row mounting the plugin). Restart the profile (`dsh web` / `dsh --profile <name>`).

## Requirements

- dsh ≥ 0.1.0-rc.6 (provides `@deepseek-ai/dsh-tools` in the profile's module tree)
- The plugin resolves `@deepseek-ai/dsh-tools` from the profile node_modules; `@ff-labs/fff-node` (+ its platform binary) is installed as a dependency.

## Tool parameters

`ffgrep`: `pattern` (required) · `path` (default: session workspace) · `limit` (default 20)

`fffind`: `pattern` (required) · `path` (default: session workspace) · `limit` (default 30)

Output matches pi-fff's format: per-file blocks in frecency order, `path:line: content`,
with `[VERY often touched file]` / `[often touched file]` annotations for hot files.

## Layout

| File | Role |
|---|---|
| `index.js` | Cordis plugin (registers `ffgrep` + `fffind` via `defineTool`) |
| `cordis.patch.yml` | bundle patch — inserts the `dsh-pi-tools` row |
| `package.json` | declares `dsh.bundle.patch` + `@ff-labs/fff-node` dependency |

## License

MIT
