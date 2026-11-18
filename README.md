# valet-cursor

`inference@1` agent provider `cursor`, built on the Cursor TypeScript SDK (`@cursor/sdk`). It names the `cursor` logo (`icon`), so valet-ui shows the Cursor mark behind another lab's model mark.

A [valet](https://github.com/valethq/valet-core) plugin and a sibling of `valet-claudecode`: Cursor's local agent runs the loop and its own tools in-process, and valet mirrors the stream into messages and parts. Nothing is spawned and no JSON is parsed; turns go through `Agent.create` / `Agent.resume` and `agent.send(..., { onDelta })`.

Imports `@valethq/sdk` only, plus the Cursor SDK. The Cursor SDK is the one dependency this repo adds.

## Auth

The API key is a valet secret, not a setting: `~/.valet/secrets/cursor_api_key`, then the `CURSOR_API_KEY` environment variable (rename with `secret`). With neither, the SDK's own `Cursor.auth.login()` credential (`~/.cursor/sdk/auth.json`) is used if it exists. With none of the three, a prompt fails at once with `no Cursor API key: ...` instead of waiting out the SDK's auth retries. A paid Cursor plan is needed. The settings panel shows which source was found.

## How it works

- One Cursor local agent per valet session. `open()` stores the agent id as `resumeId`. A new session pins a fresh UUID as the `agentId` and creates the agent on its first prompt.
- On reopen, `Agent.resume(resumeId)` checks Cursor's local store (`~/.cursor/projects/<cwd>`). A definite `agent_not_found` starts a new agent under a new id, so valet sends the preamble again; any other failure keeps the id and retries on the first prompt.
- The first send after a resume passes `local.force`, which expires a run a crashed valet left active (otherwise Cursor answers `already has active run`).
- The preamble is prepended to the first message: Cursor's `systemPrompt` replaces the whole harness prompt and is gated per account.
- Idle agents are closed after `idleCloseMs` (default 15 min) and resumed by the next prompt.
- Effort and fast mode arrive as model options (`open({ effort, fast })`, `setModel(model, { effort, fast })`): the next send picks the closest real catalog variant for those options plus Max mode / `modelParams`. `listModels` lists each model once with its `efforts` and `fast`. Nothing is encoded in the model id.
- Abort calls `run.cancel()`. Cursor drops a run cancelled before it saved a step, so when no model call or step had finished, the next prompt carries the cancelled text.
- `compact()` runs `agent.summarize()`. It takes no instructions.

## Events

| Cursor `InteractionUpdate`              | valet `AgentEvent`                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `text-delta`                            | `text-delta`                                                                   |
| `thinking-delta`                        | `reasoning-delta`                                                              |
| `tool-call-started`                     | `tool-start` (MCP calls are named after the MCP tool)                          |
| `shell-output-delta` (stdout / stderr)  | `tool-update` with `outputDelta` on the named or latest open shell call        |
| `tool-call-completed`                   | `tool-end`: `done` / `error`, shell `exitCode`, output clipped to 4000 chars   |
| `model-call-completed`                  | `usage.contextTokens` (input + output of that call)                            |
| `turn-ended`                            | summed into the final `usage` (`inputTokens`, `outputTokens`)                  |
| `summary-started` / `summary-completed` | `compaction-start` / `compaction-end`                                          |
| run result                              | `finish`: `finished` -> `stop`, `cancelled` -> `cancelled`, `error` -> `error` |

Calls still open when a run ends get a `tool-end` (`cancelled` or `error`). Subagent (`tool-call-delta`), partial-call, token and step updates are not mirrored.

## Tools

- **Valet's tools are Cursor custom tools.** `ToolSurface.list()` is passed as `local.customTools` on every send, sorted by name, and each call runs `ToolSurface.call`, so valet's gate applies. Custom tools run in-process, so they need no MCP endpoint and are not blocked by Cursor's sandbox or Auto-review.
- **Built-ins go through valet's gate when they start.** On `tool-call-started` for a built-in, the plugin awaits `ToolSurface.authorize`. A denial, a gate that throws, or a rewritten input (Cursor can't take one) cancels the run and finishes with `valet denied <tool>: <reason>`. The SDK has no pre-tool hook, so whether the tool already ran depends on whether Cursor waits for `onDelta` before running it. That is not measured yet; `test/live.test.ts` checks it.
- **`denyTools`** maps to `disallowedTools`, `tools` to `tools`, and **`hideBuiltinTools`** sends `tools: ["mcp"]`, which leaves only valet's tools. `"mcp"` is always kept, because valet's custom tools ride on it.
- There are no interactive approvals: Cursor's SDK has none. `autoReview` and `sandbox` turn on Cursor's own classifier and sandbox.

