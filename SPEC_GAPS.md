# Spec gaps and narrow choices (greyfolk, SDK-first rebuild 2026-10-09)

1. **Cancelled response's terminal event.** The standard has status `cancelled` but no stream event for it; the stream ends with `response.incomplete` whose response has status `cancelled`.
2. **Approval mid-turn.** The engine is still running while the caller answers an `mcp_approval_request`; the answering request (with `mcp_approval_response` and `previous_response_id`) continues the same turn in its response. Any other request while an approval waits → 409.
3. **Conversation id = engine session id** (Claude session UUID, Codex thread id). `previous_response_id` works within the process's life; across restarts the caller uses `conversation`.
4. **Codex limits.** No steer (`codex exec` takes no mid-turn input), no approval prompt (`require_approval: "always"` refused), no conversation reader, no `--engine-exec`; engine options limited to what the Codex SDK carries (`-c`, `--enable`, `--disable`).
5. **Claude between turns.** Claude Code may run a step of its own (a late native subagent result); a new turn's message waits until that step ends.
6. **Tool verification** (whether an engine's own tools are really off) is not greyfolk's: the engine's settings and the options after `--` decide; a starter that needs proof checks it itself.
