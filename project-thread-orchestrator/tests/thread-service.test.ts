import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore, registryPathFor } from "../mcp-server/src/registry.js";
import {
  AppServerRpcError,
  AppServerTimeoutError,
} from "../mcp-server/src/app-server-client.js";
import {
  ThreadService,
  assertReplacementThreadIdIsNew,
  classifyOrphanMetadataEvidence,
} from "../mcp-server/src/thread-service.js";
import { CleanupOrphanThreadsInputSchema } from "../mcp-server/src/types.js";
import type {
  AppThread,
  AppThreadListPage,
  AppTurn,
  CodexAppServerPort,
  LoadedThreadListPage,
  ThreadStartParams,
  TurnStartParams,
} from "../mcp-server/src/types.js";
import { makePlan, makeTask, makeTasks } from "./test-helpers.js";

export class MockAppServer implements CodexAppServerPort {
  public readonly events: Array<{
    method: string;
    params: unknown;
    connection_id?: number;
  }> = [];
  public readonly threads = new Map<string, AppThread>();
  public readonly loaded = new Set<string>();
  public readonly archived = new Set<string>();
  public readonly failStartCalls = new Set<number>();
  public readonly missingThreadStartedCalls = new Set<number>();
  public readonly noRolloutThreadIds = new Set<string>();
  public readonly failTurnCompletionCalls = new Set<number>();
  public readonly startErrors = new Map<number, Error>();
  public readonly ambiguousStartCalls = new Set<number>();
  public readonly ambiguousTurnStartCalls = new Set<number>();
  public readonly ambiguousWaitCalls = new Set<number>();
  public readonly failGoalCalls = new Set<number>();
  public readonly ambiguousArchiveCalls = new Set<number>();
  public readonly ambiguousArchiveWithoutEffectCalls = new Set<number>();
  public readonly hideArchivedThreadIds = new Set<string>();
  public readonly hideListThreadIds = new Set<string>();
  public readonly readErrors = new Map<string, Error>();
  public readonly readNotLoadedOnce = new Set<string>();
  public readonly resumeErrors = new Map<string, Error>();
  public readonly hideLoadedThreadIds = new Set<string>();
  public readonly closeAfterResumeThreadIds = new Set<string>();
  public readonly deleteErrors = new Map<string, Error>();
  public readonly deleteNoRolloutThreadIds = new Set<string>();
  public readonly listErrorsByArchived = new Map<boolean, Error>();
  private nextThread = 1;
  private nextTurn = 1;
  private startCalls = 0;
  private turnStartCalls = 0;
  private waitCalls = 0;
  private goalCalls = 0;
  private archiveCalls = 0;
  private connectionId = 1;
  private closed = false;

  public async startThread(params: ThreadStartParams): Promise<AppThread> {
    this.ensureConnection();
    this.startCalls += 1;
    this.events.push({ method: "thread/start", params, connection_id: this.connectionId });
    if (this.ambiguousStartCalls.has(this.startCalls)) {
      const error = new Error("mock transport disconnected") as Error & {
        ambiguous: boolean;
      };
      error.ambiguous = true;
      throw error;
    }
    const startError = this.startErrors.get(this.startCalls);
    if (startError !== undefined) {
      throw startError;
    }
    if (this.failStartCalls.has(this.startCalls)) {
      throw new Error("mock explicit start failure");
    }
    const thread: AppThread = {
      id: `thread-${this.nextThread++}`,
      name: null,
      cwd: params.cwd,
      ephemeral: false,
      status: { type: "idle" },
      sourceKind: "appServer",
      turns: [],
    };
    this.threads.set(thread.id, thread);
    this.loaded.add(thread.id);
    return structuredClone(thread);
  }

  public async waitForThreadStarted(threadId: string): Promise<AppThread> {
    this.ensureConnection();
    this.events.push({
      method: "thread/started:wait",
      params: { threadId },
      connection_id: this.connectionId,
    });
    const call = Number(threadId.replace("thread-", ""));
    if (this.missingThreadStartedCalls.has(call)) {
      throw new AppServerTimeoutError("thread/started", 100);
    }
    return structuredClone(this.requireThread(threadId));
  }

  public async resumeThread(threadId: string): Promise<AppThread> {
    this.ensureConnection();
    this.events.push({
      method: "thread/resume",
      params: { threadId },
      connection_id: this.connectionId,
    });
    const error = this.resumeErrors.get(threadId);
    if (error !== undefined) {
      throw error;
    }
    if (this.noRolloutThreadIds.has(threadId)) {
      throw new AppServerRpcError(
        "thread/resume",
        -32_600,
        `no rollout found for thread id ${threadId}`,
      );
    }
    const thread = this.requireThread(threadId);
    thread.status = { type: "idle" };
    this.loaded.add(threadId);
    const result = structuredClone(thread);
    if (this.closeAfterResumeThreadIds.has(threadId)) {
      await this.close();
    }
    return result;
  }

  public async listLoadedThreadIds(): Promise<LoadedThreadListPage> {
    this.ensureConnection();
    this.events.push({
      method: "thread/loaded/list",
      params: {},
      connection_id: this.connectionId,
    });
    return {
      data: [...this.loaded].filter(
        (threadId) => !this.hideLoadedThreadIds.has(threadId),
      ),
      nextCursor: null,
    };
  }

  public async setThreadName(
    threadId: string,
    name: string,
  ): Promise<void> {
    this.ensureConnection();
    this.events.push({
      method: "thread/name/set",
      params: { threadId, name },
    });
    this.requireThread(threadId).name = name;
  }

  public async setThreadGoal(
    threadId: string,
    objective: string,
  ): Promise<void> {
    this.ensureConnection();
    this.goalCalls += 1;
    this.events.push({
      method: "thread/goal/set",
      params: { threadId, objective, status: "paused" },
    });
    if (this.failGoalCalls.has(this.goalCalls)) {
      throw new Error("mock explicit goal failure");
    }
  }

  public async startTurn(params: TurnStartParams): Promise<AppTurn> {
    this.ensureConnection();
    this.turnStartCalls += 1;
    this.events.push({
      method: "turn/start",
      params,
      connection_id: this.connectionId,
    });
    if (!this.loaded.has(params.threadId)) {
      throw new AppServerRpcError(
        "turn/start",
        -32_600,
        `thread not found: ${params.threadId}`,
      );
    }
    const turn: AppTurn = {
      id: `turn-${this.nextTurn++}`,
      status: "inProgress",
      items: params.input.map((item, index) => ({
        id: `user-${this.nextTurn}-${index}`,
        type: "userMessage",
        text: item.text,
      })),
      error: null,
    };
    this.requireThread(params.threadId).turns?.push(turn);
    if (this.ambiguousTurnStartCalls.has(this.turnStartCalls)) {
      throw new AppServerTimeoutError("turn/start", 100);
    }
    return structuredClone(turn);
  }

  public async waitForTurnCompletion(
    threadId: string,
    turnId: string,
  ): Promise<AppTurn> {
    this.ensureConnection();
    this.waitCalls += 1;
    this.events.push({
      method: "turn/wait",
      params: { threadId, turnId },
    });
    const turn = this.requireThread(threadId).turns?.find(
      (candidate) => candidate.id === turnId,
    );
    if (turn === undefined) {
      throw new Error(`unknown mock turn: ${turnId}`);
    }
    turn.status = "completed";
    turn.items = [
      ...(turn.items ?? []),
      {
        id: `agent-${turnId}`,
        type: "agentMessage",
        text: JSON.stringify({
          status: "READY",
          goal: "confirmed",
          scope: [],
          acceptance_criteria: [],
          dependencies_checked: [],
          blockers: [],
        }),
      },
    ];
    if (this.ambiguousWaitCalls.has(this.waitCalls)) {
      throw new AppServerTimeoutError("turn/wait", 100);
    }
    if (this.failTurnCompletionCalls.has(this.waitCalls)) {
      turn.status = "failed";
      turn.error = {
        message:
          "stream disconnected before completion: mock Responses API transport",
      };
    }
    return structuredClone(turn);
  }

