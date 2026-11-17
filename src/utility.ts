import { tmpdir } from "node:os";
import type { ModelSelection } from "@cursor/sdk";
import type { PluginContext, UtilityModel } from "@valethq/sdk";
import type { CursorConfig } from "./config";
import type { SdkDeps } from "./sdk";
import { apiKey, utilityModel } from "./settings";

/** Side jobs are one tool-free run in a throwaway agent, outside any project. */
export function createUtility(
  ctx: PluginContext<CursorConfig>,
  deps: SdkDeps,
  select: (pickerId: string) => Promise<ModelSelection>,
): UtilityModel {
  return {
    model: () => utilityModel(ctx),
    async complete(req, signal) {
      const picked = utilityModel(ctx);
      if (!picked) throw new Error("no utility model is configured");
      const key = await apiKey(ctx);
      if (!key && (await deps.authStatus().catch(() => undefined))?.status !== "logged-in")
        throw new Error("no Cursor API key for the utility model");
      const agent = await deps.create({
        ...(key && { apiKey: key }),
        model: await select(picked),
        tools: [],
        local: { cwd: tmpdir(), settingSources: [] },
      });
      const cancel = () => void run?.cancel().catch(() => undefined);
      let run: Awaited<ReturnType<typeof agent.send>> | undefined;
      try {
        // spec-gap: Cursor's systemPrompt option is gated per account, so the system text leads the message.
        run = await agent.send(`${req.system}\n\n${req.prompt}`);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        const r = await run.wait();
        if (r.status === "finished") return (r.result ?? "").trim();
        throw new Error(r.error?.message || `cursor utility run ${r.status}`);
      } finally {
        signal.removeEventListener("abort", cancel);
        agent.close();
      }
    },
  };
}
