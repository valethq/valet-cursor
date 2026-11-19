import type {
  AgentOptions,
  InteractionUpdate,
  ModelSelection,
  Run,
  RunResult,
  SDKAgent,
  SDKImage,
  ToolName,
} from "@cursor/sdk";
import type { AgentEvent, AgentSession, Logger, ModelContent, ModelOptions, ToolSurface } from "@valethq/sdk";
import { EventQueue } from "./channel";
import { type CursorConfig, DEFAULT_IDLE_CLOSE_MS, type Mode } from "./config";
import { closeOpen, mapUpdate, newTurnState, type ToolInfo, type TurnState, toolInfo } from "./events";
import { asEffort } from "./models";
import type { SdkDeps } from "./sdk";
import { customTools } from "./tools";

export interface SessionFlags {
  hideBuiltinTools: boolean;
  autoReview?: boolean;
  sandbox?: boolean;
}

export interface SessionInit {
  deps: SdkDeps;
  /** Cursor agent id, also valet's resumeId. */
  id: string;
  cwd: string;
  model: string;
  effort?: string;
  /** Cursor fast mode; unset follows the model's fastByDefault. */
  fast?: boolean;
  tools: ToolSurface;
  reseeded: boolean;
  /** The agent is already in Cursor's local store, so the first prompt resumes it instead of creating it. */
  existing: boolean;
  cfg(): CursorConfig;
  /** Read at each agent start so a settings change applies without a restart. */
  flags(): SessionFlags;
  mode(): Mode;
  apiKey(): Promise<string | undefined>;
  /** Model id + options -> the model and params Cursor runs; prefs (Max mode, modelParams) are read each time. */
  select(modelId: string, options: ModelOptions): Promise<ModelSelection>;
  /** Shown when there is no key and no `Cursor.auth.login()` credential, instead of the SDK's slow auth retries. */
  missingKey: string;
  log: Logger;
  readBlob(blobId: string): Promise<Uint8Array>;
  onClose(): void;
}

type Outcome = Pick<RunResult, "status" | "error" | "usage">;

/** Built-in tool set for the agent. valet's custom tools ride on "mcp", so it is always kept. */
export function toolSet(cfg: CursorConfig, flags: SessionFlags): ToolName[] | undefined {
  if (flags.hideBuiltinTools) return ["mcp"];
  if (!cfg.tools) return undefined;
  return cfg.tools.includes("mcp") ? cfg.tools : [...cfg.tools, "mcp"];
}

export class CursorSession implements AgentSession {
  readonly reseeded: boolean;
  private agent?: SDKAgent;
  private existing: boolean;
  /** Set after a resume: the first send expires a run a crashed valet left active. */
  private force = false;
  private model: string;
  private effort?: string;
  private fast?: boolean;
  private idle?: ReturnType<typeof setTimeout>;
  private lastContext?: number;
  /** A prompt cancelled before Cursor saved it; Cursor drops it, so the next prompt carries it. */
  private carry?: string;

  constructor(private init: SessionInit) {
    this.reseeded = init.reseeded;
    this.existing = init.existing;
    this.model = init.model;
    this.effort = asEffort(init.effort);
    this.fast = init.fast;
  }

  get resumeId(): string {
    return this.init.id;
  }

  private async agentOptions(): Promise<AgentOptions> {
    const cfg = this.init.cfg();
    const flags = this.init.flags();
    const key = await this.init.apiKey();
    const tools = toolSet(cfg, flags);
    return {
      ...(key && { apiKey: key }),
      model: await this.init.select(this.model, this.options()),
      local: {
        cwd: this.init.cwd,
        settingSources: cfg.settingSources ?? [],
        ...(flags.autoReview !== undefined && { autoReview: flags.autoReview }),
        ...(flags.sandbox !== undefined && { sandboxOptions: { enabled: flags.sandbox } }),
      },
      ...(tools && { tools }),
      ...(cfg.denyTools?.length && { disallowedTools: cfg.denyTools }),
    };
  }

