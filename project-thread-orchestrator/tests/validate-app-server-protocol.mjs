#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDirectory, "..");

function parseArgs(argv) {
  const options = {
    codexCommand: process.env.CODEX_COMMAND?.trim() || "codex",
    schemaDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex-command") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--codex-command requires a path or command");
      }
      options.codexCommand = value;
      index += 1;
    } else if (argument === "--schema-dir") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--schema-dir requires a directory");
      }
      options.schemaDir = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${String(result.status)}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function requireProperties(schema, fileName, properties, errors) {
  const available = schema?.properties;
  for (const property of properties) {
    if (
      available === null ||
      typeof available !== "object" ||
      !(property in available)
    ) {
      errors.push(`${fileName} is missing property ${property}`);
    }
  }
}

async function generateSchemas(codexCommand) {
  const version = run(codexCommand, ["--version"]);
  const safeVersion = version.replace(/[^0-9A-Za-z._-]+/gu, "-");
  const auditRoot = path.join(
    pluginRoot,
    ".tmp",
    `protocol-quality-${safeVersion}-${Date.now()}`,
  );
  const schemaDir = path.join(auditRoot, "json-schema");
  const typesDir = path.join(auditRoot, "typescript");
  await Promise.all([
    mkdir(schemaDir, { recursive: true }),
    mkdir(typesDir, { recursive: true }),
  ]);
  run(codexCommand, [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    schemaDir,
  ]);
  run(codexCommand, [
    "app-server",
    "generate-ts",
    "--experimental",
    "--out",
    typesDir,
  ]);
  return { schemaDir, typesDir, version };
}

