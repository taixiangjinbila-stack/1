import { AppServerRpcError, CodexAppServerClient } from "../mcp-server/src/app-server-client.js";
import type { AppThread } from "../mcp-server/src/types.js";
import {
  canonicalizeProjectCwd,
  formatUnknownError,
  pathsEqual,
} from "../mcp-server/src/plan-validator.js";

interface CliOptions {
  projectCwd: string;
  codexCommand: string;
  threadIds: string[];
}

type StoredClassification =
  | "STORED"
  | "MISSING_STORED_THREAD"
  | "RESUME_FAILED";

interface ThreadObservation {
  thread_id: string;
  classification: StoredClassification;
  read_status: string | null;
  resumed: boolean;
  loaded: boolean;
  name: string | null;
  cwd: string | null;
  error: string | null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectCwd = await canonicalizeProjectCwd(options.projectCwd);
  const client = new CodexAppServerClient({
    command: options.codexCommand,
    cwd: projectCwd,
    clientInfo: {
      name: "project-thread-orchestrator-read-resume-check",
      title: "Project Thread Orchestrator Read/Resume Check",
      version: "read-only-verification",
    },
  });
  const observations: ThreadObservation[] = [];
  let closeError: string | null = null;
  try {
    await client.getInitializeInfo();
    for (const threadId of options.threadIds) {
      observations.push(
        await inspectThread(client, threadId, projectCwd),
      );
    }
  } finally {
    try {
      await client.close();
    } catch (error) {
      closeError = formatUnknownError(error);
    }
  }

