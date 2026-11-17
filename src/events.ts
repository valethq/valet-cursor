import type { InteractionUpdate } from "@cursor/sdk";
import type { AgentEvent } from "@valethq/sdk";
import { VALET_TOOL_PROVIDER } from "./tools";

type Obj = Record<string, unknown>;

const MAX_OUTPUT = 4_000;

export interface ToolInfo {
  name: string;
  title?: string;
  input: Obj;
  /** One of valet's own tools, already gated by `ToolSurface.call`. */
  valet: boolean;
}

export interface TurnState {
  /** Tool calls started and not yet completed, by Cursor call id. */
  open: Map<string, ToolInfo>;
  /** A model call or step finished, so Cursor has saved this run in the conversation. */
  stepped: boolean;
  contextTokens?: number;
  inputTokens: number;
  outputTokens: number;
}

export function newTurnState(contextTokens?: number): TurnState {
  return { open: new Map(), stepped: false, contextTokens, inputTokens: 0, outputTokens: 0 };
}

const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function titleOf(args: Obj): string | undefined {
  for (const k of ["description", "command", "path", "filePath", "pattern", "globPattern", "query", "url"]) {
    const v = args[k];
    if (typeof v === "string" && v) return clip(v, 120);
  }
  return undefined;
}

/** Name, title and input of a Cursor tool call. MCP calls are named after the MCP tool. */
export function toolInfo(toolCall: unknown): ToolInfo {
  const call = obj(toolCall);
  const type = typeof call.type === "string" ? call.type : "tool";
  const args = obj(call.args);
  if (type === "mcp") {
    const name = typeof args.toolName === "string" && args.toolName ? args.toolName : "mcp";
    const input = obj(args.args);
    return { name, title: titleOf(input), input, valet: args.providerIdentifier === VALET_TOOL_PROVIDER };
  }
  return { name: type, title: titleOf(args), input: args, valet: false };
}

function mcpText(value: Obj): string {
  const content = Array.isArray(value.content) ? (value.content as unknown[]) : [];
  return content
    .map((c) => {
      const text = obj(obj(c).text).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** Status, output and exit code of a completed tool call. */
export function toolOutcome(
  toolCall: unknown,
  aborted: boolean,
): { status: "done" | "error" | "cancelled"; output?: string; exitCode?: number } {
  const call = obj(toolCall);
  const result = obj(call.result);
  if (result.status === "error") {
    const err = obj(result.error);
    const message = typeof err.message === "string" ? err.message : JSON.stringify(result.error ?? "error");
    return { status: aborted ? "cancelled" : "error", output: clip(message, MAX_OUTPUT) };
  }
  if (result.status !== "success") return { status: "done" };
  const value = obj(result.value);
  if (call.type === "shell") {
    const out = [value.stdout, value.stderr].filter((s) => typeof s === "string" && s).join("\n");
    const exitCode = typeof value.exitCode === "number" ? value.exitCode : undefined;
    return {
      status: exitCode === undefined || exitCode === 0 ? "done" : "error",
      output: clip(out, MAX_OUTPUT),
      ...(exitCode !== undefined && { exitCode }),
    };
  }
  if (call.type === "mcp")
    return { status: value.isError === true ? "error" : "done", output: clip(mcpText(value), MAX_OUTPUT) };
  if (typeof value.content === "string") return { status: "done", output: clip(value.content, MAX_OUTPUT) };
  return { status: "done", output: clip(JSON.stringify(value), MAX_OUTPUT) };
}

function shellChunk(event: Obj): string {
  if (event.case !== "stdout" && event.case !== "stderr") return "";
  const data = obj(event.value).data;
  return typeof data === "string" ? data : "";
}

/** The shell call a `shell-output-delta` belongs to: the one it names, else the latest open shell call. */
function shellCallId(event: Obj, st: TurnState): string | undefined {
  if (typeof event.toolCallId === "string" && st.open.has(event.toolCallId)) return event.toolCallId;
  return [...st.open].reverse().find(([, t]) => t.name === "shell")?.[0];
}

export function mapUpdate(u: InteractionUpdate, st: TurnState, aborted: () => boolean): AgentEvent[] {
  switch (u.type) {
    case "text-delta":
      return u.text ? [{ type: "text-delta", text: u.text }] : [];
    case "thinking-delta":
      return u.text ? [{ type: "reasoning-delta", text: u.text }] : [];
    case "tool-call-started": {
      if (st.open.has(u.callId)) return [];
      const info = toolInfo(u.toolCall);
      st.open.set(u.callId, info);
      return [
        { type: "tool-start", callId: u.callId, name: info.name, title: info.title, input: info.input },
      ];
    }
    case "tool-call-completed": {
      if (!st.open.delete(u.callId)) return [];
      return [{ type: "tool-end", callId: u.callId, ...toolOutcome(u.toolCall, aborted()) }];
    }
    case "shell-output-delta": {
      const event = obj(u.event);
      const chunk = shellChunk(event);
      const callId = chunk ? shellCallId(event, st) : undefined;
      return callId ? [{ type: "tool-update", callId, outputDelta: chunk }] : [];
    }
    case "summary-started":
      return [{ type: "compaction-start" }];
    case "summary-completed":
      return [{ type: "compaction-end", status: u.failed ? "failed" : "completed" }];
    case "model-call-completed":
      st.stepped = true;
      st.contextTokens = u.usage.inputTokens + u.usage.outputTokens;
      return [{ type: "usage", contextTokens: st.contextTokens }];
    case "turn-ended":
      st.stepped = true;
      if (u.usage) {
        st.inputTokens += u.usage.inputTokens;
        st.outputTokens += u.usage.outputTokens;
      }
      return [];
    case "step-completed":
      st.stepped = true;
      return [];
    default:
      return [];
  }
}

/** Closes calls the run left open, e.g. when it was cancelled mid-tool. */
export function closeOpen(st: TurnState, status: "error" | "cancelled"): AgentEvent[] {
  const events = [...st.open.keys()].map((callId): AgentEvent => ({ type: "tool-end", callId, status }));
  st.open.clear();
  return events;
}