## Models

`listModels` uses `config.models`, then Cursor's catalog (`Cursor.models.list()`, cached for 10 minutes, needs a key or login), then `composer-2.5` and `composer-2`.

Cursor's catalog lists every combination of a model's params as a variant (Claude Opus 4.8 has 40, all with the same name), so the plugin does not list variants. Each catalog model is one row in valet's picker:

- Efforts become `ModelInfo.efforts` (Cursor's `extra-high` is shown as `xhigh`), with `defaultEffort` from the catalog default.
- A model with a `fast` param advertises `fast: true`, and `fastByDefault` when the catalog default is fast.
- The selection's `ModelOptions.effort` / `ModelOptions.fast` pick the variant; unset effort runs the default, unset fast follows `fastByDefault`.
- Max mode (`maxMode` config, default off) chooses Max-mode variants so the advertised and sent context windows are the large ones. `thinking` keeps the catalog default unless `modelParams` pins it.
- The plugin sends the params of the closest real catalog variant, so a combination Cursor doesn't offer is never sent.

`hideAuto` (default off) leaves Cursor's Auto model (`default`) out of the catalog list. It only hides the row: a session or stored id already on `default` keeps running on Auto, and `default` added by hand to `models` is still listed.

Legacy `id?param=value` ids from 0.1.0 still work and are sent as written. Config `models` entries can list `efforts`, `defaultEffort`, `fast`, `fastByDefault`, and `effortParam` (default `effort`) for a model the catalog doesn't know.

The Utility model (default `composer-2`) runs one tool-free send in a throwaway agent under the temp dir; it may end in an effort (`composer-2-high`).

## Config

Settings are this plugin's config (valet-core 12.1): the UI edits them through core, and every value applies at the next prompt or agent start.
(`plugins.valet-cursor.config`)

| Key                | Meaning                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `secret`           | Secret name for the API key. Default `cursor_api_key` (`~/.valet/secrets/cursor_api_key`, `CURSOR_API_KEY`).                                           |
| `mode`             | `agent` (default) or `plan`.                                                                                                                           |
| `denyTools`        | Built-ins Cursor may never offer (`disallowedTools`), e.g. `["shell"]`.                                                                                |
| `tools`            | Base set of built-ins. Unset keeps Cursor's defaults. `"mcp"` is added.                                                                                |
| `hideBuiltinTools` | Default `false`. `true` offers only valet's tools.                                                                                                     |
| `autoReview`       | Cursor's Auto-review for local tool calls. Unset keeps the SDK default.                                                                                |
| `sandbox`          | Cursor's local sandbox (`sandboxOptions.enabled`). Unset keeps the SDK default.                                                                        |
| `settingSources`   | Cursor settings layers to load. Default `[]`: valet supplies the persona and AGENTS.md.                                                                |
| `idleCloseMs`      | Default 900000; `0` never closes.                                                                                                                      |
| `utilityModel`     | Default `composer-2`; `""` turns side jobs off. May end in an effort.                                                                                  |
| `maxMode`          | Default `false`. Allow Max-mode variants (large context windows).                                                                                      |
| `hideAuto`         | Default `false`. Leave Cursor's Auto model (`default`) out of the picker.                                                                              |
| `modelParams`      | Per-model Cursor params, e.g. `{ "claude-opus-4-8": { "thinking": "false" } }`. Wins over the picker.                                                  |
| `models`           | Replace the model list (`id`, `name?`, `contextWindow?`, `maxOutputTokens?`, `efforts?`, `defaultEffort?`, `effortParam?`, `fast?`, `fastByDefault?`). |

The settings panel above the form shows whether an API key or Cursor login was found, and a "Reload models" action. Fast mode is not a plugin setting: it is chosen per model selection.

## Tests

`bun test` runs against a fake SDK (`test/fake-sdk.ts`) and boots the real kernel once. The live tests are skipped unless `VALET_LIVE_CURSOR=1` and `CURSOR_API_KEY` are set; `VALET_LIVE_CURSOR_MODEL` picks the model (default `composer-2`).
