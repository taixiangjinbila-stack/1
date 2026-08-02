# Project Thread Orchestrator / 项目线程编排器

[English](#english) | [中文](#中文)

## English

Project Thread Orchestrator is a Codex plugin that turns a reviewed project plan into a small, dependency-aware set of persistent Codex tasks. It bundles:

- **`project-capsule-orchestrator` Skill** — interviews, audits, plans, previews, and requests confirmation.
- **Local stdio MCP server** — validates plans, creates named tasks through the public `codex app-server` protocol, records state, and safely reconciles or archives tasks.

### Safety model

1. Validate and preview a 3–12 milestone DAG before any write.
2. Stop after the preview and require a separate, explicit confirmation.
3. Initialize new tasks in read-only, network-disabled mode; never start milestone work automatically.
4. Persist a project-local registry and fail closed when ownership or state is ambiguous.

The normal Skill prompt intentionally excludes diagnostic, repair, migration, cleanup, archive, resume, and delete operations.

### Requirements

- Codex Desktop or Codex CLI with `codex app-server` support
- Node.js 18 or later
- pnpm for development and verification

### Install from GitHub

After publishing, replace `<owner>/<repo>` with the repository address:

```powershell
codex plugin marketplace add <owner>/<repo>
codex plugin add project-thread-orchestrator@project-thread-orchestrator-marketplace
```

Restart Codex Desktop after installation so that the bundled Skill and MCP server load.

### Use

```text
Use $project-thread-orchestrator:project-capsule-orchestrator to audit this project, build a project capsule, preview milestone tasks, and stop for my explicit confirmation.
```

The first response is a preview only. Send a separate, explicit confirmation without changing the plan before tasks are created.

### Development and verification

```powershell
cd project-thread-orchestrator\mcp-server
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:dist
pnpm run validate:package
```

`pnpm run validate:protocol` is separate from the mocked suite and requires a compatible local `codex` command.

### Layout

```text
.agents/plugins/marketplace.json        GitHub-installable marketplace entry
project-thread-orchestrator/             Plugin package
  .codex-plugin/plugin.json              Plugin manifest
  skills/project-capsule-orchestrator/   Bundled Skill
  mcp-server/                            Local stdio MCP server
  tests/                                 Unit, protocol, and package checks
```

### Limitations

The App Server protocol identifies project ownership by canonical working directory, not a project ID. Its behavior can change between Codex releases, so run the verification suite after upgrading. A task can be visible as metadata yet not resumable; the plugin records that state rather than silently creating a replacement.

See [the E2E test plan](docs/e2e-local-marketplace-test-plan.md) and [Windows launch diagnosis](docs/windows-bundled-mcp-launch-diagnosis.md) for development-only details.

## 中文

Project Thread Orchestrator 是一个 Codex 插件，用于把经过审阅的项目计划拆成少量、具有依赖关系的持久化 Codex 任务。它包含：

- **`project-capsule-orchestrator` Skill**：负责访谈、审计、规划、预览并请求确认。
- **本地 stdio MCP Server**：负责校验计划、通过公开的 `codex app-server` 协议创建具名任务、记录状态，并可安全地同步或归档任务。

### 安全设计

1. 在任何写入前校验并预览一个包含 3–12 个里程碑的 DAG。
2. 展示预览后停止，等待用户单独且明确的确认。
3. 新建任务只在只读、禁网模式下初始化；不会自动开始执行里程碑工作。
4. 在项目目录保存注册表；当任务归属或状态不明确时，默认拒绝继续操作。

普通 Skill 提示词不会触发诊断、修复、迁移、清理、归档、恢复或删除操作。

### 环境要求

- 支持 `codex app-server` 的 Codex Desktop 或 Codex CLI
- Node.js 18 或更高版本
- pnpm（用于开发和验证）

### 从 GitHub 安装

发布后，将 `<owner>/<repo>` 替换为实际仓库地址：

```powershell
codex plugin marketplace add <owner>/<repo>
codex plugin add project-thread-orchestrator@project-thread-orchestrator-marketplace
```

安装后请完整重启 Codex Desktop，使内置 Skill 与 MCP Server 被加载。

### 使用方法

```text
Use $project-thread-orchestrator:project-capsule-orchestrator to audit this project, build a project capsule, preview milestone tasks, and stop for my explicit confirmation.
```

第一次回复只会给出预览。只有在计划保持不变的前提下，再单独发送明确确认，才会创建任务。

### 开发与验证

```powershell
cd project-thread-orchestrator\mcp-server
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:dist
pnpm run validate:package
```

`pnpm run validate:protocol` 会检查本机 Codex App Server 协议，因此需要兼容的本地 `codex` 命令。

### 已知限制

App Server 协议通过规范化工作目录识别项目，而没有提供 project ID。协议可能随 Codex 版本演进，因此升级 Codex 后请重新运行验证。任务即使在元数据中可见，也可能无法恢复；遇到这种情况，插件会记录状态，而不会悄悄创建替代任务。

开发细节请查看 [端到端测试计划](docs/e2e-local-marketplace-test-plan.md) 和 [Windows 启动诊断](docs/windows-bundled-mcp-launch-diagnosis.md)。
