# greyfolk — progress

Spec: greyverse-project/specs/greyfolk.md (DRAFT 2, 2026-10-07). Nothing is committed; chunk 4 ended 2026-10-08.

## Rework 2026-10-09 (complete) — the Responses API is the abstraction

Baseline before the rework: commit `99e4ce8`. Audits: `~/.greyzone/projects/greyverse/loop/greyfolk-audit-*.md`.

- **Two layers + engine strategies.** `server/` (controller: HTTP+SSE, WebSocket) → `service/agent-service.ts`
  (the Responses API for one agent: turns, steer, cancel, held results, status; implements `ResponsesApi`)
  → one `Engine` strategy per engine (`engine/claude.ts`, `engine/codex.ts`, `engine/fake.ts`). The engine
  writes its output straight into the turn (`common/turn.ts`) with the official Responses types.
- **No custom model.** `harness/types.ts` (engine event model) and `profile/types.ts` (hand-written Responses
  look-alikes) are gone; `profile/engine.ts` (619 lines) is replaced by the service plus small parts in
  `common/` (response log, session record, held results, steer queue, permission bridge). Types come from
  npm `openai` 7.31 (`api/types.ts` adds only `greyfolk.*`).
- **Engine registry.** `engine/registry.ts`; `engine/index.ts` lists the engines (one line each). A new engine =
  one strategy file + one line (`test/registry.test.ts` proves it).
