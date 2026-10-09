# greyfolk

One agent (soul + engine + session) served as a plain OpenAI Responses-shaped server.

One greyfolk process = one agent = one continuing session. The agent is a folder: its instruction
file (the **soul**: `AGENTS.md` or `CLAUDE.md`), the engine's own config and session data, and a
`.greyfolk/` directory with greyfolk's small records. The engine (the **vessel**) is the Claude
Agent SDK, the Codex CLI, or a scripted fake for tests. Clients talk to it with the OpenAI
Responses API shape; everything engine-specific is hidden behind that.

## Layout

```
server/   controller: HTTP + SSE and WebSocket; only how things are sent
service/  the Responses API itself for one agent (turns, steer, cancel, held results, status)
engine/   one strategy per engine (claude, codex, fake) + the registry; engine/index.ts lists them
common/   engine-neutral parts the service and engines share (turn writer, response log,
          session record, held results, steer queue, permission bridge)
api/      the official OpenAI Responses types (npm `openai`) plus greyfolk's `greyfolk.*` additions
mcp/      MCP entries → engine transports (incl. the `http+unix://` bridge)
```

A new engine is one file in `engine/` (a class implementing `Engine` that writes its output into the
turn with Responses types) plus one line in `engine/index.ts`.

Spec: `greyverse-project/specs/greyfolk.md`. Implementation choices and open items: `SPEC_GAPS.md`.

## Start

```
greyfolk --listen unix:/run/agent.sock|tcp:127.0.0.1:8900|fd:3 \
         --key-fd 4 --agent-dir /agents/alice \
         --engine fake|claude|codex [--no-host-tools] \
         [--model fixed|request] [--subagent-profile FILE] [--soul FILE] \
         [--reset-archive DIR] [--socket-mode 0600]
```

| option | meaning |
|---|---|
| `--listen` | `unix:PATH`, `tcp:HOST:PORT` (`PORT` 0 = any), or `fd:N` (an inherited listening socket) |
| `--key-fd N` | the bearer key, read once from inherited file descriptor N. Never in argv, the environment or a file (`--key-file`/`--dev-key` are refused) |
| `--agent-dir DIR` | the agent folder (default `.`) |
| `--engine` | required: a registered engine — `fake` (test fixture, no model), `claude` (Claude Agent SDK), `codex` (Codex CLI) |
| `--no-host-tools` | the engine's own file, shell, browser and other host tools are off, so only the request's MCP tools reach anything. The engine runs as greyfolk's child either way. Claude: built-in tools limited to `Agent`/`TodoWrite`, host tools disallowed, the session's tool list checked on every turn. Codex: read-only sandbox, host features disabled; greyfolk refuses to start if this Codex does not know a feature it must disable (fail closed) |
| `--socket-mode` | mode of a `unix:` listening socket (default `0600`); the path is reused only when it is a stale socket |
| `--model` | `fixed` (default): a request's `model` is ignored; `request`: it may choose within the engine's family |
| `--subagent-profile FILE` | a JSON file from the starter: `{name?, description?, mcp_tools:["<label>__<tool>", …], read_only?:[paths], writable?:path}`. `mcp_tools` (wildcards allowed) are the MCP tools a subagent may call; `read_only`/`writable` confine the engine's own file tools when host tools are on. Claude: applied (an agent definition plus a `PreToolUse` guard on every subagent call). Codex: **not applied** (`status.subagent_profile.applied=false`). Missing or malformed file → refuses to start |
| `--soul FILE` | the instruction file to use instead of `AGENTS.md` / `CLAUDE.md` in the folder (claude/codex only). An optional `---` metadata header (`name`, `description`, `author`, `version`, …) is parsed and validated — a malformed header refuses the start; only the Markdown body becomes the system prompt |
| `--reset-archive DIR` | where a reset moves the old session (must lie outside the agent folder; default `<agent>.archive` next to it) |

Where things load from: the engine runs with the agent folder as its working folder and config home
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); the soul is passed explicitly as the system prompt; a repo's
own `AGENTS.md`, `.mcp.json` or global config is never loaded. Tools come only from the MCP servers
each request names, plus — unless `--no-host-tools` — the engine's built-in tools as the folder's settings allow.

## Client contract

Every request carries `Authorization: Bearer <key>`. Errors use the OpenAI shape
`{error:{type,code,message,param}}` (`invalid_request_error`, `not_found_error`, `server_error`...).

### `POST /v1/responses`

Body (the OpenAI Responses subset greyfolk takes):

| field | notes |
|---|---|
| `input` | a string or message items (`role` user/system/developer/assistant, text parts only). New input is chosen **by position**: with `previous_response_id` the input holds only new items (the standard); without it the input is read as the whole conversation and only the items after its last assistant message are fed. The same text may be sent any number of times. Nothing new → `400 no_new_input`. Images, files and audio → `400 unsupported_input` |
| `instructions` | applies to this response only, on top of the soul; never written into it |
| `previous_response_id` | must belong to the latest turn (one session, no branches), else `400` |
| `tools` | `{type:"mcp", server_label, server_url, headers?, require_approval?}` entries, attached to the engine **for this turn only**. `http+unix://` URLs are bridged to a Unix socket. `headers` (the turn's credentials) are never echoed: the response's `tools` carry `headers: null`. `require_approval` defaults to `"always"`: the engine asks (`greyfolk.permission_request`) before such a server's tools run; an engine that cannot ask (Codex) refuses anything but `"never"` with `400 unsupported_tool` |
| `model` | honoured only under `--model request` |
| `stream` | `true` → SSE of the events below; `false` → the last response of the turn once it ends |
| `background` | `true` → the response is not cancelled when the creating stream closes |
| `metadata` | stored on the response |
| `greyfolk.deliver_held` | extension: turn ids whose **held subagent results** (see §Subagents) this response carries in. Unknown id → `400 unknown_held_turn` |

