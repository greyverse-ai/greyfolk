/**
 * Stand-ins for what a real `codex app-server` talks to, so the engine runs against the real
 * pinned codex binary with no login: a model (OpenAI Responses, SSE) and an MCP server
 * (streamable HTTP, JSON replies) that records the credentials each call carried.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

type Item = Record<string, unknown>;
export type ModelScript = (req: { input: Item[]; instructions: string; lastUser: string; freshToolOutput: boolean }) => { items: Item[]; delayMs?: number };

export async function mockModel(script: ModelScript): Promise<{ url: string; close: () => void }> {
  let outputs = 0;
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      const j = JSON.parse(body || "{}") as { input?: Item[]; instructions?: string };
      const input = j.input ?? [];
      const now = input.filter((i) => i.type === "function_call_output").length;
      const user = input.filter((i) => i.role === "user").at(-1);
      const { items, delayMs = 0 } = script({ input, instructions: j.instructions ?? "", lastUser: JSON.stringify(user?.content ?? ""), freshToolOutput: now > outputs });
      outputs = now;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
      const id = `resp_${++n}`;
      ev("response.created", { response: { id } });
      for (const item of items) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        if (res.destroyed) return;
        ev("response.output_item.added", { item });
        ev("response.output_item.done", { item });
      }
      ev("response.completed", { response: { id, usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => server.close() };
}

export async function mockMcp(): Promise<{ url: string; auth: string[]; close: () => void }> {
  const auth: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.method !== "POST") return void res.writeHead(405).end();
      const m = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string; arguments?: unknown } };
      if (m.method === "tools/call") auth.push(req.headers.authorization ?? "");
      if (m.id === undefined) return void res.writeHead(202).end();
      const result =
        m.method === "initialize"
          ? { protocolVersion: m.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } }
          : m.method === "tools/list"
            ? { tools: [{ name: "send", description: "send a message", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
            : m.method === "tools/call"
              ? { content: [{ type: "text", text: `sent ${JSON.stringify(m.params?.arguments)}` }] }
              : {};
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, auth, close: () => server.close() };
}

export const message = (text: string): Item => ({ type: "message", role: "assistant", id: `m_${Math.random().toString(36).slice(2)}`, content: [{ type: "output_text", text, annotations: [] }], status: "completed" });
export const mcpCall = (server: string, tool: string, args: object): Item => ({ type: "function_call", id: `fc_${Math.random().toString(36).slice(2)}`, call_id: `call_${Math.random().toString(36).slice(2)}`, namespace: `mcp__${server}`, name: tool, arguments: JSON.stringify(args), status: "completed" });
export const shellCall = (cmd: string): Item => ({ type: "function_call", id: `fc_${Math.random().toString(36).slice(2)}`, call_id: `call_${Math.random().toString(36).slice(2)}`, name: "exec_command", arguments: JSON.stringify({ cmd }), status: "completed" });
