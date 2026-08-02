import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  InitialStatusSchema,
  MilestoneTaskSchema,
  PLUGIN_VERSION,
  REGISTRY_SCHEMA_VERSION,
  type MilestoneTask,
} from "./types.js";
import { formatUnknownError, normalizePathKey } from "./plan-validator.js";

export const RegistryStatusSchema = z.enum([
  "RESERVED",
  "CREATED",
  "STORED",
  "LOADED",
  "INITIALIZING",
  "READY",
  "WAITING",
  "ACCEPTED",
  "NEEDS_REWORK",
  "INITIALIZATION_FAILED",
  "RESUME_FAILED",
  "MISSING_STORED_THREAD",
  "ORPHAN_METADATA_ONLY",
  "ORPHAN_RECONCILED",
  "CREATE_FAILED",
  "CREATE_PERSISTENCE_FAILED",
  "AMBIGUOUS",
  "MISSING",
  "ARCHIVED",
]);

/** Business progression is independent from App Server lifecycle metadata. */
export const MilestoneBusinessStatusSchema = z.enum(["READY", "WAITING", "EXECUTING", "ACCEPTED", "NEEDS_REWORK"]);

export const InitializationStatusSchema = z.enum([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "UNKNOWN",
]);

export const LastSuccessfulStepSchema = z.enum([
  "RESERVED",
  "THREAD_STARTED",
  "NAME_SET",
  "GOAL_SET",
  "TURN_STARTED",
  "TURN_COMPLETED",
]);

export const CreationStateSchema = z.enum([
  "RESERVED",
  "CREATING",
  "VERIFYING_PERSISTENCE",
  "CREATED",
  "CREATE_PERSISTENCE_FAILED",
]);

const HistoryEntrySchema = z
  .object({
    generation: z.number().int().positive(),
    thread_id: z.string().min(1).nullable(),
    status: RegistryStatusSchema,
    creation_state: CreationStateSchema.default("CREATED"),
    operation_id: z.string().uuid().nullable().default(null),
    provisional_thread_id: z.string().min(1).nullable().default(null),
    thread_started_received: z.boolean().default(false),
    first_turn_id: z.string().min(1).nullable().default(null),
    first_turn_status: z.string().min(1).nullable().default(null),
    rollout_verified: z.boolean().default(false),
    resume_verified: z.boolean().default(false),
    persisted_cwd: z.string().min(1).nullable().default(null),
    persisted_name: z.string().min(1).nullable().default(null),
    failure_stage: z.string().min(1).nullable().default(null),
    plan_digest: z.string().length(64),
    created_at: z.string().datetime(),
    archived_at: z.string().datetime().nullable(),
  })
  .strict();

export const RegistryRecordSchema = z
  .object({
    milestone_id: z.string().min(1),
    generation: z.number().int().positive(),
    reservation_id: z.string().uuid(),
    thread_id: z.string().min(1).nullable(),
    expected_name: z.string().min(1),
    goal: z.string().min(1).max(4_000),
    initial_status: InitialStatusSchema,
    requested_sandbox_mode: z.enum(["read-only", "workspace-write"]),
    plan_digest: z.string().length(64),
    plan_snapshot: MilestoneTaskSchema,
    project_plan_digest: z.string().length(64),
    status: RegistryStatusSchema,
    milestone_status: MilestoneBusinessStatusSchema.optional(),
    creation_state: CreationStateSchema.default("CREATED"),
    operation_id: z.string().uuid().nullable().default(null),
    provisional_thread_id: z.string().min(1).nullable().default(null),
    thread_started_received: z.boolean().default(false),
    first_turn_id: z.string().min(1).nullable().default(null),
    first_turn_status: z.string().min(1).nullable().default(null),
    rollout_verified: z.boolean().default(false),
    resume_verified: z.boolean().default(false),
    persisted_cwd: z.string().min(1).nullable().default(null),
    persisted_name: z.string().min(1).nullable().default(null),
    failure_stage: z.string().min(1).nullable().default(null),
    archived: z.boolean().default(false),
    ambiguous_operation: z
      .enum(["THREAD_START", "INITIALIZATION", "ARCHIVE"])
      .nullable()
      .default(null),
    initialization: z
      .object({
        status: InitializationStatusSchema,
        turn_id: z.string().min(1).nullable(),
        turn_status: z.string().min(1).nullable(),
        prompt_digest: z.string().length(64).nullable(),
        result_summary: z.string().max(8_000).nullable(),
        completed_at: z.string().datetime().nullable(),
      })
      .strict(),
    last_successful_step: LastSuccessfulStepSchema,
    live_status: z.string().nullable(),
    live_name: z.string().nullable(),
    live_cwd: z.string().nullable(),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    archived_at: z.string().datetime().nullable(),
    last_synced_at: z.string().datetime().nullable(),
    last_error: z.string().max(8_000).nullable(),
    history: z.array(HistoryEntrySchema).max(100),
  })
  .strict();

