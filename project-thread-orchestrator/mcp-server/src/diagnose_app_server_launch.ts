#!/usr/bin/env node

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  AppServerLaunchError,
  type AppServerLaunchDiagnostic,
  type AppServerSpawnErrorDetails,
  extractAppServerSpawnError,
  launchAppServerProcess,
  resolveAppServerLaunch,
} from "./app-server-launcher.js";
import { PLUGIN_VERSION } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_CAPTURE_LENGTH = 8_192;

export interface DiagnosticCliOptions {
  readonly command?: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly json: boolean;
}

interface SerializedDiagnosticError {
  readonly name: string;
  readonly message: string;
  readonly details: AppServerSpawnErrorDetails | null;
}

export interface ProcessAttempt {
  readonly attempted: boolean;
  readonly status: "success" | "failed" | "timed_out" | "skipped";
  readonly elapsedMs: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: SerializedDiagnosticError | null;
}

export interface HandshakeAttempt extends ProcessAttempt {
  readonly initializeResponseReceived: boolean;
  readonly initializedSent: boolean;
  readonly normalCloseRequested: boolean;
  readonly forcedClose: boolean;
}

export interface LaunchDiagnosis {
  readonly diagnosticKind: "project-thread-orchestrator.app-server-launch";
  readonly generatedAt: string;
  readonly launch: AppServerLaunchDiagnostic | null;
  readonly resolutionError: SerializedDiagnosticError | null;
  readonly version: ProcessAttempt;
  readonly handshake: HandshakeAttempt;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const result = await diagnoseAppServerLaunch(options);
  const output = options.json ? JSON.stringify(result, null, 2) : formatText(result);
  process.stdout.write(`${output}\n`);
  if (result.resolutionError !== null || result.handshake.status !== "success") {
    process.exitCode = 1;
  }
}

/**
 * Read-only launcher diagnostic. It never constructs a thread request and has
 * no access to a registry or project-plan file. Its only child processes are:
 * `codex --version` and the fixed public `codex app-server --listen stdio://`
 * initialize/initialized handshake.
 */
export async function diagnoseAppServerLaunch(
  options: DiagnosticCliOptions,
): Promise<LaunchDiagnosis> {
  let launch: AppServerLaunchDiagnostic | null = null;
  let resolutionError: SerializedDiagnosticError | null = null;
  try {
    launch = resolveAppServerLaunch({
      ...toLaunchInputs(options),
    }).diagnostic;
  } catch (error) {
    resolutionError = serializeError(error);
    if (error instanceof AppServerLaunchError) {
      launch = error.diagnostic;
    }
  }

  if (resolutionError !== null) {
    return {
      diagnosticKind: "project-thread-orchestrator.app-server-launch",
      generatedAt: new Date().toISOString(),
      launch,
      resolutionError,
      version: skippedAttempt(),
      handshake: skippedHandshakeAttempt(),
    };
  }

  // Keep the two probes serial. The second probe is a live stdio server and
  // should not compete with a concurrently starting Codex process.
  const version = await runVersion(options);
  const handshake = await runHandshake(options);
  return {
    diagnosticKind: "project-thread-orchestrator.app-server-launch",
    generatedAt: new Date().toISOString(),
    launch,
    resolutionError: null,
    version,
    handshake,
  };
}

async function runVersion(options: DiagnosticCliOptions): Promise<ProcessAttempt> {
  const startedAt = Date.now();
  let child: ReturnType<typeof launchAppServerProcess>["child"];
  try {
    child = launchAppServerProcess({
      args: ["--version"],
      ...toLaunchInputs(options),
    }).child;
  } catch (error) {
    return failedAttempt(startedAt, "", "", error, null, null);
  }

  return await new Promise<ProcessAttempt>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        attempted: true,
        status: "timed_out",
        elapsedMs: Date.now() - startedAt,
        exitCode: null,
        signal: null,
        stdout: sanitizeCapturedOutput(stdout),
        stderr: sanitizeCapturedOutput(stderr),
        error: null,
      });
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(failedAttempt(startedAt, stdout, stderr, error, null, null));
      }
    });
    child.stderr.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(failedAttempt(startedAt, stdout, stderr, error, null, null));
      }
    });
    child.stdout.on("data", (chunk: string) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(failedAttempt(startedAt, stdout, stderr, error, null, null));
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        attempted: true,
        status: exitCode === 0 ? "success" : "failed",
        elapsedMs: Date.now() - startedAt,
        exitCode,
        signal,
        stdout: sanitizeCapturedOutput(stdout),
        stderr: sanitizeCapturedOutput(stderr),
        error: null,
      });
    });
  });
}