  public async interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    this.ensureConnection();
    this.events.push({
      method: "turn/interrupt",
      params: { threadId, turnId },
    });
  }

  public async readThread(
    threadId: string,
    _includeTurns: boolean,
  ): Promise<AppThread> {
    this.ensureConnection();
    this.events.push({
      method: "thread/read",
      params: { threadId, includeTurns: _includeTurns },
      connection_id: this.connectionId,
    });
    if (this.readNotLoadedOnce.delete(threadId)) {
      throw new AppServerRpcError(
        "thread/read",
        -32_600,
        `thread not loaded: ${threadId}`,
      );
    }
    const error = this.readErrors.get(threadId);
    if (error !== undefined) {
      throw error;
    }
    if (this.noRolloutThreadIds.has(threadId) && !this.loaded.has(threadId)) {
      throw new AppServerRpcError(
        "thread/read",
        -32_600,
        `thread not loaded: ${threadId}`,
      );
    }
    const thread = structuredClone(this.requireThread(threadId));
    if (!this.loaded.has(threadId)) {
      thread.status = { type: "notLoaded" };
    }
    return thread;
  }

  public async listThreads(params: {
    cwd: string;
    archived: boolean;
  }): Promise<AppThreadListPage> {
    this.ensureConnection();
    this.events.push({ method: "thread/list", params });
    const error = this.listErrorsByArchived.get(params.archived);
    if (error !== undefined) {
      throw error;
    }
    return {
      data: [...this.threads.values()]
        .filter((thread) => thread.cwd === params.cwd)
        .filter((thread) => !this.hideListThreadIds.has(thread.id))
        .filter(
          (thread) =>
            this.archived.has(thread.id) === params.archived,
        )
        .filter(
          (thread) =>
            !params.archived ||
            !this.hideArchivedThreadIds.has(thread.id),
        )
        .map((thread) => structuredClone(thread)),
      nextCursor: null,
    };
  }

  public async archiveThread(threadId: string): Promise<void> {
    this.ensureConnection();
    this.archiveCalls += 1;
    this.events.push({
      method: "thread/archive",
      params: { threadId },
    });
    this.requireThread(threadId);
    if (
      this.ambiguousArchiveWithoutEffectCalls.has(this.archiveCalls)
    ) {
      throw new AppServerTimeoutError("thread/archive", 100);
    }
    this.archived.add(threadId);
    if (this.ambiguousArchiveCalls.has(this.archiveCalls)) {
      throw new AppServerTimeoutError("thread/archive", 100);
    }
  }

  public async deleteThread(threadId: string): Promise<void> {
    this.ensureConnection();
    this.events.push({
      method: "thread/delete",
      params: { threadId },
      connection_id: this.connectionId,
    });
    const error = this.deleteErrors.get(threadId);
    if (error !== undefined) {
      throw error;
    }
    if (this.deleteNoRolloutThreadIds.has(threadId)) {
      throw new AppServerRpcError(
        "thread/delete",
        -32_600,
        `no rollout found for thread id ${threadId}`,
      );
    }
    this.requireThread(threadId);
    this.threads.delete(threadId);
    this.loaded.delete(threadId);
    this.archived.delete(threadId);
    this.noRolloutThreadIds.delete(threadId);
  }

  public async close(): Promise<void> {
    if (!this.closed) {
      this.events.push({
        method: "app-server/close",
        params: {},
        connection_id: this.connectionId,
      });
    }
    this.closed = true;
    this.loaded.clear();
  }

  public count(method: string): number {
    return this.events.filter((event) => event.method === method).length;
  }

  private requireThread(threadId: string): AppThread {
    const thread = this.threads.get(threadId);
    if (thread === undefined) {
      throw new Error(`unknown mock thread: ${threadId}`);
    }
    return thread;
  }

  private ensureConnection(): void {
    if (this.closed) {
      this.closed = false;
      this.connectionId += 1;
      this.loaded.clear();
    }
  }
}

class HookedRegistryStore extends RegistryStore {
  public beforeNextLock: (() => Promise<void>) | null = null;

  public override async withProjectLock<T>(
    projectCwd: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const hook = this.beforeNextLock;
    this.beforeNextLock = null;
    if (hook !== null) {
      await hook();
    }
    return super.withProjectLock(projectCwd, action);
  }
}

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects
      .splice(0)
      .map((project) => rm(project, { recursive: true, force: true })),
  );
});

async function createProject(): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), "pto-service-"));
  temporaryProjects.push(project);
  return project;
}

function createInput(
  projectCwd: string,
  threads = makeTasks(3),
): Record<string, unknown> {
  return {
    ...(makePlan(projectCwd, threads) as Record<string, unknown>),
    dry_run: false,
    confirmed: true,
    recreate_archived: false,
  };
}

const cleanupThreadIds = [
  "019fbdf8-74ad-7f03-819c-34d58356c570",
  "019fbdf8-f4bd-7152-b817-c93794004c15",
  "019fbdf9-736d-71f1-8da1-248c7e4faa36",
] as const;
async function seedReviewedOrphans(project: string, app: MockAppServer): Promise<ThreadService> {
  const service = new ThreadService(app, new RegistryStore(), {
    orphanCleanupScope: { projectCwd: project, threadIds: cleanupThreadIds },
  });
  const tasks = makeTasks(3);
  await service.previewProjectThreads(makePlan(project, tasks));
  await service.createProjectThreads(createInput(project, tasks));
  const store = new RegistryStore();
  const loaded = await store.load(project);
  for (const [index, milestoneId] of ["M0", "M1", "M2"].entries()) {
    const oldId = `thread-${index + 1}`;
    const newId = cleanupThreadIds[index]!;
    const thread = app.threads.get(oldId)!;
    app.threads.delete(oldId);
    thread.id = newId;
    app.threads.set(newId, thread);
    app.loaded.delete(oldId);
    app.noRolloutThreadIds.add(newId);
    app.hideListThreadIds.add(newId);
    const record = loaded.registry.milestones[milestoneId]!;
    record.thread_id = newId;
    record.status = "ORPHAN_METADATA_ONLY";
    record.initialization.status = "FAILED";
  }
  await store.save(loaded.registry);
  await app.close();
  return service;
}

function arrayField(
  value: Record<string, unknown>,
  field: string,
): Array<Record<string, unknown>> {
  const candidate = value[field];
  if (!Array.isArray(candidate)) {
    throw new Error(`${field} is not an array`);
  }
  return candidate as Array<Record<string, unknown>>;
}

function confirmationToken(value: Record<string, unknown>): string {
  const confirmation = value.confirmation;
  if (
    confirmation === null ||
    typeof confirmation !== "object" ||
    !("token" in confirmation) ||
    typeof confirmation.token !== "string"
  ) {
    throw new Error("result does not contain a confirmation token");
  }
  return confirmation.token;
}

function recoveryConfirmationToken(
  value: Record<string, unknown>,
): string {
  const confirmation = value.recovery_confirmation;
  if (
    confirmation === null ||
    typeof confirmation !== "object" ||
    !("token" in confirmation) ||
    typeof confirmation.token !== "string"
  ) {
    throw new Error(
      "result does not contain a recovery confirmation token",
    );
  }
  return confirmation.token;
}

async function prepareThreeFailedStoredThreads(
  project: string,
  app: MockAppServer,
  service: ThreadService,
): Promise<void> {
  const plan = makePlan(project, makeTasks(3));
  await service.previewProjectThreads(plan);
  const created = await service.createProjectThreads(createInput(project));
  expect(arrayField(created, "created")).toHaveLength(3);
  expect([...app.threads.keys()]).toEqual([
    "thread-1",
    "thread-2",
    "thread-3",
  ]);
  const store = new RegistryStore();
  const loaded = await store.load(project);
  for (const record of Object.values(loaded.registry.milestones)) {
    record.status = "INITIALIZATION_FAILED";
    record.initialization.status = "FAILED";
    record.initialization.turn_id = null;
    record.initialization.turn_status = "failed";
    record.initialization.completed_at = null;
    record.last_error = "synthetic recovery fixture";
  }
  await store.save(loaded.registry);
  await app.close();
}

async function initializeFailedStoredThreads(
  project: string,
  service: ThreadService,
): Promise<Record<string, unknown>> {
  const preview = await service.initializeProjectThreads({
    project_cwd: project,
    milestone_ids: ["M0", "M1", "M2"],
    dry_run: true,
    retry_failed_initialization: true,
  });
  return service.initializeProjectThreads({
    project_cwd: project,
    milestone_ids: ["M0", "M1", "M2"],
    dry_run: false,
    confirmed: true,
    confirmation_token: confirmationToken(preview),
    retry_failed_initialization: true,
  });
}

