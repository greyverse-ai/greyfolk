# greyfolk — progress

## 2026-10-09: rebuilt SDK-first

Records of earlier versions: `99e4ce8` (first implementation), `2337cd4` (Responses-port rework). Both rebuilt
harness features (held subagent results, subagent events, session records, its own status, tool-kind control,
subagent profiles); this version drops all of that (intent: agent/operations — greyfolk is the engine SDK behind
the OpenAI Responses protocol, nothing more).

Layout: `server/` (controller: HTTP+SSE, WebSocket, health) → `service/` (the Responses API: response log for
streaming and re-attach, the turn writer) → `engine/` (one strategy per engine SDK, registry, `index.ts` lists
them) · `api/` (official `openai` types, request parsing) · `mcp/` (MCP entries → the servers a turn attaches) ·
`options.ts` (the one option table).

## 2026-10-09: review fixes; Codex on `codex app-server`

Record before this step: `1480427`. The Codex SDK started `codex exec` for every turn (and every MCP server
with it); the engine now talks to one `codex app-server` process for the agent (intent: one engine process kept
across turns). Steer, approvals and the conversation reader work on Codex too. The protocol types are codex's
own generated code (`src/engine/codex-protocol`, `npm run gen:codex-protocol` from the pinned binary).

Claude: a step is bound to its turn by the uuid stamps Claude Code puts on its frames; the old process ending
no longer touches a newer one; an MCP call that needs approval shows once it is approved.

Tests: 38 green (`npm test`); the Codex tests run the real pinned codex binary against a stand-in model and MCP
server, with no login.

Decided after review: the engines keep their own base prompt and read the soul themselves (`--soul` only
adds); the `http+unix` MCP bridge is gone (MCP servers are plain http(s); the per-turn token is the guard).

Open: real-engine end to end with logins.
