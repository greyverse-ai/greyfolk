# greyfolk — progress

## 2026-10-09: rebuilt SDK-first

Records of earlier versions: `99e4ce8` (first implementation), `2337cd4` (Responses-port rework). Both rebuilt
harness features (held subagent results, subagent events, session records, its own status, tool-kind control,
subagent profiles); this version drops all of that (intent: agent/operations — greyfolk is the engine SDK behind
the OpenAI Responses protocol, nothing more).

Layout: `server/` (controller: HTTP+SSE, WebSocket, health) → `service/` (the Responses API: response log for
streaming and re-attach, the turn writer) → `engine/` (one strategy per engine SDK, registry, `index.ts` lists
them) · `api/` (official `openai` types, request parsing) · `mcp/` (MCP entries → transports, `http+unix` bridge) ·
`options.ts` (the one option table).

Tests: 34 green (`npm test`).

Open: real-engine end to end (needs logins in an agent folder); Codex conversation history (its SDK has no
reader); Codex `require_approval: "always"` (needs the app-server).
