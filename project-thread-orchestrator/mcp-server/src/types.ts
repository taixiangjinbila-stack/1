import { z } from "zod";

export const PLUGIN_VERSION = "0.2.1-mvp";
export const REGISTRY_SCHEMA_VERSION = "1.0";
export const MIN_PROJECT_THREADS = 3;
export const MAX_PROJECT_THREADS = 12;

export const MilestoneIdSchema = z
  .string()
  .regex(/^M(?:0|[1-9][0-9]?)$/, "milestone_id must look like M0, M1, ...");

export const InitialStatusSchema = z.enum(["READY", "WAITING"]);

export const SandboxModeSchema = z.enum(["read-only", "workspace-write"]);

const SafeCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\r\n\0]/u.test(value), {
    message: "validation commands must be single-line strings",
  })
  .refine(
    (value) =>
      !/(?:\brm\s+-rf\b|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bshutdown\b|\breboot\b|\bdiskpart\b|\bformat(?:\.com)?\b|Remove-Item\b[^\r\n]*(?:-Recurse[^\r\n]*-Force|-Force[^\r\n]*-Recurse))/iu.test(
        value,
      ),
    {
      message:
        "validation command contains a destructive or externally mutating operation",
    },
  );

const PlanPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\0\r\n]/u.test(value), {
    message: "paths may not contain NUL or line breaks",
  });

export const MilestoneTaskSchema = z
  .object({
    milestone_id: MilestoneIdSchema,
    name: z.string().trim().min(1).max(120),
    goal: z.string().trim().min(1).max(4_000),
    initial_prompt: z.string().trim().min(1).max(12_000),
    dependencies: z.array(MilestoneIdSchema).max(MAX_PROJECT_THREADS),
    allowed_paths: z.array(PlanPathSchema).max(64),
    forbidden_paths: z.array(PlanPathSchema).max(64),
    acceptance_criteria: z
      .array(z.string().trim().min(1).max(2_000))
      .min(1)
      .max(64),
    validation_commands: z.array(SafeCommandSchema).min(1).max(32),
    initial_status: InitialStatusSchema,
    sandbox_mode: SandboxModeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sandbox_mode === "workspace-write" &&
      value.allowed_paths.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowed_paths"],
        message:
          "workspace-write milestones require at least one allowed path",
      });
    }
  });

const PlanFieldsSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
    project_name: z.string().trim().min(1).max(200),
    initialize_only: z.literal(true),
    threads: z
      .array(MilestoneTaskSchema)
      .min(MIN_PROJECT_THREADS)
      .max(MAX_PROJECT_THREADS),
  })
  .strict();

export const PreviewProjectThreadsInputSchema = PlanFieldsSchema.extend({
  recreate_archived: z.boolean().default(false),
}).strict();

export const CreateProjectThreadsInputSchema = PlanFieldsSchema.extend({
  dry_run: z.boolean().default(true),
  confirmed: z.boolean().optional(),
  confirmation_token: z.string().trim().min(16).max(256).optional(),
  recreate_archived: z.boolean().default(false),
})
  .strict()
  .superRefine((value, context) => {
    if (
      value.dry_run === false &&
      value.confirmed !== true &&
      value.confirmation_token === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmed"],
        message:
          "a mutating create_project_threads call requires confirmed=true or the preview confirmation_token",
      });
    }
  });

export const InitializeProjectThreadsInputSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
    milestone_ids: z.array(MilestoneIdSchema).min(1).max(MAX_PROJECT_THREADS).optional(),
    dry_run: z.boolean().default(true),
    confirmed: z.boolean().default(false),
    confirmation_token: z.string().trim().min(16).max(256).optional(),
    retry_failed_initialization: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dry_run === false &&
      value.confirmed !== true &&
      value.confirmation_token === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmed"],
        message:
          "a mutating initialize_project_threads call requires confirmed=true or its preview confirmation_token",
      });
    }
  });

export const ListProjectThreadsInputSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
  })
  .strict();

export const ProjectCapsuleDoctorInputSchema = z.object({
  project_cwd: z.string().trim().min(1).max(2_048),
}).strict();

const MilestoneOperationSchema = z.object({
  canonical_cwd: z.string().trim().min(1).max(2048),
  milestone_id: MilestoneIdSchema,
  existing_thread_id: z.string().trim().min(1).max(256),
  user_intent: z.string().trim().min(1).max(4000),
}).strict();
export const PreviewMilestoneActivationInputSchema = MilestoneOperationSchema;
export const ActivateMilestoneInputSchema = MilestoneOperationSchema.extend({ confirmed: z.literal(true) }).strict();
export const StartProjectMilestoneInputSchema = MilestoneOperationSchema.extend({ confirmed: z.boolean().default(false) }).strict();
export const PreviewMilestoneCompletionInputSchema = MilestoneOperationSchema;
export const CompleteMilestoneInputSchema = MilestoneOperationSchema.extend({ outcome: z.enum(["ACCEPTED", "NEEDS_REWORK"]), confirmed: z.literal(true) }).strict();