describe("ThreadService creation orchestration", () => {
  it("rejects an unconfirmed mutating create before any App Server side effect", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app, new RegistryStore());

    await expect(
      service.createProjectThreads({
        ...(makePlan(project, makeTasks(3)) as Record<string, unknown>),
        dry_run: false,
        recreate_archived: false,
      }),
    ).rejects.toThrow(/confirmed=true|confirmation_token/u);

    expect(app.events).toHaveLength(0);
    expect(app.count("thread/start")).toBe(0);
    expect(app.count("turn/start")).toBe(0);
  });

  it("previews without side effects, then creates in the required safe sequence", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app, new RegistryStore());
    const threads = makeTasks(3);

    const preview = await service.previewProjectThreads(
      makePlan(project, threads),
    );
    expect(preview).toMatchObject({ ok: true, dry_run: true });
    expect(app.events).toHaveLength(0);

    const result = await service.createProjectThreads(
      createInput(project, threads),
    );
    expect(result).toMatchObject({ ok: true, dry_run: false });
    expect(arrayField(result, "created")).toHaveLength(3);
    expect(app.count("thread/start")).toBe(3);

    const startEvents = app.events.filter(
      (event) => event.method === "thread/start",
    );
    for (const event of startEvents) {
      expect(event.params).toMatchObject({
        cwd: path.normalize(project),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
      });
    }

    const goals = app.events.filter(
      (event) => event.method === "thread/goal/set",
    );
    expect(goals).toHaveLength(3);
    expect(goals.every((event) =>
      JSON.stringify(event.params).includes('"status":"paused"'),
    )).toBe(true);

    const turns = app.events.filter(
      (event) => event.method === "turn/start",
    );
    expect(turns).toHaveLength(3);
    const firstTurn = turns[0]?.params as TurnStartParams;
    expect(firstTurn).toMatchObject({
      cwd: path.normalize(project),
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "readOnly",
        networkAccess: false,
      },
      input: [
        expect.objectContaining({
          text_elements: [],
        }),
      ],
    });
    const prompt = firstTurn.input[0]?.text ?? "";
    for (const file of [
      "AGENTS.md",
      "SPEC.md",
      "PLAN.md",
      "STATUS.md",
      "DECISIONS.md",
      "RISKS.md",
      "THREADS.md",
      ".project-capsule/thread-plan.json",
    ]) {
      expect(prompt).toContain(file);
    }
    expect(prompt).toContain("task card for M0");
    for (const prohibition of [
      "Do not modify business code",
      "Do not install software",
      "Do not modify the operating system",
      "outside the project directory",
      "Do not operate real hardware",
      "Do not commit or push Git",
      "stop immediately",
    ]) {
      expect(prompt).toContain(prohibition);
    }

    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as { milestones: Record<string, { thread_id: string; status: string }> };
    expect(Object.keys(persisted.milestones)).toEqual(["M0", "M1", "M2"]);
    expect(persisted.milestones.M0).toMatchObject({
      thread_id: "thread-1",
      status: "READY",
    });
  });

  it("uses the two exact user-approved prompts only on the guarded smoke path", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const m0Prompt =
      "这是线程创建器的安全冒烟测试。请只确认当前线程名称和工作目录，然后回复 READY。不要创建、修改或删除任何文件，不要运行命令，不要访问网络。";
    const m1Prompt =
      "这是线程创建器的安全冒烟测试。请只确认当前线程名称和工作目录，然后回复 WAITING。不要创建、修改或删除任何文件，不要运行命令，不要访问网络。";
    const smokePlan = {
      project_cwd: project,
      project_name: "Project Thread Orchestrator Smoke Test",
      initialize_only: true,
      smoke_guard: "REAL_APP_SERVER_TWO_THREAD_SMOKE",
      threads: [
        makeTask(0, {
          milestone_id: "M0",
          name: "测试信息确认",
          initial_prompt: m0Prompt,
          initial_status: "READY",
          dependencies: [],
        }),
        makeTask(1, {
          milestone_id: "M1",
          name: "测试构建基线",
          initial_prompt: m1Prompt,
          initial_status: "WAITING",
          dependencies: ["M0"],
        }),
      ],
    };

    await service.previewSmokeProjectThreads(smokePlan);
    const result = await service.createSmokeProjectThreads(smokePlan, {
      dry_run: false,
      confirmed: true,
    });

    expect(result).toMatchObject({ ok: true });
    const turns = app.events.filter(
      (event) => event.method === "turn/start",
    );
    expect(turns).toHaveLength(2);
    const params = turns.map((event) => event.params as TurnStartParams);
    expect(params.map((item) => item.input[0]?.text)).toEqual([
      m0Prompt,
      m1Prompt,
    ]);
    expect(params.every((item) => item.outputSchema === undefined)).toBe(
      true,
    );
    expect(JSON.stringify(params)).not.toContain("AGENTS.md");

    const eventCountAfterFirst = app.events.length;
    const startsAfterFirst = app.count("thread/start");
    const namesAfterFirst = app.count("thread/name/set");
    const goalsAfterFirst = app.count("thread/goal/set");
    const turnsAfterFirst = app.count("turn/start");
    const repeated = await service.createSmokeProjectThreads(smokePlan, {
      dry_run: false,
      confirmed: true,
    });

    expect(arrayField(repeated, "created")).toHaveLength(0);
    expect(arrayField(repeated, "failed")).toHaveLength(0);
    expect(
      arrayField(repeated, "reused").map((item) => item.thread_id),
    ).toEqual(["thread-1", "thread-2"]);
    expect(app.events).toHaveLength(eventCountAfterFirst);
    expect(app.count("thread/start")).toBe(startsAfterFirst);
    expect(app.count("thread/name/set")).toBe(namesAfterFirst);
    expect(app.count("thread/goal/set")).toBe(goalsAfterFirst);
    expect(app.count("turn/start")).toBe(turnsAfterFirst);
  });

  it("returns existing thread ids on an identical repeated call", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const plan = makePlan(project, makeTasks(3));
    await service.previewProjectThreads(plan);
    const first = await service.createProjectThreads(
      createInput(project),
    );
    const startsAfterFirst = app.count("thread/start");

    const second = await service.createProjectThreads(
      createInput(project),
    );

    expect(arrayField(first, "created")).toHaveLength(3);
    expect(arrayField(second, "created")).toHaveLength(0);
    expect(arrayField(second, "reused")).toHaveLength(3);
    expect(app.count("thread/start")).toBe(startsAfterFirst);
    expect(
      arrayField(second, "reused").map((item) => item.thread_id),
    ).toEqual(["thread-1", "thread-2", "thread-3"]);
  });

  it("shows field-level differences and never rebuilds a changed milestone", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const original = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, original));
    await service.createProjectThreads(createInput(project, original));
    const starts = app.count("thread/start");
    const changed = makeTasks(3);
    changed[1] = {
      ...changed[1]!,
      goal: "A materially changed long-term goal.",
    };

    const preview = await service.previewProjectThreads(
      makePlan(project, changed),
    );
    expect(preview.ok).toBe(false);
    const conflict = arrayField(preview, "actions").find(
      (item) => item.milestone_id === "M1",
    );
    expect(conflict).toMatchObject({ action: "plan-changed" });
    expect(conflict?.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/goal" }),
      ]),
    );
    expect(app.count("thread/start")).toBe(starts);
  });

  it("returns both success and failure lists when one thread creation fails", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.failStartCalls.add(2);
    const service = new ThreadService(app);
    await service.previewProjectThreads(makePlan(project, makeTasks(3)));

    const result = await service.createProjectThreads(
      createInput(project),
    );

    expect(result.ok).toBe(false);
    expect(arrayField(result, "created")).toHaveLength(1);
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        stage: "THREAD_START",
        ambiguous: false,
      }),
    ]);
    expect(app.count("thread/start")).toBe(2);
    expect(app.threads.size).toBe(1);
  });

  it("records three synchronous spawn EPERM failures without fake ids or orphan threads, then safely retries", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    const plan = makePlan(project, tasks);
    for (const call of [1, 2, 3]) {
      const error = new Error("spawn EPERM") as Error & {
        code: string;
        errno: number;
        syscall: string;
      };
      error.code = "EPERM";
      error.errno = -4048;
      error.syscall = "spawn";
      app.startErrors.set(call, error);
    }

    await service.previewProjectThreads(plan);
    const failedCreate = await service.createProjectThreads(
      createInput(project, tasks),
    );

    expect(failedCreate).toMatchObject({ ok: false, dry_run: false });
    expect(arrayField(failedCreate, "created")).toHaveLength(0);
    expect(arrayField(failedCreate, "reused")).toHaveLength(0);
    expect(arrayField(failedCreate, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: null,
        stage: "THREAD_START",
        error: "spawn EPERM",
        ambiguous: false,
      }),
    ]);
    expect(app.count("thread/start")).toBe(1);
    expect(app.count("thread/name/set")).toBe(0);
    expect(app.count("thread/goal/set")).toBe(0);
    expect(app.count("turn/start")).toBe(0);
    expect(app.threads.size).toBe(0);
    expect(app.archived.size).toBe(0);

    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        {
          thread_id: string | null;
          status: string;
          live_name: string | null;
          live_cwd: string | null;
          live_status: string | null;
          last_error: string | null;
          initialization: { status: string; turn_id: string | null };
        }
      >;
    };
    expect(Object.keys(persisted.milestones)).toEqual(["M0"]);
    for (const task of tasks.slice(0, 1)) {
      expect(persisted.milestones[task.milestone_id]).toMatchObject({
        thread_id: null,
        status: "CREATE_FAILED",
        live_name: null,
        live_cwd: null,
        live_status: null,
        last_error: "spawn EPERM",
        initialization: {
          status: "NOT_STARTED",
          turn_id: null,
        },
      });
    }

    const retryPreview = await service.previewProjectThreads(plan);
    expect(retryPreview).toMatchObject({ ok: true, dry_run: true });
    expect(arrayField(retryPreview, "actions")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        action: "retry-create",
        thread_id: null,
      }),
      expect.objectContaining({ milestone_id: "M1", action: "create" }),
      expect.objectContaining({ milestone_id: "M2", action: "create" }),
    ]);

    app.startErrors.clear();
    const retried = await service.createProjectThreads(
      createInput(project, tasks),
    );

    expect(retried).toMatchObject({ ok: true, dry_run: false });
    expect(arrayField(retried, "failed")).toHaveLength(0);
    expect(arrayField(retried, "created")).toEqual(
      tasks.map((task, index) =>
        expect.objectContaining({
          milestone_id: task.milestone_id,
          thread_id: `thread-${index + 1}`,
        }),
      ),
    );
    expect(app.count("thread/start")).toBe(4);
    expect(app.count("turn/start")).toBe(3);
    expect([...app.threads.keys()]).toEqual([
      "thread-1",
      "thread-2",
      "thread-3",
    ]);
    expect(app.archived.size).toBe(0);
  });

  it("fails closed after an ambiguous start and will not create a duplicate", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.ambiguousStartCalls.add(2);
    const service = new ThreadService(app);
    const plan = makePlan(project, makeTasks(3));
    await service.previewProjectThreads(plan);
    const result = await service.createProjectThreads(
      createInput(project),
    );
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        ambiguous: true,
      }),
    ]);
    const starts = app.count("thread/start");

    const preview = await service.previewProjectThreads(plan);
    expect(preview.ok).toBe(false);
    expect(
      arrayField(preview, "actions").find(
        (item) => item.milestone_id === "M1",
      ),
    ).toMatchObject({ action: "ambiguous-reservation" });
    expect(app.count("thread/start")).toBe(starts);
  });

  it("does not commit a thread id when thread/started is never received", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.missingThreadStartedCalls.add(1);
    const service = new ThreadService(app);
    await service.previewProjectThreads(makePlan(project, makeTasks(3)));
    const result = await service.createProjectThreads(createInput(project));

    expect(arrayField(result, "created")).toHaveLength(0);
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: "thread-1",
        stage: "THREAD_STARTED_NOTIFICATION",
      }),
    ]);
    expect(app.count("thread/start")).toBe(1);
    expect(app.count("turn/start")).toBe(0);
    const registry = await new RegistryStore().load(project);
    expect(registry.registry.milestones.M0).toMatchObject({
      thread_id: null,
      provisional_thread_id: "thread-1",
      thread_started_received: false,
      creation_state: "CREATE_PERSISTENCE_FAILED",
    });
  });

  it("marks persistence failure when metadata exists but the rollout is absent", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.noRolloutThreadIds.add("thread-1");
    const service = new ThreadService(app);
    await service.previewProjectThreads(makePlan(project, makeTasks(3)));
    const result = await service.createProjectThreads(createInput(project));

    expect(arrayField(result, "created")).toHaveLength(0);
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: "thread-1",
        stage: "PERSISTENCE_RESUME",
        error: expect.stringContaining("no rollout found"),
      }),
    ]);
    expect(app.count("thread/start")).toBe(1);
    const registry = await new RegistryStore().load(project);
    expect(registry.registry.milestones.M0).toMatchObject({
      thread_id: null,
      provisional_thread_id: "thread-1",
      status: "CREATE_PERSISTENCE_FAILED",
      rollout_verified: false,
      resume_verified: false,
      failure_stage: "PERSISTENCE_RESUME",
    });
  });

  it("keeps the App Server alive long enough to read an explicit first-turn stream failure", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.failTurnCompletionCalls.add(1);
    const service = new ThreadService(app);
    await service.previewProjectThreads(makePlan(project, makeTasks(3)));
    const eventStart = app.events.length;
    const result = await service.createProjectThreads(createInput(project));

    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        stage: "FIRST_SESSION_FINAL_READ",
        error: expect.stringContaining("stream disconnected"),
      }),
    ]);
    const methods = app.events.slice(eventStart).map((event) => event.method);
    expect(methods.indexOf("thread/read")).toBeGreaterThan(
      methods.indexOf("turn/wait"),
    );
    expect(methods.indexOf("app-server/close")).toBeGreaterThan(
      methods.indexOf("thread/read"),
    );
    const registry = await new RegistryStore().load(project);
    expect(registry.registry.milestones.M0).toMatchObject({
      thread_id: null,
      first_turn_status: "failed",
      creation_state: "CREATE_PERSISTENCE_FAILED",
    });
  });

  it("verifies the rollout on a fresh connection before committing CREATED", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await service.previewProjectThreads(makePlan(project, makeTasks(3)));
    const result = await service.createProjectThreads(createInput(project));

    expect(result.ok).toBe(true);
    const registry = await new RegistryStore().load(project);
    for (const record of Object.values(registry.registry.milestones)) {
      expect(record).toMatchObject({
        creation_state: "CREATED",
        thread_started_received: true,
        rollout_verified: true,
        resume_verified: true,
        first_turn_status: "completed",
      });
      expect(record.thread_id).toBe(record.provisional_thread_id);
    }
    for (const threadId of ["thread-1", "thread-2", "thread-3"]) {
      const start = app.events.find(
        (event) =>
          event.method === "thread/start" &&
          (event.params as ThreadStartParams).cwd === path.normalize(project) &&
          threadId === `thread-${
            app.events
              .filter((candidate) => candidate.method === "thread/start")
              .indexOf(event) + 1
          }`,
      );
      const resume = app.events.find(
        (event) =>
          event.method === "thread/resume" &&
          (event.params as { threadId: string }).threadId === threadId,
      );
      expect(start?.connection_id).not.toBe(resume?.connection_id);
    }
  });
});

