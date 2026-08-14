# @dsh-pi/llm

Bridges **pi's model configuration** into DeepSeek Harness as `llm-pi-ai` provider routes — the dsh multi-provider adapter that is itself backed by `@earendil-works/pi-ai`. One model config across both tools.

On boot this bundle:

1. Reads `~/.pi/agent/models.json` (pi's custom providers);
2. Mirrors each provider into `$DSH_HOME/settings.yaml` → `llm-pi-ai.providers` (baseURL + api protocol + models + an `apiKeyEnv` credential reference), **skipping routes whose baseURL already exists**;
3. Migrates pi's inline API keys into the dsh credential store (`$DSH_HOME/.credentials.yaml`, mode 600), never overwriting existing entries;
4. Sets `agent-default-model` from pi's `settings.json` default when dsh has none.

Non-destructive and idempotent. `dsh-base` already ships `dsh-llm-pi-ai` (dormant); installing this bundle activates pi's routes.

## Usage

```sh
dsh plugin --profile web add @dsh-pi/llm
dsh web
```

(or add to a profile's bundles; the TUI picks routes from the same settings.)

## Notes

- Provider names in dsh match the pi provider ids (e.g. `550A-QwenTokenPlan`); the default model route follows pi's `settings.json`.
- Secrets never appear in `settings.yaml` — only `apiKeyEnv` references; keys live in the credential store like every other dsh credential.

## License

MIT
