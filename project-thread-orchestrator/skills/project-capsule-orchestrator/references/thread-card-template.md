# 里程碑线程卡模板

为每个顶层线程生成一张独立完整的任务卡。任务卡字段必须与 `thread-plan.schema.json` 一致，并能在没有主聊天上下文时正确初始化线程。

## 目录

- [结构化字段模板](#结构化字段模板)
- [配套顶层计划字段](#配套顶层计划字段)
- [`initial_prompt` 模板](#initial_prompt-模板)
- [生成检查](#生成检查)
- [实施与结束边界](#实施与结束边界)

## 结构化字段模板

```yaml
milestone_id: M0
name: M0 简洁任务名称
goal: 一个可独立验收的主要目标
rationale: 为什么现在需要这个里程碑
dependencies: []
initial_status: DRAFT
critical_path: true
parallel_group: null
execution_mode: readonly
project_cwd: "<绝对项目路径，不得为磁盘根目录>"
required_files:
  - AGENTS.md
  - SPEC.md
  - PLAN.md
  - STATUS.md
  - DECISIONS.md
  - RISKS.md
  - THREADS.md
  - ".project-capsule/thread-plan.json"
allowed_paths: []
forbidden_paths:
  - "<明确禁止路径或资源>"
outputs:
  - "<可定位输出物>"
acceptance_criteria:
  - "<可观察且可验证的完成条件>"
validation_commands:
  - "<安全、本地、可复现的验证命令>"
risks:
  - description: "<原因、风险事件和后果>"
    severity: HIGH
    likelihood: MEDIUM
    mitigation: "<预防、降级或恢复措施>"
stop_conditions:
  - "<必须停止并请求用户的条件>"
capsule_updates:
  - STATUS.md
  - "<需要更新的其他胶囊文件>"
initial_prompt: |
  <使用下方提示词模板生成完整文本>
```

使用 JSON 时遵循 schema 的实际类型和空值约束；不要直接把 YAML 示例当成最终 JSON。`name` 必须以对应 `milestone_id` 加空格开头。`readonly` 的 `allowed_paths` 必须为空数组，其他执行模式的 `allowed_paths` 必须至少包含一项。状态只允许 `DRAFT`、`READY`、`WAITING`、`BLOCKED`、`ACTIVE`、`REVIEW`、`DONE`、`ARCHIVED`。执行模式只允许 `readonly`、`local`、`worktree`、`hardware-gated`、`production-gated`。风险对象只包含 `description`、`severity`、`likelihood`、`mitigation`；严重程度和可能性只允许 `HIGH`、`MEDIUM`、`LOW`。

## 配套顶层计划字段

线程卡属于 `thread-plan.json` 的 `milestones`。生成线程卡时同时保证：

```yaml
selected_strategy: ROBUST
safety_gates:
  - gate_id: G-HARDWARE-01
    description: 真实硬件操作必须经过人工安全核对
    applies_to:
      - M2
    approval_required: true
    release_condition: 用户确认隔离、急停和回滚条件已经满足
    status: OPEN
```

`selected_strategy` 只允许 `ROBUST`、`LEVERAGE`、`BREAKTHROUGH`。每个安全门对象只包含 `gate_id`、`description`、`applies_to`、`approval_required`、`release_condition`、`status`；`status` 只允许 `OPEN`、`SATISFIED`、`WAIVED`，`applies_to` 只引用真实 milestone ID。

## `initial_prompt` 模板

```text
你正在初始化项目“{project_name}”下的顶层里程碑线程。

项目路径：{project_cwd}
里程碑 ID：{milestone_id}
线程名称：{name}

单一目标
{goal}

为什么现在做
{rationale}

前置依赖
{dependencies；无依赖时明确写“无”}

必须读取
{逐项列出 required_files，并包含项目胶囊和自身任务卡/线程计划}

允许范围
{逐项列出 allowed_paths}

禁止范围
{逐项列出 forbidden_paths}

输出物
{逐项列出 outputs}

验收标准
{逐项列出 acceptance_criteria}

验证方式
{逐项列出 validation_commands；危险验证写明需人工阶段门}

风险
{逐项列出 risks 的 description、severity、likelihood 和 mitigation}

停止条件
{逐项列出 stop_conditions}

完成后更新
{逐项列出 capsule_updates}

本次仅初始化，不实施。严格执行以下步骤：
1. 读取项目胶囊和自身任务卡。
2. 核对项目路径、当前状态和前置依赖。
3. 核对允许范围、禁止范围和安全阶段门。
4. 汇报你理解的单一目标、输出物和验收标准。
5. 汇报阻塞项、未知项和路径冲突。
6. 若前置依赖与安全门均已满足，建议状态为 READY；否则建议 WAITING，并明确报告依赖、安全门或其他阻塞原因。初始化时不建议其他状态。
7. 停止并等待用户明确说“执行 {milestone_id}”。

初始化阶段不得：
- 修改业务代码或生成实现产物；
- 安装软件或修改系统设置；
- 删除、移动、覆盖或回滚文件；
- 操作项目目录外文件；
- 操作真实硬件或接触生产环境；
- 读取、复制或外传未授权敏感数据；
- 提交或推送 Git；
- 自动开始当前或后续里程碑。

只有用户明确说“执行 {milestone_id}”后，才可在重新核对依赖、安全门和工作树状态后进入实施阶段。用户对其他里程碑的放行不适用于本线程。
```

## 生成检查

对每张任务卡确认：

- 项目名称、绝对路径、ID 和名称明确；
- 目标只有一个且可独立验收；
- 依赖只引用真实 milestone ID；
- 所有路径已收紧到本线程需要的范围；
- 输出物、验收标准与验证命令一一对应；
- 每项风险使用四个严格字段，并配有实际停止条件；
- 硬件或生产任务使用相应 gated 模式；
- `initial_prompt` 不依赖主聊天的隐含上下文；
- 初始化只读且明确要求停止；
- 放行短语精确包含本线程的 `M编号`。

## 实施与结束边界

初始化完成不等于里程碑完成。进入实施阶段后也必须：

- 仅处理本线程目标；
- 发现范围扩大、依赖未满足或安全门缺失时停止；
- 达到验收标准后更新指定胶囊文件；
- 将状态置于 `REVIEW` 或经验证后置于 `DONE`；
- 停止等待用户，不自动启动下一线程。
