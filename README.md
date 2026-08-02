# Project Thread Orchestrator / 项目线程编排器

Project Thread Orchestrator is a GitHub-ready Codex plugin repository. It packages the `project-capsule-orchestrator` Skill with a local stdio MCP server, allowing a reviewed project to be decomposed into persistent milestone tasks only after an explicit confirmation.

Project Thread Orchestrator 是一个可发布到 GitHub 的 Codex 插件仓库。它将 `project-capsule-orchestrator` Skill 与本地 stdio MCP Server 打包，只有在用户明确确认后，才会把经过审阅的项目拆分为持久化的里程碑任务。

## Install / 安装

After publishing, replace `<owner>/<repo>` with the GitHub repository name:

发布后，将 `<owner>/<repo>` 替换为实际 GitHub 仓库名：

```powershell
codex plugin marketplace add <owner>/<repo>
codex plugin add project-thread-orchestrator@project-thread-orchestrator-marketplace
```

Restart Codex Desktop after installation.
安装后请完整重启 Codex Desktop。

## Use / 使用

```text
Use $project-thread-orchestrator:project-capsule-orchestrator to audit this project, build a project capsule, preview milestone tasks, and stop for my explicit confirmation.
```

The plugin validates a 3–12 milestone dependency graph, presents a preview, and stops. It creates tasks only after a subsequent explicit confirmation, and initializes them in read-only, network-disabled mode.

插件会校验包含 3–12 个里程碑的依赖图、展示预览并停止。只有在后续消息明确确认后才会创建任务；初始化以只读、禁网模式进行。

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

The protocol check (`pnpm run validate:protocol`) additionally needs a compatible local `codex` command.
协议检查（`pnpm run validate:protocol`）还需要兼容的本地 `codex` 命令。

See the detailed bilingual documentation in [project-thread-orchestrator/README.md](project-thread-orchestrator/README.md).

详细的中英双语说明请见 [project-thread-orchestrator/README.md](project-thread-orchestrator/README.md)。
