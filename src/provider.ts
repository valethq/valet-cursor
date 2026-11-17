import { randomUUID } from "node:crypto";
import type { AgentProvider, AgentSession, PluginContext } from "@valethq/sdk";
import type { CursorConfig } from "./config";
import { type Catalog, modelLister, selectModel } from "./models";
import { isNotFound, realSdk, type SdkDeps } from "./sdk";
import { CursorSession } from "./session";
import {
  apiKey,
  autoReview,
  customModels,
  hideBuiltinTools,
  mode,
  preferences,
  sandbox,
  secretName,
} from "./settings";
import { createUtility } from "./utility";

export const PROVIDER_KEY = "cursor";

export function createProvider(
  ctx: PluginContext<CursorConfig>,
  catalog: Catalog,
  deps: SdkDeps = realSdk,
): { provider: AgentProvider; dispose(): Promise<void> } {
  const sessions = new Set<CursorSession>();
  const select = async (id: string) =>
    selectModel(id, await catalog.get(), ctx.config?.models, preferences(ctx));
  /** Whether Cursor's local store still has the agent. Only a definite "not found" reseeds. */
  const known = (id: string, cwd: string) =>
    deps.resume(id, { local: { cwd } }).then(
      (agent) => {
        agent.close();
        return true;
      },
      (e) => !isNotFound(e),
    );
  const provider: AgentProvider = {
    kind: "agent",
    id: PROVIDER_KEY,
    label: "Cursor",
    listModels: modelLister(
      () => ctx.config,
      catalog,
      () => customModels(ctx),
      () => preferences(ctx),
    ),
    utility: createUtility(ctx, deps, select),
    async open(opts): Promise<AgentSession> {
      const session = ctx.store.sessions.get(opts.sessionId);
      const project = session && ctx.store.projects.get(session.projectId);
      const cwd = project?.workspaceDir ?? opts.cwd;
      const existing = opts.resumeId ? await known(opts.resumeId, cwd) : false;
      if (opts.resumeId && !existing)
        ctx.log.warn("cursor agent not found, reseeding", { resumeId: opts.resumeId });
      const id = opts.resumeId && existing ? opts.resumeId : randomUUID();
      const cursor: CursorSession = new CursorSession({
        deps,
        id,
        cwd,
        model: opts.model,
        tools: opts.tools,
        reseeded: opts.resumeId !== undefined && id !== opts.resumeId,
        existing,
        cfg: () => ctx.config ?? {},
        flags: () => ({
          hideBuiltinTools: hideBuiltinTools(ctx),
          autoReview: autoReview(ctx),
          sandbox: sandbox(ctx),
        }),
        mode: () => mode(ctx),
        apiKey: () => apiKey(ctx),
        select,
        missingKey: `no Cursor API key: put one in ~/.valet/secrets/${secretName(ctx)} or ${secretName(ctx).toUpperCase()}`,
        log: ctx.log,
        readBlob: (blobId) => Bun.file(ctx.store.blobs.path(blobId)).bytes(),
        onClose: () => {
          sessions.delete(cursor);
        },
      });
      sessions.add(cursor);
      ctx.store.sessions.setProviderState(opts.sessionId, PROVIDER_KEY, { resumeId: id });
      return cursor;
    },
  };
  return {
    provider,
    dispose: async () => {
      await Promise.all([...sessions].map((s) => s.close()));
    },
  };
}