- **Fixes from the audits.** `--no-host-tools` (Claude: built-ins `Agent`/`TodoWrite` only, host tools disallowed,
  init tool list checked per turn; Codex: read-only sandbox + host features disabled, feature list checked at
  start); `--harness`/`--harness-exec` removed (engine runs as greyfolk's child); MCP `headers` never echoed;
  new input chosen by position (the same text twice works; `seen-inputs` hash store removed);
  `require_approval` honoured (Claude asks unless `"never"`; Codex pre-approves and refuses `"always"`);
  Codex MCP calls no longer blocked under `approval_policy=never` (`default_tools_approval_mode="approve"`);
  subagent profile = a starter-owned JSON file with `mcp_tools`; official steer error code `response_not_active`;
  `greyfolk.steer_taken_in` (was `response.steer.taken_in`); status `engine` (was `harness`); `engine_error`.
- Tests: 59/59 green (`npm test`), `npm run typecheck` and `npm run build` green.
- Still open: real-engine end-to-end (needs logins inside an agent folder), Codex app-server permissions
  (§9.11), resume-from-copy per engine version (§3).

## Done (chunks 1–4)

- `src/profile/*` — the OpenAI Responses profile: request validation (`input.ts`), error conventions
  (`errors.ts`), in-memory response records with per-response sequence numbers + re-attach replay
  (`responses.ts`), and the engine (`engine.ts`): turn state machine (one turn at a time; a turn is a
  chain of responses), new-input-only feeding with dedup of resent history, `previous_response_id` must
  be in the latest turn, steer events, cancel (also when a foreground stream closes),
  `greyfolk.permission_request` + `decidePermission`, status, export and reset gated on fully idle,
  cut-off response reported failed on restart. **Held subagent results (§5)**: late results are kept in
  `.greyfolk/held` keyed by turn, listed in `status.held`, fed in with `greyfolk.deliver_held` and reported
  with `greyfolk.held_delivered` (chunk 3).
- `src/server/*` — bearer auth, `--listen unix:|tcp:|fd:`, HTTP + WebSocket as in README.
- `src/session/store.ts` — `.greyfolk/{session,seen-inputs,inflight,held}`, reset-archive, export with excludes.
- `src/mcp/*` — MCP tool translation (http(s) + `http+unix://` via the stdio bridge).
- `src/harness/fake.ts` — scripted harness (echo, `[perm]`, `[tool]`, `[fail]`, `[spawn]`, steer/cancel).
- `src/harness/claude.ts` (chunk 3) — Claude Agent SDK `0.3.292`: `CLAUDE_CONFIG_DIR` + cwd = agent folder,
  soul as system prompt, `settingSources=["project"]` (changed to `["user"]` in chunk 5), `strictMcpConfig`, auto-memory off, per-turn
  `mcpServers`, resume by session id, `canUseTool` → permission requests, process through `exec.ts`
  (group kill on cancel), history from the session JSONL, subagent hooks + task events, lingering process
  for late results. Type-checks against the real SDK; not run end to end (needs a login).
- `src/harness/codex.ts` (chunk 4) — Codex CLI via the SDK's `exec --experimental-json` JSONL protocol,
  process per turn through the launcher, `CODEX_HOME` = agent folder, soul as `model_instructions_file`,
  per-turn `--config mcp_servers.*`, `exec resume <thread id>`, history from the rollout file,
  `exportExcludes` = `state_*.sqlite*` + credentials. No steer / permissions / subagents. Tested with a
  stand-in `codex` binary (`test/codex.test.ts`); not run against the real CLI (needs a login).
- `src/cli.ts` (chunk 4) — `--harness fake|claude|codex`, `--harness-exec`, `--model fixed|request`,
  `--subagent-profile`, `--soul FILE`; soul read from `AGENTS.md`/`CLAUDE.md`. Smoke-started with both
  engines (listens; refuses without a soul).
- `README.md` (chunk 4) — start options + client contract (endpoints, WS client events, every event
  greyfolk emits incl. `greyfolk.*`, held results, harness matrix).
- Tests (end of chunk 4): engine 22 + server 8 + codex 4 = 34/34 green;
  `npm run typecheck`, `npm run build` green.

## Chunk 5 (2026-10-08, conformance fixes)

- Codex: MCP servers + headers via a per-turn 0600 `--profile` config layer, never argv (SPEC_GAPS 17).
- Claude: `settingSources=["user"]` only (agent folder's own `settings.json`); no project/local/CLAUDE.md auto-load (SPEC_GAPS 21).
- Fail closed: `--harness` required, `claude`/`codex` need `--harness-exec` (SPEC_GAPS 23).
- `--dev-key` removed; `--key-fd` or `--key-file` (0600, outside the agent folder) (SPEC_GAPS 16).
- Unix socket: stale-socket-only unlink, type check, live-socket refusal, 0600 / `--socket-mode` (SPEC_GAPS 24).
- `--model request` constrained to the harness family (`Harness.modelFamily`), else 400 (SPEC_GAPS 22).
- Tests: engine 23 + server 10 + codex 5 + claude 1 + cli 5 = 44/44 green; typecheck + build green.

## Chunk 6 (2026-10-08, re-audit 86.2% fixes)

- Soul metadata (§1): `src/soul.ts` parses the `---` header (`name`, `description`, `author`, `version`, extra kept);
  no header allowed; malformed header (unclosed, non `key: value`, empty known field, repeated key) refuses the start
  with a clear error; only the body is the system prompt. `test/soul.test.ts` (4).
- Subagent profile (§5): `src/harness/subagent-profile.ts` loads `<agent>/subagent-profiles/<name>.json`. Claude
  applies it (`agents` definition: built-in tools only, no Bash, `disallowedTools:["mcp__*"]`; `PreToolUse` guard denies
  subagent writes outside `writable` and any `mcp__*` call; main thread untouched). Codex records `applied:false`.
  `status.subagent_profile {name, applied}`. `test/claude.test.ts` (+2).
- Key-file fallback removed (re-audit new problem 1): `--key-fd` only; `--key-file` and `--dev-key` are refused with a
  pointer to the fd handoff. `readKeyFromFile` deleted.
- Tests: engine 23 + server 10 + codex 5 + claude 3 + cli 4 + soul 4 = 49/49 green; typecheck green.

## Left

1. End-to-end runs of the claude and codex harnesses with a real login (`GREYFOLK_E2E=1` style, never a
   token in the repo): verify `model_instructions_file` key and MCP-on-resume for Codex (SPEC_GAPS 17–18),
   Claude session file location and subagent hooks.
2. Resumption-from-copy test per engine version (§3), pinned engine versions (`CLAUDE_SDK_VERSION`,
   `CODEX_SDK_VERSION` constants exist; no test yet).
3. `--subagent-profile`: applied by Claude (option-level test only, not run against the real engine); Codex not applied (documented).
4. §9.7 10-minute auto-deny of permission requests; §9.9 archive deletion after 30 days; `/v1/models`.
5. Codex permission requests via the app-server (§9.11) if that feature is wanted (`approval_policy=never` stays).
6. Soul metadata: parsed and validated; a shareable soul schema (which fields are required) is still open in the spec (DRAFT).
7. Real-engine runs of the new Codex `--profile` layer and the Claude `settingSources=["user"]` isolation (needs a login).
