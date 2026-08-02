import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import readline from "node:readline";
import path from "node:path";
import { promisify } from "node:util";
import { PLUGIN_VERSION } from "../mcp-server/src/types.js";
import { makeTasks } from "./test-helpers.js";

const execFileAsync = promisify(execFile);
const testDist = path.join(process.cwd(), ".test-dist");
const serverEntry = path.join(
  testDist,
  "mcp-server",
  "src",
  "server.js",
);

beforeAll(async () => {
  await rm(testDist, { recursive: true, force: true });
  await execFileAsync(
    process.execPath,
    [
      path.join("node_modules", "typescript", "bin", "tsc"),
      "--project",
      "tsconfig.json",
      "--outDir",
      testDist,
      "--noEmit",
      "false",
      "--declaration",
      "false",
      "--sourceMap",
      "false",
    ],
    {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 20_000,
    },
  );
});

afterAll(async () => {
  await rm(testDist, { recursive: true, force: true });
});

interface PendingResponse {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class RawMcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingResponse>();
  private nextId = 1;
  private stderr = "";

  public constructor(extraEnv: NodeJS.ProcessEnv = {}) {
    this.child = spawn(
      process.execPath,
      [serverEntry],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...extraEnv },
      },
    );
    const lines = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message?: string };
      };
      if (message.id === undefined) {
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            message.error.message ?? "MCP server returned an unknown error",
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });
    this.child.on("exit", (code) => {
      if (code === 0 || this.pending.size === 0) {
        return;
      }
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `MCP server exited with ${String(code)}: ${this.stderr}`,
          ),
        );
      }
      this.pending.clear();
    });
  }

  public async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "project-thread-orchestrator-test",
        version: "0.1.0",
      },
    });
    this.notify("notifications/initialized", {});
    return result;
  }

  public request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP ${method} timed out. stderr: ${this.stderr}`),
        );
      }, 3_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  public notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  public async close(): Promise<void> {
    if (!this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
    if (this.child.exitCode === null) {
      this.child.kill();
    }
  }

  private send(value: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
}

describe("stdio MCP server", () => {
    it("advertises capsule health and thread tools without starting a real Codex App Server", async () => {
    const client = new RawMcpClient();
    try {
      const initialized = await client.initialize();
      expect(initialized).toMatchObject({
        serverInfo: {
          name: "project-thread-orchestrator",
          version: PLUGIN_VERSION,
        },
      });
      const listed = await client.request("tools/list", {});
      const tools = listed.tools;
      expect(Array.isArray(tools)).toBe(true);
      const toolRecords = tools as Array<{
        name: string;
        annotations?: Record<string, unknown>;
        inputSchema?: Record<string, unknown>;
      }>;
      expect(toolRecords.map((tool) => tool.name).sort()).toEqual([
        "create_project_threads",
        "initialize_project_capsule",
        "list_project_threads",
        "preview_project_threads",
        "sync_project_threads",
      ]);
      expect(
        toolRecords.find(
          (tool) => tool.name === "preview_project_threads",
        )?.annotations,
      ).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      for (const tool of toolRecords) {
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
    } finally {
      await client.close();
    }
  });

  it("previews through MCP tools/call and rejects an unconfirmed create without App Server startup", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "pto-mcp-preview-"));
    const client = new RawMcpClient({
      PTO_CODEX_COMMAND: path.join(project, "codex-must-not-start.exe"),
    });
    try {
      await client.initialize();
      const plan = { canonical_cwd: project, project_goal: "MVP preview", milestones: makeTasks(3).map((task) => ({ milestone_id: task.milestone_id, name: task.name, objective: task.goal, dependencies: task.dependencies, acceptance_criteria: task.acceptance_criteria })) };
      const preview = await client.request("tools/call", {
        name: "preview_project_threads",
        arguments: plan,
      });
      expect(preview).toMatchObject({
        structuredContent: {
          ok: true,
          confirmation_required: true,
        },
      });
      const structured = preview.structuredContent as Record<string, unknown>;
      expect(structured.threads).toHaveLength(3);
    } finally {
      await client.close();
      await rm(project, { recursive: true, force: true });
    }
  });
});
