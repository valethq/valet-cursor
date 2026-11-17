import { Agent, AgentNotFoundError, Cursor } from "@cursor/sdk";

/** The parts of `@cursor/sdk` the plugin calls, so tests can swap in a fake. */
export interface SdkDeps {
  create: typeof Agent.create;
  resume: typeof Agent.resume;
  listModels: typeof Cursor.models.list;
  authStatus: typeof Cursor.auth.status;
}

export const realSdk: SdkDeps = {
  create: (o) => Agent.create(o),
  resume: (id, o) => Agent.resume(id, o),
  listModels: (o) => Cursor.models.list(o),
  authStatus: (o) => Cursor.auth.status(o),
};

export const isNotFound = (e: unknown): boolean =>
  e instanceof AgentNotFoundError || (e as { code?: unknown } | undefined)?.code === "agent_not_found";
