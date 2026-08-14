# @dsh-pi/prompt

pi-style system prompt for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), aka dsh-pi.

Transplants pi's prompt philosophy into dsh as a **Cordis plugin bundle**:

- **complete mode** — the model sees only this section as its system prompt (dsh's default identity / tool-guidance text is replaced)
- **pi-style persona** — `You are an expert coding assistant operating inside dsh-pi...`
- **tool one-liners** — `Available tools:` list in pi's format
- **guidelines** — concise responses, clear file paths, small precise changes, verify with tests
- **cwd line** — injected as a dynamic PromptContext

Zero dependencies: the plugin only uses `ctx.systemPrompt`, which ships in the `@deepseek-ai/dsh-base` bundle.

## Install into a profile

```sh
# from anywhere, with dsh on PATH:
dsh plugin --profile web add file:/abs/path/to/dsh-pi-prompt     # or an npm/git spec
```

Then register the bundle in the profile's manifest:

```sh
# edit ~/.dsh/profiles/<name>/package.json:
#   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-pi/prompt" ] } }
```

Restart the profile: `dsh web` (or `dsh --profile <name>`). Done — the system prompt is now pi-style.

> `dsh plugin --profile <name> add <pkg>` forwards `pnpm add` into the profile
> directory (`~/.dsh/profiles/<name>`), so the bare package name resolves from
> the profile's `node_modules`. Any other profile or machine repeats the two
> steps above; sessions/config stay per-profile.

## Configure

The bundle's patch inserts row id `dsh-pi-prompt`. Override it from a higher
patch layer (e.g. the profile's own `cordis.patch.yml`):

```yaml
- id: dsh-pi-prompt
  config:
    complete: true          # default; false keeps dsh's other prompt sections
    persona: "Your custom persona text"   # override the whole persona
    includeCwd: false       # drop the "Current working directory" line
```

Patch files are HMR'd — changes apply without a restart.

## Publish

```sh
npm publish --access public   # from this directory
# then on any machine: dsh plugin --profile web add @dsh-pi/prompt
```

## Layout

| File | Role |
|---|---|
| `index.js` | Cordis plugin (default export; `inject: ['systemPrompt']`) |
| `cordis.patch.yml` | bundle patch — inserts the `dsh-pi-prompt` row |
| `package.json` | declares `dsh.bundle.patch` |

## License

MIT
