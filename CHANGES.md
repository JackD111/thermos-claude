# Changes

## 0.1.0 - First port of thermos 1.0.0

- Port the three thermos skills and two subagents from cursor/plugins `dc41543` to Claude Code and Codex.
- Rewrite Cursor's `Task` tool, its `shell` and `explore` subagent types, and bare agent names into Claude Code's `Agent` tool, `Bash`, `Explore`, and `thermos:`-namespaced agents.
- Drop `disable-model-invocation` from the two rubric skills so their subagents can load them. `thermos` keeps it.
- Map the subagent dispatch to Codex `spawn_agent` through `skills/thermos/references/codex-tools.md`.
