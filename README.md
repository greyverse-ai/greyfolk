# greyfolk

One agent's engine SDK behind the OpenAI Responses protocol — nothing more. Sessions, compaction,
tools, native subagents, permissions and late results stay the engine's own (its SDK's); greyfolk
maps them onto the protocol and rebuilds none of them.

Engines: the Claude Agent SDK (`claude`) and Codex's own long-running interface `codex app-server` (`codex`).
`src/engine/sample.ts` shows how an engine is written (scripted, no model); it is not shipped, only the tests load it. Each agent keeps one engine process across its turns; steer and cancel are calls into it.

## Start

```
greyfolk --listen unix:/run/agent.sock|tcp:127.0.0.1:8900|fd:3 --key-fd 4 --agent-dir /agents/alice \
         --engine claude|codex [--model fixed|request] [--soul FILE] [--engine-exec "<launcher>"] \
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
| `--soul` | an instruction file added to the engine's own instructions. The engine itself reads the folder's `CLAUDE.md` (Claude Code) / `AGENTS.md` (Codex) as usual, under its own base prompt; greyfolk never replaces that prompt |
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

## Development

```
npm install && npm run typecheck && npm run build && npm test
(umask 077; echo dev-key > /tmp/greyfolk.key)
node dist/cli.js --listen tcp:127.0.0.1:8900 --key-fd 3 --agent-dir ./agent --engine claude 3</tmp/greyfolk.key
```
