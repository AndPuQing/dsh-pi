# @dsh-pi/preset

Makes dsh-pi the **default** for web sessions — no per-session pick, no setup steps.

Installing this bundle into a web profile:

1. Installs the preset composition `agent-presets/dsh-pi/agent.cordis.yml` into the auto-discovered user root `$DSH_HOME/.agent-presets/dsh-pi/` (a tiny plugin copies it at boot; the package stays the source of truth);
2. Patches the `agent-presets` row so new sessions **default to `dsh-pi`** — pi prompt + `ffgrep`/`fffind` + pi-interface `edit`, all on by default.

It depends on `@dsh-pi/prompt`, `@dsh-pi/fff`, `@dsh-pi/tools`, so installing it pulls the whole kit.

## Usage

```sh
dsh plugin --profile web add @dsh-pi/preset
dsh web
```

Existing sessions keep their preset; new sessions default to `dsh-pi`. Headless profiles have no `agent-presets` row and are unaffected.

## License

MIT
