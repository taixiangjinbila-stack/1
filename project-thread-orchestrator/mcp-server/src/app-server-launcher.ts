import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, isAbsolute, resolve } from "node:path";

/**
 * The only production App Server invocation supported by this plugin. Keeping
 * this constant here (instead of accepting a shell command) makes the Windows
 * .cmd fallback auditable and prevents command injection through the launcher.
 */
export const DEFAULT_APP_SERVER_ARGS = [
  "app-server",
  "--listen",
  "stdio://",
] as const;

export type AppServerCommandKind =
  | "exe"
  | "cmd"
  | "bat"
  | "other"
  | "unresolved";

export type AppServerCommandSource =
  | "explicit"
  | "path"
  | "windows-safe-fallback"
  | "unresolved";

export interface AppServerFileProbe {
  readonly path: string;
  readonly exists: boolean;
  readonly readable: boolean;
  readonly directory: boolean | null;
}

export interface AppServerCommandCandidate extends AppServerFileProbe {
  readonly source: "explicit" | "path" | "windows-safe-fallback";
  readonly kind: AppServerCommandKind;
  readonly rejectedReason: string | null;
}

/**
 * A deliberately small, redacted process snapshot. Do not add arbitrary
 * environment variables: this object is intended for support logs.
 */
export interface AppServerLaunchDiagnostic {
  readonly process: {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly execPath: string;
  };
  readonly environment: {
    readonly ComSpec: string | null;
    readonly PATH: string | null;
    readonly PATHEXT: string | null;
    readonly CODEX_HOME: string | null;
  };
  readonly requestedCommand: string;
  readonly selectedCommand: string | null;
  readonly commandSource: AppServerCommandSource;
  readonly commandKind: AppServerCommandKind;
  readonly appServerArgs: readonly string[];
  readonly spawnCommand: string | null;
  readonly spawnArgs: readonly string[];
  readonly cwd: AppServerFileProbe;
  readonly candidates: readonly AppServerCommandCandidate[];
  readonly fallbackReason: string | null;
  readonly directCmdSpawnWouldBeUnsafe: boolean;
  readonly warnings: readonly string[];
}

export interface AppServerLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptionsWithoutStdio;
  readonly diagnostic: AppServerLaunchDiagnostic;
}

export interface AppServerLauncherFileAccess {
  readonly exists: (target: string) => boolean;
  readonly readable: (target: string) => boolean;
  readonly directory: (target: string) => boolean | null;
}

export interface ResolveAppServerLaunchOptions {
  /**
   * An optional executable path or command name supplied by the host. A bare
   * name is resolved to an absolute file before it is spawned on Windows.
   */
  readonly command?: string;
  /**
   * Defaults to the fixed public App Server stdio invocation. Custom arguments
   * are only intended for the isolated diagnostic (--version) and test mocks;
   * they are never derived from an MCP tool input.
   */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test seams; production uses the current Node.js process values. */
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly execPath?: string;
  readonly homeDirectory?: string;
  readonly fileAccess?: AppServerLauncherFileAccess;
}

export interface LaunchAppServerProcessOptions extends ResolveAppServerLaunchOptions {
  /**
   * This hook is intentionally narrow so unit tests can simulate a synchronous
   * Windows `spawn EPERM` without running a child process.
   */
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
}

export interface LaunchedAppServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly diagnostic: AppServerLaunchDiagnostic;
}

export interface AppServerSpawnErrorDetails {
  readonly name: string;
  readonly message: string;
  readonly code: string | number | null;
  readonly errno: number | null;
  readonly syscall: string | null;
  readonly path: string | null;
  readonly spawnargs: readonly string[] | null;
}

/**
 * A structured, safe-to-log error raised before (or while) an App Server child
 * is launched. The original Error is retained for in-process callers only.
 */
export class AppServerLaunchError extends Error {
  public readonly diagnostic: AppServerLaunchDiagnostic;
  public readonly details: AppServerSpawnErrorDetails | null;
  public readonly causeError: Error | null;

  public constructor(
    message: string,
    diagnostic: AppServerLaunchDiagnostic,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AppServerLaunchError";
    this.diagnostic = diagnostic;
    this.details =
      options.cause === undefined ? null : extractAppServerSpawnError(options.cause);
    this.causeError = options.cause === undefined ? null : toError(options.cause);
  }
}