export const PreviewProjectCapsuleRepairInputSchema = ProjectCapsuleDoctorInputSchema;

export const ApplyProjectCapsuleRepairInputSchema = ProjectCapsuleDoctorInputSchema.extend({
  confirmed: z.literal(true),
}).strict();

/** Read-only discovery and explicitly-confirmed upgrade for pre-manifest capsules. */
export const PreviewLegacyCapsuleMigrationInputSchema = ProjectCapsuleDoctorInputSchema;
export const ApplyLegacyCapsuleMigrationInputSchema = ProjectCapsuleDoctorInputSchema.extend({
  confirmed: z.literal(true),
}).strict();

/** Canonical structured source used for every generated capsule artifact. */
export const OrchestrateProjectCapsuleInputSchema = PlanFieldsSchema.extend({
  dry_run: z.boolean().default(true),
  confirmed: z.boolean().default(false),
}).strict();

export const SyncThreadRegistryInputSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
    project_name: z.string().trim().min(1).max(200).optional(),
    threads: z
      .array(MilestoneTaskSchema)
      .min(MIN_PROJECT_THREADS)
      .max(MAX_PROJECT_THREADS)
      .optional(),
    dry_run: z.boolean().default(true),
    recover_corrupt_registry: z.boolean().default(false),
    confirmed_recovery: z.boolean().default(false),
    confirmation_token: z.string().trim().min(16).max(256).optional(),
  })
  .strict();

export const PreviewOrphanThreadCleanupInputSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
    thread_ids: z
      .array(z.string().trim().min(1).max(256))
      .min(1)
      .max(MAX_PROJECT_THREADS),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.thread_ids).size !== value.thread_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["thread_ids"],
        message: "thread_ids must be unique",
      });
    }
  });

/**
 * Reserved for the future destructive half of the cleanup workflow. The
 * current MCP surface deliberately exposes preview only, but keeping the
 * confirmation contract executable makes the safety boundary testable now.
 */
export const CleanupOrphanThreadsInputSchema =
  PreviewOrphanThreadCleanupInputSchema.extend({
    confirmation_token: z.string().trim().min(16).max(256),
    confirmed: z.literal(true),
    expected_classification: z.literal("ORPHAN_METADATA_ONLY"),
    expected_preview_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
    .strict()
    .superRefine((value, context) => {
      if (value.thread_ids.length !== 3) {
        context.addIssue({
          code: "custom",
          path: ["thread_ids"],
          message:
            "orphan cleanup only accepts the exact three reviewed metadata-only thread IDs",
        });
      }
    });

export const ArchiveProjectThreadsInputSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
    milestone_ids: z.array(MilestoneIdSchema).min(1).max(MAX_PROJECT_THREADS),
    dry_run: z.boolean().default(true),
    confirmed: z.boolean().default(false),
    confirmation_token: z.string().trim().min(16).max(256).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dry_run === false &&
      value.confirmed !== true &&
      value.confirmation_token === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmed"],
        message:
          "a mutating archive_project_threads call requires confirmed=true or its preview confirmation_token",
      });
    }
  });

export const SmokeThreadPlanSchema = z
  .object({
    project_cwd: z.string().trim().min(1).max(2_048),
    project_name: z.literal("Project Thread Orchestrator Smoke Test"),
    initialize_only: z.literal(true),
    threads: z.tuple([
      MilestoneTaskSchema.safeExtend({
        milestone_id: z.literal("M0"),
        name: z.literal("测试信息确认"),
        sandbox_mode: z.literal("read-only"),
      }).strict(),
      MilestoneTaskSchema.safeExtend({
        milestone_id: z.literal("M1"),
        name: z.literal("测试构建基线"),
        sandbox_mode: z.literal("read-only"),
      }).strict(),
    ]),
    smoke_guard: z.literal("REAL_APP_SERVER_TWO_THREAD_SMOKE"),
  })
  .strict();

export const ManualSmokeCliSchema = z
  .object({
    action: z
      .enum([
        "preview",
        "create",
        "verify",
        "idempotency",
        "archive-preview",
        "archive",
      ])
      .default("preview"),
    project_cwd: z.string().trim().min(1),
    codex_command: z.string().trim().min(1).optional(),
    retry_after_no_side_effect: z
      .enum(["yes", "no"])
      .default("no"),
    expected_m0_thread_id: z.string().trim().min(1).optional(),
    expected_m1_thread_id: z.string().trim().min(1).optional(),
    confirm_phrase: z.string().optional(),
    desktop_visible: z.enum(["yes", "no", "unknown"]).default("unknown"),
    same_project: z.enum(["yes", "no", "unknown"]).default("unknown"),
  })
  .strict();

