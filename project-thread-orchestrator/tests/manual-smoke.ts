import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CodexAppServerClient } from "../mcp-server/src/app-server-client.js";
import { runArchiveProjectThreadsTool } from "../mcp-server/src/local-tool-client.js";
import { canonicalizeProjectCwd } from "../mcp-server/src/plan-validator.js";
import { RegistryStore, registryPathFor } from "../mcp-server/src/registry.js";
import { ThreadService } from "../mcp-server/src/thread-service.js";
import type {
  AppThread,
  AppThreadListPage,
  AppTurn,
  CodexAppServerPort,
  LoadedThreadListPage,
  ManualSmokeCliOptions,
  SmokeThreadPlan,
  ThreadStartParams,
  TurnStartParams,
} from "../mcp-server/src/types.js";
import { ManualSmokeCliSchema } from "../mcp-server/src/types.js";

const CREATE_CONFIRMATION =
  "CREATE EXACTLY TWO INITIALIZATION-ONLY THREADS";
const IDEMPOTENCY_CONFIRMATION =
  "VERIFY IDEMPOTENT REUSE OF EXACTLY TWO THREADS";
const ARCHIVE_CONFIRMATION = "ARCHIVE EXACTLY TWO SMOKE THREADS";
const SMOKE_PROJECT_MARKER =
  "project-thread-orchestrator-real-app-server-smoke-v1";
const execFileAsync = promisify(execFile);

type SmokeMilestoneId = "M0" | "M1";

interface ExpectedSmokeThreadIds {
  M0: string;
  M1: string;
}

interface ThreadInvariantSnapshot {
  milestone_id: SmokeMilestoneId;
  thread_id: string;
  name: string | null;
  cwd: string | null;
  created_at: number | null;
  updated_at: number | null;
  turns: Array<{
    turn_id: string;
    status: string;
    error_message: string | null;
    items: Array<{
      item_id: string | null;
      type: string;
      text: string | null;
      content: unknown;
    }>;
  }>;
}

class LazySmokeAppServer implements CodexAppServerPort {
  private client: CodexAppServerClient | null = null;

  public constructor(private readonly command?: string) {}

  public async startThread(params: ThreadStartParams): Promise<AppThread> {
    return this.get().startThread(params);
  }

  public async waitForThreadStarted(
    threadId: string,
    timeoutMs?: number,
  ): Promise<AppThread> {
    return this.get().waitForThreadStarted(threadId, timeoutMs);
  }

  public async resumeThread(threadId: string): Promise<AppThread> {
    return this.get().resumeThread(threadId);
  }

  public async listLoadedThreadIds(
    params: {
      cursor?: string | null;
      limit?: number;
    } = {},
  ): Promise<LoadedThreadListPage> {
    return this.get().listLoadedThreadIds(params);
  }

  public async setThreadName(
    threadId: string,
    name: string,
  ): Promise<void> {
    await this.get().setThreadName(threadId, name);
  }

  public async setThreadGoal(
    threadId: string,
    objective: string,
  ): Promise<void> {
    await this.get().setThreadGoal(threadId, objective);
  }

  public async startTurn(params: TurnStartParams): Promise<AppTurn> {
    return this.get().startTurn(params);
  }