const DEFAULT_FILE_ACCESS: AppServerLauncherFileAccess = {
  exists: existsSync,
  readable: (target) => {
    try {
      accessSync(target, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  },
  directory: (target) => {
    try {
      return statSync(target).isDirectory();
    } catch {
      return null;
    }
  },
};

const CMD_UNSAFE_CHARACTERS = /[&|<>()^%!\r\n\u0000"]/u;

/**
 * Resolve a launch to an explicit, validated command without starting it.
 *
 * On Windows a bare `codex` must not be sent directly to child_process.spawn:
 * a packaged WindowsApps command can synchronously fail with EPERM. We resolve
 * PATH ourselves, reject a WindowsApps candidate, and only then use a known
 * per-user executable fallback when it is readable. The fallback is recorded
 * in diagnostics because it is a host-runtime compatibility workaround, not a
 * separate protocol implementation.
 */
export function resolveAppServerLaunch(
  options: ResolveAppServerLaunchOptions = {},
): AppServerLaunchPlan {
  const environment = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileAccess = options.fileAccess ?? DEFAULT_FILE_ACCESS;
  const currentCwd = process.cwd();
  const cwd = resolve(options.cwd ?? currentCwd);
  const cwdProbe = probePath(cwd, fileAccess);
  const args = validateArguments(options.args ?? DEFAULT_APP_SERVER_ARGS);
  const requestedCommand = normalizeCommand(options.command ?? "codex");
  const candidates: AppServerCommandCandidate[] = [];
  const warnings: string[] = [];

  let selectedCommand: string | null = null;
  let commandSource: AppServerCommandSource = "unresolved";
  let commandKind: AppServerCommandKind = "unresolved";
  let fallbackReason: string | null = null;

  if (!cwdProbe.exists || cwdProbe.directory !== true) {
    const diagnostic = buildDiagnostic({
      platform,
      arch: options.arch ?? process.arch,
      execPath: options.execPath ?? process.execPath,
      environment,
      requestedCommand,
      selectedCommand,
      commandSource,
      commandKind,
      args,
      cwdProbe,
      candidates,
      fallbackReason,
      warnings: [
        "The requested working directory does not exist or is not a directory.",
      ],
    });
    throw new AppServerLaunchError(
      `Codex App Server cwd is not an existing directory: ${cwd}`,
      diagnostic,
    );
  }
  if (!cwdProbe.readable) {
    const diagnostic = buildDiagnostic({
      platform,
      arch: options.arch ?? process.arch,
      execPath: options.execPath ?? process.execPath,
      environment,
      requestedCommand,
      selectedCommand,
      commandSource,
      commandKind,
      args,
      cwdProbe,
      candidates,
      fallbackReason,
      warnings: ["The requested working directory is not readable."],
    });
    throw new AppServerLaunchError(
      `Codex App Server cwd is not readable: ${cwd}`,
      diagnostic,
    );
  }

  const explicitPath = resolveCommandPath(requestedCommand, cwd);
  if (explicitPath !== null) {
    const candidate = makeCandidate(explicitPath, "explicit", fileAccess);
    candidates.push(candidate);
    if (
      candidate.exists &&
      candidate.readable &&
      candidate.directory === false &&
      !(platform === "win32" && isWindowsAppsPath(candidate.path))
    ) {
      selectedCommand = candidate.path;
      commandSource = "explicit";
      commandKind = candidate.kind;
    } else if (
      platform === "win32" &&
      candidate.exists &&
      candidate.readable &&
      candidate.directory === false &&
      isCodexExecutablePath(candidate.path)
    ) {
      warnings.push(
        "The explicitly configured Codex command is inside WindowsApps and will not be spawned directly because it can fail with EPERM in the bundled MCP runtime.",
      );
      const fallbackCandidates = findWindowsCodexFallbacks(
        options.homeDirectory ?? homedir(),
        fileAccess,
      );
      candidates.push(...fallbackCandidates);
      const fallback = fallbackCandidates.find(
        (fallbackCandidate) =>
          fallbackCandidate.exists &&
          fallbackCandidate.readable &&
          fallbackCandidate.directory === false,
      );
      if (fallback !== undefined) {
        selectedCommand = fallback.path;
        commandSource = "windows-safe-fallback";
        commandKind = fallback.kind;
        fallbackReason =
          "The explicitly configured WindowsApps Codex executable was rejected before spawn because it can return EPERM from the bundled MCP runtime.";
      }
    }
  } else {
    const fromPath = findExecutableOnPath(
      requestedCommand,
      environment,
      platform,
      fileAccess,
    );
    candidates.push(...fromPath);

    const safePathCandidate = fromPath.find(
      (candidate) =>
        candidate.exists &&
        candidate.readable &&
        candidate.directory === false &&
        (platform !== "win32" || !isWindowsAppsPath(candidate.path)),
    );
    if (safePathCandidate !== undefined) {
      selectedCommand = safePathCandidate.path;
      commandSource = "path";
      commandKind = safePathCandidate.kind;
    } else if (platform === "win32" && isCodexCommandName(requestedCommand)) {
      const blockedWindowsAppsCandidate = fromPath.find(
        (candidate) =>
          candidate.exists &&
          candidate.readable &&
          candidate.directory === false &&
          isWindowsAppsPath(candidate.path),
      );
      if (blockedWindowsAppsCandidate !== undefined) {
        warnings.push(
          "A WindowsApps Codex command was found on PATH and will not be spawned directly because it can fail with EPERM in the bundled MCP runtime.",
        );
      }

      const fallbackCandidates = findWindowsCodexFallbacks(
        options.homeDirectory ?? homedir(),
        fileAccess,
      );
      candidates.push(...fallbackCandidates);
      const fallback = fallbackCandidates.find(
        (candidate) =>
          candidate.exists && candidate.readable && candidate.directory === false,
      );
      if (fallback !== undefined) {
        selectedCommand = fallback.path;
        commandSource = "windows-safe-fallback";
        commandKind = fallback.kind;
        fallbackReason =
          blockedWindowsAppsCandidate === undefined
            ? "No readable non-WindowsApps Codex executable was found on PATH."
            : "A WindowsApps Codex executable was rejected before spawn because it can return EPERM from the bundled MCP runtime.";
      }
    }
  }

  if (selectedCommand === null) {
    warnings.push("No readable Codex executable could be resolved.");
    const diagnostic = buildDiagnostic({
      platform,
      arch: options.arch ?? process.arch,
      execPath: options.execPath ?? process.execPath,
      environment,
      requestedCommand,
      selectedCommand,
      commandSource,
      commandKind,
      args,
      cwdProbe,
      candidates,
      fallbackReason,
      warnings,
    });
    throw new AppServerLaunchError(
      `Unable to resolve a readable Codex executable for ${requestedCommand}`,
      diagnostic,
    );
  }

  if (platform === "win32" && commandKind === "other") {
    warnings.push(
      "Windows App Server launch only accepts .exe, .cmd, or .bat command files.",
    );
    const diagnostic = buildDiagnostic({
      platform,
      arch: options.arch ?? process.arch,
      execPath: options.execPath ?? process.execPath,
      environment,
      requestedCommand,
      selectedCommand,
      commandSource,
      commandKind,
      args,
      cwdProbe,
      candidates,
      fallbackReason,
      warnings,
    });
    throw new AppServerLaunchError(
      `Unsupported Windows Codex command type: ${selectedCommand}`,
      diagnostic,
    );
  }

  const spawnSpec = buildSpawnSpec({
    platform,
    command: selectedCommand,
    kind: commandKind,
    args,
    cwd,
    env: environment,
  });
  if (spawnSpec.error !== null) {
    warnings.push(spawnSpec.error);
    const diagnostic = buildDiagnostic({
      platform,
      arch: options.arch ?? process.arch,
      execPath: options.execPath ?? process.execPath,
      environment,
      requestedCommand,
      selectedCommand,
      commandSource,
      commandKind,
      args,
      cwdProbe,
      candidates,
      fallbackReason,
      warnings,
      spawnCommand: spawnSpec.command,
      spawnArgs: spawnSpec.args,
    });
    throw new AppServerLaunchError(spawnSpec.error, diagnostic);
  }

  const diagnostic = buildDiagnostic({
    platform,
    arch: options.arch ?? process.arch,
    execPath: options.execPath ?? process.execPath,
    environment,
    requestedCommand,
    selectedCommand,
    commandSource,
    commandKind,
    args,
    cwdProbe,
    candidates,
    fallbackReason,
    warnings,
    spawnCommand: spawnSpec.command,
    spawnArgs: spawnSpec.args,
  });
  return {
    command: spawnSpec.command,
    args: spawnSpec.args,
    options: {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
    diagnostic,
  };
}

/** Launch a resolved App Server process and preserve all synchronous spawn fields. */
export function launchAppServerProcess(
  options: LaunchAppServerProcessOptions = {},
): LaunchedAppServerProcess {
  const plan = resolveAppServerLaunch(options);
  const spawnProcess = options.spawnProcess ?? defaultSpawn;
  try {
    return {
      child: spawnProcess(plan.command, plan.args, plan.options),
      diagnostic: plan.diagnostic,
    };
  } catch (error) {
    throw new AppServerLaunchError(
      `Could not spawn Codex App Server: ${toError(error).message}`,
      plan.diagnostic,
      { cause: error },
    );
  }
}

/** Extract the useful Node child_process fields without exposing process.env. */
export function extractAppServerSpawnError(
  error: unknown,
): AppServerSpawnErrorDetails {
  const record = isRecord(error) ? error : {};
  const spawnargs = Array.isArray(record.spawnargs)
    ? record.spawnargs.filter((value): value is string => typeof value === "string")
    : null;
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    code:
      typeof record.code === "string" || typeof record.code === "number"
        ? record.code
        : null,
    errno: typeof record.errno === "number" ? record.errno : null,
    syscall: typeof record.syscall === "string" ? record.syscall : null,
    path: typeof record.path === "string" ? record.path : null,
    spawnargs,
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

function normalizeCommand(command: string): string {
  const normalized = command.trim();
  if (normalized.length === 0 || /[\r\n\u0000]/u.test(normalized)) {
    throw new Error("Codex command must be a non-empty single path or command name");
  }
  return normalized;
}

function validateArguments(args: readonly string[]): readonly string[] {
  if (args.length === 0) {
    throw new Error("Codex App Server arguments must not be empty");
  }
  return args.map((argument) => {
    if (argument.length === 0 || /[\r\n\u0000]/u.test(argument)) {
      throw new Error("Codex App Server arguments must be non-empty single-line strings");
    }
    return argument;
  });
}

function resolveCommandPath(command: string, cwd: string): string | null {
  if (isAbsolute(command)) {
    return resolve(command);
  }
  if (command.includes("/") || command.includes("\\")) {
    return resolve(cwd, command);
  }
  return null;
}

function findExecutableOnPath(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileAccess: AppServerLauncherFileAccess,
): AppServerCommandCandidate[] {
  const rawPath = environment.PATH ?? environment.Path ?? "";
  const extensions = executableExtensions(command, environment, platform);
  const candidates: AppServerCommandCandidate[] = [];
  const seen = new Set<string>();

  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  for (const entry of rawPath.split(pathDelimiter)) {
    if (entry.trim().length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const target = resolve(entry, `${command}${extension}`);
      const key = platform === "win32" ? target.toLowerCase() : target;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const candidate = makeCandidate(target, "path", fileAccess);
      if (candidate.exists) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function executableExtensions(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): readonly string[] {
  if (platform !== "win32" || extname(command).length > 0) {
    return [""];
  }
  const rawPathext = environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const values = rawPathext
    .split(";")
    .map((value) => value.trim())
    .filter((value) => /^\.[a-z0-9]+$/iu.test(value));
  // Never probe the extensionless `codex` entry on Windows. In this exact
  // host it resolves to a Linux ELF alongside codex.exe, and Node's direct
  // spawn can synchronously return EPERM before it ever considers PATHEXT.
  // The launcher explicitly supports only the three command kinds below.
  const permitted = [".EXE", ".CMD", ".BAT"].filter((extension) =>
    values.some((value) => value.toUpperCase() === extension),
  );
  return permitted.length > 0 ? permitted : [".EXE", ".CMD", ".BAT"];
}

function findWindowsCodexFallbacks(
  homeDirectory: string,
  fileAccess: AppServerLauncherFileAccess,
): AppServerCommandCandidate[] {
  const fallbackPaths = [
    resolve(homeDirectory, ".codex", ".sandbox-bin", "codex.exe"),
    resolve(homeDirectory, ".codex", "plugins", ".plugin-appserver", "codex.exe"),
  ];
  return fallbackPaths.map((target) =>
    makeCandidate(target, "windows-safe-fallback", fileAccess),
  );
}

function makeCandidate(
  target: string,
  source: AppServerCommandCandidate["source"],
  fileAccess: AppServerLauncherFileAccess,
): AppServerCommandCandidate {
  const probe = probePath(target, fileAccess);
  const kind = classifyCommand(target);
  return {
    ...probe,
    source,
    kind,
    rejectedReason:
      probe.directory === true
        ? "Candidate is a directory, not an executable file."
        : isWindowsAppsPath(target)
        ? "WindowsApps candidate is not safe to spawn directly from the bundled MCP runtime."
        : null,
  };
}

function probePath(
  target: string,
  fileAccess: AppServerLauncherFileAccess,
): AppServerFileProbe {
  const exists = fileAccess.exists(target);
  return {
    path: target,
    exists,
    readable: exists && fileAccess.readable(target),
    directory: exists ? fileAccess.directory(target) : null,
  };
}

function classifyCommand(command: string): AppServerCommandKind {
  switch (extname(command).toLowerCase()) {
    case ".exe":
      return "exe";
    case ".cmd":
      return "cmd";
    case ".bat":
      return "bat";
    default:
      return "other";
  }
}

function buildSpawnSpec(input: {
  readonly platform: NodeJS.Platform;
  readonly command: string;
  readonly kind: AppServerCommandKind;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): { readonly command: string; readonly args: readonly string[]; readonly error: string | null } {
  if (input.platform !== "win32" || input.kind !== "cmd" && input.kind !== "bat") {
    return { command: input.command, args: input.args, error: null };
  }

  const comSpec = input.env.ComSpec ?? input.env.COMSPEC;
  if (comSpec === undefined || comSpec.trim().length === 0) {
    return {
      command: input.command,
      args: input.args,
      error: "ComSpec is required to safely start a .cmd or .bat Codex command on Windows.",
    };
  }
  if (!isAbsolute(comSpec)) {
    return {
      command: input.command,
      args: input.args,
      error: "ComSpec must resolve to an absolute cmd.exe path.",
    };
  }
  const resolvedComSpec = resolve(comSpec);
  if (CMD_UNSAFE_CHARACTERS.test(input.command)) {
    return {
      command: resolvedComSpec,
      args: [],
      error: "The .cmd/.bat Codex path contains unsafe cmd.exe metacharacters.",
    };
  }
  for (const argument of input.args) {
    if (CMD_UNSAFE_CHARACTERS.test(argument)) {
      return {
        command: resolvedComSpec,
        args: [],
        error: "Codex .cmd/.bat arguments contain unsafe cmd.exe metacharacters.",
      };
    }
  }

  const commandLine = [
    quoteForCmd(input.command),
    ...input.args.map(quoteForCmd),
  ].join(" ");
  return {
    command: resolvedComSpec,
    args: ["/d", "/s", "/c", commandLine],
    error: null,
  };
}

function quoteForCmd(value: string): string {
  return `"${value}"`;
}

function buildDiagnostic(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly execPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly requestedCommand: string;
  readonly selectedCommand: string | null;
  readonly commandSource: AppServerCommandSource;
  readonly commandKind: AppServerCommandKind;
  readonly args: readonly string[];
  readonly cwdProbe: AppServerFileProbe;
  readonly candidates: readonly AppServerCommandCandidate[];
  readonly fallbackReason: string | null;
  readonly warnings: readonly string[];
  readonly spawnCommand?: string;
  readonly spawnArgs?: readonly string[];
}): AppServerLaunchDiagnostic {
  return {
    process: {
      platform: input.platform,
      arch: input.arch,
      execPath: input.execPath,
    },
    environment: {
      ComSpec: input.environment.ComSpec ?? input.environment.COMSPEC ?? null,
      PATH: input.environment.PATH ?? input.environment.Path ?? null,
      PATHEXT: input.environment.PATHEXT ?? null,
      CODEX_HOME: input.environment.CODEX_HOME ?? null,
    },
    requestedCommand: input.requestedCommand,
    selectedCommand: input.selectedCommand,
    commandSource: input.commandSource,
    commandKind: input.commandKind,
    appServerArgs: [...input.args],
    spawnCommand: input.spawnCommand ?? null,
    spawnArgs: [...(input.spawnArgs ?? [])],
    cwd: input.cwdProbe,
    candidates: input.candidates.map((candidate) => ({ ...candidate })),
    fallbackReason: input.fallbackReason,
    directCmdSpawnWouldBeUnsafe:
      input.commandKind === "cmd" || input.commandKind === "bat",
    warnings: [...input.warnings],
  };
}

function isCodexCommandName(command: string): boolean {
  return command.toLowerCase() === "codex" || command.toLowerCase() === "codex.exe";
}

function isCodexExecutablePath(target: string): boolean {
  const filename = basename(target).toLowerCase();
  return filename === "codex" || filename === "codex.exe";
}

function isWindowsAppsPath(target: string): boolean {
  return target.replaceAll("/", "\\").toLowerCase().includes("\\windowsapps\\");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