describe("metadata-only orphan safety", () => {
  it("requires every independent evidence bit for ORPHAN_METADATA_ONLY", () => {
    const full = {
      registry_thread_id_present: true,
      metadata_present: true,
      resume_no_rollout: true,
      active_rollout_exists: false,
      archived_rollout_exists: false,
      readable_history: false,
    };
    expect(classifyOrphanMetadataEvidence(full)).toBe(
      "ORPHAN_METADATA_ONLY",
    );
    expect(
      classifyOrphanMetadataEvidence({ ...full, readable_history: true }),
    ).toBe("NOT_ORPHAN_METADATA_ONLY");
    expect(
      classifyOrphanMetadataEvidence({ ...full, metadata_present: false }),
    ).toBe("NOT_ORPHAN_METADATA_ONLY");
  });

  it("rejects an unconfirmed destructive cleanup contract", () => {
    expect(() =>
      CleanupOrphanThreadsInputSchema.parse({
        project_cwd: "C:\\safe-project",
        thread_ids: ["019fbdf8-74ad-7f03-819c-34d58356c570"],
      }),
    ).toThrow(/expected true/u);
  });

  it("previews only the exact reviewed orphan IDs and performs no deletion", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = await seedReviewedOrphans(project, app);

    const preview = await service.previewOrphanThreadCleanup({
      project_cwd: project,
      thread_ids: cleanupThreadIds,
    });
    expect(preview).toMatchObject({
      ok: true,
      dry_run: true,
      deletion_performed: false,
      registry_modified: false,
      targets: expect.arrayContaining([
        expect.objectContaining({
          thread_id: cleanupThreadIds[0],
          classification: "ORPHAN_METADATA_ONLY",
        }),
      ]),
    });
    expect(app.count("thread/delete")).toBe(0);

    await expect(
      service.previewOrphanThreadCleanup({
        project_cwd: project,
        thread_ids: [cleanupThreadIds[0]],
      }),
    ).rejects.toThrow(/exact reviewed thread IDs/u);
  });

  it("requires the one-time preview token and atomically cleans all three reviewed IDs", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = await seedReviewedOrphans(project, app);
    const preview = await service.previewOrphanThreadCleanup({ project_cwd: project, thread_ids: cleanupThreadIds });
    const result = await service.cleanupOrphanThreads({
      project_cwd: project,
      thread_ids: cleanupThreadIds,
      confirmation_token: confirmationToken(preview),
      confirmed: true,
      expected_classification: "ORPHAN_METADATA_ONLY",
      expected_preview_digest: preview.expected_preview_digest,
    });
    expect(result).toMatchObject({ ok: true, registry_modified: true });
    expect(app.count("thread/delete")).toBe(3);
    await expect(service.cleanupOrphanThreads({
      project_cwd: project,
      thread_ids: cleanupThreadIds,
      confirmation_token: confirmationToken(preview),
      confirmed: true,
      expected_classification: "ORPHAN_METADATA_ONLY",
      expected_preview_digest: preview.expected_preview_digest,
    })).resolves.toMatchObject({ already_reconciled: true, registry_modified: false });
    expect(await readFile(path.join(project, ".project-capsule", "orphan-cleanup-audit.json"), "utf8")).toContain(cleanupThreadIds[0]);
  });

  it("reconciles a fully preflighted no-rollout delete as ALREADY_ABSENT", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = await seedReviewedOrphans(project, app);
    for (const threadId of cleanupThreadIds) {
      app.deleteNoRolloutThreadIds.add(threadId);
    }
    const preview = await service.previewOrphanThreadCleanup({ project_cwd: project, thread_ids: cleanupThreadIds });
    const result = await service.cleanupOrphanThreads({
      project_cwd: project,
      thread_ids: cleanupThreadIds,
      confirmation_token: confirmationToken(preview),
      confirmed: true,
      expected_classification: "ORPHAN_METADATA_ONLY",
      expected_preview_digest: preview.expected_preview_digest,
    });
    expect(result).toMatchObject({ ok: true, registry_modified: true });
    expect(arrayField(result, "results")).toEqual(expect.arrayContaining([
      expect.objectContaining({ app_server_delete_result: "ALREADY_ABSENT" }),
    ]));
    const registry = await new RegistryStore().load(project);
    expect(Object.keys(registry.registry.milestones)).toHaveLength(0);
    expect(registry.registry.reconciled_orphans).toHaveLength(3);
    expect(registry.registry.reconciled_orphans[0]?.status).toBe("ORPHAN_RECONCILED");
  });

  it("does not call thread/delete when any latest preflight condition changes", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = await seedReviewedOrphans(project, app);
    const preview = await service.previewOrphanThreadCleanup({ project_cwd: project, thread_ids: cleanupThreadIds });
    app.hideListThreadIds.delete(cleanupThreadIds[0]);
    await expect(service.cleanupOrphanThreads({
      project_cwd: project,
      thread_ids: cleanupThreadIds,
      confirmation_token: confirmationToken(preview),
      confirmed: true,
      expected_classification: "ORPHAN_METADATA_ONLY",
      expected_preview_digest: preview.expected_preview_digest,
    })).rejects.toThrow(/evidence changed|preflight changed/u);
    expect(app.count("thread/delete")).toBe(0);
  });

  it("rejects a descendant before any delete", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = await seedReviewedOrphans(project, app);
    app.threads.set("descendant", {
      id: "descendant", cwd: project, parentThreadId: cleanupThreadIds[0], status: { type: "idle" }, turns: [],
    });
    const preview = await service.previewOrphanThreadCleanup({ project_cwd: project, thread_ids: cleanupThreadIds });
    expect(preview.ok).toBe(false);
    expect(preview.confirmation).toBeNull();
    expect(app.count("thread/delete")).toBe(0);
  });

  it("rejects reuse of a retired id for a replacement generation", () => {
    expect(() =>
      assertReplacementThreadIdIsNew("old-thread", ["old-thread"]),
    ).toThrow(/reused retired thread id/u);
    expect(() =>
      assertReplacementThreadIdIsNew("new-thread", ["old-thread"]),
    ).not.toThrow();
  });

  it("never modifies the project thread-plan file", async () => {
    const project = await createProject();
    const capsule = path.join(project, ".project-capsule");
    await mkdir(capsule, { recursive: true });
    const planPath = path.join(capsule, "thread-plan.json");
    const original = '{"immutable_test_marker":true}\n';
    await writeFile(planPath, original, "utf8");
    const app = new MockAppServer();
    app.noRolloutThreadIds.add("thread-1");
    const service = new ThreadService(app);

    await service.previewProjectThreads(makePlan(project, makeTasks(3)));
    await service.createProjectThreads(createInput(project));
    expect(await readFile(planPath, "utf8")).toBe(original);
  });
});

