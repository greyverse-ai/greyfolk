# greyfolk

**One agent's engine, served as a plain OpenAI Responses endpoint — and nothing more.**

greyfolk is a thin server that puts a single coding-agent engine (Claude Code, Codex) behind the
OpenAI *Responses* protocol. One greyfolk process runs one agent. Everything that makes the engine
an agent — its session, compaction, tools, native subagents, permissions, late/streamed results —
stays the engine's own; greyfolk only maps those onto the protocol and **rebuilds none of them**.

So a caller talks to any engine the same way — `POST /v1/responses`, stream, steer, cancel — without
binding to a vendor's SDK or client, and without greyfolk growing a second agent framework of its own.

```
client ──OpenAI Responses──▶ greyfolk ──SDK/stdio──▶ engine (Claude Code · Codex)
                              (one per agent)
```

## What it is, and is not

- **Is:** a protocol adapter. It owns the socket, the bearer-key handshake, the request/response and
  WebSocket shapes, the health check, and the translation of engine events into standard items.
- **Is not:** an orchestrator, a sandbox, a permission system, a memory/RAG layer, or a model router.
  Those belong to the engine (its own features) or to whatever runs greyfolk. If a feature already
  exists in the engine, greyfolk surfaces it; it does not reimplement it.

In greyverse, the runtime starts one greyfolk per agent, points it at the agent's folder, and reaches
it over a private socket; the engine's host tools are turned off and sandboxed separately by the
runtime. greyfolk itself is engine-neutral and runs fine on its own.

## Engines

| engine | backed by | notes |
|---|---|---|
| `claude` | the Claude Agent SDK | one Claude Code process per conversation, kept across turns (streaming input), so the session, compaction, native subagents and their late results stay Claude Code's own |
| `codex` | `codex app-server` (Codex's long-running interface) | one app-server thread per conversation; MCP, approvals and tools are Codex's |

`src/engine/sample.ts` shows how an engine is written (scripted, no model); it is not shipped — only
the tests load it. Each agent keeps one engine process across its turns; **steer** and **cancel** are
calls into that live process.

## Start

```
greyfolk --listen unix:/run/agent.sock|tcp:127.0.0.1:8900|fd:3 --key-fd 4 --agent-dir /agents/alice \
         --engine claude|codex [--model fixed|request] [--engine-exec "<launcher>"] \
         [-- <the engine's own options, passed to its SDK as they are>]
```

| option | meaning |
|---|---|
| `--listen` | `unix:PATH`, `tcp:HOST:PORT`, or `fd:N` (an inherited listening socket) |
| `--socket-mode` | mode of a `unix:` socket (default `0600`) |
| `--key-fd N` | the bearer key, read once from inherited fd N and closed (never argv, env or a file) |
| `--agent-dir` | the agent folder = the engine's config home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); the engine reads its own settings files there as usual |
| `--engine` | required |
| `--model` | `fixed` (default): the engine's own model setting; `request`: a request's `model`, within the engine's family |
| `--engine-exec` | a launcher prefix the engine process is started through (e.g. a sandbox wrapper) |
| `--engines` | print the engines this greyfolk has, one per line, and exit |
| `-- …` | the engine's own options, as they are. Claude: Claude Code CLI options (SDK `extraArgs`, e.g. `--tools Agent,TodoWrite`). Codex: `codex app-server` options (`-c key=value`, `--enable F`, `--disable F`, …); only its transport options (`--listen`, `--stdio`, `--ws-*`) are greyfolk's own and refused |

`greyfolk --help` prints the table (one table in `src/options.ts`; engines add their own options to it).

## Protocol (OpenAI Responses)

| | |
|---|---|
| `POST /v1/responses` | create (stream over SSE, or the final response; `background` returns at once) |
| `GET /v1/responses/{id}` | the response; `?stream=true&starting_after=N` re-attaches |
| `POST /v1/responses/{id}/cancel` | cancel (the response ends with status `cancelled`) |
| WebSocket `/v1/responses` | the standard client events `response.create` and `response.steer` |
| `GET /v1/conversations/{id}/items` | the conversation as the engine's session holds it |
| `GET /health` | standard health check (`application/health+json`): busy, live response, subagents running, approvals waiting, conversation |

- **Conversation** = the engine's session. `conversation` continues it; no `conversation` (and no `previous_response_id`) starts a new one. The response names it in `conversation.id`.
- **New input** is chosen by position: with `conversation`/`previous_response_id` the input holds only new items; without, it is the whole conversation and only what follows its last assistant message is new.
- **Steer** (WebSocket, `previous_response_id` required): the live response ends `incomplete` (reason `steered`) and a successor answers; otherwise `response.steer.failed` with the standard code (`invalid_input`, `response_not_found`, `response_already_completed`, `response_not_active`, `steering_not_supported`).
- **Tools**: only `{type:"mcp"}` entries, for that turn. `headers` are never echoed. `allowed_tools` (names) and `require_approval` are applied; a field greyfolk cannot apply (`authorization`, `connector_id`, a `read_only` filter, per-tool approval filters) is refused with 400. Servers are `http(s)://` addresses (the standard); nothing else is attached.
- **Approval**: a tool needing approval ends the response with an `mcp_approval_request` item; the next request carries an `mcp_approval_response` (with `previous_response_id`) and the turn goes on in its response. With Codex, whether it may ask at all is the agent's own approval policy (its `config.toml`); Codex's own approval prompts for commands and file changes have no standard shape and are declined.
- **Output items**: MCP tools → `mcp_call`; the engine's own tools → the standard item that means the same (`shell_call`/`shell_call_output`, `apply_patch_call`/`_output`, `web_search_call`, anything else — e.g. the subagent tool — `custom_tool_call`/`_output`).

## Security

- The bearer key arrives once on an inherited file descriptor (`--key-fd`) and is closed — never in
  argv, the environment or a file. Every request must carry it.
- A turn's MCP servers carry their own credentials for that turn only; `headers` are **never echoed**
  back and **never stored**.
- A `unix:` socket defaults to `0600`; a `tcp:` listener is for a trusted local boundary.
- greyfolk keeps no secrets of its own and logs none. The engine's host access (shell, files) is not
  greyfolk's to grant — it is left to the engine's options and to whatever sandboxes the process.

## Development

```
npm install && npm run typecheck && npm run build && npm test
(umask 077; echo dev-key > /tmp/greyfolk.key)
node dist/cli.js --listen tcp:127.0.0.1:8900 --key-fd 3 --agent-dir ./agent --engine claude 3</tmp/greyfolk.key
```

MIT.
