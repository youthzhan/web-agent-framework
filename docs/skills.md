# Skill 技能系统

系统会从 `SKILLS_DIR/**/SKILL.md` 中发现 Skill。启动时，加载器仅读取 YAML
frontmatter（`name`、`description`、`allowedTools`、`triggers`）；只有选中
某个 Skill 后，才会按需加载完整的技能说明。

## 加载与路由

`name` 与可选的 `triggers` 提供受限且确定性的路由路径：

- 显式指定 Skill 名称，或命中触发词时，无需首次调用规划模型，最多选择三个
  Skill。
- 随后按需加载完整 `SKILL.md` 正文，由 Skill 工具规划器决定具体工具调用及其
  串行或并行模式。
- 未命中时由模型规划器在运行时动态选择 Skill 及其执行模式。
- 设置 `SKILL_PLANNER_FALLBACK_ENABLED=true` 后，规划器发生
  `MODEL_TIMEOUT` 时会回退到同一名称/触发词匹配；仍未命中则回退为直接对话。
- 设置 `SKILL_TOOL_PLAN_FALLBACK_ENABLED=true` 后，Skill 工具规划超时时，
  仅会从用户消息中提取明确的相对文件路径或 HTTP(S) URL 生成调用。这些调用仍
  必须通过 Skill ACL、Zod 校验、沙箱和域名检查以及高风险审批策略。

frontmatter 示例：

```yaml
---
name: workspace-inspection
description: 检查沙箱中的文件。
allowedTools: file_read
triggers: [workspace, sandbox, file, "文件", "读取"]
---
```

## 执行模式

规划器会为每个选中的 Skill 返回 `mode`；Skill 工具规划器会为自身的工具调用返回
单独的 `mode`：

- `parallel`：连续的一批相互独立调用会并发执行。
- `serial`：该项前后都会形成顺序屏障。

运行时会保留规划器顺序。例如，`serial(A), parallel(B,C), serial(D)` 的执行顺序为
`A -> [B,C] -> D`。

`tool_call` SSE 事件会携带运行时选择的工具模式。Agent 对话页面会在执行活动面板
中展示该信息。

## 真实对话调用

Agent 会根据真实用户消息选择以下路由方式：

- 直接调用：消息中出现完整 Skill 名称，例如
  `使用 workspace-inspection 读取 README.md`。
- 意图匹配：消息命中 `triggers`，例如 `读取 README.md` 会匹配
  `workspace-inspection`。
- 显式串行：包含 `先...再...`、`然后`、`串行`、`依次` 等依赖表达时，
  多个 Skill 按消息中的出现顺序串行执行。
- 显式并行：包含 `并行`、`并发`、`同时`、`互不依赖` 等表达时，多个
  Skill 以 `parallel` 模式执行。
- 动态调度：命中多个 Skill，但用户没有说明依赖关系时，由模型规划器判断需要
  哪些 Skill 以及采用 `serial` 还是 `parallel`。规划器超时则保守回退为串行。

示例：

```text
# 直接调用单个 Skill
使用 workspace-inspection 读取 README.md

# 意图匹配
读取 README.md 并总结

# 串行调用两个 Skill
先用 workspace-inspection 读取 README.md，然后用 web-research 访问 https://jsonplaceholder.typicode.com/todos/1

# 并行调用两个 Skill
同时用 workspace-inspection 读取 README.md，并用 web-research 访问 https://jsonplaceholder.typicode.com/todos/1

# 动态决定串并行
读取 README.md，并查询 https://jsonplaceholder.typicode.com/todos/1 中的相关信息
```

`planning_deterministic` SSE 状态表示规则已明确决定路由；
`planning_dynamic` 表示模型参与了 Skill 选择或串并行决策。事件的 `detail.skills`
会列出每个 Skill 的 `skillName` 和 `mode`。

## 内置示例

- `workspace-inspection`：在 `SANDBOX_ROOT` 下执行低风险 `file_read` 调用。
- `web-research`：执行高风险 `http_request` 调用，并暂停等待人工审批。

每个审批步骤只允许一个高风险调用。包含多个高风险调用的计划会安全失败，不会将一次
用户审批视为对多个外部操作的授权。
