# @dsh-pi/tools

pi-compatible tool surface for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh-pi), aligning the model-visible tool layer with pi's:

1. **`edit` tool** — pi's exact interface: `path` + `edits[]` with `oldText`/`newText`. Every `oldText` must match a **unique, non-overlapping** region of the **original** file; edits are validated like pi and applied in one call. (pi's description is used verbatim.)
2. **Description alignment** — via the `system-prompt/assemble` waterfall, the model-visible descriptions of `read` / `write` / `bash` are rewritten to pi's wording. `bash` keeps a one-line sandbox-escalation note so dsh's denial policy is not lost.

## Install into a profile

```sh
dsh plugin --profile web add @dsh-pi/tools        # published, or:
dsh plugin --profile web add file:/abs/path/to/dsh-pi-tools
```

The bundle auto-registers in the profile manifest. Restart the profile.

## Config

| Field | Default | Meaning |
|---|---|---|
| `alignDescriptions` | `true` | rewrite read/write/bash descriptions to pi wording |

## Notes

- Param names (`path` vs `file_path`) are intentionally NOT renamed: execution binds by parameter name, and rewriting schemas would break calls. The model adapts (observed using both styles).
- `str_replace_editor` remains available as the native dsh editor; the persona tool list steers toward `edit` for pi-style precision.
- Requires dsh ≥ 0.1.0-rc.6 (`@deepseek-ai/dsh-tools` resolves from the profile module tree).

## Layout

| File | Role |
|---|---|
| `index.js` | Cordis plugin (registers `edit`, installs the assemble description listener) |
| `cordis.patch.yml` | bundle patch — inserts the `dsh-pi-tools` row |
| `package.json` | declares `dsh.bundle.patch` |

## License

MIT
