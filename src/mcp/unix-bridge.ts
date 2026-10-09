/**
 * stdio ⇄ MCP streamable HTTP over a Unix socket.
 *
 * Started by the harness as a stdio MCP server. Each JSON-RPC message read from stdin is POSTed
 * to the socket (env GREYFOLK_MCP_SOCKET) at the HTTP path (GREYFOLK_MCP_PATH) with the headers
 * in GREYFOLK_MCP_HEADERS (JSON). Responses — a JSON body or an SSE stream — are written to stdout
 * one JSON-RPC message per line. The `Mcp-Session-Id` the server assigns on `initialize` is kept.
 */
import * as http from "node:http";
import * as readline from "node:readline";

const socketPath = process.env.GREYFOLK_MCP_SOCKET;
const httpPath = process.env.GREYFOLK_MCP_PATH || "/mcp";
const extraHeaders: Record<string, string> = JSON.parse(process.env.GREYFOLK_MCP_HEADERS || "{}");

if (!socketPath) {
  process.stderr.write("greyfolk unix-bridge: GREYFOLK_MCP_SOCKET is not set\n");
  process.exit(2);
}

let sessionId: string | null = null;

function emit(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function post(body: string): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      ...extraHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": String(Buffer.byteLength(body)),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = http.request({ socketPath, path: httpPath, method: "POST", headers }, (res) => {
      const sid = res.headers["mcp-session-id"];
      if (typeof sid === "string" && sid) sessionId = sid;
      const ctype = String(res.headers["content-type"] || "");
      if (ctype.startsWith("text/event-stream")) {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart())
              .join("\n");
            if (data) {
              try {
                emit(JSON.parse(data));
              } catch {
                /* ignore malformed frame */
              }
            }
          }
        });
        res.on("end", () => resolve());
        res.on("error", () => resolve());
        return;
      }
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 400) {
          const parsed = safeParse(body);
          if (parsed && parsed.id !== undefined) {
            emit({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: `MCP server returned HTTP ${res.statusCode}: ${text.slice(0, 200)}` } });
          }
          resolve();
          return;
        }
        if (text.trim()) {
          const parsed = safeParse(text);
          if (parsed !== null) {
            if (Array.isArray(parsed)) parsed.forEach(emit);
            else emit(parsed);
          }
        }
        resolve();
      });
      res.on("error", () => resolve());
    });
    req.on("error", (err) => {
      const parsed = safeParse(body);
      if (parsed && parsed.id !== undefined) {
        emit({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: `MCP socket error: ${err.message}` } });
      }
      resolve();
    });
    req.end(body);
  });
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  chain = chain.then(() => post(trimmed));
});
rl.on("close", () => {
  chain.then(() => process.exit(0));
});
