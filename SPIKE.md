# Spike: Cursor SDK (`@cursor/sdk` 1.4.1)

Measured on this host with Bun 1.4.4, no API key, and a throwaway `HOME`, so nothing was billed:

- **Pinned ids work.** `Agent.create({ agentId, local: { cwd } })` keeps the given id and writes the agent to `~/.cursor/projects/<cwd slug>` before any send. `Agent.resume(id)` of that id works from a new process.
- **Missing agents are a typed error.** `Agent.resume` of an unknown id throws `AgentNotFoundError` with `code: "agent_not_found"`. `Agent.messages.list` of an unknown id returns `[]`.
- **A crashed process leaves the agent busy.** After the creating process exited, the next process's first send failed with `Agent <id> already has active run`. `local.force` on that send is the SDK's recovery path for this.
- **The options valet sends are accepted.** `settingSources: []`, `tools: ["mcp"]`, `disallowedTools: ["shell"]`, `sandboxOptions`, `autoReview` and `local.customTools` pass validation. The first failure is auth.
- **No key is slow.** Without a key or login, a send fails with `[unknown] Invalid User API Key` after about 15 s of retries, so the plugin checks for a key or `Cursor.auth.status()` first. `Cursor.models.list()` without a key throws `ConfigurationError` at once.
- **Update shapes.** From the shipped types: `shell-output-delta.event` is the proto's `{ case, value }`, with `case` `stdout` / `stderr` carrying `value.data`. `model-call-completed.usage.inputTokens` is the whole prompt, cache included.

## Open items (need a key)

- Whether Cursor waits for `onDelta` on `tool-call-started` before it runs the tool. If it does, valet's gate on built-ins is a real pre-check; if not, it only stops the run after the fact. `test/live.test.ts` covers it.
- The `providerIdentifier` Cursor reports for custom tools. The docs name the server `custom-user-tools`, and the plugin uses that to skip the built-in gate for valet's own tools.
- Whether a run cancelled before its first step really drops the prompt (T3 Code reports it does), and the exact point Cursor saves a run.
- Context fill. The plugin uses the last model call's input + output; Cursor's checkpoint also holds a `usedTokens` / `maxTokens` pair that is not public API.
- Steering (`run.steer`) has no slot in `AgentSession`, so it is unused.
