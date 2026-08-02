---
name: project-capsule-orchestrator
description: Turn a project goal into 2-8 practical, dependency-aware milestone tasks in one Codex project. Use when the user asks to audit a project, create a project capsule, split work into confirmed Codex tasks, or plan milestone threads. 将项目目标拆分为 2–8 个具有依赖关系的里程碑任务；适用于项目审计、项目胶囊、任务拆分和 Codex 里程碑任务规划。
---

# Project Capsule / 项目胶囊

1. Read the user's project description and ask at most three high-value questions only when needed.
2. Propose 2-8 milestones named M0, M1, and so on. Each has a clear goal, dependencies as task context, and acceptance criteria.
3. Call `preview_project_threads` and explain the proposed milestones in ordinary language.
4. Stop for one clear confirmation.
5. After confirmation, call `initialize_project_capsule`; only after it succeeds call `create_project_threads` with the unchanged plan.
6. Tell the user that the milestone tasks are now available in the same project.

Do not expose implementation details such as JSON, RPC, thread IDs, sandbox settings, or cwd mechanics unless the user explicitly asks for diagnostics. Dependencies are planning context only; do not use a lifecycle state machine. Use `list_project_threads` or `sync_project_threads` only to show or refresh the created tasks. Never call Doctor, repair, migration, activation, completion, execution-grant, cleanup, archive, resume, or delete operations.

中文执行说明：

1. 阅读用户的项目描述；仅在必要时提出最多三个高价值问题。
2. 提议 2–8 个编号为 M0、M1 等的里程碑，每项都要有明确目标、依赖关系和验收标准。
3. 调用 `preview_project_threads`，用普通语言说明拟议任务。
4. 展示预览后停止，等待一次明确确认。
5. 确认后调用 `initialize_project_capsule`；仅在成功后才用未变化的计划调用 `create_project_threads`。
6. 告知用户里程碑任务已在同一项目中可用。

除非用户明确要求诊断，否则不要暴露 JSON、RPC、线程 ID、沙箱或 cwd 等实现细节。依赖仅用于规划，不使用生命周期状态机。只用 `list_project_threads` 或 `sync_project_threads` 展示或刷新已创建任务。绝不调用 Doctor、修复、迁移、激活、完成、执行授权、清理、归档、恢复或删除操作。
