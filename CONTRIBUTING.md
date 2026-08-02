# Contributing / 参与贡献

Thank you for improving Project Thread Orchestrator.  
感谢你帮助改进 Project Thread Orchestrator。

## Before you start / 开始前

1. Search existing issues before opening a new one.  
   创建新 Issue 前请先搜索已有问题。
2. Discuss large behavior, protocol, or security changes in an issue first.  
   涉及行为、协议或安全模型的大改动，请先在 Issue 中讨论。
3. Do not weaken the preview-and-confirm boundary.  
   不得削弱“预览后确认”的安全边界。

## Development workflow / 开发流程

```powershell
cd project-thread-orchestrator\mcp-server
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:dist
pnpm run validate:package
```

Keep changes focused, add tests for behavior changes, and update English and Chinese documentation together.  
请保持改动聚焦；行为变更须添加测试，并同时更新中文与英文文档。

## Pull requests / 拉取请求

- Use a clear, imperative title. / 使用清晰的祈使式标题。
- Explain user-visible behavior and validation performed. / 说明用户可见行为和已完成的验证。
- Never include credentials, private project data, or generated dependency directories. / 不得提交凭据、私有项目数据或生成的依赖目录。
- Keep commits reviewable. / 保持提交便于审阅。