async function validateProtocol(schemaDir) {
  const errors = [];
  const v1 = path.join(schemaDir, "v1");
  const v2 = path.join(schemaDir, "v2");
  const files = {
    initialize: path.join(v1, "InitializeParams.json"),
    threadStart: path.join(v2, "ThreadStartParams.json"),
    threadStarted: path.join(v2, "ThreadStartedNotification.json"),
    threadResume: path.join(v2, "ThreadResumeParams.json"),
    threadLoadedList: path.join(v2, "ThreadLoadedListParams.json"),
    threadName: path.join(v2, "ThreadSetNameParams.json"),
    threadGoal: path.join(v2, "ThreadGoalSetParams.json"),
    turnStart: path.join(v2, "TurnStartParams.json"),
    threadList: path.join(v2, "ThreadListParams.json"),
    threadRead: path.join(v2, "ThreadReadParams.json"),
    threadArchive: path.join(v2, "ThreadArchiveParams.json"),
    threadDelete: path.join(v2, "ThreadDeleteParams.json"),
    turnCompleted: path.join(v2, "TurnCompletedNotification.json"),
  };
  const schemas = {};
  for (const [label, filePath] of Object.entries(files)) {
    try {
      schemas[label] = await readJson(filePath);
    } catch (error) {
      errors.push(`${label} schema is unavailable or invalid at ${filePath}: ${error.message}`);
    }
  }

  requireProperties(
    schemas.initialize,
    "InitializeParams.json",
    ["clientInfo", "capabilities"],
    errors,
  );
  requireProperties(
    schemas.threadStart,
    "ThreadStartParams.json",
    ["cwd", "approvalPolicy", "sandbox", "ephemeral"],
    errors,
  );
  requireProperties(
    schemas.threadStarted,
    "ThreadStartedNotification.json",
    ["thread"],
    errors,
  );
  requireProperties(
    schemas.threadResume,
    "ThreadResumeParams.json",
    ["threadId"],
    errors,
  );
  requireProperties(
    schemas.threadLoadedList,
    "ThreadLoadedListParams.json",
    ["cursor", "limit"],
    errors,
  );
  requireProperties(
    schemas.threadName,
    "ThreadSetNameParams.json",
    ["threadId", "name"],
    errors,
  );
  requireProperties(
    schemas.threadGoal,
    "ThreadGoalSetParams.json",
    ["threadId", "objective", "status"],
    errors,
  );
  requireProperties(
    schemas.turnStart,
    "TurnStartParams.json",
    ["threadId", "input", "cwd", "sandboxPolicy", "approvalPolicy"],
    errors,
  );
  requireProperties(
    schemas.threadList,
    "ThreadListParams.json",
    ["cwd", "sourceKinds", "archived", "cursor", "limit"],
    errors,
  );
  requireProperties(
    schemas.threadRead,
    "ThreadReadParams.json",
    ["threadId", "includeTurns"],
    errors,
  );
  requireProperties(
    schemas.threadArchive,
    "ThreadArchiveParams.json",
    ["threadId"],
    errors,
  );
  requireProperties(
    schemas.threadDelete,
    "ThreadDeleteParams.json",
    ["threadId"],
    errors,
  );
  requireProperties(
    schemas.turnCompleted,
    "TurnCompletedNotification.json",
    ["threadId", "turn"],
    errors,
  );

  const [clientRequest, clientNotification, serverNotification, clientSource] =
    await Promise.all([
      readFile(path.join(schemaDir, "ClientRequest.json"), "utf8"),
      readFile(path.join(schemaDir, "ClientNotification.json"), "utf8"),
      readFile(path.join(schemaDir, "ServerNotification.json"), "utf8"),
      readFile(
        path.join(pluginRoot, "mcp-server", "src", "app-server-client.ts"),
        "utf8",
      ),
    ]);
  const clientMethods = [
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/loaded/list",
    "thread/name/set",
    "thread/goal/set",
    "turn/start",
    "thread/list",
    "thread/read",
    "thread/archive",
  ];
  for (const method of clientMethods) {
    if (!clientRequest.includes(`"${method}"`)) {
      errors.push(`generated ClientRequest does not advertise ${method}`);
    }
    if (!clientSource.includes(`"${method}"`)) {
      errors.push(`app-server-client.ts does not call ${method}`);
    }
  }
  if (!clientNotification.includes('"initialized"')) {
    errors.push("generated ClientNotification does not advertise initialized");
  }
  if (!clientSource.includes('{ method: "initialized" }')) {
    errors.push("app-server-client.ts does not send initialized");
  }
  if (!serverNotification.includes('"turn/completed"')) {
    errors.push("generated ServerNotification does not advertise turn/completed");
  }
  if (!serverNotification.includes('"thread/started"')) {
    errors.push("generated ServerNotification does not advertise thread/started");
  }
  if (!clientRequest.includes('"thread/delete"')) {
    errors.push("generated ClientRequest does not advertise thread/delete");
  }

  const sourceRequirements = [
    ['approvalPolicy: "never"', "approvalPolicy never"],
    ['z.literal("read-only")', "read-only thread sandbox"],
    ["networkAccess: false", "network disabled"],
    ['sourceKinds: ["cli", "vscode", "appServer"]', "appServer sourceKinds"],
    ['"thread/read"', "thread/read client call"],
    ['"thread/resume"', "thread/resume client call"],
    ['"thread/loaded/list"', "thread/loaded/list client call"],
    ['"thread/archive"', "thread/archive client call"],
    ['"thread/delete"', "thread/delete client call"],
    ['method === "thread/started"', "thread/started notification handling"],
  ];
  for (const [fragment, label] of sourceRequirements) {
    if (!clientSource.includes(fragment)) {
      errors.push(`app-server-client.ts is missing ${label}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`App Server protocol compatibility failed:\n- ${errors.join("\n- ")}`);
  }
  return {
    checked_methods: clientMethods,
    checked_notifications: ["thread/started", "turn/completed"],
    cleanup_protocol_capability: "thread/delete",
    schema_dir: schemaDir,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const generated =
    options.schemaDir === undefined
      ? await generateSchemas(options.codexCommand)
      : {
          schemaDir: options.schemaDir,
          typesDir: null,
          version: run(options.codexCommand, ["--version"]),
        };
  const validation = await validateProtocol(generated.schemaDir);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        codex_version: generated.version,
        generated_types_dir: generated.typesDir,
        ...validation,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(
    `PROTOCOL VALIDATION FAILED\n${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