describe("confirmation grant absolute-time semantics", () => {
  const cases = [
    ["UTC+8 cross-midnight", "2026-08-01T17:56:48.370Z"],
    ["UTC-5 cross-midnight", "2026-08-02T04:56:48.370Z"],
    ["UTC", "2026-08-02T01:56:48.370Z"],
    ["Asia/Shanghai", "2026-08-01T17:56:48.370Z"],
    ["DST region", "2026-11-01T05:56:48.370Z"],
  ] as const;

  it.each(cases)("accepts a still-valid %s grant using epoch milliseconds", async (_label, issuedAt) => {
    const project = await createProject();
    const app = new MockAppServer();
    let nowMs = Date.parse(issuedAt);
    const service = new ThreadService(app, new RegistryStore(() => new Date(nowMs)), {
      now: () => new Date(nowMs),
    });
    const plan = makePlan(project, makeTasks(3)) as Record<string, unknown>;
    const preview = await service.previewProjectThreads(plan);
    const confirmation = preview.confirmation as Record<string, unknown>;
    expect(confirmation.issued_at).toBe(new Date(nowMs).toISOString());
    expect(confirmation.expires_at_epoch_ms).toBe(nowMs + 300_000);
    nowMs += 299_999;
    await expect(service.createProjectThreads({ ...plan, dry_run: false, confirmed: true, confirmation_token: confirmationToken(preview) })).resolves.toMatchObject({ ok: true });
  });

  it("expires exactly at the parsed UTC timestamp and records a redacted diagnostic", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    let nowMs = Date.parse("2026-08-01T17:56:48.370Z");
    const service = new ThreadService(app, new RegistryStore(() => new Date(nowMs)), { now: () => new Date(nowMs) });
    const plan = makePlan(project, makeTasks(3)) as Record<string, unknown>;
    const preview = await service.previewProjectThreads(plan);
    nowMs += 300_000;
    await expect(service.createProjectThreads({ ...plan, dry_run: false, confirmed: true, confirmation_token: confirmationToken(preview) })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      diagnostic: expect.objectContaining({ expired: true, remaining_ms: 0, token_fingerprint: expect.any(String) }),
    });
  });

  it("rejects malformed expiration timestamps without using date-only comparison", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const plan = makePlan(project, makeTasks(3)) as Record<string, unknown>;
    const preview = await service.previewProjectThreads(plan);
    const token = confirmationToken(preview);
    const internals = service as unknown as { grantsByToken: Map<string, { expires_at: string }> };
    internals.grantsByToken.get(token)!.expires_at = "not-a-timestamp";
    await expect(service.createProjectThreads({ ...plan, dry_run: false, confirmed: true, confirmation_token: token })).rejects.toMatchObject({
      code: "INVALID_EXPIRATION_TIMESTAMP",
    });
  });
});

