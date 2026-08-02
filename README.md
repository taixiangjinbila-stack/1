# Project Thread Orchestrator

<p align="center">
  <strong>Turn a reviewed project plan into safe, persistent Codex milestone tasks.</strong><br />
  将经过审阅的项目计划，安全地拆分为可持续推进的 Codex 里程碑任务。
</p>

<p align="center">
  <a href="https://github.com/taixiangjinbila-stack/1/blob/main/project-thread-orchestrator/LICENSE">MIT License</a>
  · <a href="https://github.com/taixiangjinbila-stack/1/issues">Report a bug / 报告问题</a>
  · <a href="https://github.com/taixiangjinbila-stack/1/issues">Request a feature / 提出建议</a>
</p>

> [!WARNING]
> This plugin creates persistent Codex tasks only after an explicit confirmation. Review the preview carefully before confirming.<br />
> 本插件只有在用户明确确认后才会创建持久化 Codex 任务。请在确认前仔细审阅预览内容。

## What it does / 它能做什么

Project Thread Orchestrator packages a planning Skill and a local stdio MCP server:

| Component / 组件 | Role / 职责 |
| --- | --- |
| `project-capsule-orchestrator` Skill | Audits a project, asks focused questions, proposes milestones, and stops for confirmation. / 审计项目、提出关键问题、规划里程碑并等待确认。 |
| MCP server | Validates the plan, creates named persistent tasks through `codex app-server`, and keeps a project-local registry. / 通过 `codex app-server` 校验计划、创建具名持久化任务，并维护项目级注册表。 |

## Why this is safe / 为什么更安全

- **Preview first** — validates a 3–12 milestone dependency graph before any write.<br />
  **先预览**：任何写入前，先校验包含 3–12 个里程碑的依赖图。
- **Explicit confirmation** — a separate confirmation is required before creation.<br />
  **明确确认**：只有后续的单独确认才会创建任务。
- **Read-only initialization** — new tasks initialize with network disabled and do not start milestone work automatically.<br />
  **只读初始化**：新任务以禁网、只读方式初始化，不会自动执行里程碑工作。
- **Fail closed** — ambiguous ownership or state is recorded, never silently replaced.<br />
  **默认拒绝**：任务归属或状态不明确时仅记录，不会静默创建替代任务。

## Install / 安装

### Requirements / 环境要求

- Codex Desktop or Codex CLI with `codex app-server` support
- Node.js 18+
- pnpm (only needed for development / 仅开发时需要)

### From GitHub / 从 GitHub 安装

```powershell
codex plugin marketplace add taixiangjinbila-stack/1
codex plugin add project-thread-orchestrator@project-thread-orchestrator-marketplace
```

Restart Codex Desktop after installation.<br />
安装后请完整重启 Codex Desktop。

## Quick start / 快速开始

Use this prompt in a Codex task:

在 Codex 任务中使用以下提示词：

```text
Use $project-thread-orchestrator:project-capsule-orchestrator to audit this project, build a project capsule, preview milestone tasks, and stop for my explicit confirmation.
```

The first response is always a preview. Confirm in a separate message only if the plan is unchanged and correct.<br />
第一次回复始终是预览。只有在计划未变化且确认无误时，才在后续消息中单独确认。

## Architecture / 架构

```text
Project description / 项目描述
             │
             ▼
  Planning Skill / 规划 Skill
             │  audited milestone plan / 经审阅的里程碑计划
             ▼
        Preview / 预览 ──── explicit confirmation / 明确确认 ────► stop / 停止
             │
             ▼
 Local MCP server / 本地 MCP Server
             │
             ▼
Persistent Codex tasks / 持久化 Codex 任务
```

## Development / 开发

```powershell
cd project-thread-orchestrator\mcp-server
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:dist
pnpm run validate:package
```

`pnpm run validate:protocol` additionally checks the locally installed Codex App Server protocol.<br />
`pnpm run validate:protocol` 还会校验本机安装的 Codex App Server 协议。

## Repository layout / 仓库结构

```text
.agents/plugins/marketplace.json        Codex marketplace entry / Marketplace 配置
.github/                                Community templates and CI / 社区模板与持续集成
project-thread-orchestrator/
├── .codex-plugin/plugin.json           Plugin manifest / 插件清单
├── skills/                             Bundled Skill / 内置 Skill
├── mcp-server/                         Local stdio MCP server / 本地 MCP 服务
├── tests/                              Test suite / 测试套件
└── docs/                               Technical documentation / 技术文档
```

## Contributing / 参与贡献

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), and open an issue before substantial changes.<br />
欢迎贡献。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、遵守[行为准则](CODE_OF_CONDUCT.md)，并在进行较大改动前先创建 Issue。

## Security / 安全

Please do not disclose vulnerabilities in public issues. See [SECURITY.md](SECURITY.md) for the reporting process.<br />
请不要在公开 Issue 中披露漏洞；报告流程请见 [SECURITY.md](SECURITY.md)。

## License / 许可证

Licensed under the [MIT License](project-thread-orchestrator/LICENSE).<br />
采用 [MIT 许可证](project-thread-orchestrator/LICENSE) 发布。