  public async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs?: number,
  ): Promise<AppTurn> {
    return this.get().waitForTurnCompletion(threadId, turnId, timeoutMs);
  }

  public async interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    await this.get().interruptTurn(threadId, turnId);
  }

  public async readThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<AppThread> {
    return this.get().readThread(threadId, includeTurns);
  }

  public async listThreads(params: {
    cwd: string;
    archived: boolean;
    cursor?: string | null;
    limit?: number;
  }): Promise<AppThreadListPage> {
    return this.get().listThreads(params);
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.get().archiveThread(threadId);
  }

  public async deleteThread(threadId: string): Promise<void> {
    await this.get().deleteThread(threadId);
  }

  public async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.close();
      this.client = null;
    }
  }

  private get(): CodexAppServerClient {
    this.client ??= new CodexAppServerClient({
      ...(this.command === undefined ? {} : { command: this.command }),
    });
    return this.client;
  }
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  const canonicalCwd = await canonicalizeProjectCwd(options.project_cwd);
  const codexCommand =
    options.codex_command ?? process.env.PTO_CODEX_COMMAND;
  const plan = buildSmokePlan(canonicalCwd);
  const lazyAppServer = new LazySmokeAppServer(codexCommand);
  const service = new ThreadService(lazyAppServer);

  try {
    if (options.action === "preview") {
      print(await service.previewSmokeProjectThreads(plan));
      return;
    }

    if (options.action === "create") {
      requireRealAppServerGate();
      await assertSmokeProject(canonicalCwd);
      const command = requireCodexCommand(codexCommand);
      const codexVersion = await readCodexVersion(command);
      const compatibilityRetry =
        options.retry_after_no_side_effect === "yes"
          ? await assertVerifiedNoSideEffectRetryState(canonicalCwd)
          : (await assertNoExistingSmokeState(canonicalCwd), null);
      const preflight = await inspectProjectThreads(
        command,
        canonicalCwd,
      );
      if (preflight.active.length > 0 || preflight.archived.length > 0) {
        await writeSmokeRegistry(canonicalCwd, {
          action: "create-preflight-blocked",
          codex_version: codexVersion,
          app_server_initialize: preflight.initialize,
          preflight,
          compatibility_retry_of: compatibilityRetry,
          archive_allowed: false,
          desktop_visibility_checked: false,
        });
        throw new Error(
          "The dedicated smoke project already has Codex threads. Creation is fail-closed until they are reconciled manually.",
        );
      }
      const preview = await service.previewSmokeProjectThreads(plan);
      print({ phase: "create-preview", result: preview });
      requirePhrase(options.confirm_phrase, CREATE_CONFIRMATION);
      let creation: Record<string, unknown>;
      try {
        creation = await service.createSmokeProjectThreads(plan, {
          dry_run: false,
          confirmed: true,
        });
      } catch (error) {
        await writeSmokeRegistry(canonicalCwd, {
          action: "create-failed",
          codex_version: codexVersion,
          app_server_initialize: preflight.initialize,
          preflight,
          compatibility_retry_of: compatibilityRetry,
          creation_error: formatError(error),
          archive_allowed: false,
          desktop_visibility_checked: false,
        });
        throw error;
      }
      print({ phase: "create", result: creation });

      // Persistence is checked through a fresh app-server process, not the
      // connection that created the threads.
      await service.close();
      let verification: Record<string, unknown>;
      try {
        verification = await verifyPersistence(
          canonicalCwd,
          false,
          options,
          command,
        );
      } catch (error) {
        await writeSmokeRegistry(canonicalCwd, {
          action: "verification-failed",
          codex_version: codexVersion,
          app_server_initialize: preflight.initialize,
          preflight,
          compatibility_retry_of: compatibilityRetry,
          creation,
          verification_error: formatError(error),
          archive_allowed: false,
          desktop_visibility_checked: false,
        });
        throw error;
      }
      print({ phase: "fresh-process-verification", result: verification });
      await writeSmokeRegistry(canonicalCwd, {
        action: "create",
        codex_version: codexVersion,
        app_server_initialize: verification.app_server_initialize,
        preflight,
        compatibility_retry_of: compatibilityRetry,
        creation,
        verification,
        archive_allowed: false,
        desktop_visibility_checked: false,
      });
      return;
    }

    if (options.action === "verify") {
      requireRealAppServerGate();
      await assertSmokeProject(canonicalCwd);
      const command = requireCodexCommand(codexCommand);
      const codexVersion = await readCodexVersion(command);
      const verification = await verifyPersistence(
        canonicalCwd,
        false,
        options,
        command,
      );
      const creationResult =
        await summarizeRegisteredCreation(canonicalCwd);
      print(verification);
      await writeSmokeRegistry(canonicalCwd, {
        action: "verify",
        codex_version: codexVersion,
        app_server_initialize: verification.app_server_initialize,
        creation_result: creationResult,
        verification,
        archive_allowed: false,
        desktop_visibility_checked:
          options.desktop_visible !== "unknown" ||
          options.same_project !== "unknown",
      });
      return;
    }

    if (options.action === "idempotency") {
      requireRealAppServerGate();
      requirePhrase(options.confirm_phrase, IDEMPOTENCY_CONFIRMATION);
      await assertSmokeProject(canonicalCwd);
      const command = requireCodexCommand(codexCommand);
      const codexVersion = await readCodexVersion(command);
      const expectedIds = {
        M0: requireExpectedThreadId(
          options.expected_m0_thread_id,
          "M0",
        ),
        M1: requireExpectedThreadId(
          options.expected_m1_thread_id,
          "M1",
        ),
      };

      const preflight = await inspectProjectThreads(
        command,
        canonicalCwd,
      );
      assertExactExistingThreadSet(
        preflight,
        expectedIds,
        canonicalCwd,
      );
      const before = await captureThreadInvariants(
        command,
        canonicalCwd,
        expectedIds,
      );

      const preview = await service.previewSmokeProjectThreads(plan);
      assertReusePreview(preview, expectedIds);
      const createResult = await service.createSmokeProjectThreads(
        plan,
        {
          dry_run: false,
          confirmed: true,
        },
      );
      assertReuseResult(createResult, expectedIds);

      const syncResult = await service.syncThreadRegistry({
        project_cwd: canonicalCwd,
        dry_run: false,
        recover_corrupt_registry: false,
        confirmed_recovery: false,
      });
      await service.close();

      const postflight = await inspectProjectThreads(
        command,
        canonicalCwd,
      );
      assertExactExistingThreadSet(
        postflight,
        expectedIds,
        canonicalCwd,
      );
      const after = await captureThreadInvariants(
        command,
        canonicalCwd,
        expectedIds,
      );
      const unchanged = compareThreadInvariants(before, after);
      const verification = await verifyPersistence(
        canonicalCwd,
        false,
        {
          desktop_visible: "yes",
          same_project: "yes",
        },
        command,
      );
      const creationResult =
        await summarizeRegisteredCreation(canonicalCwd);
      const idempotencyOk =
        unchanged.ok &&
        verification.protocol_ok === true &&
        getObjectArray(createResult, "created").length === 0 &&
        getObjectArray(createResult, "reused").length === 2;

      await writeSmokeRegistry(canonicalCwd, {
        action: "idempotency",
        codex_version: codexVersion,
        app_server_initialize: postflight.initialize,
        creation_result: creationResult,
        idempotency_result: {
          ok: idempotencyOk,
          classification: idempotencyOk
            ? "EXISTING_NOT_RECREATED"
            : "FAILED",
          expected_thread_ids: expectedIds,
          preview,
          create_result: createResult,
          preflight,
          postflight,
          invariants: unchanged,
        },
        registry_sync: syncResult,
        verification,
        archive_allowed: false,
        desktop_visibility_checked: true,
        desktop_visible: true,
        same_project: true,
        project_grouping_correct: true,
      });

      if (!idempotencyOk) {
        throw new Error(
          "Idempotency verification failed; inspect smoke-test-registry.json. No archive was attempted.",
        );
      }
      print({
        ok: true,
        classification: "EXISTING_NOT_RECREATED",
        active_thread_count: postflight.active.length,
        created: [],
        reused: getObjectArray(createResult, "reused"),
        thread_ids: expectedIds,
        registry_sync: syncResult,
        invariants: unchanged,
      });
      return;
    }

    if (options.action === "archive-preview") {
      const archivePreview = await service.archiveProjectThreads({
        project_cwd: canonicalCwd,
        milestone_ids: ["M0", "M1"],
        dry_run: true,
        confirmed: false,
      });
      print({ phase: "archive-preview", result: archivePreview });
      return;
    }

    requireRealAppServerGate();
    await assertSmokeProject(canonicalCwd);
    const command = requireCodexCommand(codexCommand);
    const codexVersion = await readCodexVersion(command);
    requirePhrase(options.confirm_phrase, ARCHIVE_CONFIRMATION);
    const expectedIds = {
      M0: requireExpectedThreadId(
        options.expected_m0_thread_id,
        "M0",
      ),
      M1: requireExpectedThreadId(
        options.expected_m1_thread_id,
        "M1",
      ),
    };
    const priorSmokeRecord =
      await readExistingSmokeRegistry(canonicalCwd);
    assertPriorIdempotencyRecord(priorSmokeRecord, expectedIds);
    const preflight = await inspectProjectThreads(
      command,
      canonicalCwd,
    );
    assertExactExistingThreadSet(
      preflight,
      expectedIds,
      canonicalCwd,
    );
    const before = await captureThreadInvariants(
      command,
      canonicalCwd,
      expectedIds,
    );
    const serverEntry = path.resolve(process.cwd(), "dist/server.js");
    await access(serverEntry);
    const toolFlow = await runArchiveProjectThreadsTool(
      {
        server_entry: serverEntry,
        codex_command: command,
        project_cwd: canonicalCwd,
        milestone_ids: ["M0", "M1"],
      },
      (preview) =>
        assertArchivePreview(
          preview,
          expectedIds,
          canonicalCwd,
        ),
    );
    assertArchiveResult(toolFlow.archive, expectedIds);
    print({ phase: "archive-tool", result: toolFlow });

    const postflight = await inspectProjectThreads(
      command,
      canonicalCwd,
    );
    assertExactArchivedThreadSet(
      postflight,
      expectedIds,
      canonicalCwd,
    );
    const after = await captureThreadInvariants(
      command,
      canonicalCwd,
      expectedIds,
    );
    const historyPreservation = compareArchivedThreadHistory(
      before,
      after,
    );
    const syncResult = await service.syncThreadRegistry({
      project_cwd: canonicalCwd,
      dry_run: false,
      recover_corrupt_registry: false,
      confirmed_recovery: false,
    });
    await service.close();
    const verification = await verifyPersistence(
      canonicalCwd,
      true,
      options,
      command,
    );
    const archivedRecords =
      await summarizeArchivedRegistryRecords(
        canonicalCwd,
        expectedIds,
      );
    const archiveOk =
      toolFlow.archive.ok === true &&
      historyPreservation.ok &&
      syncResult.ok === true &&
      verification.protocol_ok === true &&
      archivedRecords.every((record) => record.archived === true);
    print({ phase: "archive-verification", result: verification });
    await writeSmokeRegistry(canonicalCwd, {
      action: "archive",
      codex_version: codexVersion,
      app_server_initialize: postflight.initialize,
      prior_test_record: priorSmokeRecord,
      archive_tool: "archive_project_threads",
      archive_preview: toolFlow.preview,
      archive: toolFlow.archive,
      preflight,
      postflight,
      history_preservation: historyPreservation,
      registry_sync: syncResult,
      archived_threads: archivedRecords,
      verification,
      archive_allowed: false,
      desktop_visibility_checked: false,
      desktop_visibility_before_archive: true,
      project_grouping_before_archive: true,
      desktop_archive_view_check: "MANUAL_CHECK_REQUIRED",
      unarchive_capability: {
        app_server_protocol_supports_thread_unarchive: true,
        plugin_exposes_unarchive_project_threads: false,
        unarchive_performed: false,
      },
    });
    if (!archiveOk) {
      throw new Error(
        "Archive verification failed; evidence was saved. No delete or unarchive was attempted.",
      );
    }
    print({
      ok: true,
      archived: getObjectArray(toolFlow.archive, "archived"),
      active_thread_count: postflight.active.length,
      archived_thread_count: postflight.archived.length,
      registry_sync: syncResult,
      history_preservation: historyPreservation,
    });
  } finally {
    await service.close();
  }
}

