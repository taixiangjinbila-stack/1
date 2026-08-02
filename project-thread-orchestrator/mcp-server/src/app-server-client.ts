import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import { z } from "zod";

import {
  extractAppServerSpawnError,
  launchAppServerProcess,
  type AppServerLaunchDiagnostic,
  type AppServerSpawnErrorDetails,
  type LaunchAppServerProcessOptions,
} from "./app-server-launcher.js";
import type {
  AppThread,
  AppThreadItem,
  AppThreadListPage,
  AppTurn,
  CodexAppServerPort,
  LoadedThreadListPage,
  ThreadStartParams,
  ThreadStatus,
  TurnStartParams,
} from "./types.js";
import { PLUGIN_VERSION } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_STDERR_TAIL_LENGTH = 8_192;
const MAX_COMPLETED_TURNS = 256;
const MAX_JSONL_LINE_LENGTH = 8 * 1_024 * 1_024;

const NonEmptyStringSchema = z.string().trim().min(1);
const RpcIdSchema = z.union([z.number().int(), z.string()]);

const ThreadStartParamsSchema = z
  .object({
    cwd: NonEmptyStringSchema,
    approvalPolicy: z.literal("never"),
    sandbox: z.literal("read-only"),
    ephemeral: z.literal(false),
    serviceName: NonEmptyStringSchema,
  })
  .strict();