Closing the SSE stream that *created* a non-background response cancels it. A re-attach stream
(`GET …?stream=true`) closing does not.

### Other endpoints

| endpoint | what it does |
|---|---|
| `GET /v1/responses/{id}` | the response object. `?stream=true&starting_after=N` re-attaches to a running response and replays its events after sequence number N |
| `POST /v1/responses/{id}/cancel` | cancels; an already-ended response is returned as is (200) |
| `GET /greyfolk/status` | `{state:"idle"|"busy", engine, model, session_id, turn, subagents:{running,lost}, subagent_profile:{name,applied}, held, permission_requests}` |
| `GET /greyfolk/history` | `{object:"list", data:[{role,text,at}]}` read from the engine's own session file |
| `POST /greyfolk/export {dest}` | copies the agent folder to `dest` (outside the folder) while fully idle; leaves out what the engine rebuilds (and credentials) |
| `POST /greyfolk/reset` | moves the session out of the agent's reach (`--reset-archive`) and starts over; fully idle only |
| `POST /greyfolk/permissions/{id} {decision:"allow"|"deny"}` | answers a pending permission request |

### WebSocket `/v1/responses`

Client events: `response.create` (same body as the POST), `response.steer`
(`{previous_response_id?, input}` — defaults to the running response), `response.cancel` (`{response_id}`).
Server events are the ones below, each tagged with the `response_id`. Closing the socket cancels the
non-background responses it created.

### Events greyfolk emits

Every event carries `sequence_number` (per response, for re-attach).

| event | when |
|---|---|
| `response.created`, `response.in_progress` | the response starts |
| `response.output_item.added` / `.done` | a `message`, `reasoning` or `mcp_call` output item opens / closes |
| `response.content_part.added` / `.done`, `response.output_text.delta` / `.done` | assistant text streaming |
| `response.mcp_call.in_progress` | a tool call is running (its `mcp_call` item carries `arguments`, later `output` / `error`) |
| `response.completed` / `response.failed` / `response.cancelled` | the response ended. `usage` is the engine's token count when it reports one |
| `response.incomplete` (`incomplete_details.reason="steered"`) | a steer landed: this response ends and a successor `response.created` follows in the same turn |
| `response.steer.accepted` `{steer:{id,previous_response_id}}` | greyfolk took the steer |
| `greyfolk.steer_taken_in` `{steer, next_response_id}` | the engine took the input into the running turn (the successor's `response.created` follows) |
| `response.steer.failed` `{steer:{id, previous_response_id, input}, error:{code:"response_not_active"}}` | the response had ended, or the engine cannot take mid-turn input (then send it as the next turn) |
| `greyfolk.permission_request` `{id, response_id, tool, operation}` | the engine asks for a tool permission; answer with `POST /greyfolk/permissions/{id}` (`deny` if the turn is cancelled or greyfolk stops) |
| `greyfolk.subagent_started` `{id, turn, description}` / `greyfolk.subagent_finished` `{id, turn, status}` | a native subagent of the engine started / reported inside a response |
| `greyfolk.held_delivered` `{response_id, turns:[{turn, results}]}` | this response carried held subagent results in (`greyfolk.deliver_held`) |

### Subagents and held results

A subagent result that arrives when no response is running is **not** fed to the model by itself.
Greyfolk holds it keyed by the turn that spawned it (`status.held`), and the client decides when it
goes in: the next `POST /v1/responses` with `greyfolk.deliver_held:[turn id, …]` feeds the held results
ahead of the new input and emits `greyfolk.held_delivered`. A subagent the engine lost (its process
ended) is listed in `status.subagents.lost`.

## Engines

| | fake | claude | codex |
|---|---|---|---|
| engine | none (scripted echo) | Claude Agent SDK `0.3.292`, one Claude Code process per turn (streaming input) | Codex CLI through the SDK's `exec --experimental-json` protocol (`@openai/codex-sdk 0.161.0` types), one process per turn |
| session | `fake-session/*.jsonl` | `projects/<cwd>/<session id>.jsonl` under the folder, resumed by id | `sessions/…/rollout-*-<thread id>.jsonl` under the folder, `exec resume <id>` |
| steer (mid-turn input) | yes | yes | no → `response.steer.failed(response_not_active)` |
| permission requests | yes | yes (`canUseTool`; MCP servers with `require_approval:"never"` run without asking) | no (`approval_policy=never`; MCP tools pre-approved; `require_approval:"always"` refused) |
| host tools off (`--no-host-tools`) | — | built-ins = `Agent`, `TodoWrite` | read-only sandbox, shell/exec/browser/computer/image/app features disabled |
| subagents observed | yes | yes (hooks + task events, late results held) | no |
| subagent profile (§5) | no | applied | **not applied** (no subagent settings in the exec protocol) |
| per-turn MCP | — | SDK `mcpServers` | a 0600 `--profile` config layer for that turn's process (never argv) |
| export leaves out | — | credentials, caches, shell snapshots, debug | `state_*.sqlite*`, `auth.json`, logs, cache |

Resuming from an exported copy is tested behaviour per pinned engine version, not an SDK promise
(see `PROGRESS.md` for what is still open). Engine logins live in the agent folder's config home;
greyfolk never reads or prints them.

## Development

```
npm install
npm run typecheck && npm run build && npm test
(umask 077; echo dev-key > /tmp/greyfolk.key)
node dist/cli.js --listen tcp:127.0.0.1:8900 --key-fd 3 --agent-dir ./agent --engine fake 3</tmp/greyfolk.key
```

Tests use the fake engine and a stand-in `codex` binary; nothing needs a real login.
