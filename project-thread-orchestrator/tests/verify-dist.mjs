import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourcePluginRoot = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const pluginRoot =
  process.argv[2] === undefined
    ? sourcePluginRoot
    : path.resolve(process.argv[2]);
const entry = path.join(pluginRoot, "mcp-server", "dist", "server.js");
const diagnosticEntry = path.join(
  pluginRoot,
  "mcp-server",
  "dist",
  "diagnose_app_server_launch.js",
);
const manifest = JSON.parse(
  await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
);
const child = spawn(process.execPath, [entry], {
  cwd: pluginRoot,
  stdio: ["pipe", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
});
const pending = new Map();
let nextId = 1;
let stderr = "";
const lines = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) {
    return;
  }
  const waiter = pending.get(message.id);
  if (waiter === undefined) {
    return;
  }
  pending.delete(message.id);
  if (message.error !== undefined) {
    waiter.reject(new Error(message.error.message ?? "MCP error"));
  } else {
    waiter.resolve(message.result ?? {});
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
}

function notify(method, params) {
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
  );
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: {
      name: "project-thread-orchestrator-dist-verifier",
      version: "0.1.0",
    },
  });
  notify("notifications/initialized", {});
  const listed = await request("tools/list", {});
  const names = (listed.tools ?? [])
    .map((tool) => tool.name)
    .sort();
  const expected = ["create_project_threads", "initialize_project_capsule", "list_project_threads", "preview_project_threads", "sync_project_threads"];
  if (
    initialized.serverInfo?.name !== "project-thread-orchestrator" ||
    initialized.serverInfo?.version !== manifest.version ||
    JSON.stringify(names) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `dist verification mismatch: ${JSON.stringify({
        serverInfo: initialized.serverInfo,
        names,
      })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      entry,
      serverInfo: initialized.serverInfo,
      tools: names,
      real_app_server_started: false,
    }, null, 2)}\n`,
  );
} finally {
  child.stdin.end();
  child.kill();
  lines.close();
}

if (stderr.trim() !== "") {
  process.stderr.write(stderr);
}

const diagnostic = spawn(process.execPath, [diagnosticEntry, "--help"], {
  cwd: pluginRoot,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  windowsHide: true,
});
let diagnosticStdout = "";
let diagnosticStderr = "";
diagnostic.stdout.setEncoding("utf8");
diagnostic.stderr.setEncoding("utf8");
diagnostic.stdout.on("data", (chunk) => {
  diagnosticStdout += chunk;
});
diagnostic.stderr.on("data", (chunk) => {
  diagnosticStderr += chunk;
});
const diagnosticExit = await new Promise((resolve, reject) => {
  diagnostic.once("error", reject);
  diagnostic.once("exit", (code, signal) => {
    resolve({ code, signal });
  });
});
if (
  diagnosticExit.code !== 0 ||
  diagnosticExit.signal !== null ||
  !diagnosticStdout.includes("Usage: diagnose_app_server_launch") ||
  diagnosticStderr.trim() !== ""
) {
  throw new Error(
    `bundled diagnostic verification failed: ${JSON.stringify({
      diagnosticEntry,
      diagnosticExit,
      diagnosticStdout,
      diagnosticStderr,
    })}`,
  );
}