function parseCli(argv: string[]): ManualSmokeCliOptions {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const values: Record<string, string> = {};
  for (let index = 0; index < normalizedArgv.length; index += 2) {
    const flag = normalizedArgv[index];
    const value = normalizedArgv[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new Error(
        "Arguments must be --key value pairs. Required: --project-cwd <absolute-path>.",
      );
    }
    values[flag.slice(2).replaceAll("-", "_")] = value;
  }
  return ManualSmokeCliSchema.parse(values);
}

function buildSmokePlan(projectCwd: string): SmokeThreadPlan {
  return {
    project_cwd: projectCwd,
    project_name: "Project Thread Orchestrator Smoke Test",
    initialize_only: true,
    smoke_guard: "REAL_APP_SERVER_TWO_THREAD_SMOKE",
    threads: [
      {
        milestone_id: "M0",
        name: "测试信息确认",
        goal:
          "Confirm the smoke thread name and canonical working directory without changing project state.",
        initial_prompt:
          "这是线程创建器的安全冒烟测试。请只确认当前线程名称和工作目录，然后回复 READY。不要创建、修改或删除任何文件，不要运行命令，不要访问网络。",
        dependencies: [],
        allowed_paths: ["."],
        forbidden_paths: [
          ".git",
          ".agents",
          ".codex",
          ".project-capsule",
        ],
        acceptance_criteria: [
          "The thread reports its scope, capsule availability, and blockers.",
          "No project file is changed.",
        ],
        validation_commands: ["codex --version"],
        initial_status: "READY",
        sandbox_mode: "read-only",
      },
      {
        milestone_id: "M1",
        name: "测试构建基线",
        goal:
          "Confirm the baseline smoke thread name and canonical working directory without changing project state.",
        initial_prompt:
          "这是线程创建器的安全冒烟测试。请只确认当前线程名称和工作目录，然后回复 WAITING。不要创建、修改或删除任何文件，不要运行命令，不要访问网络。",
        dependencies: ["M0"],
        allowed_paths: ["."],
        forbidden_paths: [
          ".git",
          ".agents",
          ".codex",
          ".project-capsule",
        ],
        acceptance_criteria: [
          "The thread reports dependency state and the planned baseline scope.",
          "No command is executed and no project file is changed.",
        ],
        validation_commands: ["codex --version"],
        initial_status: "WAITING",
        sandbox_mode: "read-only",
      },
    ],
  };
}

