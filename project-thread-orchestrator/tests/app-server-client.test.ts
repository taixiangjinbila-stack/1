import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppServerProtocolError,
  AppServerRpcError,
  AppServerStartupTimeoutError,
  AppServerTimeoutError,
  CodexAppServerClient,
} from "../mcp-server/src/app-server-client.js";
import { AppServerLaunchError } from "../mcp-server/src/app-server-launcher.js";
import type { TurnStartParams } from "../mcp-server/src/types.js";

const fixture = path.resolve(
  process.cwd(),
  "..",
  "tests",
  "fixtures",
  "mock-app-server.mjs",
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  const pending = temporaryDirectories.splice(0);
  await Promise.all(
    pending.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createClient(
  mode = "basic",
  timeouts: {
    readonly startupTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
  } = {},
): Promise<{
  client: CodexAppServerClient;
  logPath: string;
  directory: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "pto-app-client-"));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, "wire.jsonl");
  return {
    directory,
    logPath,
    client: new CodexAppServerClient({
      command: process.execPath,
      args: [fixture],
      cwd: directory,
      env: {
        PTO_MOCK_MODE: mode,
        PTO_MOCK_LOG: logPath,
      },
      startupTimeoutMs: timeouts.startupTimeoutMs ?? 200,
      requestTimeoutMs: timeouts.requestTimeoutMs ?? 200,
      turnTimeoutMs: 500,
      closeTimeoutMs: 200,
    }),
  };
}

function turnParams(
  threadId: string,
  cwd: string,
): TurnStartParams {
  return {
    threadId,
    input: [
      {
        type: "text",
        text: "Initialization only",
        text_elements: [],
      },
    ],
    cwd,
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "readOnly",
      networkAccess: false,
    },
    outputSchema: {
      type: "object",
      properties: { status: { enum: ["READY", "WAITING"] } },
    },
  };
}

async function readWireLog(logPath: string): Promise<
  Array<{ direction: string; message: Record<string, unknown> }>
> {
  const raw = await readFile(logPath, "utf8");
  return raw
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      direction: string;
      message: Record<string, unknown>;
    });
}

