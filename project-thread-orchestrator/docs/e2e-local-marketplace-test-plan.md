# Phase 3: local marketplace end-to-end test plan

Status: **prepared only**. No marketplace was registered, no plugin was installed, no global Codex
configuration was changed, and `C:\Users\Lenovo\Documents\ProjectCapsuleE2ETest` was not created
while preparing this plan.

Read-only preflight on 2026-07-31 found no configured marketplace and no marketplace plugin in
scope. `C:\Users\Lenovo\.agents\plugins\marketplace.json` does not exist, so this plan deliberately
uses the already prepared repository-local marketplace instead of creating or overwriting a
personal marketplace file.

## Installation proposal shown for approval

| Item | Exact value |
| --- | --- |
| Local marketplace root | `C:\Users\Lenovo\Documents\拆分胶囊` |
| Marketplace manifest | `C:\Users\Lenovo\Documents\拆分胶囊\.agents\plugins\marketplace.json` |
| Marketplace name | `project-thread-orchestrator-local` |
| Plugin source | `C:\Users\Lenovo\Documents\拆分胶囊\project-thread-orchestrator` |
| Plugin name | `project-thread-orchestrator` |
| Plugin version | `0.1.0` |
| Bundled Skill | `project-capsule-orchestrator` |
| Bundled MCP Server | `project-thread-orchestrator` |
| MCP command | `node ./mcp-server/dist/server.js` |
| MCP cwd | installed plugin root |

After explicit installation approval, the proposed commands are:

```powershell
codex plugin marketplace add "C:\Users\Lenovo\Documents\拆分胶囊"
codex plugin marketplace list
codex plugin add project-thread-orchestrator@project-thread-orchestrator-local
codex plugin list
```

These commands would add one local marketplace reference, create/update a Codex-managed cached
plugin copy, and enable the plugin in the current user's Codex configuration. They must not remove
or overwrite another marketplace or unrelated plugin. Before running them, inspect
`codex plugin marketplace list` and `codex plugin list` for a name collision and stop on any
unexpected existing entry.

A full Codex Desktop restart is expected after the install so the marketplace, bundled Skill, and
stdio MCP Server are loaded from one fresh state. Start the actual test in a **new main task** after
the restart. Source edits after installation require a cachebuster/reinstall and another new task;
the cached plugin must not be assumed to track the source directory live.

## Test project proposal

Exact project root:

```text
C:\Users\Lenovo\Documents\ProjectCapsuleE2ETest
```

Creation is a later, separately authorized action. Before creating it:

1. Check whether the exact path exists.
2. If it exists, inspect it without overwriting anything.
3. Continue only if it has the test marker and exact known contents from a prior run; otherwise
   stop and report the collision.
4. Do not copy OpenVibe or any other real project.

The project will be a local Git repository with no remote. Its initial files are:

`README.md`

```markdown
# ProjectCapsuleE2ETest

开发一个本地个人任务管理器。

首版用户为单个 Windows 用户。
需要支持创建、完成、搜索任务和本地数据持久化。
暂时不需要账号、云同步、多人协作或移动端。
要求可以本地启动，并具有自动化测试。
```

`RECOVERY.md`

```markdown
# Recovery state

- 项目只有初步设想；
- 尚未选择技术栈；
- 尚未实现业务代码；
- 数据存储方案仍未决定。
```

A small marker file may be added solely to prove that this tool owns the disposable test
directory. No application source, dependency, generated artifact, or remote repository is created
at setup time.

## Exact user flow

1. After approved installation and Desktop restart, open
   `C:\Users\Lenovo\Documents\ProjectCapsuleE2ETest` as a Codex project.
2. Manually create one new main task under that project.
3. Paste the invocation prompt below.
4. Verify that the Skill reads `README.md`, `RECOVERY.md`, and Git state before asking anything.
5. Answer one question at a time. Do not volunteer several answers in one message merely to speed
   up the test.
6. Verify the Skill presents `ROBUST`, `LEVERAGE`, and `BREAKTHROUGH` routes and asks for route
   selection.
7. Select the route based on the displayed evidence. Route selection is not thread-creation
   confirmation.
8. Verify the Skill creates the capsule files and validates
   `.project-capsule/thread-plan.json` with the bundled Node validator.
9. Verify exactly these milestone cards are produced:
   - `M0 产品范围与技术基线`
   - `M1 核心任务数据与服务`
   - `M2 最小界面与端到端验收`
10. Verify the Skill calls `preview_project_threads`, displays the exact preview and confirmation
    binding, and then stops. At this point `thread/list` must show no new milestone task.
11. Review the generated capsule, projection, path boundaries, acceptance criteria, dependency
    DAG, and preview.
12. Only if all are correct, send this later message in the same main task:

```text
确认按刚才最新预览创建 M0、M1、M2 三个初始化线程。计划、cwd、名称和顺序均不得改变；initialize_only: true，dry_run: false。只初始化，不执行任何里程碑。
```

13. Verify `create_project_threads` returns three real opaque thread IDs and no partial failure.
14. Use `list_project_threads` and, if needed, `sync_thread_registry` to verify all three records.
15. In Codex Desktop, verify the three tasks are visible under the single
    `ProjectCapsuleE2ETest` project.
16. Do not tell any milestone task to execute. Stop the E2E test after initialization and
    visibility checks.

If the MCP process restarted, the confirmation grant expired, or any plan/registry field changed
between steps 10 and 12, run a new preview and review it again. Never use an old token or
`confirmed:true` without a matching unexpired preview in the same MCP process.

## Skill invocation prompt to copy