function requireRealAppServerGate(): void {
  if (process.env.PTO_ENABLE_REAL_APP_SERVER !== "1") {
    throw new Error(
      "Real App Server smoke actions are disabled. Set PTO_ENABLE_REAL_APP_SERVER=1 only after reviewing the preview and README.",
    );
  }
}

function requirePhrase(
  actual: string | undefined,
  expected: string,
): void {
  if (actual !== expected) {
    throw new Error(`Exact confirmation phrase required: ${expected}`);
  }
}

function requireExpectedThreadId(
  value: string | undefined,
  milestoneId: SmokeMilestoneId,
): string {
  if (
    value === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new Error(
      `${milestoneId} requires the exact expected thread UUID before a real-state mutation check`,
    );
  }
  return value;
}

function assertExactExistingThreadSet(
  inspection: {
    active: AppThread[];
    archived: AppThread[];
  },
  expectedIds: ExpectedSmokeThreadIds,
  projectCwd: string,
): void {
  const expected = [
    {
      milestone_id: "M0" as const,
      thread_id: expectedIds.M0,
      name: "M0 测试信息确认",
    },
    {
      milestone_id: "M1" as const,
      thread_id: expectedIds.M1,
      name: "M1 测试构建基线",
    },
  ];
  const actualIds = inspection.active.map((thread) => thread.id).sort();
  const expectedIdList = expected.map((item) => item.thread_id).sort();
  if (
    inspection.archived.length !== 0 ||
    inspection.active.length !== 2 ||
    JSON.stringify(actualIds) !== JSON.stringify(expectedIdList)
  ) {
    throw new Error(
      `Expected exactly the two approved active thread IDs and no archived threads; observed active=${JSON.stringify(actualIds)}, archived=${JSON.stringify(
        inspection.archived.map((thread) => thread.id).sort(),
      )}`,
    );
  }
  for (const item of expected) {
    const observed = inspection.active.find(
      (thread) => thread.id === item.thread_id,
    );
    if (
      observed === undefined ||
      observed.name !== item.name ||
      observed.cwd !== projectCwd
    ) {
      throw new Error(
        `${item.milestone_id} precondition mismatch: expected id=${item.thread_id}, name=${item.name}, cwd=${projectCwd}; observed=${JSON.stringify(
          observed === undefined ? null : summarizeThread(observed),
        )}`,
      );
    }
  }
}

function assertExactArchivedThreadSet(
  inspection: {
    active: AppThread[];
    archived: AppThread[];
  },
  expectedIds: ExpectedSmokeThreadIds,
  projectCwd: string,
): void {
  const expected = [
    {
      milestone_id: "M0" as const,
      thread_id: expectedIds.M0,
      name: "M0 测试信息确认",
    },
    {
      milestone_id: "M1" as const,
      thread_id: expectedIds.M1,
      name: "M1 测试构建基线",
    },
  ];
  const archivedIds = inspection.archived
    .map((thread) => thread.id)
    .sort();
  const expectedIdList = expected.map((item) => item.thread_id).sort();
  if (
    inspection.active.length !== 0 ||
    inspection.archived.length !== 2 ||
    JSON.stringify(archivedIds) !== JSON.stringify(expectedIdList)
  ) {
    throw new Error(
      `Expected zero active threads and exactly the two approved archived IDs; observed active=${JSON.stringify(
        inspection.active.map((thread) => thread.id).sort(),
      )}, archived=${JSON.stringify(archivedIds)}`,
    );
  }
  for (const item of expected) {
    const observed = inspection.archived.find(
      (thread) => thread.id === item.thread_id,
    );
    if (
      observed === undefined ||
      observed.name !== item.name ||
      observed.cwd !== projectCwd
    ) {
      throw new Error(
        `${item.milestone_id} archived-state mismatch: expected id=${item.thread_id}, name=${item.name}, cwd=${projectCwd}; observed=${JSON.stringify(
          observed === undefined ? null : summarizeThread(observed),
        )}`,
      );
    }
  }
}

function assertArchivePreview(
  preview: Record<string, unknown>,
  expectedIds: ExpectedSmokeThreadIds,
  projectCwd: string,
): void {
  if (
    preview.ok !== true ||
    preview.dry_run !== true ||
    preview.project_cwd !== projectCwd ||
    getStringArray(preview, "already_archived").length !== 0
  ) {
    throw new Error(
      `archive_project_threads preview was not an exact active-only preview: ${JSON.stringify(preview)}`,
    );
  }
  assertExactArchiveItems(
    getObjectArray(preview, "targets"),
    expectedIds,
    "archive preview",
    false,
  );
}

function assertArchiveResult(
  result: Record<string, unknown>,
  expectedIds: ExpectedSmokeThreadIds,
): void {
  if (
    result.ok !== true ||
    result.dry_run !== false ||
    getObjectArray(result, "failed").length !== 0
  ) {
    throw new Error(
      `archive_project_threads failed or returned a partial result: ${JSON.stringify(result)}`,
    );
  }
  assertExactArchiveItems(
    getObjectArray(result, "archived"),
    expectedIds,
    "archive result",
    true,
  );
}

function assertExactArchiveItems(
  items: Array<Record<string, unknown>>,
  expectedIds: ExpectedSmokeThreadIds,
  label: string,
  expectArchived: boolean,
): void {
  const expected = new Map<SmokeMilestoneId, string>([
    ["M0", expectedIds.M0],
    ["M1", expectedIds.M1],
  ]);
  if (items.length !== expected.size) {
    throw new Error(
      `${label} must contain exactly two approved targets; observed ${items.length}`,
    );
  }
  for (const [milestoneId, threadId] of expected) {
    const item = items.find(
      (candidate) => candidate.milestone_id === milestoneId,
    );
    if (
      item === undefined ||
      item.thread_id !== threadId ||
      (expectArchived
        ? item.status !== "ARCHIVED"
        : item.archived !== false)
    ) {
      throw new Error(
        `${label} did not match approved ${milestoneId} thread ${threadId}: ${JSON.stringify(
          item ?? null,
        )}`,
      );
    }
  }
}