export type RegistryRecord = z.infer<typeof RegistryRecordSchema>;

export const ThreadRegistrySchema = z
  .object({
    schema_version: z.literal(REGISTRY_SCHEMA_VERSION),
    plugin_version: z.string().min(1),
    project: z
      .object({
        name: z.string().min(1),
        cwd: z.string().min(1),
        cwd_key: z.string().min(1),
      })
      .strict(),
    recovery: z
      .object({
        required: z.boolean(),
        reason: z.string().nullable(),
        corrupt_backup: z.string().nullable(),
      })
      .strict(),
    milestones: z.record(z.string(), RegistryRecordSchema),
    reconciled_orphans: z.array(
      z.object({
        milestone_id: z.string().min(1),
        old_thread_id: z.string().min(1),
        status: z.literal("ORPHAN_RECONCILED"),
        reconciliation_result: z.enum(["DELETED", "ALREADY_ABSENT"]),
        operation_id: z.string().uuid(),
        preview_digest: z.string().length(64),
        reconciled_at: z.string().datetime(),
        replacement_thread_id: z.string().min(1).nullable(),
      }).strict(),
    ).default([]),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

export type ThreadRegistry = z.infer<typeof ThreadRegistrySchema>;

export interface RegistryLoadResult {
  registry: ThreadRegistry;
  exists: boolean;
  recovered_from_corruption: boolean;
}

export class RegistryCorruptError extends Error {
  public readonly code = "REGISTRY_CORRUPT";

  public constructor(
    public readonly registryPath: string,
    public readonly causeMessage: string,
  ) {
    super(
      `thread registry is corrupt; run sync_thread_registry with recover_corrupt_registry=true: ${registryPath}`,
    );
    this.name = "RegistryCorruptError";
  }
}

export class RegistryProjectMismatchError extends Error {
  public readonly code = "REGISTRY_PROJECT_MISMATCH";

  public constructor(message: string) {
    super(message);
    this.name = "RegistryProjectMismatchError";
  }
}

export class RegistryLockError extends Error {
  public readonly code = "REGISTRY_LOCKED";

  public constructor(public readonly lockPath: string) {
    super(
      `another project-thread-orchestrator mutation may be running; inspect this lock before retrying: ${lockPath}`,
    );
    this.name = "RegistryLockError";
  }
}

export function registryPathFor(projectCwd: string): string {
  return path.join(projectCwd, ".project-capsule", "thread-registry.json");
}

export function createEmptyRegistry(
  projectCwd: string,
  projectName: string,
  now: string,
): ThreadRegistry {
  return {
    schema_version: REGISTRY_SCHEMA_VERSION,
    plugin_version: PLUGIN_VERSION,
    project: {
      name: projectName,
      cwd: projectCwd,
      cwd_key: normalizePathKey(projectCwd),
    },
    recovery: {
      required: false,
      reason: null,
      corrupt_backup: null,
    },
    milestones: {},
    reconciled_orphans: [],
    created_at: now,
    updated_at: now,
  };
}

export function createReservedRecord(input: {
  task: MilestoneTask;
  taskDigest: string;
  projectPlanDigest: string;
  expectedName: string;
  now: string;
  generation?: number;
  history?: RegistryRecord["history"];
}): RegistryRecord {
  return {
    milestone_id: input.task.milestone_id,
    generation: input.generation ?? 1,
    reservation_id: randomUUID(),
    thread_id: null,
    expected_name: input.expectedName,
    goal: input.task.goal,
    initial_status: input.task.initial_status,
    requested_sandbox_mode: input.task.sandbox_mode,
    plan_digest: input.taskDigest,
    plan_snapshot: input.task,
    project_plan_digest: input.projectPlanDigest,
    status: "RESERVED",
    milestone_status: input.task.dependencies.length === 0 ? "READY" : "WAITING",
    creation_state: "RESERVED",
    operation_id: null,
    provisional_thread_id: null,
    thread_started_received: false,
    first_turn_id: null,
    first_turn_status: null,
    rollout_verified: false,
    resume_verified: false,
    persisted_cwd: null,
    persisted_name: null,
    failure_stage: null,
    archived: false,
    ambiguous_operation: null,
    initialization: {
      status: "NOT_STARTED",
      turn_id: null,
      turn_status: null,
      prompt_digest: null,
      result_summary: null,
      completed_at: null,
    },
    last_successful_step: "RESERVED",
    live_status: null,
    live_name: null,
    live_cwd: null,
    created_at: input.now,
    updated_at: input.now,
    archived_at: null,
    last_synced_at: null,
    last_error: null,
    history: input.history ?? [],
  };
}

export function archiveRecordHistory(record: RegistryRecord): RegistryRecord["history"] {
  return [
    ...record.history,
    {
      generation: record.generation,
      thread_id: record.thread_id,
      status: record.status,
      creation_state: record.creation_state,
      operation_id: record.operation_id,
      provisional_thread_id: record.provisional_thread_id,
      thread_started_received: record.thread_started_received,
      first_turn_id: record.first_turn_id,
      first_turn_status: record.first_turn_status,
      rollout_verified: record.rollout_verified,
      resume_verified: record.resume_verified,
      persisted_cwd: record.persisted_cwd,
      persisted_name: record.persisted_name,
      failure_stage: record.failure_stage,
      plan_digest: record.plan_digest,
      created_at: record.created_at,
      archived_at: record.archived_at,
    },
  ];
}

export class RegistryStore {
  public constructor(
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async load(
    projectCwd: string,
    options: {
      projectName?: string;
      recoverCorruption?: boolean;
      persistRecovery?: boolean;
    } = {},
  ): Promise<RegistryLoadResult> {
    const registryPath = registryPathFor(projectCwd);
    let raw: string;
    try {
      raw = await readFile(registryPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        const projectName = options.projectName ?? path.basename(projectCwd);
        return {
          registry: createEmptyRegistry(
            projectCwd,
            projectName || "Unnamed project",
            this.now().toISOString(),
          ),
          exists: false,
          recovered_from_corruption: false,
        };
      }
      throw error;
    }

    try {
      const registry = ThreadRegistrySchema.parse(JSON.parse(raw) as unknown);
      this.assertProject(registry, projectCwd);
      return {
        registry,
        exists: true,
        recovered_from_corruption: false,
      };
    } catch (error) {
      if (error instanceof RegistryProjectMismatchError) {
        throw error;
      }
      if (options.recoverCorruption !== true) {
        throw new RegistryCorruptError(registryPath, formatUnknownError(error));
      }
      return this.recoverCorruptRegistry(
        projectCwd,
        options.projectName ??
          (path.basename(projectCwd) || "Recovered project"),
        registryPath,
        options.persistRecovery !== false,
      );
    }
  }

  public async save(registry: ThreadRegistry): Promise<void> {
    registry.plugin_version = PLUGIN_VERSION;
    registry.updated_at = this.now().toISOString();
    const validated = ThreadRegistrySchema.parse(registry);
    const target = registryPathFor(validated.project.cwd);
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true });

    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const serialized = `${JSON.stringify(validated, null, 2)}\n`;
    const temporaryHandle = await open(temporary, "wx");
    try {
      await temporaryHandle.writeFile(serialized, "utf8");
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }

    try {
      await rename(temporary, target);
    } catch (error) {
      if (!isNodeError(error, "EEXIST") && !isNodeError(error, "EPERM")) {
        await safeUnlink(temporary);
        throw error;
      }

      // Windows can refuse rename-over-existing. Preserve a last-known-good
      // copy before replacing the target bytes and never delete that backup.
      const backup = `${target}.last-known-good`;
      try {
        await copyFile(target, backup);
      } catch (copyError) {
        if (!isNodeError(copyError, "ENOENT")) {
          await safeUnlink(temporary);
          throw copyError;
        }
      }
      await copyFile(temporary, target);
      await safeUnlink(temporary);
    }
  }

  public async withProjectLock<T>(
    projectCwd: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const directory = path.join(projectCwd, ".project-capsule");
    await mkdir(directory, { recursive: true });
    const lockPath = path.join(directory, "thread-registry.lock");
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (isNodeError(error, "EEXIST")) {
        throw new RegistryLockError(lockPath);
      }
      throw error;
    }

    try {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          created_at: this.now().toISOString(),
          nonce: randomUUID(),
        })}\n`,
        "utf8",
      );
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      await safeUnlink(lockPath);
    }
  }

  private assertProject(registry: ThreadRegistry, projectCwd: string): void {
    if (registry.project.cwd_key !== normalizePathKey(projectCwd)) {
      throw new RegistryProjectMismatchError(
        `registry cwd ${registry.project.cwd} does not match requested cwd ${projectCwd}`,
      );
    }
  }

  private async recoverCorruptRegistry(
    projectCwd: string,
    projectName: string,
    registryPath: string,
    persistRecovery: boolean,
  ): Promise<RegistryLoadResult> {
    const timestamp = this.now().toISOString().replace(/[:.]/gu, "-");
    const backup = path.join(
      path.dirname(registryPath),
      `thread-registry.corrupt.${timestamp}.json`,
    );
    const registry = createEmptyRegistry(
      projectCwd,
      projectName,
      this.now().toISOString(),
    );
    registry.recovery = {
      required: true,
      reason:
        "The prior registry failed JSON/schema validation. Creation is fail-closed until a confirmed sync reconciles real threads.",
      corrupt_backup: backup,
    };
    if (persistRecovery) {
      await rename(registryPath, backup);
      await this.save(registry);
    }
    return {
      registry,
      exists: true,
      recovered_from_corruption: true,
    };
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}