  private async ensure(): Promise<SDKAgent> {
    if (this.agent) return this.agent;
    const { deps, id } = this.init;
    const opts = await this.agentOptions();
    if (!opts.apiKey && (await deps.authStatus().catch(() => undefined))?.status !== "logged-in")
      throw new Error(this.init.missingKey);
    this.agent = this.existing ? await deps.resume(id, opts) : await deps.create({ ...opts, agentId: id });
    this.force = this.existing;
    this.existing = true;
    return this.agent;
  }

  private drop(): void {
    clearTimeout(this.idle);
    try {
      this.agent?.close();
    } catch {}
    this.agent = undefined;
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    const ms = this.init.cfg().idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
    if (!ms || !this.agent) return;
    this.idle = setTimeout(() => {
      this.init.log.info("closing idle cursor agent; the next prompt resumes it", { session: this.init.id });
      this.drop();
    }, ms);
    this.idle.unref?.();
  }

  private options(): ModelOptions {
    return {
      ...(this.effort !== undefined && { effort: this.effort }),
      ...(this.fast !== undefined && { fast: this.fast }),
    };
  }

  async setModel(model: string, options: ModelOptions): Promise<void> {
    this.model = model;
    this.effort = asEffort(options.effort);
    this.fast = options.fast;
  }

  async close(): Promise<void> {
    this.drop();
    this.init.onClose();
  }

  /** Runs valet's `tool.call` gate for a Cursor built-in. Returns the denial reason, if any. */
  private async gate(info: ToolInfo, callId: string): Promise<string | undefined> {
    const verdict = await this.init.tools.authorize(info.name, info.input, { callId });
    if ("denied" in verdict) return verdict.denied;
    // spec-gap: authorize may rewrite the input, but Cursor's SDK has no way to hand a built-in a new input.
    if (JSON.stringify(verdict.input) !== JSON.stringify(info.input))
      return "a policy hook rewrote the input, and Cursor's built-in tools cannot take a rewritten input";
    return undefined;
  }

  private async message(input: { content: ModelContent[]; preamble?: string }) {
    const texts = input.content.flatMap((c) => (c.type === "text" ? [c.text] : []));
    const images = await Promise.all(
      input.content.flatMap((c) =>
        c.type === "image"
          ? [
              this.init
                .readBlob(c.blobId)
                .then((b): SDKImage => ({ data: Buffer.from(b).toString("base64"), mimeType: c.mime })),
            ]
          : [],
      ),
    );
    const text = [this.carry, input.preamble, texts.join("\n\n")].filter((t) => !!t).join("\n\n");
    return { text, ...(images.length && { images }) };
  }