function assertReusePreview(
  preview: Record<string, unknown>,
  expectedIds: ExpectedSmokeThreadIds,
): void {
  if (preview.ok !== true) {
    throw new Error(
      `Idempotency preview was not safe: ${JSON.stringify(preview)}`,
    );
  }
  assertExactReuseItems(
    getObjectArray(preview, "actions"),
    expectedIds,
    "preview",
    "action",
  );
}

function assertReuseResult(
  result: Record<string, unknown>,
  expectedIds: ExpectedSmokeThreadIds,
): void {
  if (
    result.ok !== true ||
    getObjectArray(result, "created").length !== 0 ||
    getObjectArray(result, "failed").length !== 0
  ) {
    throw new Error(
      `Idempotency create flow attempted work or failed: ${JSON.stringify(result)}`,
    );
  }
  assertExactReuseItems(
    getObjectArray(result, "reused"),
    expectedIds,
    "create result",
  );
}

function assertExactReuseItems(
  items: Array<Record<string, unknown>>,
  expectedIds: ExpectedSmokeThreadIds,
  label: string,
  actionField?: string,
): void {
  const expected = new Map<SmokeMilestoneId, string>([
    ["M0", expectedIds.M0],
    ["M1", expectedIds.M1],
  ]);
  if (items.length !== expected.size) {
    throw new Error(
      `${label} must contain exactly two reused milestones; observed ${items.length}`,
    );
  }
  for (const [milestoneId, threadId] of expected) {
    const item = items.find(
      (candidate) => candidate.milestone_id === milestoneId,
    );
    if (
      item === undefined ||
      item.thread_id !== threadId ||
      (actionField !== undefined && item[actionField] !== "reuse")
    ) {
      throw new Error(
        `${label} did not reuse the approved ${milestoneId} thread ${threadId}: ${JSON.stringify(
          item ?? null,
        )}`,
      );
    }
  }
}

async function captureThreadInvariants(
  codexCommand: string,
  projectCwd: string,
  expectedIds: ExpectedSmokeThreadIds,
): Promise<ThreadInvariantSnapshot[]> {
  const client = new CodexAppServerClient({ command: codexCommand });
  try {
    const milestones: Array<{
      milestone_id: SmokeMilestoneId;
      thread_id: string;
    }> = [
      { milestone_id: "M0", thread_id: expectedIds.M0 },
      { milestone_id: "M1", thread_id: expectedIds.M1 },
    ];
    return await Promise.all(
      milestones.map(async ({ milestone_id, thread_id }) => {
        const thread = await client.readThread(thread_id, true);
        if (thread.id !== thread_id || thread.cwd !== projectCwd) {
          throw new Error(
            `${milestone_id} thread/read returned an unexpected identity or cwd`,
          );
        }
        return {
          milestone_id,
          thread_id: thread.id,
          name: thread.name ?? null,
          cwd: thread.cwd ?? null,
          created_at: thread.createdAt ?? null,
          updated_at: thread.updatedAt ?? null,
          turns: (thread.turns ?? []).map((turn) => ({
            turn_id: turn.id,
            status: turn.status,
            error_message: turn.error?.message ?? null,
            items: (turn.items ?? []).map((item) => ({
              item_id: item.id ?? null,
              type: item.type,
              text: item.text ?? null,
              content: item.content ?? null,
            })),
          })),
        };
      }),
    );
  } finally {
    await client.close();
  }
}

function compareThreadInvariants(
  before: ThreadInvariantSnapshot[],
  after: ThreadInvariantSnapshot[],
): Record<string, unknown> & { ok: boolean } {
  const checks = {
    exact_thread_ids:
      JSON.stringify(before.map((item) => item.thread_id)) ===
      JSON.stringify(after.map((item) => item.thread_id)),
    names_unchanged:
      JSON.stringify(before.map((item) => item.name)) ===
      JSON.stringify(after.map((item) => item.name)),
    cwd_unchanged:
      JSON.stringify(before.map((item) => item.cwd)) ===
      JSON.stringify(after.map((item) => item.cwd)),
    timestamps_unchanged:
      JSON.stringify(
        before.map((item) => [item.created_at, item.updated_at]),
      ) ===
      JSON.stringify(
        after.map((item) => [item.created_at, item.updated_at]),
      ),
    history_unchanged:
      JSON.stringify(before.map((item) => item.turns)) ===
      JSON.stringify(after.map((item) => item.turns)),
  };
  return {
    ok: Object.values(checks).every((value) => value),
    checks,
    before,
    after,
  };
}

function compareArchivedThreadHistory(
  before: ThreadInvariantSnapshot[],
  after: ThreadInvariantSnapshot[],
): Record<string, unknown> & { ok: boolean } {
  const checks = {
    exact_thread_ids:
      JSON.stringify(before.map((item) => item.thread_id)) ===
      JSON.stringify(after.map((item) => item.thread_id)),
    names_preserved:
      JSON.stringify(before.map((item) => item.name)) ===
      JSON.stringify(after.map((item) => item.name)),
    cwd_preserved:
      JSON.stringify(before.map((item) => item.cwd)) ===
      JSON.stringify(after.map((item) => item.cwd)),
    creation_times_preserved:
      JSON.stringify(before.map((item) => item.created_at)) ===
      JSON.stringify(after.map((item) => item.created_at)),
    complete_turn_history_preserved:
      JSON.stringify(before.map((item) => item.turns)) ===
      JSON.stringify(after.map((item) => item.turns)),
  };
  return {
    ok: Object.values(checks).every((value) => value),
    checks,
    before,
    after,
  };
}