async function runHandshake(
  options: DiagnosticCliOptions,
): Promise<HandshakeAttempt> {
  const startedAt = Date.now();
  let child: ReturnType<typeof launchAppServerProcess>["child"];
  try {
    child = launchAppServerProcess({
      ...toLaunchInputs(options),
    }).child;
  } catch (error) {
    return failedHandshakeAttempt(startedAt, "", "", error, null, null);
  }

  return await new Promise<HandshakeAttempt>((resolve) => {
    let stdout = "";
    let stderr = "";
    let initializeResponseReceived = false;
    let initializedSent = false;
    let normalCloseRequested = false;
    let forcedClose = false;
    let settled = false;
    let closeTimer: NodeJS.Timeout | null = null;

    const complete = (
      status: HandshakeAttempt["status"],
      error: unknown | null,
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(handshakeTimer);
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
      }
      resolve({
        attempted: true,
        status,
        elapsedMs: Date.now() - startedAt,
        exitCode,
        signal,
        stdout: sanitizeCapturedOutput(stdout),
        stderr: sanitizeCapturedOutput(stderr),
        error: error === null ? null : serializeError(error),
        initializeResponseReceived,
        initializedSent,
        normalCloseRequested,
        forcedClose,
      });
    };

    const handshakeTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      forcedClose = true;
      child.kill();
      complete("timed_out", null, null, null);
    }, options.timeoutMs);

    child.stderr.setEncoding("utf8");
    child.stdout.on("error", (error) => {
      complete("failed", error, null, null);
    });
    child.stderr.on("error", (error) => {
      complete("failed", error, null, null);
    });
    child.stdin.on("error", (error) => {
      complete("failed", error, null, null);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      complete("failed", error, null, null);
    });
    child.once("exit", (exitCode, signal) => {
      complete(
        initializeResponseReceived && initializedSent ? "success" : "failed",
        null,
        exitCode,
        signal,
      );
    });

    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      stdout = appendTail(stdout, `${line}\n`);
      if (settled || initializeResponseReceived) {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch (error) {
        complete(
          "failed",
          new Error(`App Server emitted non-JSON stdout: ${toError(error).message}`),
          null,
          null,
        );
        child.kill();
        return;
      }
      if (!isInitializeSuccess(message)) {
        if (isInitializeError(message)) {
          complete(
            "failed",
            new Error("Codex App Server rejected initialize."),
            null,
            null,
          );
          child.kill();
        }
        return;
      }
      initializeResponseReceived = true;
      try {
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`, "utf8");
        initializedSent = true;
        normalCloseRequested = true;
        child.stdin.end();
      } catch (error) {
        complete("failed", error, null, null);
        child.kill();
        return;
      }
      closeTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        forcedClose = true;
        child.kill();
        complete("success", null, null, null);
      }, DEFAULT_CLOSE_TIMEOUT_MS);
    });

    try {
      child.stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: {
              name: "project-thread-orchestrator-launch-diagnostic",
              title: "Project Thread Orchestrator launch diagnostic",
              version: PLUGIN_VERSION,
            },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
              optOutNotificationMethods: [],
            },
          },
        })}\n`,
        "utf8",
      );
    } catch (error) {
      complete("failed", error, null, null);
      child.kill();
    }
  });
}

function isInitializeSuccess(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.id === 1 &&
    Object.prototype.hasOwnProperty.call(value, "result")
  );
}

function isInitializeError(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.id === 1 &&
    Object.prototype.hasOwnProperty.call(value, "error")
  );
}

function failedAttempt(
  startedAt: number,
  stdout: string,
  stderr: string,
  error: unknown,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): ProcessAttempt {
  return {
    attempted: true,
    status: "failed",
    elapsedMs: Date.now() - startedAt,
    exitCode,
    signal,
    stdout: sanitizeCapturedOutput(stdout),
    stderr: sanitizeCapturedOutput(stderr),
    error: serializeError(error),
  };
}

function failedHandshakeAttempt(
  startedAt: number,
  stdout: string,
  stderr: string,
  error: unknown,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): HandshakeAttempt {
  return {
    ...failedAttempt(startedAt, stdout, stderr, error, exitCode, signal),
    initializeResponseReceived: false,
    initializedSent: false,
    normalCloseRequested: false,
    forcedClose: false,
  };
}