  const runtime = client.getRuntimeDiagnostic();
  const forbiddenMethods = runtime.rpc
    .filter(
      (entry) =>
        entry.direction === "request" &&
        ["thread/start", "turn/start"].includes(entry.method),
    )
    .map((entry) => entry.method);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: closeError === null && forbiddenMethods.length === 0,
        project_cwd: projectCwd,
        observations,
        app_server: {
          process_id: runtime.processId,
          connection_id: runtime.connectionId,
          closed: runtime.closed,
          stderr: runtime.stderr,
          close_error: closeError,
        },
        forbidden_methods_observed: forbiddenMethods,
        rpc: runtime.rpc,
      },
      null,
      2,
    )}\n`,
  );
}

async function inspectThread(
  client: CodexAppServerClient,
  threadId: string,
  projectCwd: string,
): Promise<ThreadObservation> {
  let stored: AppThread | null = null;
  let readReportedNotLoaded = false;
  let readStatus: string | null = null;
  try {
    stored = await client.readThread(threadId, true);
    readStatus = stored.status?.type ?? null;
  } catch (error) {
    if (isThreadNotLoaded(error)) {
      readReportedNotLoaded = true;
      readStatus = "notLoaded";
    } else if (isThreadNotFound(error)) {
      return {
        thread_id: threadId,
        classification: "MISSING_STORED_THREAD",
        read_status: null,
        resumed: false,
        loaded: false,
        name: null,
        cwd: null,
        error: formatUnknownError(error),
      };
    } else {
      return {
        thread_id: threadId,
        classification: "RESUME_FAILED",
        read_status: null,
        resumed: false,
        loaded: false,
        name: null,
        cwd: null,
        error: formatUnknownError(error),
      };
    }
  }

  if (
    stored !== null &&
    (stored.id !== threadId ||
      !pathsEqual(stored.cwd ?? "", projectCwd))
  ) {
    return {
      thread_id: threadId,
      classification: "RESUME_FAILED",
      read_status: stored.status?.type ?? null,
      resumed: false,
      loaded: false,
      name: stored.name ?? null,
      cwd: stored.cwd ?? null,
      error: `thread/read identity or cwd mismatch: id=${stored.id}, cwd=${stored.cwd ?? "<missing>"}`,
    };
  }

  let resumed = false;
  let current = stored;
  if (readReportedNotLoaded || stored?.status?.type === "notLoaded") {
    try {
      current = await client.resumeThread(threadId);
      resumed = true;
    } catch (error) {
      return {
        thread_id: threadId,
        classification: "RESUME_FAILED",
        read_status: readStatus,
        resumed: false,
        loaded: false,
        name: stored?.name ?? null,
        cwd: stored?.cwd ?? null,
        error: formatUnknownError(error),
      };
    }
    if (
      current.id !== threadId ||
      !pathsEqual(current.cwd ?? "", projectCwd)
    ) {
      return {
        thread_id: threadId,
        classification: "RESUME_FAILED",
        read_status: readStatus,
        resumed,
        loaded: false,
        name: current.name ?? null,
        cwd: current.cwd ?? null,
        error: `thread/resume identity or cwd mismatch: id=${current.id}, cwd=${current.cwd ?? "<missing>"}`,
      };
    }
  }

  if (current === null) {
    return {
      thread_id: threadId,
      classification: "RESUME_FAILED",
      read_status: readStatus,
      resumed,
      loaded: false,
      name: null,
      cwd: null,
      error: "thread/resume returned no thread",
    };
  }

  try {
    const loadedIds = await listAllLoadedThreadIds(client);
    if (!loadedIds.has(threadId)) {
      return {
        thread_id: threadId,
        classification: "RESUME_FAILED",
        read_status: readStatus,
        resumed,
        loaded: false,
        name: current.name ?? null,
        cwd: current.cwd ?? null,
        error: "thread/loaded/list did not contain the target id",
      };
    }
  } catch (error) {
    return {
      thread_id: threadId,
      classification: "RESUME_FAILED",
      read_status: readStatus,
      resumed,
      loaded: false,
      name: current.name ?? null,
      cwd: current.cwd ?? null,
      error: formatUnknownError(error),
    };
  }

  if (stored === null) {
    try {
      stored = await client.readThread(threadId, true);
    } catch (error) {
      return {
        thread_id: threadId,
        classification: "RESUME_FAILED",
        read_status: readStatus,
        resumed,
        loaded: true,
        name: current.name ?? null,
        cwd: current.cwd ?? null,
        error: `post-resume thread/read failed: ${formatUnknownError(error)}`,
      };
    }
    if (
      stored.id !== threadId ||
      !pathsEqual(stored.cwd ?? "", projectCwd)
    ) {
      return {
        thread_id: threadId,
        classification: "RESUME_FAILED",
        read_status: readStatus,
        resumed,
        loaded: true,
        name: stored.name ?? null,
        cwd: stored.cwd ?? null,
        error: `post-resume thread/read identity or cwd mismatch: id=${stored.id}, cwd=${stored.cwd ?? "<missing>"}`,
      };
    }
  }

  return {
    thread_id: threadId,
    classification: "STORED",
    read_status: readStatus,
    resumed,
    loaded: true,
    name: current.name ?? null,
    cwd: current.cwd ?? null,
    error: null,
  };
}

async function listAllLoadedThreadIds(
  client: CodexAppServerClient,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null | undefined;
  do {
    const page = await client.listLoadedThreadIds({
      ...(cursor === undefined ? {} : { cursor }),
      limit: 1_000,
    });
    page.data.forEach((threadId) => ids.add(threadId));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return ids;
}

function isThreadNotFound(error: unknown): boolean {
  return (
    error instanceof AppServerRpcError &&
    /\b(?:thread\s+)?(?:not found|does not exist|unknown thread|no such thread)\b/iu.test(
      error.message,
    )
  );
}

function isThreadNotLoaded(error: unknown): boolean {
  return (
    error instanceof AppServerRpcError &&
    /\bthread\s+not\s+loaded\b/iu.test(error.message)
  );
}

function parseArgs(argv: string[]): CliOptions {
  let projectCwd: string | undefined;
  let codexCommand: string | undefined;
  const threadIds: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--project-cwd" && value !== undefined) {
      projectCwd = value;
      index += 1;
    } else if (argument === "--codex-command" && value !== undefined) {
      codexCommand = value;
      index += 1;
    } else if (argument === "--thread" && value !== undefined) {
      threadIds.push(value);
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (projectCwd === undefined || codexCommand === undefined) {
    throw new Error("--project-cwd and --codex-command are required");
  }
  if (threadIds.length === 0) {
    throw new Error("at least one --thread is required");
  }
  return { projectCwd, codexCommand, threadIds };
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `READ/RESUME VERIFICATION FAILED\n${formatUnknownError(error)}\n`,
  );
  process.exitCode = 1;
});