function getObjectArray(
  value: Record<string, unknown>,
  field: string,
): Array<Record<string, unknown>> {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    candidate.some(
      (item) =>
        item === null || typeof item !== "object" || Array.isArray(item),
    )
  ) {
    throw new Error(`${field} must be an array of objects`);
  }
  return candidate as Array<Record<string, unknown>>;
}

function getStringArray(
  value: Record<string, unknown>,
  field: string,
): string[] {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== "string")
  ) {
    throw new Error(`${field} must be an array of strings`);
  }
  return candidate as string[];
}

function getObject(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const candidate = value[field];
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new Error(`${field} must be an object`);
  }
  return candidate as Record<string, unknown>;
}

async function readExistingSmokeRegistry(
  projectCwd: string,
): Promise<Record<string, unknown>> {
  const registryPath = path.join(
    projectCwd,
    ".project-capsule",
    "smoke-test-registry.json",
  );
  const value = JSON.parse(
    await readFile(registryPath, "utf8"),
  ) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The existing smoke-test registry is not an object");
  }
  return value as Record<string, unknown>;
}

function assertPriorIdempotencyRecord(
  record: Record<string, unknown>,
  expectedIds: ExpectedSmokeThreadIds,
): void {
  const idempotency = getObject(record, "idempotency_result");
  const ids = getObject(idempotency, "expected_thread_ids");
  if (
    record.action !== "idempotency" ||
    idempotency.ok !== true ||
    ids.M0 !== expectedIds.M0 ||
    ids.M1 !== expectedIds.M1
  ) {
    throw new Error(
      "The prior smoke-test registry does not prove the approved idempotent two-thread state",
    );
  }
}

async function summarizeArchivedRegistryRecords(
  projectCwd: string,
  expectedIds: ExpectedSmokeThreadIds,
): Promise<
  Array<{
    milestone_id: SmokeMilestoneId;
    thread_id: string;
    name: string;
    canonical_cwd: string;
    status: string;
    initialization_status: string;
    initialization_turn_status: string | null;
    initialization_turn_id: string | null;
    created_at: string;
    last_synced_at: string | null;
    archived: boolean;
    archived_at: string | null;
    desktop_visible_before_archive: true;
    project_grouping_before_archive: true;
  }>
> {
  const loaded = await new RegistryStore().load(projectCwd);
  const expected: Array<{
    milestone_id: SmokeMilestoneId;
    thread_id: string;
  }> = [
    { milestone_id: "M0", thread_id: expectedIds.M0 },
    { milestone_id: "M1", thread_id: expectedIds.M1 },
  ];
  return expected.map(({ milestone_id, thread_id }) => {
    const record = loaded.registry.milestones[milestone_id];
    if (
      record === undefined ||
      record.thread_id !== thread_id ||
      record.status !== "ARCHIVED" ||
      record.archived !== true ||
      record.archived_at === null
    ) {
      throw new Error(
        `${milestone_id} was not durably recorded as the approved archived thread`,
      );
    }
    return {
      milestone_id,
      thread_id,
      name: record.expected_name,
      canonical_cwd: loaded.registry.project.cwd,
      status: record.status,
      initialization_status: record.initialization.status,
      initialization_turn_status: record.initialization.turn_status,
      initialization_turn_id: record.initialization.turn_id,
      created_at: record.created_at,
      last_synced_at: record.last_synced_at,
      archived: record.archived,
      archived_at: record.archived_at,
      desktop_visible_before_archive: true,
      project_grouping_before_archive: true,
    };
  });
}