function skippedAttempt(): ProcessAttempt {
  return {
    attempted: false,
    status: "skipped",
    elapsedMs: 0,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: "",
    error: null,
  };
}

function skippedHandshakeAttempt(): HandshakeAttempt {
  return {
    ...skippedAttempt(),
    initializeResponseReceived: false,
    initializedSent: false,
    normalCloseRequested: false,
    forcedClose: false,
  };
}

function appendTail(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  return combined.length <= MAX_CAPTURE_LENGTH
    ? combined
    : combined.slice(-MAX_CAPTURE_LENGTH);
}

/**
 * App Server stdout may contain status notifications unrelated to this launch
 * check. Preserve diagnostic usefulness while removing values under common
 * credential/device identity keys before the result is emitted or saved.
 */
function sanitizeCapturedOutput(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => sanitizeOutputLine(line))
    .join("\n");
}

function sanitizeOutputLine(line: string): string {
  if (line.trim().length === 0) {
    return line;
  }
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(line) as unknown));
  } catch {
    return line
      .replace(
        /\b(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[=:]\s*[^\s,;]+/giu,
        "[REDACTED]",
      )
      .replace(
        /\binstallationId\s*[=:]\s*[^\s,;]+/giu,
        "installationId=[REDACTED]",
      );
  }
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      isSensitiveDiagnosticKey(key) ? "[REDACTED]" : redactJsonValue(nested),
    ]),
  );
}

function isSensitiveDiagnosticKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|cookie|password|secret|token|installationid)/iu.test(
    key,
  );
}

function serializeError(error: unknown): SerializedDiagnosticError {
  if (error instanceof AppServerLaunchError) {
    return {
      name: error.name,
      message: error.message,
      details: error.details,
    };
  }
  const normalized = toError(error);
  return {
    name: normalized.name,
    message: normalized.message,
    details: extractAppServerSpawnError(error),
  };
}

function parseCliOptions(args: readonly string[]): DiagnosticCliOptions {
  let command: string | undefined;
  let cwd: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    switch (argument) {
      case "--command": {
        command = requiredValue(args, ++index, "--command");
        break;
      }
      case "--cwd": {
        cwd = requiredValue(args, ++index, "--cwd");
        break;
      }
      case "--timeout-ms": {
        const value = requiredValue(args, ++index, "--timeout-ms");
        timeoutMs = parseTimeout(value);
        break;
      }
      case "--json": {
        json = true;
        break;
      }
      case "--text": {
        json = false;
        break;
      }
      case "--help": {
        process.stdout.write(
          "Usage: diagnose_app_server_launch [--command <path-or-name>] [--cwd <directory>] [--timeout-ms <ms>] [--json|--text]\n",
        );
        process.exitCode = 0;
        throw new DiagnosticHelpRequestedError();
      }
      default:
        throw new Error(`Unknown diagnostic option: ${argument}`);
    }
  }
  const result: DiagnosticCliOptions = { timeoutMs, json };
  if (command !== undefined) {
    Object.assign(result, { command });
  }
  if (cwd !== undefined) {
    Object.assign(result, { cwd });
  }
  return result;
}

function toLaunchInputs(options: DiagnosticCliOptions): {
  readonly command?: string;
  readonly cwd?: string;
} {
  const result: { command?: string; cwd?: string } = {};
  if (options.command !== undefined) {
    result.command = options.command;
  }
  if (options.cwd !== undefined) {
    result.cwd = options.cwd;
  }
  return result;
}

function requiredValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseTimeout(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error("--timeout-ms must be between 100 and 120000");
  }
  return parsed;
}

function formatText(result: LaunchDiagnosis): string {
  const selected = result.launch?.selectedCommand ?? "unresolved";
  return [
    `selected command: ${selected}`,
    `command source: ${result.launch?.commandSource ?? "unresolved"}`,
    `version: ${result.version.status}`,
    `handshake: ${result.handshake.status}`,
    `initialize response: ${String(result.handshake.initializeResponseReceived)}`,
    `initialized sent: ${String(result.handshake.initializedSent)}`,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class DiagnosticHelpRequestedError extends Error {}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    if (error instanceof DiagnosticHelpRequestedError) {
      return;
    }
    const normalized = toError(error);
    process.stderr.write(`${normalized.name}: ${normalized.message}\n`);
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}