```text
使用 $project-thread-orchestrator:project-capsule-orchestrator 对当前项目执行第三阶段端到端联调。

项目根目录必须精确解析为：
C:\Users\Lenovo\Documents\ProjectCapsuleE2ETest

请先读取 README.md、RECOVERY.md、Git 状态和所有适用的 AGENTS.md，再开始采访。
一次只问一个能最大幅度降低关键不确定性的问题；不要询问文件里已经有答案的事项。

完成采访和审计后：
1. 建立或更新 AGENTS.md、SPEC.md、FUTURES.md、PLAN.md、STATUS.md、DECISIONS.md、RISKS.md 和 THREADS.md；
2. 展示稳健（ROBUST）、杠杆（LEVERAGE）、突破（BREAKTHROUGH）三条路线，并等待我选择；
3. 基于证据生成且仅生成三个里程碑：
   M0 产品范围与技术基线
   M1 核心任务数据与服务
   M2 最小界面与端到端验收
4. 依赖必须为 M1 依赖 M0、M2 依赖 M1；
5. 生成 .project-capsule/thread-plan.json；
6. 使用 bundled schemas/thread-plan.schema.json 和 scripts/validate-thread-plan.mjs 完成验证，并确定性生成 .project-capsule/thread-create-plan.json；
7. 调用 preview_project_threads，完整展示 canonical cwd、计划摘要、三个名称、目标、依赖、路径范围、验收标准、READY/WAITING、sandbox、差异、风险和确认绑定；
8. 展示预览后立即停止。

在我后续明确发送“确认按刚才最新预览创建 M0、M1、M2 三个初始化线程”之前：
- 不得调用真实 create_project_threads；
- 不得创建任何顶层线程；
- 不得执行任何里程碑；
- 不得安装依赖；
- 不得修改系统或 Codex 全局配置；
- 不得提交或推送 Git；
- 不得访问项目外文件。

后续若得到与最新未变化预览匹配的明确确认，只能以 initialize_only: true 创建这三个线程。
三个线程必须使用完全相同的 canonical cwd，首次回合只读取胶囊和自己的任务卡、核对依赖、汇报目标/范围/验收/阻塞项，然后分别标记：
- M0：READY
- M1：WAITING（依赖 M0）
- M2：WAITING（依赖 M1）

初始化后立即停止，不得开始业务实现。
```

If the standalone unqualified Skill is also installed, do not shorten the invocation to
`$project-capsule-orchestrator`; the namespaced form above proves that the bundled adapter and MCP
dependency are being tested.

## Acceptance checklist

### Package and discovery

- [ ] Plugin manifest is recognized as `project-thread-orchestrator` version `0.1.0`.
- [ ] The bundled namespaced Skill is visible.
- [ ] The MCP Server is visible and advertises all six expected tools.
- [ ] No unrelated marketplace or plugin changed.

### Interview and capsule

- [ ] Project root is the exact canonical test path.
- [ ] README, RECOVERY, Git, and applicable instructions were read first.
- [ ] Only one high-value unanswered question was asked at a time.
- [ ] Existing answers were not asked again.
- [ ] ROBUST, LEVERAGE, and BREAKTHROUGH routes were materially distinct.
- [ ] Capsule files preserve evidence labels, unknowns, decisions, risks, and route selection.
- [ ] `thread-plan.json` passes the bundled JSON Schema and semantic validator.
- [ ] `thread-create-plan.json` is a deterministic strict projection, not a replacement for the
      rich plan.

### Preview boundary

- [ ] Exactly M0, M1, and M2 were proposed with the required names.
- [ ] The DAG is `M0 -> M1 -> M2`.
- [ ] Preview is read-only and returns a plan digest/confirmation binding.
- [ ] Before explicit later confirmation, no real milestone task exists.
- [ ] Any plan or registry change causes a fresh preview.

### Creation and initialization

- [ ] Exactly three real task IDs are returned.
- [ ] All three tasks use one identical canonical cwd.
- [ ] Names are exactly `M0 产品范围与技术基线`, `M1 核心任务数据与服务`, and
      `M2 最小界面与端到端验收`.
- [ ] Each task reads the capsule and only its own task card.
- [ ] M0 reports READY; M1 and M2 report WAITING with the correct predecessor.
- [ ] Initialization is read-only, network-disabled, approval-never, and terminal.
- [ ] No business code, dependency, system setting, project-external file, hardware, Git commit, or
      Git push is changed.
- [ ] No milestone begins automatically.

### Persistence and Desktop

- [ ] `list_project_threads` and the registry contain the same three opaque IDs.
- [ ] Desktop shows all three tasks under the one `ProjectCapsuleE2ETest` project.
- [ ] No duplicate, unknown, failed, ambiguous, or orphan task exists.
- [ ] A later identical create is not attempted until a separate idempotency-test confirmation.
- [ ] No test task is archived until a separate archive confirmation.

## Known limitations for this test

- App Server exposes no public `projectId` on thread creation; grouping is expressed by identical
  canonical cwd and still needs Desktop observation.
- `thread/start` exposes no client idempotency key, so the registry/reservation/reconciliation
  design minimizes duplicates but cannot claim strict exactly-once behavior.
- Confirmation grants are process-local and expire. Desktop or MCP reload requires a fresh
  preview.
- Plugin installation is cached. A source edit is not proof that the installed cache changed.
- Skill behavior remains model-mediated. Static files and validators enforce contracts, but the
  interview quality and route analysis still require human review.
- Archive is intentionally outside this E2E run and must use its own preview and confirmation.