async function verifyPersistence(
  projectCwd: string,
  expectArchived: boolean,
  observations: Pick<
    ManualSmokeCliOptions,
    "desktop_visible" | "same_project"
  >,
  codexCommand: string,
): Promise<Record<string, unknown>> {
  const registry = await new RegistryStore().load(projectCwd);
  const expected = ["M0", "M1"].map((milestoneId) => {
    const record = registry.registry.milestones[milestoneId];
    return {
      milestone_id: milestoneId,
      thread_id: record?.thread_id ?? null,
      expected_name:
        record?.expected_name ??
        `${milestoneId} ${
          milestoneId === "M0" ? "测试信息确认" : "测试构建基线"
        }`,
      expected_reply: milestoneId === "M0" ? "READY" : "WAITING",
      registry_status: record?.status ?? "MISSING_RECORD",
      initialization_turn_id: record?.initialization.turn_id ?? null,
      initialization_registry_status:
        record?.initialization.status ?? "MISSING_RECORD",
    };
  });
  const persisted = expected.filter(
    (
      item,
    ): item is typeof item & {
      thread_id: string;
    } => item.thread_id !== null,
  );
  const client = new CodexAppServerClient({ command: codexCommand });
  try {
    const initialize = await client.getInitializeInfo();
    const active = await listAll(client, projectCwd, false);
    const archived = await listAll(client, projectCwd, true);
    const observed = expectArchived ? archived : active;
    const allObserved = [...active, ...archived];
    const reads = await Promise.all(
      persisted.map(async (item) => {
        const thread = await client.readThread(item.thread_id, true);
        const initializationTurn =
          item.initialization_turn_id === null
            ? undefined
            : thread.turns?.find(
                (turn) => turn.id === item.initialization_turn_id,
              );
        const agentText =
          initializationTurn === undefined
            ? ""
            : extractAgentText(initializationTurn);
        const forbiddenItems =
          initializationTurn?.items?.filter((candidate) =>
            [
              "commandExecution",
              "fileChange",
              "mcpToolCall",
              "dynamicToolCall",
              "webSearch",
            ].includes(candidate.type),
          ) ?? [];
        return {
          ...item,
          thread,
          initialization_turn: initializationTurn ?? null,
          agent_text: agentText,
          agent_text_mentions_display_name: agentText.includes(
            item.expected_name,
          ),
          forbidden_items: forbiddenItems.map((item) => ({
            id: item.id ?? null,
            type: item.type,
          })),
        };
      }),
    );
    const matchingNamedThreads = allObserved.filter((thread) =>
      expected.some((item) => item.expected_name === thread.name),
    );
    const expectedIds = new Set(persisted.map((item) => item.thread_id));
    const unexpectedThreads = allObserved.filter(
      (thread) => !expectedIds.has(thread.id),
    );
    const failedThreads = reads.filter(
      (item) =>
        item.initialization_turn?.status !== "completed" ||
        !new RegExp(`\\b${item.expected_reply}\\b`, "u").test(
          item.agent_text,
        ) ||
        item.forbidden_items.length > 0,
    );
    const checks = {
      two_thread_ids_persisted:
        persisted.length === 2 &&
        new Set(persisted.map((item) => item.thread_id)).size === 2,
      names_correct: reads.every(
        (item) => item.thread.name === item.expected_name,
      ) && reads.length === 2,
      same_cwd: reads.every(
        (item) => path.normalize(item.thread.cwd ?? "") === projectCwd,
      ) && reads.length === 2,
      listed_in_expected_archive_state: persisted.every((item) =>
        observed.some((thread) => thread.id === item.thread_id),
      ) && persisted.length === 2,
      duplicate_free:
        matchingNamedThreads.length === 2 &&
        persisted.every(
          (item) =>
            matchingNamedThreads.filter(
              (thread) => thread.name === item.expected_name,
            ).length === 1 &&
            matchingNamedThreads.some(
              (thread) => thread.id === item.thread_id,
            ),
        ),
      initialization_turns_completed:
        reads.length === 2 &&
        reads.every(
          (item) => item.initialization_turn?.status === "completed",
        ),
      expected_replies_observed:
        reads.length === 2 &&
        reads.every((item) =>
          new RegExp(`\\b${item.expected_reply}\\b`, "u").test(
            item.agent_text,
          ),
        ),
      agent_reported_display_names:
        reads.length === 2 &&
        reads.every((item) => item.agent_text_mentions_display_name),
      no_forbidden_tool_activity:
        reads.length === 2 &&
        reads.every((item) => item.forbidden_items.length === 0),
      no_unexpected_project_threads: unexpectedThreads.length === 0,
      desktop_visible:
        observations.desktop_visible === "unknown"
          ? "MANUAL_CHECK_REQUIRED"
          : observations.desktop_visible,
      grouped_in_same_desktop_project:
        observations.same_project === "unknown"
          ? "MANUAL_CHECK_REQUIRED"
          : observations.same_project,
    };
    const protocolOk =
      checks.two_thread_ids_persisted &&
      checks.names_correct &&
      checks.same_cwd &&
      checks.listed_in_expected_archive_state &&
      checks.duplicate_free &&
      checks.initialization_turns_completed &&
      checks.expected_replies_observed &&
      checks.no_forbidden_tool_activity &&
      checks.no_unexpected_project_threads;
    const manualChecksPassed =
      observations.desktop_visible === "yes" &&
      observations.same_project === "yes";
    return {
      ok: protocolOk && manualChecksPassed,
      protocol_ok: protocolOk,
      manual_checks_passed: manualChecksPassed,
      manual_checks_pending:
        observations.desktop_visible === "unknown" ||
        observations.same_project === "unknown",
      expect_archived: expectArchived,
      app_server_initialize: initialize,
      checks,
      thread_list: {
        query: {
          cwd: projectCwd,
          sourceKinds: ["cli", "vscode", "appServer"],
          archived: expectArchived,
          page_limit: 100,
        },
        active: active.map(summarizeThread),
        archived: archived.map(summarizeThread),
      },
      threads: reads.map((item) => ({
        milestone_id: item.milestone_id,
        thread_id: item.thread_id,
        name: item.thread.name,
        cwd: item.thread.cwd,
        source_kind: item.thread.sourceKind,
        status: item.thread.status?.type,
        created_at: item.thread.createdAt ?? null,
        updated_at: item.thread.updatedAt ?? null,
        initialization_turn_id: item.initialization_turn_id,
        initialization_registry_status:
          item.initialization_registry_status,
        initialization_turn_status:
          item.initialization_turn?.status ?? null,
        expected_reply: item.expected_reply,
        agent_text: item.agent_text,
        agent_text_mentions_display_name:
          item.agent_text_mentions_display_name,
        forbidden_items: item.forbidden_items,
      })),
      orphan_threads: unexpectedThreads.map(summarizeThread),
      failed_threads: failedThreads.map((item) => ({
        milestone_id: item.milestone_id,
        thread_id: item.thread_id,
        initialization_turn_id: item.initialization_turn_id,
        initialization_turn_status:
          item.initialization_turn?.status ?? null,
        forbidden_items: item.forbidden_items,
      })),
      desktop_note:
        "Desktop visibility and project grouping are manual observations; this script does not automate the UI or infer success.",
    };
  } finally {
    await client.close();
  }
}

async function summarizeRegisteredCreation(
  projectCwd: string,
): Promise<Record<string, unknown>> {
  const loaded = await new RegistryStore().load(projectCwd);
  const milestones = ["M0", "M1"].map((milestoneId) => {
    const record = loaded.registry.milestones[milestoneId];
    return {
      milestone_id: milestoneId,
      thread_id: record?.thread_id ?? null,
      name: record?.expected_name ?? null,
      cwd: record?.live_cwd ?? null,
      creation_status: record?.status ?? "MISSING_RECORD",
      last_successful_step:
        record?.last_successful_step ?? "MISSING_RECORD",
      initialization_turn_id:
        record?.initialization.turn_id ?? null,
      initialization_status:
        record?.initialization.status ?? "MISSING_RECORD",
      initialization_turn_status:
        record?.initialization.turn_status ?? null,
      last_error: record?.last_error ?? null,
      ambiguous_operation: record?.ambiguous_operation ?? null,
    };
  });
  return {
    source:
      "reconstructed from durable thread-registry.json and fresh thread/read verification after the outer command timeout",
    ok: milestones.every(
      (item) =>
        item.thread_id !== null &&
        item.initialization_status === "COMPLETED" &&
        item.initialization_turn_status === "completed" &&
        item.last_error === null &&
        item.ambiguous_operation === null,
    ),
    milestones,
  };
}

