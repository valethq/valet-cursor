import type { InteractionUpdate, RunResult, SDKMessage, SendOptions } from "@cursor/sdk";
import type { SdkDeps } from "../src/sdk";

export interface Ctl {
  cancelled(): boolean;
  options: SendOptions;
}

/** Yields the updates of one run; the return value overrides the run result. */
export type Script = (
  text: string,
  ctl: Ctl,
) => AsyncGenerator<InteractionUpdate, Partial<RunResult> | undefined>;

export interface FakeSend {
  agentId: string;
  text: string;
  images?: unknown[];
  options: SendOptions;
  cancelled: boolean;
}

export interface FakeAgentRecord {
  id: string;
  via: "create" | "resume";
  options: Record<string, unknown>;
  closed: boolean;
}

export const usage = { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 100 };

export const textUpdates = (t: string): InteractionUpdate[] => [
  { type: "text-delta", text: t },
  { type: "model-call-completed", modelCallId: "m1", usage },
  { type: "turn-ended", usage },
];

export async function* say(t: string): AsyncGenerator<InteractionUpdate, undefined> {
  for (const u of textUpdates(t)) yield u;
  return undefined;
}

export function notFound(id: string): Error {
  return Object.assign(new Error(`Agent ${id} not found`), { code: "agent_not_found" });
}

export function fakeSdk(
  script: Script,
  opts: {
    stored?: Set<string>;
    summary?: SDKMessage[];
    sendError?: Error;
    models?: () => Promise<unknown[]>;
    auth?: () => Promise<unknown>;
  } = {},
) {
  const stored = opts.stored ?? new Set<string>();
  const agents: FakeAgentRecord[] = [];
  const sends: FakeSend[] = [];
  const makeAgent = (id: string, via: "create" | "resume", options: Record<string, unknown>) => {
    const rec: FakeAgentRecord = { id, via, options, closed: false };
    agents.push(rec);
    stored.add(id);
    return {
      agentId: id,
      model: undefined,
      close() {
        rec.closed = true;
      },
      async send(message: string | { text: string; images?: unknown[] }, options: SendOptions = {}) {
        if (opts.sendError) throw opts.sendError;
        const m = typeof message === "string" ? { text: message } : message;
        const send: FakeSend = { agentId: id, text: m.text, images: m.images, options, cancelled: false };
        sends.push(send);
        let resolve!: (r: RunResult) => void;
        const done = new Promise<RunResult>((r) => {
          resolve = r;
        });
        const ctl: Ctl = { cancelled: () => send.cancelled, options };
        const runId = `run-${sends.length}`;
        void (async () => {
          const it = script(m.text, ctl);
          let over: Partial<RunResult> | undefined;
          for (;;) {
            if (send.cancelled) break;
            const r = await it.next();
            if (r.done) {
              over = r.value;
              break;
            }
            await options.onDelta?.({ update: r.value });
            await Bun.sleep(0);
          }
          resolve({
            id: runId,
            status: send.cancelled ? "cancelled" : "finished",
            result: "",
            ...over,
          });
        })();
        return {
          id: runId,
          agentId: id,
          status: "running",
          supports: () => true,
          unsupportedReason: () => undefined,
          stream: async function* () {},
          conversation: async () => [],
          wait: () => done,
          cancel: async () => {
            send.cancelled = true;
          },
          onDidChangeStatus: () => () => undefined,
        };
      },
      async summarize() {
        const messages = opts.summary ?? [];
        return {
          id: "run-summary",
          agentId: id,
          stream: async function* () {
            for (const m of messages) yield m;
          },
          wait: async (): Promise<RunResult> => ({
            id: "run-summary",
            status: messages.some((m) => m.type === "summary" && m.status === "error") ? "error" : "finished",
          }),
          cancel: async () => undefined,
        };
      },
    };
  };
  const deps: SdkDeps = {
    create: (async (o: Record<string, unknown>) =>
      makeAgent(String(o.agentId ?? crypto.randomUUID()), "create", o)) as never,
    resume: (async (id: string, o: Record<string, unknown> = {}) => {
      if (!stored.has(id)) throw notFound(id);
      return makeAgent(id, "resume", o);
    }) as never,
    listModels: (async () => (opts.models ? opts.models() : [])) as never,
    authStatus: (async () => (opts.auth ? opts.auth() : { status: "logged-out" })) as never,
  };
  return { deps, agents, sends, stored };
}