describe("Codex App Server JSONL client", () => {
  it("handshakes, uses paused goals and safe initialization, and paginates by exact cwd", async () => {
    const { client, directory, logPath } = await createClient();
    try {
      const thread = await client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      await expect(client.waitForThreadStarted(thread.id)).resolves.toMatchObject({
        id: thread.id,
        ephemeral: false,
      });
      await expect(client.getInitializeInfo()).resolves.toMatchObject({
        userAgent: "mock-app-server",
        platformOs: "windows",
      });
      await client.setThreadName(thread.id, "M0 Mock baseline");
      await client.setThreadGoal(thread.id, "Inspect the baseline");
      const turn = await client.startTurn(turnParams(thread.id, directory));
      const completed = await client.waitForTurnCompletion(
        thread.id,
        turn.id,
      );
      const page = await client.listThreads({
        cwd: directory,
        archived: false,
      });

      expect(completed.status).toBe("completed");
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.name).toBe("M0 Mock baseline");
    } finally {
      await client.close();
    }

    const wire = await readWireLog(logPath);
    const methods = wire
      .filter((entry) => entry.direction === "from-client")
      .map((entry) => entry.message.method);
    expect(methods.slice(0, 2)).toEqual(["initialize", "initialized"]);

    const initialize = wire.find(
      (entry) => entry.message.method === "initialize",
    )?.message;
    expect(initialize).toMatchObject({
      params: {
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          optOutNotificationMethods: [],
        },
      },
    });

    const goal = wire.find(
      (entry) => entry.message.method === "thread/goal/set",
    )?.message;
    expect(goal).toMatchObject({
      params: { status: "paused" },
    });

    const turnStart = wire.find(
      (entry) => entry.message.method === "turn/start",
    )?.message;
    expect(turnStart).toMatchObject({
      params: {
        approvalPolicy: "never",
        input: [
          expect.objectContaining({
            type: "text",
            text_elements: [],
          }),
        ],
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
      },
    });

    const list = wire.find(
      (entry) => entry.message.method === "thread/list",
    )?.message;
    expect(list).toMatchObject({
      params: {
        cwd: directory,
        sourceKinds: ["cli", "vscode", "appServer"],
      },
    });
  });

  it("uses the generated thread/read, thread/archive, and thread/delete wire contracts", async () => {
    const { client, directory, logPath } = await createClient();
    try {
      const thread = await client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      await client.setThreadName(thread.id, "M0 Read/archive contract");

      const beforeArchive = await client.readThread(thread.id, true);
      expect(beforeArchive).toMatchObject({
        id: "thr_mock_1",
        name: "M0 Read/archive contract",
        cwd: directory,
      });

      await client.archiveThread(thread.id);
      const active = await client.listThreads({
        cwd: directory,
        archived: false,
      });
      const archived = await client.listThreads({
        cwd: directory,
        archived: true,
      });
      expect(active.data).toHaveLength(0);
      expect(archived.data.map((candidate) => candidate.id)).toEqual([
        "thr_mock_1",
      ]);
      await client.deleteThread(thread.id);
    } finally {
      await client.close();
    }

    const wire = await readWireLog(logPath);
    expect(
      wire.find((entry) => entry.message.method === "thread/read")?.message,
    ).toMatchObject({
      params: { threadId: "thr_mock_1", includeTurns: true },
    });
    expect(
      wire.find((entry) => entry.message.method === "thread/archive")?.message,
    ).toMatchObject({
      params: { threadId: "thr_mock_1" },
    });
    expect(
      wire.find((entry) => entry.message.method === "thread/delete")?.message,
    ).toMatchObject({ params: { threadId: "thr_mock_1" } });
  });

  it("keeps stored-thread resume, loaded verification, and turn/start on one connection", async () => {
    const { client, directory, logPath } =
      await createClient("stored-not-loaded");
    let processId: number | null = null;
    let connectionId = "";
    try {
      const thread = await client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      const stored = await client.readThread(thread.id, true);
      expect(stored.status?.type).toBe("notLoaded");
      await expect(
        client.startTurn(turnParams(thread.id, directory)),
      ).rejects.toMatchObject({
        method: "turn/start",
        message: expect.stringContaining("thread not found"),
      });

      const resumed = await client.resumeThread(thread.id);
      expect(resumed).toMatchObject({
        id: thread.id,
        status: { type: "idle" },
      });
      const loaded = await client.listLoadedThreadIds({ limit: 100 });
      expect(loaded).toEqual({ data: [thread.id], nextCursor: null });
      const turn = await client.startTurn(turnParams(thread.id, directory));
      await expect(
        client.waitForTurnCompletion(thread.id, turn.id),
      ).resolves.toMatchObject({ status: "completed" });

      const diagnostic = client.getRuntimeDiagnostic();
      processId = diagnostic.processId;
      connectionId = diagnostic.connectionId;
      const recoveryRequests = diagnostic.rpc.filter(
        (entry) =>
          entry.direction === "request" &&
          [
            "thread/read",
            "thread/resume",
            "thread/loaded/list",
            "turn/start",
          ].includes(entry.method),
      );
      expect(recoveryRequests).toHaveLength(5);
      expect(
        new Set(recoveryRequests.map((entry) => entry.processId)),
      ).toEqual(new Set([processId]));
      expect(
        new Set(recoveryRequests.map((entry) => entry.connectionId)),
      ).toEqual(new Set([connectionId]));
    } finally {
      await client.close();
    }

    const wire = await readWireLog(logPath);
    const methods = wire
      .filter((entry) => entry.direction === "from-client")
      .map((entry) => entry.message.method);
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "thread/read",
      "turn/start",
      "thread/resume",
      "thread/loaded/list",
      "turn/start",
    ]);
    expect(processId).not.toBeNull();
    expect(connectionId).not.toBe("");
  });

  it("retries only an explicit sandbox enum -32602 with legacy readOnly", async () => {
    const { client, directory, logPath } = await createClient("legacy");
    try {
      const thread = await client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      expect(thread.id).toBe("thr_mock_1");
    } finally {
      await client.close();
    }

    const wire = await readWireLog(logPath);
    const starts = wire.filter(
      (entry) => entry.message.method === "thread/start",
    );
    expect(starts).toHaveLength(2);
    expect(starts.map((entry) => entry.message.params)).toEqual([
      expect.objectContaining({ sandbox: "read-only" }),
      expect.objectContaining({ sandbox: "readOnly" }),
    ]);
  });

  it("does not retry an unrelated invalid-params failure", async () => {
    const { client, directory, logPath } =
      await createClient("unrelated-invalid");
    try {
      await expect(
        client.startThread({
          cwd: directory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          serviceName: "project-thread-orchestrator",
        }),
      ).rejects.toBeInstanceOf(AppServerRpcError);
    } finally {
      await client.close();
    }
    const wire = await readWireLog(logPath);
    expect(
      wire.filter((entry) => entry.message.method === "thread/start"),
    ).toHaveLength(1);
  });

  it("declines approval requests and interrupts the initialization turn", async () => {
    const { client, directory, logPath } = await createClient("approval");
    try {
      const thread = await client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      const turn = await client.startTurn(turnParams(thread.id, directory));
      const completed = await client.waitForTurnCompletion(
        thread.id,
        turn.id,
      );
      expect(completed.status).toBe("interrupted");
    } finally {
      await client.close();
    }

    const wire = await readWireLog(logPath);
    expect(
      wire.find(
        (entry) =>
          entry.direction === "client-response" &&
          entry.message.id === "approval_request_1",
      )?.message,
    ).toMatchObject({ result: { decision: "cancel" } });
    expect(
      wire.some((entry) => entry.message.method === "turn/interrupt"),
    ).toBe(true);
    expect(JSON.stringify(wire)).not.toMatch(/acceptForSession|"accept"/u);
  });

  it("resolves a non-retrying error notification as a failed turn", async () => {
    const { client, directory } = await createClient("terminal-error");
    try {
      const thread = await client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      const turn = await client.startTurn(turnParams(thread.id, directory));
      const completed = await client.waitForTurnCompletion(
        thread.id,
        turn.id,
      );
      expect(completed).toMatchObject({
        id: turn.id,
        status: "failed",
        error: { message: "mock terminal turn failure" },
      });
    } finally {
      await client.close();
    }
  });

  it("marks a timed-out thread/start as ambiguous", async () => {
    const { client, directory } = await createClient("timeout-start");
    try {
      const promise = client.startThread({
        cwd: directory,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        serviceName: "project-thread-orchestrator",
      });
      await expect(promise).rejects.toMatchObject({
        name: AppServerTimeoutError.name,
        ambiguous: true,
      });
    } finally {
      await client.close();
    }
  });

  it("fails a stalled initialize handshake safely, terminates it, and sends no thread RPC", async () => {
    const { client, directory, logPath } = await createClient(
      "timeout-initialize",
      { startupTimeoutMs: 80 },
    );
    try {
      await expect(
        client.startThread({
          cwd: directory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          serviceName: "project-thread-orchestrator",
        }),
      ).rejects.toMatchObject({
        name: AppServerStartupTimeoutError.name,
        ambiguous: false,
      });
    } finally {
      await client.close();
    }

    const wire = await readWireLog(logPath);
    expect(wire.map((entry) => entry.message.method)).toEqual(["initialize"]);
  });

  it("rejects an invalid initialize response before any thread RPC", async () => {
    const { client, directory, logPath } = await createClient(
      "invalid-initialize",
    );
    try {
      await expect(
        client.startThread({
          cwd: directory,
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: false,
          serviceName: "project-thread-orchestrator",
        }),
      ).rejects.toBeInstanceOf(AppServerProtocolError);
    } finally {
      await client.close();
    }
    const wire = await readWireLog(logPath);
    expect(wire.map((entry) => entry.message.method)).toEqual(["initialize"]);
  });

  it("preserves a synchronous launch EPERM as a structured, safe-to-retry error", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pto-app-client-"));
    temporaryDirectories.push(directory);
    const spawnError = Object.assign(new Error("spawn EPERM"), {
      code: "EPERM",
      errno: -4048,
      syscall: "spawn",
      path: process.execPath,
      spawnargs: ["app-server", "--listen", "stdio://"],
    });
    let thrown: unknown;
    try {
      new CodexAppServerClient({
        command: process.execPath,
        cwd: directory,
        spawnProcess: () => {
          throw spawnError;
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppServerLaunchError);
    expect(thrown).toMatchObject({
      details: {
        code: "EPERM",
        errno: -4048,
        syscall: "spawn",
        path: process.execPath,
      },
    });
    expect(
      (thrown as AppServerLaunchError).diagnostic.spawnArgs,
    ).toEqual(["app-server", "--listen", "stdio://"]);
  });
});