async function inspectProjectThreads(
  codexCommand: string,
  projectCwd: string,
): Promise<{
  initialize: Awaited<
    ReturnType<CodexAppServerClient["getInitializeInfo"]>
  >;
  active: AppThread[];
  archived: AppThread[];
}> {
  const client = new CodexAppServerClient({ command: codexCommand });
  try {
    const initialize = await client.getInitializeInfo();
    const active = await listAll(client, projectCwd, false);
    const archived = await listAll(client, projectCwd, true);
    return { initialize, active, archived };
  } finally {
    await client.close();
  }
}

async function listAll(
  client: CodexAppServerClient,
  projectCwd: string,
  archived: boolean,
): Promise<AppThread[]> {
  const threads: AppThread[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.listThreads({
      cwd: projectCwd,
      archived,
      cursor,
      limit: 100,
    });
    threads.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return threads;
}

async function writeSmokeRegistry(
  projectCwd: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const directory = path.join(projectCwd, ".project-capsule");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, "smoke-test-registry.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        plugin: "project-thread-orchestrator",
        test_time: new Date().toISOString(),
        project_cwd: projectCwd,
        registry_path: registryPathFor(projectCwd),
        smoke_registry_path: reportPath,
        archive_allowed: false,
        desktop_visibility_checked: false,
        ...payload,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function assertSmokeProject(projectCwd: string): Promise<void> {
  const entries = await readdir(projectCwd, { withFileTypes: true });
  const allowed = new Set([".git", ".project-capsule", "README.md"]);
  const unknown = entries
    .map((entry) => entry.name)
    .filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `The dedicated smoke project contains unknown entries: ${unknown.join(", ")}`,
    );
  }
  if (!entries.some((entry) => entry.name === ".git" && entry.isDirectory())) {
    throw new Error("The dedicated smoke project is not a Git repository");
  }
  const readme = await readFile(path.join(projectCwd, "README.md"), "utf8");
  if (
    !readme.includes(
      "这是 project-thread-orchestrator 的可删除冒烟测试项目。",
    )
  ) {
    throw new Error("The smoke-project README ownership sentence is missing");
  }
  const markerRaw = await readFile(
    path.join(
      projectCwd,
      ".project-capsule",
      "smoke-project-marker.json",
    ),
    "utf8",
  );
  const marker = JSON.parse(markerRaw) as {
    marker?: unknown;
    project_cwd?: unknown;
  };
  if (
    marker.marker !== SMOKE_PROJECT_MARKER ||
    typeof marker.project_cwd !== "string" ||
    path.normalize(marker.project_cwd) !== projectCwd
  ) {
    throw new Error("The smoke-project ownership marker is invalid");
  }
}

async function assertNoExistingSmokeState(projectCwd: string): Promise<void> {
  const candidates = [
    registryPathFor(projectCwd),
    path.join(
      projectCwd,
      ".project-capsule",
      "smoke-test-registry.json",
    ),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      throw new Error(
        `Existing smoke state blocks a second create: ${candidate}`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as Error & { code?: unknown }).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function assertVerifiedNoSideEffectRetryState(
  projectCwd: string,
): Promise<Record<string, unknown>> {
  const registry = await new RegistryStore().load(projectCwd);
  for (const milestoneId of ["M0", "M1"]) {
    const record = registry.registry.milestones[milestoneId];
    if (
      record === undefined ||
      record.thread_id !== null ||
      record.status !== "CREATE_FAILED" ||
      record.ambiguous_operation !== null
    ) {
      throw new Error(
        `${milestoneId} is not an explicit, no-thread-id CREATE_FAILED record; compatibility retry is forbidden`,
      );
    }
  }
  const smokePath = path.join(
    projectCwd,
    ".project-capsule",
    "smoke-test-registry.json",
  );
  const previous = JSON.parse(
    await readFile(smokePath, "utf8"),
  ) as Record<string, unknown>;
  const creation = previous.creation;
  const verification = previous.verification;
  if (
    creation === null ||
    typeof creation !== "object" ||
    !("ok" in creation) ||
    creation.ok !== false ||
    verification === null ||
    typeof verification !== "object" ||
    !("orphan_threads" in verification) ||
    !Array.isArray(verification.orphan_threads) ||
    verification.orphan_threads.length !== 0
  ) {
    throw new Error(
      "The previous smoke registry does not prove an explicit failure with no observed orphan threads",
    );
  }
  return {
    test_time: previous.test_time ?? null,
    action: previous.action ?? null,
    compatibility_retry_of:
      previous.compatibility_retry_of ?? null,
    creation,
    verification,
  };
}

function requireCodexCommand(command: string | undefined): string {
  if (command === undefined || !path.isAbsolute(command)) {
    throw new Error(
      "Real smoke actions require --codex-command with the absolute path audited during protocol generation.",
    );
  }
  return path.normalize(command);
}

async function readCodexVersion(command: string): Promise<string> {
  await access(command);
  const result = await execFileAsync(command, ["--version"], {
    windowsHide: true,
    timeout: 30_000,
  });
  const version = result.stdout.trim();
  if (version.length === 0) {
    throw new Error("Codex --version returned empty stdout");
  }
  return version;
}

function summarizeThread(thread: AppThread): Record<string, unknown> {
  return {
    thread_id: thread.id,
    name: thread.name ?? null,
    cwd: thread.cwd ?? null,
    source_kind: thread.sourceKind ?? null,
    status: thread.status?.type ?? null,
    created_at: thread.createdAt ?? null,
    updated_at: thread.updatedAt ?? null,
  };
}

function extractAgentText(turn: AppTurn): string {
  return (
    turn.items
      ?.filter((item) => item.type === "agentMessage")
      .map((item) => item.text ?? "")
      .filter((text) => text.length > 0)
      .join("\n") ?? ""
  );
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
});