const TurnStartParamsSchema = z
  .object({
    threadId: NonEmptyStringSchema,
    input: z
      .array(
        z
          .object({
            type: z.literal("text"),
            text: z.string().min(1),
            text_elements: z.tuple([]),
          })
          .strict(),
      )
      .min(1),
    cwd: NonEmptyStringSchema,
    approvalPolicy: z.enum(["never", "on-request"]),
    sandboxPolicy: z
      .object({
        type: z.enum(["readOnly", "workspaceWrite"]),
        networkAccess: z.literal(false),
        writableRoots: z.array(NonEmptyStringSchema).max(64).optional(),
      })
      .strict(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const AppThreadItemSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    text: z.string().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string().optional(),
            text: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const AppTurnSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    items: z.array(AppThreadItemSchema).optional(),
    error: z
      .object({
        message: z.string(),
        codexErrorInfo: z.unknown().optional(),
        additionalDetails: z.unknown().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const ThreadStatusSchema = z
  .object({
    type: z.string(),
    activeFlags: z.array(z.string()).optional(),
  })
  .passthrough();

const AppThreadSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    preview: z.string().optional(),
    ephemeral: z.boolean().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    source: z.unknown().optional(),
    sourceKind: z.string().optional(),
    parentThreadId: z.string().nullable().optional(),
    status: ThreadStatusSchema.optional(),
    turns: z.array(AppTurnSchema).optional(),
  })
  .passthrough();

const ThreadResponseSchema = z
  .object({
    thread: AppThreadSchema,
  })
  .passthrough();

const TurnResponseSchema = z
  .object({
    turn: AppTurnSchema,
  })
  .passthrough();

const ThreadListResponseSchema = z
  .object({
    data: z.array(AppThreadSchema),
    nextCursor: z.string().nullable(),
  })
  .passthrough();

const ThreadLoadedListResponseSchema = z
  .object({
    data: z.array(z.string()),
    nextCursor: z.string().nullable(),
  })
  .passthrough();

const GoalResponseSchema = z
  .object({
    goal: z
      .object({
        status: z.literal("paused"),
      })
      .passthrough(),
  })
  .passthrough();

const EmptyResponseSchema = z.object({}).passthrough();
const InitializeResponseSchema = z
  .object({
    userAgent: z.string(),
    codexHome: z.string(),
    platformFamily: z.string(),
    platformOs: z.string(),
  })
  .passthrough();

type RpcId = z.infer<typeof RpcIdSchema>;
type ParsedThread = z.infer<typeof AppThreadSchema>;
type ParsedTurn = z.infer<typeof AppTurnSchema>;
type ParsedThreadItem = z.infer<typeof AppThreadItemSchema>;
type ParsedThreadStatus = z.infer<typeof ThreadStatusSchema>;

interface PendingRequest {
  readonly method: string;
  readonly threadId: string | null;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface TurnWaiter {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (turn: AppTurn) => void;
  readonly reject: (reason: Error) => void;
}

interface ThreadStartedWaiter {
  readonly timer: NodeJS.Timeout;
  readonly resolve: (thread: AppThread) => void;
  readonly reject: (reason: Error) => void;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface CorrelatedTurn {
  readonly threadId: string;
  readonly turnId: string;
}

export interface CodexAppServerClientOptions {
  /**
   * Executable used to launch the App Server. Tests can point this at a mock
   * Node.js process; production defaults to the `codex` executable on PATH.
   */
  readonly command?: string;
  /**
   * Arguments passed to the executable. The default explicitly selects the
   * public stdio transport.
   */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Time allowed for the initial `initialize` / `initialized` handshake.
   * A timeout here occurs before any thread RPC and is safe to retry.
   */
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly turnTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly clientInfo?: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
  /** Internal test seam; MCP inputs never control the launched process. */
  readonly spawnProcess?: LaunchAppServerProcessOptions["spawnProcess"];
}

export interface AppServerRpcTraceEntry {
  readonly sequence: number;
  readonly timestamp: string;
  readonly direction: "process" | "request" | "response" | "notification";
  readonly requestId: string | number | null;
  readonly method: string;
  readonly threadId: string | null;
  readonly result: Record<string, unknown> | null;
  readonly processId: number | null;
  readonly connectionId: string;
}

export interface AppServerRuntimeDiagnostic {
  readonly processId: number | null;
  readonly connectionId: string;
  readonly closed: boolean;
  readonly stderr: string;
  readonly rpc: readonly AppServerRpcTraceEntry[];
}

export class AppServerRpcError extends Error {
  public readonly ambiguous = false;
  public readonly method: string;
  public readonly code: number;
  public readonly data: unknown;

  public constructor(
    method: string,
    code: number,
    message: string,
    data: unknown = undefined,
  ) {
    super(`Codex App Server ${method} failed (${code}): ${message}`);
    this.name = "AppServerRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export class AppServerTimeoutError extends Error {
  public readonly ambiguous = true;
  public readonly operation: string;
  public readonly timeoutMs: number;

  public constructor(operation: string, timeoutMs: number) {
    super(`Codex App Server ${operation} timed out after ${timeoutMs} ms`);
    this.name = "AppServerTimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The App Server did not complete its initial handshake. Because no thread
 * request was sent, this is deliberately non-ambiguous and may be retried.
 */
export class AppServerStartupTimeoutError extends Error {
  public readonly ambiguous = false;
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super(
      `Codex App Server initialize handshake timed out after ${timeoutMs} ms`,
    );
    this.name = "AppServerStartupTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class AppServerProcessError extends Error {
  public readonly ambiguous: boolean;
  public readonly code: number | null;
  public readonly signal: NodeJS.Signals | null;
  public readonly causeError: Error | null;
  public readonly launchDiagnostic: AppServerLaunchDiagnostic | null;
  public readonly spawnDetails: AppServerSpawnErrorDetails | null;

  public constructor(
    message: string,
    options: {
      readonly code?: number | null;
      readonly signal?: NodeJS.Signals | null;
      readonly stderrTail?: string;
      readonly cause?: Error;
      readonly ambiguous?: boolean;
      readonly launchDiagnostic?: AppServerLaunchDiagnostic;
      readonly spawnDetails?: AppServerSpawnErrorDetails;
    } = {},
  ) {
    const stderrSuffix =
      options.stderrTail === undefined || options.stderrTail.length === 0
        ? ""
        : `\nApp Server stderr (tail):\n${options.stderrTail}`;
    super(`${message}${stderrSuffix}`);
    this.name = "AppServerProcessError";
    this.ambiguous = options.ambiguous ?? true;
    this.code = options.code ?? null;
    this.signal = options.signal ?? null;
    this.causeError = options.cause ?? null;
    this.launchDiagnostic = options.launchDiagnostic ?? null;
    this.spawnDetails =
      options.spawnDetails ??
      (options.cause === undefined
        ? null
        : extractAppServerSpawnError(options.cause));
  }
}

export class AppServerProtocolError extends Error {
  public readonly ambiguous = true;
  public readonly payload: unknown;
  public readonly causeError: Error | null;

  public constructor(
    message: string,
    options: { readonly payload?: unknown; readonly cause?: Error } = {},
  ) {
    super(message);
    this.name = "AppServerProtocolError";
    this.payload = options.payload;
    this.causeError = options.cause ?? null;
  }
}

export class AppServerClosedError extends Error {
  public readonly ambiguous = false;
  public constructor(message = "Codex App Server client is closed") {
    super(message);
    this.name = "AppServerClosedError";
  }
}

/**
 * Strict JSONL client for the public `codex app-server` stdio protocol.
 *
 * The client deliberately advertises no experimental capabilities and never
 * grants an approval. Any server-initiated interaction associated with a turn
 * receives a negative/empty response and is followed by `turn/interrupt`.
 */
export class CodexAppServerClient implements CodexAppServerPort {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutReader: ReadlineInterface;
  private readonly requestTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly clientInfo: {
    readonly name: string;
    readonly title: string;
    readonly version: string;
  };
  private readonly pendingRequests = new Map<RpcId, PendingRequest>();
  private readonly turnWaiters = new Map<string, Set<TurnWaiter>>();
  private readonly threadStartedWaiters = new Map<
    string,
    Set<ThreadStartedWaiter>
  >();
  private readonly startedThreads = new Map<string, AppThread>();
  private readonly completedTurns = new Map<string, AppTurn>();
  private readonly turnThreads = new Map<string, string>();
  private readonly exitPromise: Promise<ProcessExit>;
  private readonly readyPromise: Promise<void>;
  private initializeInfo: z.infer<typeof InitializeResponseSchema> | null =
    null;
  private resolveExit!: (exit: ProcessExit) => void;
  private nextRequestId = 1;
  private stderrTail = "";
  private fatalError: Error | null = null;
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly launchDiagnostic: AppServerLaunchDiagnostic;
  private initialized = false;
  private readonly connectionId = randomUUID();
  private readonly rpcTrace: AppServerRpcTraceEntry[] = [];
  private traceSequence = 0;

  public constructor(options: CodexAppServerClientOptions = {}) {
    this.requestTimeoutMs = positiveTimeout(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.startupTimeoutMs = positiveTimeout(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
      "startupTimeoutMs",
    );
    this.turnTimeoutMs = positiveTimeout(
      options.turnTimeoutMs,
      DEFAULT_TURN_TIMEOUT_MS,
      "turnTimeoutMs",
    );
    this.closeTimeoutMs = positiveTimeout(
      options.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
      "closeTimeoutMs",
    );
    this.clientInfo = options.clientInfo ?? {
      name: "project-thread-orchestrator",
      title: "Project Thread Orchestrator",
      version: PLUGIN_VERSION,
    };

    const environment =
      options.env === undefined
        ? process.env
        : { ...process.env, ...options.env };
    const launchOptions: LaunchAppServerProcessOptions = {
      env: environment,
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.spawnProcess === undefined
        ? {}
        : { spawnProcess: options.spawnProcess }),
    };
    const launched = launchAppServerProcess(launchOptions);
    this.child = launched.child;
    this.launchDiagnostic = launched.diagnostic;
    this.recordTrace("process", null, "process/start", null, {
      spawnCommand: launched.diagnostic.spawnCommand,
      spawnArgs: [...launched.diagnostic.spawnArgs],
    });

    this.exitPromise = new Promise<ProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });

    this.stdoutReader = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    this.stdoutReader.on("line", (line) => {
      this.handleLine(line);
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.appendStderr(chunk);
    });
    this.child.stdin.on("error", (error: Error) => {
      if (!this.closing) {
        this.fail(
          new AppServerProcessError(
            `Failed writing to Codex App Server: ${error.message}`,
            {
              cause: error,
              stderrTail: this.stderrTail,
              launchDiagnostic: this.launchDiagnostic,
              ambiguous: this.initialized,
            },
          ),
          true,
        );
      }
    });
    this.child.stdout.on("error", (error: Error) => {
      if (!this.closing) {
        this.fail(
          new AppServerProcessError(
            `Failed reading from Codex App Server: ${error.message}`,
            {
              cause: error,
              stderrTail: this.stderrTail,
              launchDiagnostic: this.launchDiagnostic,
              ambiguous: this.initialized,
            },
          ),
          true,
        );
      }
    });
    this.child.once("error", (error) => {
      this.fail(
        new AppServerProcessError(
          `Could not start Codex App Server: ${error.message}`,
          {
            cause: error,
            stderrTail: this.stderrTail,
            launchDiagnostic: this.launchDiagnostic,
            ambiguous: false,
          },
        ),
        false,
      );
    });
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.recordTrace("process", null, "process/exit", null, {
        code,
        signal,
      });
      this.resolveExit({ code, signal });
      if (!this.closing) {
        this.fail(
          new AppServerProcessError("Codex App Server exited unexpectedly", {
            code,
            signal,
            stderrTail: this.stderrTail,
            launchDiagnostic: this.launchDiagnostic,
            ambiguous: this.initialized,
          }),
          false,
        );
      }
    });

    this.readyPromise = this.initialize().catch((error: unknown) => {
      const failure = toError(error);
      this.fail(failure, true);
      throw failure;
    });
    // A constructor cannot be awaited. Attach a handler immediately so a fast
    // spawn/handshake failure is never reported as an unhandled rejection.
    void this.readyPromise.catch(() => undefined);
  }

  public async startThread(params: ThreadStartParams): Promise<AppThread> {
    await this.ensureReady();
    const parsed = parseInput(
      ThreadStartParamsSchema,
      params,
      "thread/start params",
    );

    let response: z.infer<typeof ThreadResponseSchema>;
    try {
      response = await this.requestValidated(
        "thread/start",
        parsed,
        ThreadResponseSchema,
      );
    } catch (error) {
      if (!isSandboxEnumRejection(error)) {
        throw error;
      }

      // `readOnly` is the sole compatibility fallback. It is attempted once,
      // and only when the modern enum was explicitly rejected as invalid
      // parameters. No other RPC failure is retried.
      response = await this.requestValidated(
        "thread/start",
        {
          ...parsed,
          sandbox: "readOnly",
        },
        ThreadResponseSchema,
      );
    }

    return mapThread(response.thread);
  }

  public async waitForThreadStarted(
    threadId: string,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<AppThread> {
    await this.ensureReady();
    const parsedThreadId = parseNonEmptyString(threadId, "threadId");
    const cached = this.startedThreads.get(parsedThreadId);
    if (cached !== undefined) {
      return structuredClone(cached);
    }
    const parsedTimeout = positiveTimeout(
      timeoutMs,
      this.requestTimeoutMs,
      "thread/started timeout",
    );
    return await new Promise<AppThread>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this.threadStartedWaiters.get(parsedThreadId);
        if (waiters !== undefined) {
          waiters.delete(waiter);
          if (waiters.size === 0) {
            this.threadStartedWaiters.delete(parsedThreadId);
          }
        }
        reject(new AppServerTimeoutError("thread/started", parsedTimeout));
      }, parsedTimeout);
      const waiter: ThreadStartedWaiter = { timer, resolve, reject };
      const waiters = this.threadStartedWaiters.get(parsedThreadId) ?? new Set();
      waiters.add(waiter);
      this.threadStartedWaiters.set(parsedThreadId, waiters);
    });
  }

  public async resumeThread(threadId: string): Promise<AppThread> {
    await this.ensureReady();
    const response = await this.requestValidated(
      "thread/resume",
      { threadId: parseNonEmptyString(threadId, "threadId") },
      ThreadResponseSchema,
    );
    return mapThread(response.thread);
  }

  public async listLoadedThreadIds(
    params: {
      cursor?: string | null;
      limit?: number;
    } = {},
  ): Promise<LoadedThreadListPage> {
    await this.ensureReady();
    const parsed = z
      .object({
        cursor: z.string().nullable().optional(),
        limit: z.number().int().positive().max(1_000).optional(),
      })
      .strict()
      .parse(params);
    const response = await this.requestValidated(
      "thread/loaded/list",
      parsed,
      ThreadLoadedListResponseSchema,
    );
    return {
      data: [...response.data],
      nextCursor: response.nextCursor,
    };
  }

  public async setThreadName(threadId: string, name: string): Promise<void> {
    await this.ensureReady();
    await this.requestValidated(
      "thread/name/set",
      {
        threadId: parseNonEmptyString(threadId, "threadId"),
        name: parseNonEmptyString(name, "name"),
      },
      EmptyResponseSchema,
    );
  }

  public async setThreadGoal(
    threadId: string,
    objective: string,
  ): Promise<void> {
    await this.ensureReady();
    const parsedObjective = z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .parse(objective);
    await this.requestValidated(
      "thread/goal/set",
      {
        threadId: parseNonEmptyString(threadId, "threadId"),
        objective: parsedObjective,
        // A paused stable goal records the long-term objective without causing
        // the App Server to continue autonomously.
        status: "paused",
      },
      GoalResponseSchema,
    );
  }

  public async startTurn(params: TurnStartParams): Promise<AppTurn> {
    await this.ensureReady();
    const parsed = parseInput(
      TurnStartParamsSchema,
      params,
      "turn/start params",
    );
    const common = {
      threadId: parsed.threadId,
      input: parsed.input,
      cwd: parsed.cwd,
      approvalPolicy: "never" as const,
      ...(parsed.outputSchema === undefined
        ? {}
        : { outputSchema: parsed.outputSchema }),
    };
    let response: z.infer<typeof TurnResponseSchema>;
    try {
      response = await this.requestValidated(
        "turn/start",
        {
          ...common,
          sandboxPolicy: parsed.sandboxPolicy,
        },
        TurnResponseSchema,
      );
    } catch (error) {
      if (!isSandboxEnumRejection(error)) {
        throw error;
      }
      // Invalid-params responses have no turn side effect. A narrowly scoped
      // legacy fallback retains the older restricted-read extension while
      // remaining read-only and network-disabled.
      response = await this.requestValidated(
        "turn/start",
        {
          ...common,
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
            access: {
              type: "restricted",
              includePlatformDefaults: true,
              readableRoots: [parsed.cwd],
            },
          },
        },
        TurnResponseSchema,
      );
    }
    const turn = mapTurn(response.turn);
    this.turnThreads.set(turn.id, parsed.threadId);
    if (isTerminalTurn(turn)) {
      this.recordCompletedTurn(parsed.threadId, turn);
    }
    return turn;
  }

  public async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs = this.turnTimeoutMs,
  ): Promise<AppTurn> {
    await this.ensureReady();
    const parsedThreadId = parseNonEmptyString(threadId, "threadId");
    const parsedTurnId = parseNonEmptyString(turnId, "turnId");
    const parsedTimeout = positiveTimeout(
      timeoutMs,
      this.turnTimeoutMs,
      "timeoutMs",
    );
    const key = turnKey(parsedThreadId, parsedTurnId);
    const completed =
      this.completedTurns.get(key) ??
      this.completedTurns.get(wildcardTurnKey(parsedTurnId));
    if (completed !== undefined) {
      return completed;
    }

    this.turnThreads.set(parsedTurnId, parsedThreadId);
    return await new Promise<AppTurn>((resolve, reject) => {
      const waiter: TurnWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeTurnWaiter(key, waiter);
          void this.interruptTurn(parsedThreadId, parsedTurnId).catch(
            () => undefined,
          );
          reject(
            new AppServerTimeoutError(
              `turn ${parsedTurnId} completion`,
              parsedTimeout,
            ),
          );
        }, parsedTimeout),
      };
      const waiters = this.turnWaiters.get(key) ?? new Set<TurnWaiter>();
      waiters.add(waiter);
      this.turnWaiters.set(key, waiters);

      // Close the small race between the pre-registration lookup and waiter
      // insertion if the completion notification arrived synchronously.
      const racedCompletion =
        this.completedTurns.get(key) ??
        this.completedTurns.get(wildcardTurnKey(parsedTurnId));
      if (racedCompletion !== undefined) {
        this.resolveTurnWaiters(key, racedCompletion);
      }
    });
  }

  public async interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    await this.ensureReady();
    await this.interruptTurnRaw(
      parseNonEmptyString(threadId, "threadId"),
      parseNonEmptyString(turnId, "turnId"),
    );
  }

  public async readThread(
    threadId: string,
    includeTurns: boolean,
  ): Promise<AppThread> {
    await this.ensureReady();
    const response = await this.requestValidated(
      "thread/read",
      {
        threadId: parseNonEmptyString(threadId, "threadId"),
        includeTurns: z.boolean().parse(includeTurns),
      },
      ThreadResponseSchema,
    );
    return mapThread(response.thread);
  }

  public async listThreads(params: {
    cwd: string;
    archived: boolean;
    cursor?: string | null;
    limit?: number;
  }): Promise<AppThreadListPage> {
    await this.ensureReady();
    const parsed = z
      .object({
        cwd: NonEmptyStringSchema,
        archived: z.boolean(),
        cursor: z.string().nullable().optional(),
        limit: z.number().int().positive().max(1_000).optional(),
      })
      .strict()
      .parse(params);
    const wireParams: {
      cwd: string;
      archived: boolean;
      sourceKinds: ["cli", "vscode", "appServer"];
      cursor?: string | null;
      limit?: number;
    } = {
      cwd: parsed.cwd,
      archived: parsed.archived,
      sourceKinds: ["cli", "vscode", "appServer"],
    };
    if (parsed.cursor !== undefined) {
      wireParams.cursor = parsed.cursor;
    }
    if (parsed.limit !== undefined) {
      wireParams.limit = parsed.limit;
    }

    const response = await this.requestValidated(
      "thread/list",
      wireParams,
      ThreadListResponseSchema,
    );
    return {
      data: response.data.map(mapThread),
      nextCursor: response.nextCursor,
    };
  }

  public async archiveThread(threadId: string): Promise<void> {
    await this.ensureReady();
    await this.requestValidated(
      "thread/archive",
      { threadId: parseNonEmptyString(threadId, "threadId") },
      EmptyResponseSchema,
    );
  }

  public async deleteThread(threadId: string): Promise<void> {
    await this.ensureReady();
    await this.requestValidated(
      "thread/delete",
      { threadId: parseNonEmptyString(threadId, "threadId") },
      EmptyResponseSchema,
    );
  }

  public async getInitializeInfo(): Promise<{
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
  }> {
    await this.ensureReady();
    if (this.initializeInfo === null) {
      throw new AppServerProtocolError(
        "Codex App Server initialize response was not retained",
      );
    }
    return { ...this.initializeInfo };
  }

  public getRuntimeDiagnostic(): AppServerRuntimeDiagnostic {
    return {
      processId: this.child.pid ?? null,
      connectionId: this.connectionId,
      closed: this.closed,
      stderr: this.stderrTail,
      rpc: this.rpcTrace.map((entry) => ({
        ...entry,
        result: entry.result === null ? null : structuredClone(entry.result),
      })),
    };
  }

  public async close(): Promise<void> {
    if (this.closePromise !== null) {
      return await this.closePromise;
    }
    this.closePromise = this.closeInternal();
    return await this.closePromise;
  }

  private async initialize(): Promise<void> {
    try {
      this.initializeInfo = await this.requestValidated(
        "initialize",
        {
          clientInfo: this.clientInfo,
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
            optOutNotificationMethods: [],
          },
        },
        InitializeResponseSchema,
        this.startupTimeoutMs,
      );
    } catch (error) {
      if (error instanceof AppServerTimeoutError) {
        throw new AppServerStartupTimeoutError(this.startupTimeoutMs);
      }
      throw error;
    }
    this.sendMessage({ method: "initialized" });
    this.recordTrace(
      "notification",
      null,
      "initialized",
      null,
      { sent: true },
    );
    this.initialized = true;
  }

  private async ensureReady(): Promise<void> {
    if (this.closing || this.closed) {
      throw this.fatalError ?? new AppServerClosedError();
    }
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
    await this.readyPromise;
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
  }

  private async requestValidated<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    const result = await this.requestRaw(method, params, timeoutMs);
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      throw new AppServerProtocolError(
        `Codex App Server returned an invalid ${method} result: ${z.prettifyError(
          parsed.error,
        )}`,
        { payload: result, cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private async requestRaw(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.closing || this.closed) {
      throw this.fatalError ?? new AppServerClosedError();
    }
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
    const parsedTimeout = positiveTimeout(
      timeoutMs,
      this.requestTimeoutMs,
      `${method} timeout`,
    );
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const threadId = readTraceThreadId(params);
    this.recordTrace("request", id, method, threadId, summarizeRpcPayload(params));

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending === undefined) {
          return;
        }
        this.pendingRequests.delete(id);
        reject(new AppServerTimeoutError(method, parsedTimeout));
      }, parsedTimeout);
      this.pendingRequests.set(id, {
        method,
        threadId,
        timer,
        resolve,
        reject,
      });

      try {
        this.sendMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(toError(error));
      }
    });
  }

  private async interruptTurnRaw(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    await this.requestValidated(
      "turn/interrupt",
      { threadId, turnId },
      EmptyResponseSchema,
    );
  }

  private sendMessage(message: Record<string, unknown>): void {
    if (this.closing || this.closed || this.child.stdin.destroyed) {
      throw this.fatalError ?? new AppServerClosedError();
    }
    const line = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(line, "utf8", (error) => {
      if (error !== null && error !== undefined && !this.closing) {
        this.fail(
          new AppServerProcessError(
            `Failed writing to Codex App Server: ${error.message}`,
            {
              cause: error,
              stderrTail: this.stderrTail,
              launchDiagnostic: this.launchDiagnostic,
              ambiguous: this.initialized,
            },
          ),
          true,
        );
      }
    });
  }

  private handleLine(line: string): void {
    if (line.length > MAX_JSONL_LINE_LENGTH) {
      this.fail(
        new AppServerProtocolError(
          `Codex App Server emitted a JSONL line longer than ${MAX_JSONL_LINE_LENGTH} characters`,
        ),
        true,
      );
      return;
    }
    if (line.trim().length === 0 || this.closing) {
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch (error) {
      this.fail(
        new AppServerProtocolError(
          "Codex App Server emitted a non-JSON stdout line",
          { payload: line, cause: toError(error) },
        ),
        true,
      );
      return;
    }

    if (!isRecord(message)) {
      this.fail(
        new AppServerProtocolError(
          "Codex App Server emitted a non-object JSONL message",
          { payload: message },
        ),
        true,
      );
      return;
    }

    if (typeof message.method === "string") {
      const idResult = RpcIdSchema.safeParse(message.id);
      if (idResult.success) {
        this.handleServerRequest(
          idResult.data,
          message.method,
          message.params,
        );
      } else {
        this.handleNotification(message.method, message.params);
      }
      return;
    }

    const idResult = RpcIdSchema.safeParse(message.id);
    if (!idResult.success) {
      this.fail(
        new AppServerProtocolError(
          "Codex App Server emitted a response without a valid id",
          { payload: message },
        ),
        true,
      );
      return;
    }
    this.handleResponse(idResult.data, message);
  }

  private handleResponse(
    id: RpcId,
    message: Record<string, unknown>,
  ): void {
    const pending = this.pendingRequests.get(id);
    // A response can legitimately arrive after its local timeout. It is safe to
    // ignore because request ids are never reused for this process.
    if (pending === undefined) {
      return;
    }
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);

    if (Object.prototype.hasOwnProperty.call(message, "error")) {
      if (!isRecord(message.error)) {
        pending.reject(
          new AppServerProtocolError(
            `Codex App Server returned a malformed ${pending.method} error`,
            { payload: message.error },
          ),
        );
        return;
      }
      const code = message.error.code;
      const rpcMessage = message.error.message;
      if (
        typeof code !== "number" ||
        !Number.isInteger(code) ||
        typeof rpcMessage !== "string"
      ) {
        pending.reject(
          new AppServerProtocolError(
            `Codex App Server returned a malformed ${pending.method} error`,
            { payload: message.error },
          ),
        );
        return;
      }
      pending.reject(
        new AppServerRpcError(
          pending.method,
          code,
          rpcMessage,
          message.error.data,
        ),
      );
      this.recordTrace(
        "response",
        id,
        pending.method,
        pending.threadId,
        {
          ok: false,
          code,
          message: rpcMessage,
        },
      );
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "result")) {
      pending.reject(
        new AppServerProtocolError(
          `Codex App Server returned ${pending.method} without result or error`,
          { payload: message },
        ),
      );
      return;
    }
    this.recordTrace(
      "response",
      id,
      pending.method,
      pending.threadId,
      { ok: true, ...summarizeRpcPayload(message.result) },
    );
    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown): void {
    this.recordTrace(
      "notification",
      null,
      method,
      readTraceThreadId(params),
      summarizeRpcPayload(params),
    );
    if (method === "thread/started") {
      const parsed = ThreadResponseSchema.safeParse(params);
      if (!parsed.success) {
        this.fail(
          new AppServerProtocolError(
            `Codex App Server emitted an invalid thread/started notification: ${z.prettifyError(parsed.error)}`,
            { payload: params, cause: parsed.error },
          ),
          true,
        );
        return;
      }
      const thread = mapThread(parsed.data.thread);
      this.startedThreads.set(thread.id, thread);
      const waiters = this.threadStartedWaiters.get(thread.id);
      if (waiters !== undefined) {
        this.threadStartedWaiters.delete(thread.id);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(structuredClone(thread));
        }
      }
      return;
    }

    if (method === "turn/started") {
      const parsed = z
        .object({
          threadId: z.string(),
          turn: AppTurnSchema,
        })
        .passthrough()
        .safeParse(params);
      if (parsed.success) {
        this.turnThreads.set(parsed.data.turn.id, parsed.data.threadId);
      }
      return;
    }

    if (method === "error") {
      const parsed = z
        .object({
          error: z
            .object({
              message: z.string(),
              codexErrorInfo: z.unknown().optional(),
              additionalDetails: z.unknown().optional(),
            })
            .passthrough(),
          willRetry: z.boolean(),
          threadId: z.string(),
          turnId: z.string(),
        })
        .passthrough()
        .safeParse(params);
      if (!parsed.success) {
        this.fail(
          new AppServerProtocolError(
            `Codex App Server emitted an invalid error notification: ${z.prettifyError(
              parsed.error,
            )}`,
            { payload: params, cause: parsed.error },
          ),
          true,
        );
        return;
      }
      if (!parsed.data.willRetry) {
        const terminalError: NonNullable<AppTurn["error"]> = {
          message: parsed.data.error.message,
        };
        if (parsed.data.error.codexErrorInfo !== undefined) {
          terminalError.codexErrorInfo =
            parsed.data.error.codexErrorInfo;
        }
        if (parsed.data.error.additionalDetails !== undefined) {
          terminalError.additionalDetails =
            parsed.data.error.additionalDetails;
        }
        this.recordCompletedTurn(parsed.data.threadId, {
          id: parsed.data.turnId,
          status: "failed",
          items: [],
          error: terminalError,
        });
      }
      return;
    }

    if (method !== "turn/completed") {
      return;
    }

    const parsed = z
      .object({
        threadId: z.string().optional(),
        turn: AppTurnSchema,
      })
      .passthrough()
      .safeParse(params);
    if (!parsed.success) {
      this.fail(
        new AppServerProtocolError(
          `Codex App Server emitted an invalid turn/completed notification: ${z.prettifyError(
            parsed.error,
          )}`,
          { payload: params, cause: parsed.error },
        ),
        true,
      );
      return;
    }

    const turn = mapTurn(parsed.data.turn);
    const threadId =
      parsed.data.threadId ?? this.turnThreads.get(parsed.data.turn.id);
    if (threadId === undefined) {
      this.recordCompletedTurnWithoutThread(turn);
      return;
    }
    this.recordCompletedTurn(threadId, turn);
  }

  private handleServerRequest(
    id: RpcId,
    method: string,
    params: unknown,
  ): void {
    const correlation = extractCorrelatedTurn(params);
    let result: unknown;
    let error: { readonly code: number; readonly message: string } | undefined;

    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "cancel" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn" };
        break;
      case "mcpServer/elicitation/request":
        result = { action: "cancel", content: null };
        break;
      case "item/tool/requestUserInput":
      case "tool/requestUserInput":
        result = { answers: {} };
        break;
      case "item/tool/call":
        error = {
          code: -32_000,
          message:
            "Dynamic tool calls are disabled by project-thread-orchestrator",
        };
        break;
      case "applyPatchApproval":
      case "execCommandApproval":
        // Legacy App Server approval methods use the same cancellation
        // vocabulary. They are retained only for safe backwards compatibility.
        result = { decision: "cancel" };
        break;
      default:
        error = {
          code: -32_601,
          message: `Unsupported App Server request: ${method}`,
        };
        break;
    }

    try {
      if (error === undefined) {
        this.sendMessage({ id, result });
      } else {
        this.sendMessage({ id, error });
      }
    } catch (sendError) {
      this.fail(toError(sendError), true);
      return;
    }

    if (correlation !== null) {
      void this.interruptTurnRaw(
        correlation.threadId,
        correlation.turnId,
      ).catch(() => undefined);
    }
  }

  private recordCompletedTurn(threadId: string, turn: AppTurn): void {
    const key = turnKey(threadId, turn.id);
    this.turnThreads.set(turn.id, threadId);
    this.cacheCompletedTurn(key, turn);
    this.resolveTurnWaiters(key, turn);
  }

  private recordCompletedTurnWithoutThread(turn: AppTurn): void {
    const key = wildcardTurnKey(turn.id);
    this.cacheCompletedTurn(key, turn);
    for (const waiterKey of this.turnWaiters.keys()) {
      if (waiterKey.endsWith(`\u0000${turn.id}`)) {
        this.resolveTurnWaiters(waiterKey, turn);
      }
    }
  }

  private cacheCompletedTurn(key: string, turn: AppTurn): void {
    this.completedTurns.delete(key);
    this.completedTurns.set(key, turn);
    while (this.completedTurns.size > MAX_COMPLETED_TURNS) {
      const oldestKey = this.completedTurns.keys().next().value;
      if (typeof oldestKey !== "string") {
        break;
      }
      this.completedTurns.delete(oldestKey);
    }
  }

  private resolveTurnWaiters(key: string, turn: AppTurn): void {
    const waiters = this.turnWaiters.get(key);
    if (waiters === undefined) {
      return;
    }
    this.turnWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(turn);
    }
  }

  private removeTurnWaiter(key: string, waiter: TurnWaiter): void {
    const waiters = this.turnWaiters.get(key);
    if (waiters === undefined) {
      return;
    }
    waiters.delete(waiter);
    if (waiters.size === 0) {
      this.turnWaiters.delete(key);
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`;
    if (this.stderrTail.length > MAX_STDERR_TAIL_LENGTH) {
      this.stderrTail = this.stderrTail.slice(-MAX_STDERR_TAIL_LENGTH);
    }
  }

  private recordTrace(
    direction: AppServerRpcTraceEntry["direction"],
    requestId: RpcId | null,
    method: string,
    threadId: string | null,
    result: Record<string, unknown> | null,
  ): void {
    this.traceSequence += 1;
    this.rpcTrace.push({
      sequence: this.traceSequence,
      timestamp: new Date().toISOString(),
      direction,
      requestId,
      method,
      threadId,
      result,
      processId: this.child.pid ?? null,
      connectionId: this.connectionId,
    });
    if (this.rpcTrace.length > 1_000) {
      this.rpcTrace.splice(0, this.rpcTrace.length - 1_000);
    }
  }

  private fail(error: Error, terminateProcess: boolean): void {
    if (this.fatalError === null) {
      this.fatalError = error;
    }
    this.rejectOutstanding(this.fatalError);
    if (
      terminateProcess &&
      !this.closing &&
      !this.closed &&
      this.child.exitCode === null
    ) {
      this.child.kill();
    }
  }

  private rejectOutstanding(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [key, waiters] of this.turnWaiters) {
      this.turnWaiters.delete(key);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    for (const [threadId, waiters] of this.threadStartedWaiters) {
      this.threadStartedWaiters.delete(threadId);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  }

  private async closeInternal(): Promise<void> {
    this.recordTrace("process", null, "process/close-requested", null, {
      normalCloseRequested: true,
    });
    this.closing = true;
    this.rejectOutstanding(new AppServerClosedError());
    this.stdoutReader.close();

    if (this.closed || this.child.exitCode !== null) {
      this.closed = true;
      return;
    }

    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
    const exitedBeforeDeadline = await Promise.race([
      this.exitPromise.then(() => true),
      delay(this.closeTimeoutMs).then(() => false),
    ]);
    if (!exitedBeforeDeadline && this.child.exitCode === null) {
      this.child.kill();
      await Promise.race([
        this.exitPromise.then(() => undefined),
        delay(Math.min(this.closeTimeoutMs, 500)),
      ]);
    }
    this.closed = true;
  }
}

export function createCodexAppServerClient(
  options: CodexAppServerClientOptions = {},
): CodexAppServerClient {
  return new CodexAppServerClient(options);
}

function isSandboxEnumRejection(
  error: unknown,
): error is AppServerRpcError {
  if (!(error instanceof AppServerRpcError) || error.code !== -32602) {
    return false;
  }
  const details = `${error.message}\n${JSON.stringify(error.data)}`.toLowerCase();
  return (
    details.includes("sandbox") ||
    details.includes("readonly") ||
    details.includes("read-only") ||
    details.includes("networkaccess") ||
    details.includes("readable") ||
    details.includes("access")
  );
}

function mapThread(parsed: ParsedThread): AppThread {
  const thread: AppThread = { id: parsed.id };
  if (parsed.name !== undefined) {
    thread.name = parsed.name;
  }
  if (parsed.cwd !== undefined) {
    thread.cwd = parsed.cwd;
  }
  if (parsed.preview !== undefined) {
    thread.preview = parsed.preview;
  }
  if (parsed.ephemeral !== undefined) {
    thread.ephemeral = parsed.ephemeral;
  }
  if (parsed.createdAt !== undefined) {
    thread.createdAt = parsed.createdAt;
  }
  if (parsed.updatedAt !== undefined) {
    thread.updatedAt = parsed.updatedAt;
  }
  if (typeof parsed.source === "string") {
    thread.sourceKind = parsed.source;
  } else if (parsed.sourceKind !== undefined) {
    thread.sourceKind = parsed.sourceKind;
  }
  if (parsed.parentThreadId !== undefined) {
    thread.parentThreadId = parsed.parentThreadId;
  }
  if (parsed.status !== undefined) {
    thread.status = mapThreadStatus(parsed.status);
  }
  if (parsed.turns !== undefined) {
    thread.turns = parsed.turns.map(mapTurn);
  }
  return thread;
}

function mapThreadStatus(parsed: ParsedThreadStatus): ThreadStatus {
  const status: ThreadStatus = { type: parsed.type };
  if (parsed.activeFlags !== undefined) {
    status.activeFlags = [...parsed.activeFlags];
  }
  return status;
}

function mapTurn(parsed: ParsedTurn): AppTurn {
  const turn: AppTurn = {
    id: parsed.id,
    status: parsed.status,
  };
  if (parsed.items !== undefined) {
    turn.items = parsed.items.map(mapThreadItem);
  }
  if (parsed.error === null) {
    turn.error = null;
  } else if (parsed.error !== undefined) {
    const mappedError: NonNullable<AppTurn["error"]> = {
      message: parsed.error.message,
    };
    if (parsed.error.codexErrorInfo !== undefined) {
      mappedError.codexErrorInfo = parsed.error.codexErrorInfo;
    }
    if (parsed.error.additionalDetails !== undefined) {
      mappedError.additionalDetails = parsed.error.additionalDetails;
    }
    turn.error = mappedError;
  }
  return turn;
}

function mapThreadItem(parsed: ParsedThreadItem): AppThreadItem {
  const item: AppThreadItem = {
    ...parsed,
    type: parsed.type,
  };
  if (parsed.id === undefined) {
    delete item.id;
  }
  if (parsed.text === undefined) {
    delete item.text;
  }
  if (parsed.content === undefined) {
    delete item.content;
  } else {
    item.content = parsed.content.map((part) => {
      const mapped: { type?: string; text?: string } = {};
      if (part.type !== undefined) {
        mapped.type = part.type;
      }
      if (part.text !== undefined) {
        mapped.text = part.text;
      }
      return mapped;
    });
  }
  return item;
}

function parseInput<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppServerProtocolError(
      `Invalid ${label}: ${z.prettifyError(parsed.error)}`,
      { payload: value, cause: parsed.error },
    );
  }
  return parsed.data;
}

function parseNonEmptyString(value: unknown, label: string): string {
  return parseInput(NonEmptyStringSchema, value, label);
}

function positiveTimeout(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate <= 0 ||
    candidate > 2_147_483_647
  ) {
    throw new RangeError(`${label} must be a positive 32-bit integer`);
  }
  return candidate;
}

function extractCorrelatedTurn(params: unknown): CorrelatedTurn | null {
  if (!isRecord(params)) {
    return null;
  }
  if (
    typeof params.threadId !== "string" ||
    params.threadId.length === 0 ||
    typeof params.turnId !== "string" ||
    params.turnId.length === 0
  ) {
    return null;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
  };
}

function isTerminalTurn(turn: AppTurn): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "interrupted" ||
    turn.status === "failed"
  );
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function wildcardTurnKey(turnId: string): string {
  return `*\u0000${turnId}`;
}

function readTraceThreadId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.threadId === "string") {
    return value.threadId;
  }
  if (isRecord(value.thread) && typeof value.thread.id === "string") {
    return value.thread.id;
  }
  return null;
}

function summarizeRpcPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const summary: Record<string, unknown> = {};
  if (typeof value.threadId === "string") {
    summary.threadId = value.threadId;
  }
  if (typeof value.includeTurns === "boolean") {
    summary.includeTurns = value.includeTurns;
  }
  if (isRecord(value.thread)) {
    const thread: Record<string, unknown> = {};
    for (const field of ["id", "name", "cwd"] as const) {
      if (
        typeof value.thread[field] === "string" ||
        value.thread[field] === null
      ) {
        thread[field] = value.thread[field];
      }
    }
    if (
      isRecord(value.thread.status) &&
      typeof value.thread.status.type === "string"
    ) {
      thread.status = { type: value.thread.status.type };
    }
    summary.thread = thread;
  }
  if (isRecord(value.turn)) {
    const turn: Record<string, unknown> = {};
    if (typeof value.turn.id === "string") {
      turn.id = value.turn.id;
    }
    if (typeof value.turn.status === "string") {
      turn.status = value.turn.status;
    }
    summary.turn = turn;
  }
  if (
    Array.isArray(value.data) &&
    value.data.every((item) => typeof item === "string")
  ) {
    summary.data = [...value.data];
  }
  if (typeof value.nextCursor === "string" || value.nextCursor === null) {
    summary.nextCursor = value.nextCursor;
  }
  if (typeof value.userAgent === "string") {
    summary.userAgent = value.userAgent;
  }
  return summary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function delay(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
