# valet-cursor

`inference@1` agent provider `cursor`, built on the Cursor TypeScript SDK (`@cursor/sdk`).

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
- `setModel` only changes the model the next send passes; Cursor applies it per send.
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

`listModels` uses `config.models`, then Cursor's catalog (`Cursor.models.list()`, cached for 10 minutes, needs a key or login), then `composer-2.5` and `composer-2`. Each catalog variant is its own picker entry: the default variant keeps the bare id, the others are `<id>?<param>=<value>&...`, which the plugin turns back into `{ id, params }`. Custom models from the panel are appended.

The Utility model (default `composer-2`) runs one tool-free send in a throwaway agent under the temp dir.

## Config (`plugins.valet-cursor.config`)

| Key                | Meaning                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `secret`           | Secret name for the API key. Default `cursor_api_key` (`~/.valet/secrets/cursor_api_key`, `CURSOR_API_KEY`). |
| `mode`             | `agent` (default) or `plan`. Also in the settings panel.                                                     |
| `denyTools`        | Built-ins Cursor may never offer (`disallowedTools`), e.g. `["shell"]`.                                      |
| `tools`            | Base set of built-ins. Unset keeps Cursor's defaults. `"mcp"` is added.                                      |
| `hideBuiltinTools` | Default `false`. `true` offers only valet's tools. Also in the settings panel.                               |
| `autoReview`       | Cursor's Auto-review for local tool calls. Unset keeps the SDK default. Also in the settings panel.          |
| `sandbox`          | Cursor's local sandbox (`sandboxOptions.enabled`). Unset keeps the SDK default. Also in the settings panel.  |
| `settingSources`   | Cursor settings layers to load. Default `[]`: valet supplies the persona and AGENTS.md.                      |
| `idleCloseMs`      | Default 900000; `0` never closes.                                                                            |
| `utilityModel`     | Default `composer-2`; `""` turns side jobs off. Also in the settings panel.                                  |
| `models`           | Replace the model list (`id`, `name?`, `contextWindow?`, `maxOutputTokens?`).                                |
| `customModels`     | Extra picker entries (`id`, `name?`). Also in the settings panel.                                            |

Config and panel values are read when an agent starts or a prompt is sent, so changes apply without a valet restart.

## Tests

`bun test` runs against a fake SDK (`test/fake-sdk.ts`) and boots the real kernel once. The live tests are skipped unless `VALET_LIVE_CURSOR=1` and `CURSOR_API_KEY` are set; `VALET_LIVE_CURSOR_MODEL` picks the model (default `composer-2`).
