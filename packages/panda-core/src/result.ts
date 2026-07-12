/** Helpers for MCP tool results: JSON payloads and error envelopes. */

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function err(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}