export type MilestoneTask = z.infer<typeof MilestoneTaskSchema>;
export type PreviewProjectThreadsInput = z.infer<
  typeof PreviewProjectThreadsInputSchema
>;
export type CreateProjectThreadsInput = z.infer<
  typeof CreateProjectThreadsInputSchema
>;
export type InitializeProjectThreadsInput = z.infer<
  typeof InitializeProjectThreadsInputSchema
>;
export type OrchestrateProjectCapsuleInput = z.infer<typeof OrchestrateProjectCapsuleInputSchema>;
export type SyncThreadRegistryInput = z.infer<
  typeof SyncThreadRegistryInputSchema
>;
export type PreviewOrphanThreadCleanupInput = z.infer<
  typeof PreviewOrphanThreadCleanupInputSchema
>;
export type CleanupOrphanThreadsInput = z.infer<
  typeof CleanupOrphanThreadsInputSchema
>;
export type ArchiveProjectThreadsInput = z.infer<
  typeof ArchiveProjectThreadsInputSchema
>;
export type SmokeThreadPlan = z.infer<typeof SmokeThreadPlanSchema>;
export type ManualSmokeCliOptions = z.infer<typeof ManualSmokeCliSchema>;
export type PreviewMilestoneActivationInput = z.infer<typeof PreviewMilestoneActivationInputSchema>;
export type ActivateMilestoneInput = z.infer<typeof ActivateMilestoneInputSchema>;
export type StartProjectMilestoneInput = z.infer<typeof StartProjectMilestoneInputSchema>;
export type CompleteMilestoneInput = z.infer<typeof CompleteMilestoneInputSchema>;

export interface ValidatedProjectPlan {
  project_cwd: string;
  project_name: string;
  initialize_only: true;
  threads: MilestoneTask[];
  plan_digest: string;
}

export interface ThreadStatus {
  type: string;
  activeFlags?: string[] | undefined;
}

export interface AppThread {
  id: string;
  name?: string | null | undefined;
  cwd?: string | null | undefined;
  preview?: string | undefined;
  ephemeral?: boolean | undefined;
  createdAt?: number | undefined;
  updatedAt?: number | undefined;
  sourceKind?: string | undefined;
  parentThreadId?: string | null | undefined;
  status?: ThreadStatus | undefined;
  turns?: AppTurn[] | undefined;
}

export interface AppTurn {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed" | string;
  items?: AppThreadItem[] | undefined;
  error?: {
    message: string;
    codexErrorInfo?: unknown;
    additionalDetails?: unknown;
  } | null | undefined;
}

export interface AppThreadItem {
  id?: string | undefined;
  type: string;
  text?: string | undefined;
  content?:
    | Array<{
        type?: string | undefined;
        text?: string | undefined;
        [key: string]: unknown;
      }>
    | undefined;
  [key: string]: unknown;
}

export interface AppThreadListPage {
  data: AppThread[];
  nextCursor: string | null;
}

export interface LoadedThreadListPage {
  data: string[];
  nextCursor: string | null;
}

export interface ThreadStartParams {
  cwd: string;
  approvalPolicy: "never";
  sandbox: "read-only";
  ephemeral: false;
  serviceName: string;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{
    type: "text";
    text: string;
    text_elements: [];
  }>;
  cwd: string;
  approvalPolicy: "never" | "on-request";
  sandboxPolicy: {
    type: "readOnly" | "workspaceWrite";
    networkAccess: false;
    writableRoots?: string[];
  };
  outputSchema?: Record<string, unknown> | undefined;
}

export interface CodexAppServerPort {
  startThread(params: ThreadStartParams): Promise<AppThread>;
  waitForThreadStarted(threadId: string, timeoutMs?: number): Promise<AppThread>;
  resumeThread(threadId: string): Promise<AppThread>;
  listLoadedThreadIds(params?: {
    cursor?: string | null;
    limit?: number;
  }): Promise<LoadedThreadListPage>;
  setThreadName(threadId: string, name: string): Promise<void>;
  setThreadGoal(threadId: string, objective: string): Promise<void>;
  startTurn(params: TurnStartParams): Promise<AppTurn>;
  waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs?: number,
  ): Promise<AppTurn>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  readThread(threadId: string, includeTurns: boolean): Promise<AppThread>;
  listThreads(params: {
    cwd: string;
    archived: boolean;
    cursor?: string | null;
    limit?: number;
  }): Promise<AppThreadListPage>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  close(): Promise<void>;
}

export interface FieldDiff {
  path: string;
  previous: unknown;
  proposed: unknown;
}

export type PreviewAction =
  | "create"
  | "reuse"
  | "resume-initialization"
  | "retry-create"
  | "plan-changed"
  | "recreate-archived"
  | "ambiguous-reservation";

export interface MilestonePreview {
  milestone_id: string;
  expected_name: string;
  action: PreviewAction;
  thread_id: string | null;
  differences: FieldDiff[];
  reason?: string;
}