describe("ThreadService archive and recreation orchestration", () => {
  it("requires an archive preview and verifies persistence before reporting success", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    await service.createProjectThreads(createInput(project, threads));

    await expect(
      service.archiveProjectThreads({
        project_cwd: project,
        milestone_ids: ["M1"],
        dry_run: false,
        confirmed: true,
      }),
    ).rejects.toThrow("No matching, unexpired archive preview exists");
    expect(app.count("thread/archive")).toBe(0);

    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M1"],
      dry_run: true,
    });
    expect(preview).toMatchObject({
      ok: true,
      dry_run: true,
      already_archived: [],
    });
    expect(arrayField(preview, "targets")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        thread_id: "thread-2",
      }),
    ]);
    expect(app.count("thread/archive")).toBe(0);

    const archived = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M1"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(preview),
    });

    expect(archived).toMatchObject({ ok: true, dry_run: false });
    expect(arrayField(archived, "archived")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        thread_id: "thread-2",
        generation: 1,
        status: "ARCHIVED",
      }),
    ]);
    expect(app.count("thread/archive")).toBe(1);
    const archiveEventIndex = app.events.findIndex(
      (event) => event.method === "thread/archive",
    );
    const verificationEventIndex = app.events.findIndex(
      (event, index) =>
        index > archiveEventIndex &&
        event.method === "thread/list" &&
        (event.params as { archived?: unknown }).archived === true,
    );
    expect(verificationEventIndex).toBeGreaterThan(archiveEventIndex);

    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        {
          thread_id: string;
          generation: number;
          status: string;
          archived: boolean;
          archived_at: string | null;
        }
      >;
    };
    expect(persisted.milestones.M1).toMatchObject({
      thread_id: "thread-2",
      generation: 1,
      status: "ARCHIVED",
      archived: true,
      archived_at: expect.any(String),
    });
  });

  it("fails the archive result when the thread is not visible in the archived list", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    await service.createProjectThreads(createInput(project, threads));
    app.hideArchivedThreadIds.add("thread-1");
    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: true,
    });

    const result = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(preview),
    });

    expect(result.ok).toBe(false);
    expect(arrayField(result, "archived")).toHaveLength(0);
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: "thread-1",
        stage: "ARCHIVE",
        error: expect.stringContaining("not observed in the archived list"),
        ambiguous: true,
      }),
    ]);
    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as { milestones: Record<string, { status: string }> };
    expect(persisted.milestones.M0?.status).toBe("AMBIGUOUS");
  });

  it("checks live cwd and name before issuing thread/archive", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    await service.createProjectThreads(createInput(project, threads));
    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: true,
    });
    app.threads.get("thread-1")!.cwd = `${project}-drifted`;

    const result = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(preview),
    });

    expect(result.ok).toBe(false);
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        error: expect.stringContaining("archive preflight cwd mismatch"),
      }),
    ]);
    expect(app.count("thread/archive")).toBe(0);
  });

  it("reconciles an ambiguous archive response when the archived list proves success", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    await service.createProjectThreads(createInput(project, threads));
    app.ambiguousArchiveCalls.add(1);
    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: true,
    });

    const result = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(preview),
    });

    expect(result.ok).toBe(true);
    expect(arrayField(result, "archived")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        status: "ARCHIVED",
      }),
    ]);
  });

  it("persists an unverified archive timeout as AMBIGUOUS and blocks a blind retry", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    await service.createProjectThreads(createInput(project, threads));
    app.ambiguousArchiveWithoutEffectCalls.add(1);
    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: true,
    });
    const result = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(preview),
    });
    expect(result.ok).toBe(false);
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        ambiguous: true,
      }),
    ]);

    const retryPreview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: true,
    });
    expect(retryPreview).toMatchObject({
      ok: false,
      confirmation: null,
    });
    expect(arrayField(retryPreview, "blockers")).toEqual([
      expect.objectContaining({ milestone_id: "M0" }),
    ]);
  });

  it("does not clear archive ambiguity from thread/read alone when both lists omit the thread", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    app.ambiguousArchiveCalls.add(1);
    app.hideArchivedThreadIds.add("thread-1");
    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: true,
    });
    const archive = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M0"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(preview),
    });
    expect(arrayField(archive, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        ambiguous: true,
      }),
    ]);

    const synced = await service.syncThreadRegistry({
      project_cwd: project,
      dry_run: false,
      recover_corrupt_registry: false,
      confirmed_recovery: false,
    });
    expect(synced.ok).toBe(true);
    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        { status: string; ambiguous_operation: string | null }
      >;
    };
    expect(persisted.milestones.M0).toMatchObject({
      status: "AMBIGUOUS",
      ambiguous_operation: "ARCHIVE",
    });
  });

  it.each([false, true])(
    "keeps archive state AMBIGUOUS when post-mutation listing fails (RPC ambiguous: %s)",
    async (archiveRpcAmbiguous) => {
      const project = await createProject();
      const app = new MockAppServer();
      const service = new ThreadService(app);
      const tasks = makeTasks(3);
      await service.previewProjectThreads(makePlan(project, tasks));
      await service.createProjectThreads(createInput(project, tasks));
      if (archiveRpcAmbiguous) {
        app.ambiguousArchiveCalls.add(1);
      }
      const preview = await service.archiveProjectThreads({
        project_cwd: project,
        milestone_ids: ["M0"],
        dry_run: true,
      });
      app.listErrorsByArchived.set(
        true,
        new Error("mock archived list unavailable"),
      );

      const result = await service.archiveProjectThreads({
        project_cwd: project,
        milestone_ids: ["M0"],
        dry_run: false,
        confirmed: true,
        confirmation_token: confirmationToken(preview),
      });

      expect(result.ok).toBe(false);
      expect(arrayField(result, "failed")).toEqual([
        expect.objectContaining({
          milestone_id: "M0",
          ambiguous: true,
          error: expect.stringContaining(
            "archive mutation may have occurred",
          ),
        }),
      ]);
      const persisted = JSON.parse(
        await readFile(registryPathFor(project), "utf8"),
      ) as {
        milestones: Record<
          string,
          { status: string; ambiguous_operation: string | null }
        >;
      };
      expect(persisted.milestones.M0).toMatchObject({
        status: "AMBIGUOUS",
        ambiguous_operation: "ARCHIVE",
      });
      app.listErrorsByArchived.delete(true);
      const retryPreview = await service.archiveProjectThreads({
        project_cwd: project,
        milestone_ids: ["M0"],
        dry_run: true,
      });
      expect(retryPreview).toMatchObject({
        ok: false,
        confirmation: null,
      });
    },
  );

  it("refuses archive while registry recovery is pending", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    const registryPath = registryPathFor(project);
    const registry = JSON.parse(
      await readFile(registryPath, "utf8"),
    ) as {
      recovery: {
        required: boolean;
        reason: string | null;
        corrupt_backup: string | null;
      };
    };
    registry.recovery = {
      required: true,
      reason: "manual recovery test",
      corrupt_backup: `${registryPath}.corrupt`,
    };
    await writeFile(
      registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8",
    );

    await expect(
      service.archiveProjectThreads({
        project_cwd: project,
        milestone_ids: ["M0"],
        dry_run: true,
      }),
    ).rejects.toThrow("registry recovery is pending");
    expect(app.count("thread/archive")).toBe(0);
  });

  it("rejects an archive grant when the registered generation changes before the lock is acquired", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const store = new HookedRegistryStore();
    const service = new ThreadService(app, store);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    await service.createProjectThreads(createInput(project, threads));
    const preview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M1"],
      dry_run: true,
    });
    const archiveCallsBefore = app.count("thread/archive");

    store.beforeNextLock = async () => {
      const registryPath = registryPathFor(project);
      const registry = JSON.parse(
        await readFile(registryPath, "utf8"),
      ) as {
        milestones: Record<
          string,
          { generation: number; status: string }
        >;
      };
      registry.milestones.M1!.generation += 1;
      registry.milestones.M1!.status = "CREATED";
      await writeFile(
        registryPath,
        `${JSON.stringify(registry, null, 2)}\n`,
        "utf8",
      );
    };

    await expect(
      service.archiveProjectThreads({
        project_cwd: project,
        milestone_ids: ["M1"],
        dry_run: false,
        confirmed: true,
        confirmation_token: confirmationToken(preview),
      }),
    ).rejects.toThrow(
      "registered archive targets changed after preview",
    );
    expect(app.count("thread/archive")).toBe(archiveCallsBefore);
  });

  it("does not rebuild an archived milestone unless recreation was previewed and confirmed", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    const plan = makePlan(project, threads) as Record<string, unknown>;
    await service.previewProjectThreads(plan);
    await service.createProjectThreads(createInput(project, threads));
    const archivePreview = await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M1"],
      dry_run: true,
    });
    await service.archiveProjectThreads({
      project_cwd: project,
      milestone_ids: ["M1"],
      dry_run: false,
      confirmed: true,
      confirmation_token: confirmationToken(archivePreview),
    });
    const startsBeforeRecreation = app.count("thread/start");

    const disabledPreview = await service.previewProjectThreads({
      ...plan,
      recreate_archived: false,
    });
    expect(
      arrayField(disabledPreview, "actions").find(
        (item) => item.milestone_id === "M1",
      ),
    ).toMatchObject({
      action: "recreate-archived",
      thread_id: "thread-2",
      reason: expect.stringContaining("recreate_archived=true"),
    });
    await expect(
      service.createProjectThreads({
        ...createInput(project, threads),
        recreate_archived: false,
        confirmation_token: confirmationToken(disabledPreview),
      }),
    ).rejects.toThrow(
      "archived milestones cannot be recreated unless recreate_archived=true",
    );
    expect(app.count("thread/start")).toBe(startsBeforeRecreation);

    const persistedBefore = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        { thread_id: string; generation: number; status: string }
      >;
    };
    expect(persistedBefore.milestones.M1).toMatchObject({
      thread_id: "thread-2",
      generation: 1,
      status: "ARCHIVED",
    });

    const enabledPreview = await service.previewProjectThreads({
      ...plan,
      recreate_archived: true,
    });
    const recreated = await service.createProjectThreads({
      ...createInput(project, threads),
      recreate_archived: true,
      confirmation_token: confirmationToken(enabledPreview),
    });

    expect(recreated.ok).toBe(true);
    expect(arrayField(recreated, "created")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        thread_id: "thread-4",
        generation: 2,
        status: "READY",
      }),
    ]);
    expect(arrayField(recreated, "reused")).toHaveLength(2);
    expect(app.count("thread/start")).toBe(startsBeforeRecreation + 1);

    const persistedAfter = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        {
          thread_id: string;
          generation: number;
          status: string;
          history: Array<{
            generation: number;
            thread_id: string;
            status: string;
          }>;
        }
      >;
    };
    expect(persistedAfter.milestones.M1).toMatchObject({
      thread_id: "thread-4",
      generation: 2,
      status: "READY",
      history: [
        expect.objectContaining({
          generation: 1,
          thread_id: "thread-2",
          status: "ARCHIVED",
        }),
      ],
    });
  });
});

