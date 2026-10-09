# Spec gaps and narrow choices (greyfolk, DRAFT 2; reworked 2026-10-09)

Each item: what the spec leaves open, what was implemented (the narrowest safe choice), where.

1. **Non-text input.** Spec says input the engine cannot take → 400. Implemented: only text
   (`input_text`/`output_text`/`text` parts, string input) is accepted; image/file/audio and non-message
   items → `400 invalid_request_error`, `code=unsupported_input`. (`src/api/input.ts`)
2. **Which input items are "newer than those the session holds".** Chosen by position, never by content (the
   same text may be sent twice): with `previous_response_id` every input item is new (the standard); without it
   the input is read as the whole conversation and the items after its last assistant message are new (none →
   all of it). Nothing new → `400 no_new_input`; an assistant item among the new ones → `400 unsupported_input`.
   A stateless client that resends history after a *failed* turn feeds that turn's user input again (it was never
   answered). (`src/api/input.ts#selectNewItems`)
3. **Steer wire shape.** The spec names `response.steer` and an "input taken in" event but no field names.
   Implemented with the official SDK types (`openai` 7.31): client event `{type:"response.steer",
   previous_response_id?, input}` (user messages only; defaults to the running response); server events
   `response.steer.accepted {steer:{id,previous_response_id}}`, `response.steer.failed {steer:{id,
   previous_response_id,input}, error:{code:"response_not_active"}}` (the official code; the spec's
   "response_ended" is the outcome's name), and the extension `greyfolk.steer_taken_in {steer, next_response_id}`
   right before the old response's `response.incomplete` (the official commit point is the successor's
   `response.created`). HTTP has no steer endpoint. (`src/service/agent-service.ts`, `src/server/ws.ts`)
4. **Steer when the engine lacks mid-turn input.** Implemented as an immediate `response_ended`
   (`response.steer.failed`) while the current response keeps running; the caller makes it the next turn.
5. **Closing a stream cancels.** Implemented only for the stream that *created* the response (SSE POST or
   the WS connection that sent `response.create`) and only when not `background`; a re-attach stream
   (`GET …?stream=true`) closing does not cancel. (`src/server/http.ts`, `ws.ts`)
6. **Non-streaming `POST /v1/responses`.** Returns the last response of the turn's chain once it ends
   (if a WS steer split the turn meanwhile, the caller gets the successor). (`http.ts#createResponse`)
7. **Cancel of an already-ended response.** Returns the response object as is (200), no error.
8. **Permission request when the turn is cancelled / the instance closes.** The pending request is
   answered `deny`. The 10-minute auto-deny of §9.7 is an open item and is *not* implemented.
9. **`/v1/models`.** Not served (the spec only mentions it inside open item §9.4).
10. **Responses are kept in memory only.** `GET /v1/responses/{id}` works for responses of this process
    lifetime; after a restart only the cut-off response (from `.greyfolk/inflight`) is known, as `failed`.
11. **Reset archive location.** Spec: "moved out of the agent's reach". Implemented: `--reset-archive DIR`
    (must lie outside the agent folder; default `<agent>.archive` next to it). Deletion after 30 days
    (§9.9) not implemented.
12. **Export.** `POST /greyfolk/export {dest}` copies the folder to `dest` (must lie outside the agent
    folder); excludes = engine `exportExcludes()` + `.greyfolk/run` + `.greyfolk/inflight`.
13. **`require_approval`.** `"always"` by default as in OpenAI. Claude asks (`greyfolk.permission_request`) before
    tools of a server that is not `"never"`; servers marked `"never"` run without asking. Codex cannot ask, so its
    MCP servers are pre-approved (`default_tools_approval_mode="approve"`) and any `"always"` entry is refused with
    `400 unsupported_tool` (`param=tools[i].require_approval`). Under a greyzone the caller sends `"never"`.
    Credentials (`headers`) are never echoed: the response's `tools` carry `headers: null`.
14. **Model policy.** `--model fixed` (default) ignores a request's `model`; the response's `model` field
    then reports the engine's own model (or `"default"` if unknown).
15. **History shape.** `GET /greyfolk/history` → `{object:"list", data:[{role,text,at}]}` read from the
    engine's session file; the spec gives no shape.
16. **Bearer key on an inherited fd.** `--key-fd N` reads the whole fd once at start and is the only source.
    `--dev-key` (argv) and `--key-file` (a file the sandbox might read, even at 0600) are refused with an error
    that points at the fd handoff (`--key-fd 3 3<key`). (`src/cli-options.ts`, `src/server/auth.ts`)
