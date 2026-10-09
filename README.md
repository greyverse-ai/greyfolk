# greyfolk

One harness (soul + vessel + session) served as a plain OpenAI Responses-shaped server.

One greyfolk process = one agent = one continuing session. The agent is a folder: its instruction
file (the **soul**: `AGENTS.md` or `CLAUDE.md`), the engine's own config and session data, and a
`.greyfolk/` directory with greyfolk's small records. The engine (the **vessel**) is the Claude
Agent SDK, the Codex CLI, or a scripted fake for tests. Clients talk to it with the OpenAI
Responses API shape; everything engine-specific is hidden behind that.

Spec: `greyverse-project/specs/greyfolk.md`. Implementation choices and open items: `SPEC_GAPS.md`.

## Start

```
greyfolk --listen unix:/run/agent.sock|tcp:127.0.0.1:8900|fd:3 \
         --key-fd 4 --agent-dir /agents/alice \
         --harness fake|claude|codex --harness-exec "<launcher ...>" \
         [--model fixed|request] [--subagent-profile NAME] [--soul FILE] \
         [--reset-archive DIR] [--socket-mode 0600]
```

| option | meaning |
|---|---|
| `--listen` | `unix:PATH`, `tcp:HOST:PORT` (`PORT` 0 = any), or `fd:N` (an inherited listening socket) |
| `--key-fd N` | the bearer key, read once from inherited file descriptor N. Never in argv, the environment or a file (`--key-file`/`--dev-key` are refused) |
| `--agent-dir DIR` | the agent folder (default `.`) |
| `--harness` | required: `fake` (test fixture, no engine), `claude` (Claude Agent SDK), `codex` (Codex CLI) |
| `--harness-exec` | a launcher prefix (the sandbox launcher); required for `claude`/`codex` (fail closed), the engine is started only through it and greyfolk exits if it fails |
| `--socket-mode` | mode of a `unix:` listening socket (default `0600`); the path is reused only when it is a stale socket |
| `--model` | `fixed` (default): a request's `model` is ignored; `request`: it may choose within the engine's family |
| `--subagent-profile NAME` | `<agent>/subagent-profiles/NAME.json` = `{description?, read_only:[paths], writable:path}`. Claude: applied (agent definition with built-in tools only, `mcp__*` disallowed, plus a `PreToolUse` guard confining every subagent's writes to `writable` and refusing MCP tools). Codex: **not applied** (`status.subagent_profile.applied=false`). Missing file → refuses to start |
| `--soul FILE` | the instruction file to use instead of `AGENTS.md` / `CLAUDE.md` in the folder (claude/codex only). An optional `---` metadata header (`name`, `description`, `author`, `version`, …) is parsed and validated — a malformed header refuses the start; only the Markdown body becomes the system prompt |
| `--reset-archive DIR` | where a reset moves the old session (must lie outside the agent folder; default `<agent>.archive` next to it) |

Where things load from: the engine runs with the agent folder as its working folder and config home
(`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); the soul is passed explicitly as the system prompt; a repo's
own `AGENTS.md`, `.mcp.json` or global config is never loaded. Tools come only from the MCP servers
each request names, plus the engine's built-in tools as the folder's settings allow.

## Client contract

Every request carries `Authorization: Bearer <key>`. Errors use the OpenAI shape
`{error:{type,code,message,param}}` (`invalid_request_error`, `not_found_error`, `server_error`...).

### `POST /v1/responses`

Body (the OpenAI Responses subset greyfolk takes):

| field | notes |
|---|---|
| `input` | a string or message items (`role` user/system/developer/assistant, text parts only). Only items **newer than those the session already holds** are fed; resent history is skipped. A request with nothing new → `400 no_new_input`. Images, files and audio → `400 unsupported_input` |
| `instructions` | applies to this response only, on top of the soul; never written into it |
| `previous_response_id` | must belong to the latest turn (one session, no branches), else `400` |
| `tools` | `{type:"mcp", server_label, server_url, headers?, require_approval?}` entries, attached to the engine **for this turn only**. `http+unix://` URLs are bridged to a Unix socket |
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
| `GET /greyfolk/status` | `{state:"idle"|"busy", harness, model, session_id, turn, subagents:{running,lost}, subagent_profile:{name,applied}, held, permission_requests}` |
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
| `response.steer.taken_in` `{steer, next_response_id}` | the engine took the input into the running turn |
| `response.steer.failed` `{steer, error:{code:"response_ended"}}` | the response had ended, or the engine cannot take mid-turn input (then send it as the next turn) |
| `greyfolk.permission_request` `{id, response_id, tool, operation}` | the engine asks for a tool permission; answer with `POST /greyfolk/permissions/{id}` (`deny` if the turn is cancelled or greyfolk stops) |
| `greyfolk.subagent_started` `{id, turn, description}` / `greyfolk.subagent_finished` `{id, turn, status}` | a native subagent of the engine started / reported inside a response |
| `greyfolk.held_delivered` `{response_id, turns:[{turn, results}]}` | this response carried held subagent results in (`greyfolk.deliver_held`) |

### Subagents and held results

A subagent result that arrives when no response is running is **not** fed to the model by itself.
Greyfolk holds it keyed by the turn that spawned it (`status.held`), and the client decides when it
goes in: the next `POST /v1/responses` with `greyfolk.deliver_held:[turn id, …]` feeds the held results
ahead of the new input and emits `greyfolk.held_delivered`. A subagent the engine lost (its process
ended) is listed in `status.subagents.lost`.

## Harnesses

| | fake | claude | codex |
|---|---|---|---|
| engine | none (scripted echo) | Claude Agent SDK `0.3.292`, one Claude Code process per turn (streaming input) | Codex CLI through the SDK's `exec --experimental-json` protocol (`@openai/codex-sdk 0.161.0` types), one process per turn |
| session | `fake-session/*.jsonl` | `projects/<cwd>/<session id>.jsonl` under the folder, resumed by id | `sessions/…/rollout-*-<thread id>.jsonl` under the folder, `exec resume <id>` |
| steer (mid-turn input) | yes | yes | no → `response.steer.failed(response_ended)` |
| permission requests | yes | yes (`canUseTool`) | no (`approval_policy=never`, sandbox `workspace-write`) |
| subagents observed | yes | yes (hooks + task events, late results held) | no |
| subagent profile (§5) | no | applied | **not applied** (no subagent settings in the exec protocol) |
| per-turn MCP | — | SDK `mcpServers` | `--config mcp_servers.<label>…` on that turn's process |
| export leaves out | — | credentials, caches, shell snapshots, debug | `state_*.sqlite*`, `auth.json`, logs, cache |

Resuming from an exported copy is tested behaviour per pinned engine version, not an SDK promise
(see `PROGRESS.md` for what is still open). Engine logins live in the agent folder's config home;
greyfolk never reads or prints them.

## Development

```
npm install
npm run typecheck && npm run build && npm test
(umask 077; echo dev-key > /tmp/greyfolk.key)
node dist/cli.js --listen tcp:127.0.0.1:8900 --key-fd 3 --agent-dir ./agent --harness fake 3</tmp/greyfolk.key
```

Tests use the fake harness and a stand-in `codex` binary; nothing needs a real login.