  async *prompt(
    input: { content: ModelContent[]; preamble?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    let message: Awaited<ReturnType<CursorSession["message"]>>;
    try {
      message = await this.message(input);
    } catch (e) {
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    this.carry = undefined;
    yield* this.turn(message, signal);
  }

  private async *turn(
    message: { text: string; images?: SDKImage[] },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    clearTimeout(this.idle);
    let agent: SDKAgent;
    try {
      agent = await this.ensure();
    } catch (e) {
      this.drop();
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    const st = newTurnState(this.lastContext);
    const queue = new EventQueue<AgentEvent, Outcome>();
    let run: Run | undefined;
    let denied: string | undefined;
    let settled = false;
    const cancel = () => void run?.cancel().catch(() => undefined);
    const onDelta = async ({ update }: { update: InteractionUpdate }) => {
      if (update.type === "tool-call-started" && !st.open.has(update.callId) && !denied) {
        const info = toolInfo(update.toolCall);
        if (!info.valet) {
          const reason = await this.gate(info, update.callId).catch(
            (e: Error) => `the gate failed: ${e.message}`,
          );
          if (reason) {
            denied = `valet denied ${info.name}: ${reason}`;
            queue.push(...mapUpdate(update, st, () => true), {
              type: "notice",
              level: "error",
              text: denied,
            });
            cancel();
            return;
          }
        }
      }
      queue.push(...mapUpdate(update, st, () => signal.aborted || !!denied));
    };
    signal.addEventListener("abort", cancel);
    try {
      try {
        run = await agent.send(message, {
          model: await this.init.select(this.model, this.options()),
          mode: this.init.mode(),
          onDelta,
          local: {
            customTools: customTools(this.init.tools, signal, this.init.readBlob),
            ...(this.force && { force: true }),
          },
        });
      } catch (e) {
        yield { type: "finish", reason: "error", error: (e as Error).message };
        return;
      }
      this.force = false;
      if (signal.aborted || denied) cancel();
      run.wait().then(
        (r) => queue.end(r),
        (e: Error) => queue.end({ status: "error", error: { message: e.message } }),
      );
      let outcome: Outcome;
      for (;;) {
        const next = await queue.next();
        if ("done" in next) {
          outcome = next.done;
          break;
        }
        yield next.item;
      }
      settled = true;
      yield* this.finish(outcome, st, signal.aborted, denied, message.text, run.id);
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!settled) cancel();
      this.armIdle();
    }
  }

  private *finish(
    outcome: Outcome,
    st: TurnState,
    aborted: boolean,
    denied: string | undefined,
    text: string,
    runId: string,
  ): Iterable<AgentEvent> {
    const cancelled = !denied && (aborted || outcome.status === "cancelled");
    if (cancelled && !st.stepped)
      this.carry = `[valet: your previous turn was stopped before it started. It said:]\n${text}`;
    this.lastContext = st.contextTokens;
    const input = st.inputTokens || outcome.usage?.inputTokens;
    const output = st.outputTokens || outcome.usage?.outputTokens;
    this.init.log.info("cursor turn", {
      session: this.init.id,
      run: runId,
      model: this.model,
      status: outcome.status,
      input,
      output,
      cacheRead: outcome.usage?.cacheReadTokens,
    });
    yield* closeOpen(st, cancelled ? "cancelled" : "error");
    if (st.contextTokens !== undefined || input !== undefined || output !== undefined)
      yield {
        type: "usage",
        ...(st.contextTokens !== undefined && { contextTokens: st.contextTokens }),
        ...(input !== undefined && { inputTokens: input }),
        ...(output !== undefined && { outputTokens: output }),
      };
    if (denied) yield { type: "finish", reason: "error", error: denied };
    else if (cancelled) yield { type: "finish", reason: "cancelled" };
    else if (outcome.status === "finished") yield { type: "finish", reason: "stop" };
    else yield { type: "finish", reason: "error", error: outcome.error?.message || "cursor run failed" };
  }

  /** Cursor's `/summarize`. It takes no instructions, so they are ignored. */
  async *compact(_instructions: string | undefined, signal: AbortSignal): AsyncIterable<AgentEvent> {
    clearTimeout(this.idle);
    let run: Run;
    try {
      run = await (await this.ensure()).summarize();
    } catch (e) {
      yield { type: "finish", reason: "error", error: (e as Error).message };
      return;
    }
    const cancel = () => void run.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel);
    let open = false;
    try {
      for await (const m of run.stream()) {
        if (m.type !== "summary") continue;
        if (m.status === "running") {
          open = true;
          yield { type: "compaction-start" };
        } else {
          open = false;
          yield { type: "compaction-start" };
          yield { type: "compaction-end", status: m.status === "completed" ? "completed" : "failed" };
        }
      }
      const r = await run.wait();
      if (open) yield { type: "compaction-end", status: signal.aborted ? "cancelled" : "failed" };
      if (signal.aborted || r.status === "cancelled") yield { type: "finish", reason: "cancelled" };
      else if (r.status === "finished") yield { type: "finish", reason: "stop" };
      else yield { type: "finish", reason: "error", error: r.error?.message || "cursor summarize failed" };
    } catch (e) {
      if (open) yield { type: "compaction-end", status: "failed", error: (e as Error).message };
      yield { type: "finish", reason: "error", error: (e as Error).message };
    } finally {
      signal.removeEventListener("abort", cancel);
      this.armIdle();
    }
  }
}
