# Spec gaps and narrow choices (greyfolk, DRAFT 2)

Each item: what the spec leaves open, what was implemented (the narrowest safe choice), where.

1. **Non-text input.** Spec says input the harness cannot take → 400. Implemented: only text
   (`input_text`/`output_text`/`text` parts, string input) is accepted; image/file/audio and non-message
   items → `400 invalid_request_error`, `code=unsupported_input`. (`src/profile/input.ts`)
2. **Which input items are "newer than those the session holds".** Implemented as: hash(role+text)
   of every fed item and every assistant message greyfolk produced is recorded in `.greyfolk/seen-inputs`;
   the leading run of already-known items is dropped, the rest is fed. A request whose items are all
   known → 400 `no_new_input`. An unknown assistant item → 400 (a harness cannot be fed assistant text).
   (`src/profile/input.ts`, `engine.ts#rememberOutput`)
3. **Steer wire shape.** The spec names `response.steer` and an "input taken in" event but no field names.
   Implemented: client event `{type:"response.steer", previous_response_id?, input}` (defaults to the
   running response); server events `response.steer.accepted {steer:{id,previous_response_id}}`,
   `response.steer.taken_in {steer, next_response_id}` (emitted on the old response right before its
   `response.incomplete`), `response.steer.failed {steer, error:{code:"response_ended"}}`. HTTP has no steer
   endpoint (the spec ties steer to the WebSocket). (`src/profile/engine.ts`, `src/server/ws.ts`)
4. **Steer when the harness lacks mid-turn input.** Implemented as an immediate `response_ended`
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
    folder); excludes = harness `exportExcludes()` + `.greyfolk/run` + `.greyfolk/inflight`.
13. **`require_approval`.** Parsed and passed to the harness (`"always"` default as in OpenAI); the spec's
    "under a greyzone it is never" is the caller's choice, not enforced here.
14. **Model policy.** `--model fixed` (default) ignores a request's `model`; the response's `model` field
    then reports the harness's own model (or `"default"` if unknown).
15. **History shape.** `GET /greyfolk/history` → `{object:"list", data:[{role,text,at}]}` read from the
    harness's session file; the spec gives no shape.
16. **Bearer key on an inherited fd.** `--key-fd N` reads the whole fd once at start and is the only source.
    `--dev-key` (argv) and `--key-file` (a file the sandbox might read, even at 0600) are refused with an error
    that points at the fd handoff (`--key-fd 3 3<key`). (`src/cli-options.ts`, `src/server/auth.ts`)
17. **Codex engine start (§9.10, process per turn).** The Codex SDK spawns the binary itself and cannot take
    the `--harness-exec` launcher prefix, so greyfolk spawns `codex exec --experimental-json` through the
    launcher and reads the SDK's JSONL event protocol (the SDK's `ThreadEvent` types are the contract, pinned
    at `0.161.0`). MCP servers (and their authorization headers / bridge environment) never go into argv:
    greyfolk writes a per-turn config layer `<CODEX_HOME>/greyfolk-<response id>.config.toml` (mode 0600,
    created exclusively, deleted after the turn, excluded from exports) and selects it with `--profile <name>`
    (`codex exec --help`, 0.160.1: "Layer $CODEX_HOME/<name>.config.toml on top of the base user config").
    Whether Codex honours the layer on `resume` is not verified end to end here (needs a login). (`src/harness/codex.ts`)
18. **Codex soul.** Passed as `--config model_instructions_file=<agent>/.greyfolk/run/soul.md` (written at
    start; the run dir is left out of exports). The config key is taken from the Codex config docs, not
    verified against the pinned CLI (`codex-cli 0.160.1`). `project_doc_max_bytes=0` turns `AGENTS.md`
    auto-loading off.
19. **Codex permissions (§9.11) and steer.** `approval_policy=never` with sandbox `workspace-write`;
    `capabilities.permissionRequests=false`, `midTurnInput=false` (stdin carries the prompt and closes).
    The app-server route of §9.11 is not implemented.
20. **Codex text streaming.** The JSONL protocol carries whole `agent_message` items; greyfolk emits one
    `output_text.delta` per message, so clients see text per message, not per token.
21. **Soul lookup in the CLI.** `AGENTS.md` then `CLAUDE.md` in the agent folder, or `--soul FILE`. With the
    Claude harness, `settingSources=["user"]` only: with `CLAUDE_CONFIG_DIR` = the agent folder that is the
    folder's own `settings.json` (tool permissions). `project`/`local` are off, so `.claude/settings.json`,
    `.mcp.json` and `CLAUDE.md` are never auto-loaded; the soul goes in explicitly as the system prompt.
    (`CLAUDE_SETTING_SOURCES` in `src/harness/claude.ts`, `test/claude.test.ts`)
22. **Fixed engine model.** `--model fixed|request` is a policy; the fixed model is the engine's own setting
    (no CLI flag names a model string). Under `request`, the model must match the harness's family
    (`Harness.modelFamily`: Claude `claude-*`, Codex `gpt-*`/`o*`/`codex*`, fake `fake-*`), else
    `400 invalid_request_error`, `code=model_not_in_family`, `param=model`. (`src/profile/engine.ts`)
23. **Fail closed at start.** `--harness` is required (no default). `claude`/`codex` refuse to start without
    `--harness-exec`; only `fake` (the test fixture) may run without a launcher. (`src/cli-options.ts`)
24. **Unix listening socket.** The path is only unlinked when it is a socket nobody answers on (a connect
    attempt fails); a regular file / directory or a live socket aborts the start. The socket is created
    under a matching umask and then set to `--socket-mode` (default 0600). TCP binds whatever host the
    starter names (the spec puts the socket outside the sandbox; no extra guard here). (`src/server/index.ts`)
25. **Soul metadata header (§1, DRAFT).** The spec names the fields but no format. Implemented: a `---`-fenced
    header of `key: value` lines at the top of the soul file (`name`, `description`, `author`, `version` known; other
    keys kept as `extra`). No header is allowed. Unclosed header, a non `key: value` line, an empty known field or a
    repeated key refuses the start. Only the body is passed as the system prompt. (`src/soul.ts`, `src/cli.ts`)
26. **Subagent profile (§5).** The spec says "in the harness settings, set by its starter". Implemented: `--subagent-profile
    NAME` → `<agent>/subagent-profiles/NAME.json` `{description?, read_only:[paths], writable:path}` (paths relative to
    the agent folder). Claude: an `agents[NAME]` definition (built-in tools without Bash, `disallowedTools:["mcp__*"]`,
    paths in its prompt) plus a `PreToolUse` hook that denies any subagent (`agent_id` present) `Write`/`Edit`/
    `MultiEdit`/`NotebookEdit` outside `writable` and any `mcp__*` tool. Read-only paths are advisory (the hook does
    not restrict reads). Codex: not applied (`status.subagent_profile.applied=false`); the exec protocol has no
    subagent settings. Mistake prevention, not a boundary, as the spec says. Not run against the real engine.
    (`src/harness/subagent-profile.ts`, `src/harness/claude.ts`)
27. **Documented gaps left on purpose.** Codex permission requests need the app-server route (§9.11; item 19) and the
    real-engine exported-copy resume test (§3) needs pinned logins; both stay open.