describe("ThreadService initialization recovery", () => {
  it("serially resumes three notLoaded stored threads before starting turns on one connection", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);
    const startsBeforeRecovery = app.count("thread/start");
    const recoveryEventStart = app.events.length;

    const recovered = await initializeFailedStoredThreads(
      project,
      service,
    );

    expect(recovered).toMatchObject({
      ok: true,
      stopped_after_first_failure: false,
      unattempted_after_failure: [],
      app_server_session_closed: true,
      runtime_counts: {
        registry_entries: 3,
        app_server_stored_threads: 3,
        loaded_threads: 3,
        successfully_initialized_threads: 3,
      },
    });
    expect(app.count("thread/start")).toBe(startsBeforeRecovery);

    const recoveryEvents = app.events.slice(recoveryEventStart);
    const methods = recoveryEvents.map((event) => event.method);
    for (const threadId of ["thread-1", "thread-2", "thread-3"]) {
      const readIndex = recoveryEvents.findIndex(
        (event) =>
          event.method === "thread/read" &&
          (event.params as { threadId?: string }).threadId === threadId,
      );
      const resumeIndex = recoveryEvents.findIndex(
        (event) =>
          event.method === "thread/resume" &&
          (event.params as { threadId?: string }).threadId === threadId,
      );
      const loadedIndex = recoveryEvents.findIndex(
        (event, index) =>
          index > resumeIndex && event.method === "thread/loaded/list",
      );
      const turnIndex = recoveryEvents.findIndex(
        (event) =>
          event.method === "turn/start" &&
          (event.params as { threadId?: string }).threadId === threadId,
      );
      expect(readIndex).toBeGreaterThanOrEqual(0);
      expect(resumeIndex).toBeGreaterThan(readIndex);
      expect(loadedIndex).toBeGreaterThan(resumeIndex);
      expect(turnIndex).toBeGreaterThan(loadedIndex);
      expect(recoveryEvents[resumeIndex]?.connection_id).toBe(
        recoveryEvents[turnIndex]?.connection_id,
      );
    }
    expect(methods.at(-1)).toBe("app-server/close");
    expect(
      methods.indexOf("thread/read", methods.indexOf("turn/wait") + 1),
    ).toBeGreaterThan(methods.indexOf("turn/wait"));
  });

  it("does not treat thread/read as loading a notLoaded stored thread", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);

    const stored = await app.readThread("thread-1", true);
    expect(stored.status?.type).toBe("notLoaded");
    expect(app.loaded.has("thread-1")).toBe(false);
  });

  it("treats the real thread/read 'thread not loaded' RPC error as resumable and verifies storage afterward", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);
    app.readNotLoadedOnce.add("thread-1");
    const recoveryEventStart = app.events.length;

    const result = await initializeFailedStoredThreads(project, service);

    expect(result).toMatchObject({
      ok: true,
      runtime_counts: {
        registry_entries: 3,
        app_server_stored_threads: 3,
        loaded_threads: 3,
        successfully_initialized_threads: 3,
      },
    });
    const events = app.events.slice(recoveryEventStart).filter((event) => {
      const eventThreadId = (event.params as { threadId?: string }).threadId;
      return eventThreadId === "thread-1";
    });
    expect(events.map((event) => event.method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/read",
      "turn/start",
      "turn/wait",
      "thread/read",
    ]);
    const resumeEvent = events.find(
      (event) => event.method === "thread/resume",
    );
    const turnEvent = events.find(
      (event) => event.method === "turn/start",
    );
    expect(resumeEvent?.connection_id).toBe(turnEvent?.connection_id);
  });

  it("fails closed when the App Server process closes after resume and before loaded verification", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);
    app.closeAfterResumeThreadIds.add("thread-1");
    const startsBeforeRecovery = app.count("thread/start");
    const turnsBeforeRecovery = app.count("turn/start");

    const result = await initializeFailedStoredThreads(project, service);

    expect(result).toMatchObject({
      ok: false,
      stopped_after_first_failure: true,
      unattempted_after_failure: ["M1", "M2"],
      runtime_counts: {
        registry_entries: 3,
        app_server_stored_threads: 1,
        loaded_threads: 0,
        successfully_initialized_threads: 0,
      },
    });
    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: "thread-1",
        stage: "LOADED_VERIFY",
      }),
    ]);
    expect(app.count("thread/start")).toBe(startsBeforeRecovery);
    expect(app.count("turn/start")).toBe(turnsBeforeRecovery);
  });

  it("marks resume not-found as RESUME_FAILED, stops later threads, and never starts a replacement", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);
    app.resumeErrors.set(
      "thread-1",
      new AppServerRpcError(
        "thread/resume",
        -32_600,
        "thread not found: thread-1",
      ),
    );
    const startsBeforeRecovery = app.count("thread/start");
    const turnsBeforeRecovery = app.count("turn/start");

    const result = await initializeFailedStoredThreads(project, service);

    expect(result).toMatchObject({
      ok: false,
      stopped_after_first_failure: true,
      unattempted_after_failure: ["M1", "M2"],
    });
    expect(app.count("thread/start")).toBe(startsBeforeRecovery);
    expect(app.count("turn/start")).toBe(turnsBeforeRecovery);
    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as { milestones: Record<string, { status: string }> };
    expect(persisted.milestones.M0?.status).toBe("RESUME_FAILED");
    expect(persisted.milestones.M1?.status).toBe(
      "INITIALIZATION_FAILED",
    );
    expect(persisted.milestones.M2?.status).toBe(
      "INITIALIZATION_FAILED",
    );
    expect(
      Object.values(persisted.milestones).some((record) =>
        ["READY", "WAITING"].includes(record.status),
      ),
    ).toBe(false);
  });

  it("classifies registry plus listed metadata plus no rollout as ORPHAN_METADATA_ONLY", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);
    app.noRolloutThreadIds.add("thread-1");
    const startsBeforeRecovery = app.count("thread/start");
    const turnsBeforeRecovery = app.count("turn/start");

    const result = await initializeFailedStoredThreads(project, service);

    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: "thread-1",
        stage: "THREAD_RESUME",
        error: expect.stringContaining("metadata but no active or archived rollout"),
      }),
    ]);
    expect(app.count("thread/start")).toBe(startsBeforeRecovery);
    expect(app.count("turn/start")).toBe(turnsBeforeRecovery);
    const registry = await new RegistryStore().load(project);
    expect(registry.registry.milestones.M0).toMatchObject({
      status: "ORPHAN_METADATA_ONLY",
      rollout_verified: false,
      resume_verified: false,
      failure_stage: "THREAD_RESUME_NO_ROLLOUT",
    });
  });

  it("marks thread/read not-found as MISSING_STORED_THREAD without resume or turn/start", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    await prepareThreeFailedStoredThreads(project, app, service);
    app.readErrors.set(
      "thread-1",
      new AppServerRpcError(
        "thread/read",
        -32_600,
        "thread not found: thread-1",
      ),
    );
    const startsBeforeRecovery = app.count("thread/start");
    const resumesBeforeRecovery = app.count("thread/resume");
    const turnsBeforeRecovery = app.count("turn/start");

    const result = await initializeFailedStoredThreads(project, service);

    expect(arrayField(result, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        thread_id: "thread-1",
        stage: "THREAD_READ",
      }),
    ]);
    expect(app.count("thread/resume")).toBe(resumesBeforeRecovery);
    expect(app.count("turn/start")).toBe(turnsBeforeRecovery);
    expect(app.count("thread/start")).toBe(startsBeforeRecovery);
    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as { milestones: Record<string, { status: string }> };
    expect(persisted.milestones.M0?.status).toBe(
      "MISSING_STORED_THREAD",
    );
  });

  it("does not recover a provisional thread whose atomic create never committed", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.failGoalCalls.add(2);
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));
    const initialCreate = await service.createProjectThreads(
      createInput(project, threads),
    );
    expect(arrayField(initialCreate, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        thread_id: "thread-2",
        stage: "GOAL_SET",
      }),
    ]);
    const startsBeforeRecovery = app.count("thread/start");
    app.failGoalCalls.clear();

    const preview = await service.initializeProjectThreads({
      project_cwd: project,
      milestone_ids: ["M1"],
      dry_run: true,
      retry_failed_initialization: true,
    });
    expect(preview).toMatchObject({ ok: false, confirmation: null });
    expect(arrayField(preview, "blockers")).toEqual([
      expect.objectContaining({
        milestone_id: "M1",
        thread_id: "thread-2",
        reason: expect.stringContaining("orphan cleanup"),
      }),
    ]);
    expect(app.count("thread/start")).toBe(startsBeforeRecovery);
    expect(app.threads.size).toBe(2);
    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        {
          thread_id: string | null;
          provisional_thread_id: string | null;
          status: string;
          creation_state: string;
        }
      >;
    };
    expect(persisted.milestones.M1).toMatchObject({
      thread_id: null,
      provisional_thread_id: "thread-2",
      status: "CREATE_PERSISTENCE_FAILED",
      creation_state: "CREATE_PERSISTENCE_FAILED",
    });
  });

  it("fails closed on an ambiguous first turn without formally committing the id", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    app.ambiguousWaitCalls.add(1);
    const service = new ThreadService(app);
    const threads = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, threads));

    const created = await service.createProjectThreads(
      createInput(project, threads),
    );
    expect(arrayField(created, "failed")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        ambiguous: true,
      }),
    ]);
    const turnsBeforeRetry = app.count("turn/start");

    const initializationPreview =
      await service.initializeProjectThreads({
        project_cwd: project,
        milestone_ids: ["M0"],
        dry_run: true,
        retry_failed_initialization: true,
      });
    expect(initializationPreview).toMatchObject({
      ok: false,
      confirmation: null,
    });
    expect(arrayField(initializationPreview, "blockers")).toEqual([
      expect.objectContaining({
        milestone_id: "M0",
        reason: expect.stringContaining("orphan cleanup"),
      }),
    ]);
    await expect(
      service.initializeProjectThreads({
        project_cwd: project,
        milestone_ids: ["M0"],
        dry_run: false,
        confirmed: true,
        retry_failed_initialization: true,
      }),
    ).rejects.toThrow(
      "No matching, unexpired initialize preview exists",
    );
    expect(app.count("turn/start")).toBe(turnsBeforeRetry);

    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as {
      milestones: Record<
        string,
        {
          thread_id: string | null;
          provisional_thread_id: string | null;
          creation_state: string;
        }
      >;
    };
    expect(persisted.milestones.M0).toMatchObject({
      thread_id: null,
      provisional_thread_id: "thread-1",
      creation_state: "CREATE_PERSISTENCE_FAILED",
    });
  });
});

