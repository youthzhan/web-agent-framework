# Skill 技能系统

系统会从 `SKILLS_DIR` 或 `SKILLS_DIRS` 指定的每个目录下递归发现 `SKILL.md`。启动时，加载器仅读取 YAML
frontmatter 元数据（`name`、`description`、`allowedTools`、`triggers`、路由字段和可选的
`operations`）；只有选中
某个 Skill 后，才会按需加载完整的技能说明。

`SKILLS_DIRS` 用分隔符连接多个根目录：Windows 使用 `;`，POSIX 使用 `:`，逗号在两种平台都可用。例如 `./skills;./node_modules/m4-skills/skills` 可以同时加载框架内置 Skill 和已安装的 M4 Skill npm 包。`SKILLS_DIR` 仍保持向后兼容，未设置 `SKILLS_DIRS` 时作为唯一根目录使用。

## 加载与路由

`name` 与可选的 `triggers` 提供快速、可解释的路由召回路径：

- 显式指定 Skill 名称，或命中触发词时，无需首次调用规划模型，最多选择三个
  Skill。
- 随后按需加载完整 `SKILL.md` 正文和该 Skill `references/` 目录下的 Markdown
  接口文档，由 Skill 工具规划器决定具体工具调用及其串行或并行模式。
- 没有命中名称或 trigger 时，加载器会从 Skill 的名称、描述、trigger 和
  `metadata` 做轻量语义召回，最多提供三个候选；候选不会直接执行，必须由
  模型规划器结合用户消息和 Skill 描述做最终判断。
- 没有任何语义候选时才会跳过规划器，直接按普通对话处理，避免每条闲聊都扫描完整
  Skill 目录。
- `SKILL_SEMANTIC_RECALL_ENABLED` 控制语义召回，`SKILL_SEMANTIC_RECALL_LIMIT`
  控制最多提供的候选数，默认分别为 `true` 和 `3`。
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

普通 Skill 只需要 `name` 和 `description`。M4 调度 Skill 同样保持这个最小 frontmatter：

```yaml
name: m4-scheduling
description: 处理 M4 调度系统中的 TransportOrder、运单、步骤和调度状态。
```

运行时、工具权限、认证和人工确认属于 Agent 或包清单配置，不写进 Skill metadata。

## 声明式 Operations（可选）

需要确定性规划的 Skill 可以声明 `operations`；最小 Skill 不需要声明它们，直接由宿主模型
根据 Skill 正文和 references 规划调用。

```yaml
operations:
  - id: query-status
    intent: [查询, 状态]
    exclude: [创建, 取消]
    requiresAny: ['\\b[A-Za-z][A-Za-z0-9_-]*\\b']
    tool: domain_read
    method: GET
    path: /api/status
    preflight:
      - tool: domain_read
        method: GET
        path: /api/ping
    parameters:
      - name: id
        target: query
        pattern: 'ID[:：]?[A-Za-z0-9_-]+'
        group: 0
        required: true
    mode: serial
```

字段含义如下：`intent` 命中任意意图词，`exclude` 命中任意排除词时跳过，
`requiresAny` 至少命中一个正则；`parameters` 从用户消息提取 query/body/path 参数，
`env` 可声明由宿主注入的默认环境变量，`preflight` 用于执行主调用前的依赖检查。
`mode` 未声明时沿用用户请求的串并行模式。缺少 required 参数时不会生成工具调用，
避免 Agent 猜测实体 ID。

Agent 不应硬编码具体领域的 endpoint、参数正则、业务实体名称或 Skill 名称。认证、
人工确认、召回 topK/阈值和环境变量值属于 Agent 部署配置；`operations`、命令参数、
错误码及 references 属于 Skill 包。`operations` 只适合明确、低歧义的声明式调用，复杂
请求体和需要多步决策的流程继续交给模型规划器。

调度 Skill 的接口实体、字段和示例维护在 `references/api.md`；当一句话缺少运单 ID 或
请求参数时，模型应先澄清，不猜测业务标识。

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
- 语义召回：消息没有出现完整 trigger，但与 Skill 的领域、实体和能力词相关时，
  会产生 `semantic` 候选。该候选只进入模型规划器，不会因为单个候选就直接调用。
- 动态调度：命中多个 Skill，或存在语义候选且用户没有说明依赖关系时，由模型规划器
  判断需要哪些 Skill 以及采用 `serial` 还是 `parallel`。语义候选的规划超时会安全
  回退为普通对话，不会猜测工具调用。

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

## M4 Skills

安装并接入 `m4-skills` npm 包：

```powershell
npm install
```

在 `.env` 中配置：

```dotenv
SKILLS_DIRS=./skills;./node_modules/m4-skills/skills
M4_BASE_URL=http://localhost:5800
M4_USER_ID=operator-id
M4_USER_TOKEN=server-issued-token
# M4 默认使用 x-xzz-qyq / x-xzz-qyx；只有接入网关改写头名时才需要覆盖。
M4_AUTH_MODE=header
```

启动时框架会从 Skill 根目录旁的 `skill-pack.json` 发现 runtime，并根据 runtime
manifest 自动加载其工具；`src/index.ts` 不需要导入或注册 M4 专用 adapter。M4 调度
`SKILL.md` 只保留 `name`/`description`，工具由包 runtime 提供。加载 Skill 时会把其
`references/*.md` 一并放入规划上下文，
SkillEngine 再规划调用，ToolExecutor 校验并执行。`m4_read` 只允许相对 `/api/` 路径和
查询方法，`m4_write` 用于变更并自动进入人工确认队列。Tool 内部固定使用
`M4_BASE_URL`，由服务端注入认证信息（用户会话默认使用 `x-xzz-qyq` / `x-xzz-qyx`），
因此 Skill 不直接执行 `scripts/`，模型也不能把 M4 API 调成任意外部 URL。

要做到放入目录即发现，目录需要保留 runtime manifest 的相对关系：

```text
agent/
  skills/
    m4-skills/
      skill-pack.json
      runtime/
      skills/
        m4-scheduling/
          SKILL.md
          references/
          scripts/
```

其中 `m4-scheduling/` 是纯 Skill 目录，只包含 `SKILL.md`、`references/` 和 `scripts/`。
`skill-pack.json`、`runtime/` 和 `shared/` 属于 npm 包宿主适配层；如果 Agent 已经自行提供
工具和认证能力，可以只复制 `m4-scheduling/`，不需要复制这些适配层文件。

也可以直接把 npm 包安装到 `node_modules/m4-skills`，并将
`./node_modules/m4-skills/skills` 加入 `SKILLS_DIRS`。只复制一个没有 runtime 的
`SKILL.md` 只能提供说明和路由信息，不能凭空提供可执行工具。