17. **Codex engine start (§9.10, process per turn).** greyfolk spawns `codex exec --experimental-json` as its own
    child (own process group) and reads the SDK's JSONL event protocol (`ThreadEvent` types, pinned at `0.161.0`).
    MCP servers (and their authorization headers / bridge environment) never go into argv: a per-turn config layer
    `<CODEX_HOME>/greyfolk-<response id>.config.toml` (mode 0600, created exclusively, deleted after the turn,
    excluded from exports) selected with `--profile <name>`. Verified against `codex-cli 0.160.1` (2026-10-09):
    without `default_tools_approval_mode="approve"` an MCP call under `approval_policy=never` is refused ("requires
    approval"), so the layer sets it per server. Whether the layer holds on `resume` is not verified end to end.
18. **Codex soul.** Passed as `--config model_instructions_file=<agent>/.greyfolk/run/soul.md` (written at
    start; the run dir is left out of exports). The config key is taken from the Codex config docs, not
    verified against the pinned CLI (`codex-cli 0.160.1`). `project_doc_max_bytes=0` turns `AGENTS.md`
    auto-loading off.
19. **Codex permissions (§9.11), host tools and steer.** `approval_policy=never`; `canAskApproval=false`; no steer
    (stdin carries the prompt and closes). Sandbox `workspace-write`, or with `--no-host-tools` `read-only` plus
    `--disable` of `shell_tool unified_exec view_image browser_use browser_use_external browser_use_full_cdp_access
    computer_use in_app_browser apps image_generation` and `web_search="disabled"`. Checked by hand against
    0.160.1 (2026-10-09): the model could neither read `/etc/hosts` nor create a file, and an MCP tool still ran.
    `code_mode_host` must stay on (disabling it blocks MCP calls too). At start greyfolk runs `codex features list`
    and refuses to start if any feature it disables is unknown (fail closed). The app-server route of §9.11 is not
    implemented.
20. **Codex text streaming.** The JSONL protocol carries whole `agent_message` items; greyfolk emits one
    `output_text.delta` per message, so clients see text per message, not per token.
21. **Soul lookup in the CLI.** `AGENTS.md` then `CLAUDE.md` in the agent folder, or `--soul FILE`. With the
    Claude engine, `settingSources=["user"]` only: with `CLAUDE_CONFIG_DIR` = the agent folder that is the
    folder's own `settings.json` (tool permissions). `project`/`local` are off, so `.claude/settings.json`,
    `.mcp.json` and `CLAUDE.md` are never auto-loaded; the soul goes in explicitly as the system prompt.
    (`CLAUDE_SETTING_SOURCES` in `src/engine/claude.ts`, `test/claude.test.ts`)
22. **Fixed engine model.** `--model fixed|request` is a policy; the fixed model is the engine's own setting
    (no CLI flag names a model string). Under `request`, the model must match the engine's family
    (`Engine.modelFamily`: Claude `claude-*`, Codex `gpt-*`/`o*`/`codex*`, fake `fake-*`), else
    `400 invalid_request_error`, `code=model_not_in_family`, `param=model`. (`src/service/agent-service.ts`)
23. **Fail closed at start.** `--engine` is required (no default) and must be registered. `--engine`/`--engine-exec`
    (the old sandbox-launcher design) are refused with an explanation. With `--no-host-tools`, Claude limits its
    built-ins to `Agent`/`TodoWrite`, disallows every host tool and checks the session's `init` tool list on every
    turn (a host tool there fails the turn); Codex checks its feature list at start. Claude cannot confirm before
    the first turn without spawning Claude Code, so its check is per turn. (`src/cli-options.ts`, `src/engine/*`)
24. **Unix listening socket.** The path is only unlinked when it is a socket nobody answers on (a connect
    attempt fails); a regular file / directory or a live socket aborts the start. The socket is created
    under a matching umask and then set to `--socket-mode` (default 0600). TCP binds whatever host the
    starter names (the spec puts the socket outside the sandbox; no extra guard here). (`src/server/index.ts`)
25. **Soul metadata header (§1, DRAFT).** The spec names the fields but no format. Implemented: a `---`-fenced
    header of `key: value` lines at the top of the soul file (`name`, `description`, `author`, `version` known; other
    keys kept as `extra`). No header is allowed. Unclosed header, a non `key: value` line, an empty known field or a
    repeated key refuses the start. Only the body is passed as the system prompt. (`src/soul.ts`, `src/cli.ts`)
26. **Subagent profile (§5, §9.13).** The spec says "set by its starter" and gives no format. Implemented:
    `--subagent-profile FILE` (a JSON file the starter owns) `{name?, description?, mcp_tools:["<label>__<tool>"…],
    read_only?:[paths], writable?:path}`. `mcp_tools` (wildcards allowed) are the MCP tools a subagent may call —
    the read-only subset of the greyzone's file tools of §9.13. Claude: an `agents[name]` definition (with host
    tools off: only `mcp__<label>__*` of the turn's servers; with host tools on: Read/Glob/Grep/Write/Edit too) plus
    a `PreToolUse` hook that denies any subagent call to an MCP tool outside `mcp_tools` and, with host tools on, a
    write outside `writable`. Codex: not applied. Mistake prevention, not a boundary. (`src/engine/subagent-profile.ts`,
    `src/engine/claude.ts`)
27. **Documented gaps left on purpose.** Codex permission requests need the app-server route (§9.11; item 19) and the
    real-engine exported-copy resume test (§3) needs pinned logins; both stay open.