describe("ThreadService registry synchronization", () => {
  it("keeps corrupt registry bytes untouched during recovery dry-run", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const registryPath = registryPathFor(project);
    await mkdir(path.dirname(registryPath), { recursive: true });
    const corruptContents = "{ this registry is corrupt";
    await writeFile(registryPath, corruptContents, "utf8");

    const preview = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: makeTasks(3),
      dry_run: true,
      recover_corrupt_registry: true,
      confirmed_recovery: false,
    });

    expect(preview).toMatchObject({
      ok: false,
      dry_run: true,
      recovery: {
        required: true,
      },
    });
    expect(arrayField(preview, "errors")).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "no uniquely verified completed ownership turn was found",
        ),
      ]),
    );
    expect(await readFile(registryPath, "utf8")).toBe(corruptContents);
    expect(await readdir(path.dirname(registryPath))).toEqual([
      "thread-registry.json",
    ]);
  });

  it("does not touch a corrupt registry until recovery is explicitly confirmed", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const registryPath = registryPathFor(project);
    await mkdir(path.dirname(registryPath), { recursive: true });
    const corruptContents = "{ recovery must be confirmed";
    await writeFile(registryPath, corruptContents, "utf8");

    await expect(
      service.syncThreadRegistry({
        project_cwd: project,
        project_name: "Unit Test Project",
        threads: makeTasks(3),
        dry_run: false,
        recover_corrupt_registry: true,
        confirmed_recovery: false,
      }),
    ).rejects.toThrow();

    expect(await readFile(registryPath, "utf8")).toBe(corruptContents);
    expect(await readdir(path.dirname(registryPath))).toEqual([
      "thread-registry.json",
    ]);
  });

  it("recovers only uniquely verified completed marker turns and preserves a corrupt backup", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    const registryPath = registryPathFor(project);
    await writeFile(registryPath, "{ corrupt after creation", "utf8");

    const preview = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: true,
      recover_corrupt_registry: true,
      confirmed_recovery: false,
    });
    expect(preview.ok).toBe(true);
    expect(arrayField(preview, "changes")).toHaveLength(3);

    const recovered = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: false,
      recover_corrupt_registry: true,
      confirmed_recovery: true,
    });
    expect(recovered.ok).toBe(true);
    const persisted = JSON.parse(
      await readFile(registryPath, "utf8"),
    ) as {
      recovery: { required: boolean; corrupt_backup: string | null };
      milestones: Record<
        string,
        {
          thread_id: string;
          status: string;
          initialization: { turn_status: string; turn_id: string };
        }
      >;
    };
    expect(persisted.recovery.required).toBe(false);
    expect(persisted.recovery.corrupt_backup).toEqual(
      expect.stringContaining("thread-registry.corrupt."),
    );
    expect(persisted.milestones.M0).toMatchObject({
      thread_id: "thread-1",
      status: "READY",
      initialization: {
        turn_status: "completed",
        turn_id: "turn-1",
      },
    });
    const registryFiles = await readdir(path.dirname(registryPath));
    expect(registryFiles).toEqual(
      expect.arrayContaining([
        "thread-registry.json",
        expect.stringMatching(/^thread-registry\.corrupt\..+\.json$/u),
      ]),
    );
  });

  it("resumes recovery after a crash left a valid pending-recovery staging registry", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    const registryPath = registryPathFor(project);
    await writeFile(registryPath, "{ crash staging source", "utf8");

    const staged = await new RegistryStore().load(project, {
      projectName: "Unit Test Project",
      recoverCorruption: true,
      persistRecovery: true,
    });
    expect(staged.recovered_from_corruption).toBe(true);
    expect(staged.registry.recovery).toMatchObject({
      required: true,
      corrupt_backup: expect.stringContaining(
        "thread-registry.corrupt.",
      ),
    });

    const preview = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: true,
      recover_corrupt_registry: true,
      confirmed_recovery: false,
    });
    const recovered = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: false,
      recover_corrupt_registry: true,
      confirmed_recovery: true,
      confirmation_token: recoveryConfirmationToken(preview),
    });

    expect(recovered.ok).toBe(true);
    const persisted = JSON.parse(
      await readFile(registryPath, "utf8"),
    ) as {
      recovery: { required: boolean; corrupt_backup: string };
      milestones: Record<string, { thread_id: string }>;
    };
    expect(persisted.recovery.required).toBe(false);
    expect(persisted.recovery.corrupt_backup).toBe(
      staged.registry.recovery.corrupt_backup,
    );
    expect(persisted.milestones.M0?.thread_id).toBe("thread-1");
  });

  it("invalidates a corrupt-registry recovery grant when the candidate thread set changes", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    const registryPath = registryPathFor(project);
    const corruptContents = "{ corrupt candidate-binding test";
    await writeFile(registryPath, corruptContents, "utf8");
    const preview = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: true,
      recover_corrupt_registry: true,
      confirmed_recovery: false,
    });
    const token = recoveryConfirmationToken(preview);
    const replacement = structuredClone(app.threads.get("thread-1")!);
    replacement.id = "thread-replacement";
    app.threads.delete("thread-1");
    app.threads.set(replacement.id, replacement);

    await expect(
      service.syncThreadRegistry({
        project_cwd: project,
        project_name: "Unit Test Project",
        threads: tasks,
        dry_run: false,
        recover_corrupt_registry: true,
        confirmed_recovery: true,
        confirmation_token: token,
      }),
    ).rejects.toThrow(
      "confirmation token is expired or does not match",
    );
    expect(await readFile(registryPath, "utf8")).toBe(corruptContents);
    expect(await readdir(path.dirname(registryPath))).toEqual([
      "thread-registry.json",
    ]);
  });

  it("binds corrupt recovery grants to raw bytes, including invalid UTF-8 changes", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    const registryPath = registryPathFor(project);
    await writeFile(registryPath, Buffer.from([0x80]));
    const preview = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: true,
      recover_corrupt_registry: true,
      confirmed_recovery: false,
    });
    const token = recoveryConfirmationToken(preview);
    await writeFile(registryPath, Buffer.from([0x81]));

    await expect(
      service.syncThreadRegistry({
        project_cwd: project,
        project_name: "Unit Test Project",
        threads: tasks,
        dry_run: false,
        recover_corrupt_registry: true,
        confirmed_recovery: true,
        confirmation_token: token,
      }),
    ).rejects.toThrow(
      "confirmation token is expired or does not match",
    );
    expect(await readFile(registryPath)).toEqual(Buffer.from([0x81]));
  });

  it("rejects duplicate ownership claims during corrupt-registry recovery", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    const duplicate = structuredClone(app.threads.get("thread-1")!);
    duplicate.id = "thread-duplicate";
    app.threads.set(duplicate.id, duplicate);
    const registryPath = registryPathFor(project);
    await writeFile(registryPath, "{ corrupt with duplicate claim", "utf8");

    const preview = await service.syncThreadRegistry({
      project_cwd: project,
      project_name: "Unit Test Project",
      threads: tasks,
      dry_run: true,
      recover_corrupt_registry: true,
      confirmed_recovery: false,
    });

    expect(preview.ok).toBe(false);
    expect(arrayField(preview, "errors")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("multiple threads claim M0"),
      ]),
    );
    expect(await readFile(registryPath, "utf8")).toBe(
      "{ corrupt with duplicate claim",
    );
  });

  it("does not mark a registered thread missing on a transient read failure", async () => {
    const project = await createProject();
    const app = new MockAppServer();
    const service = new ThreadService(app);
    const tasks = makeTasks(3);
    await service.previewProjectThreads(makePlan(project, tasks));
    await service.createProjectThreads(createInput(project, tasks));
    app.hideListThreadIds.add("thread-1");
    app.readErrors.set(
      "thread-1",
      new AppServerTimeoutError("thread/read", 100),
    );

    await expect(
      service.syncThreadRegistry({
        project_cwd: project,
        dry_run: false,
        recover_corrupt_registry: false,
        confirmed_recovery: false,
      }),
    ).rejects.toThrow("registry sync failed closed");

    const persisted = JSON.parse(
      await readFile(registryPathFor(project), "utf8"),
    ) as { milestones: Record<string, { status: string }> };
    expect(persisted.milestones.M0?.status).toBe("READY");
  });
});
