# Skills

Skills are discovered from `SKILLS_DIR/**/SKILL.md`. At startup, the loader
reads only YAML frontmatter (`name`, `description`, `allowedTools`, `triggers`).
Full skill instructions are loaded only after a Skill is selected.

## Loading and routing

`name` and optional `triggers` provide a bounded deterministic routing path:

- An explicit Skill name, or a matching trigger, selects at most three Skills
  without the initial planner model call.
- The full `SKILL.md` body is then loaded on demand, and the Skill tool planner
  decides concrete tool calls and its own serial/parallel mode.
- Requests without a match use the model planner, which can dynamically select
  Skills and their execution modes at runtime.
- With `SKILL_PLANNER_FALLBACK_ENABLED=true`, a planner `MODEL_TIMEOUT` falls
  back to the same name/trigger matching. No match falls back to direct chat.
- With `SKILL_TOOL_PLAN_FALLBACK_ENABLED=true`, a Skill planner timeout may
  derive calls only from explicit relative file paths or HTTP(S) URLs in the
  user message. Those calls still pass the Skill ACL, Zod validation, sandbox
  and host checks, and high-risk approval policy.

Example frontmatter:

```yaml
---
name: workspace-inspection
description: Inspect sandbox files.
allowedTools: file_read
triggers: [workspace, sandbox, file, "\u6587\u4ef6", "\u8bfb\u53d6"]
---
```

## Execution modes

The planner returns a `mode` for every selected Skill. The skill tool planner
returns a separate `mode` for its tool calls:

- `parallel`: a contiguous batch runs concurrently when calls are independent.
- `serial`: creates an ordering barrier before and after the item.

The runtime preserves the planner's order. For example,
`serial(A), parallel(B,C), serial(D)` runs as `A -> [B,C] -> D`.

`tool_call` SSE events include the runtime-selected tool mode. The Agent chat
page exposes this in the execution activity panel.

## Built-in examples

- `workspace-inspection`: low-risk `file_read` calls under `SANDBOX_ROOT`.
- `web-research`: high-risk `http_request` calls, paused for human approval.

Each approval step permits one high-risk call. A plan containing multiple
high-risk calls fails safely rather than treating one user approval as consent
for several external actions.
