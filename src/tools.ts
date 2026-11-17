import type { SDKCustomTool, SDKCustomToolContent, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import type { ToolResult, ToolSurface } from "@valethq/sdk";

/** The MCP server name Cursor gives `customTools` in tool-call events. */
export const VALET_TOOL_PROVIDER = "custom-user-tools";

async function toCustomResult(
  r: ToolResult,
  readBlob: (blobId: string) => Promise<Uint8Array>,
): Promise<SDKCustomToolResult> {
  const content = await Promise.all(
    r.content.map(async (c): Promise<SDKCustomToolContent> => {
      if (c.type === "text") return { type: "text", text: c.text };
      const bytes = await readBlob(c.blobId);
      return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: c.mime };
    }),
  );
  return { content, ...(r.isError && { isError: true }) };
}

/**
 * Valet's tools as in-process Cursor custom tools, sorted by name. Calls go through `ToolSurface.call`, which
 * runs valet's gate, so they need no further check here.
 */
export function customTools(
  surface: ToolSurface,
  signal: AbortSignal,
  readBlob: (blobId: string) => Promise<Uint8Array>,
): Record<string, SDKCustomTool> {
  const specs = [...surface.list()].sort((a, b) => a.name.localeCompare(b.name));
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema as Record<string, SDKJsonValue>,
        execute: async (args, context) => {
          const callId = context.toolCallId ?? crypto.randomUUID();
          const result = await surface.call(spec.name, args, { callId, signal });
          return toCustomResult(result, readBlob);
        },
      } satisfies SDKCustomTool,
    ]),
  );
}
