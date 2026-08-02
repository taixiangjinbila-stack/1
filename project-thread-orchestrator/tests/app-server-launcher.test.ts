import path from "node:path";
import {
  AppServerLaunchError,
  DEFAULT_APP_SERVER_ARGS,
  launchAppServerProcess,
  resolveAppServerLaunch,
  type AppServerLauncherFileAccess,
} from "../mcp-server/src/app-server-launcher.js";

type VirtualEntry = {
  readonly readable?: boolean;
  readonly directory?: boolean;
};

const projectDirectory = "C:\\pto-launcher-tests\\project";
const executable = "C:\\pto-launcher-tests\\bin\\codex.exe";
const commandScript = "C:\\pto-launcher-tests\\bin\\codex.cmd";
const batchScript = "C:\\pto-launcher-tests\\bin\\codex.bat";
const comSpec = "C:\\Windows\\System32\\cmd.exe";

function normalized(target: string): string {
  return path.resolve(target).toLowerCase();
}

function virtualFileAccess(
  entries: Readonly<Record<string, VirtualEntry>>,
): AppServerLauncherFileAccess {
  const mapped = new Map(
    Object.entries(entries).map(([target, entry]) => [normalized(target), entry]),
  );
  return {
    exists: (target) => mapped.has(normalized(target)),
    readable: (target) => mapped.get(normalized(target))?.readable ?? false,
    directory: (target) => {
      const entry = mapped.get(normalized(target));
      return entry === undefined ? null : entry.directory ?? false;
    },
  };
}

function filesFor(...commands: string[]): AppServerLauncherFileAccess {
  return virtualFileAccess({
    [projectDirectory]: { readable: true, directory: true },
    ...Object.fromEntries(
      commands.map((command) => [command, { readable: true, directory: false }]),
    ),
  });
}

function windowsEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "C:\\pto-launcher-tests\\bin",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: comSpec,
    ...overrides,
  };
}

describe("Windows App Server launcher", () => {
  it("spawns an absolute .exe directly with fixed App Server arguments", () => {
    const plan = resolveAppServerLaunch({
      command: executable,
      cwd: projectDirectory,
      env: windowsEnvironment(),
      platform: "win32",
      fileAccess: filesFor(executable),
    });

    expect(plan.command).toBe(path.resolve(executable));
    expect(plan.args).toEqual(DEFAULT_APP_SERVER_ARGS);
    expect(plan.options).toMatchObject({
      cwd: path.resolve(projectDirectory),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(plan.diagnostic).toMatchObject({
      commandKind: "exe",
      commandSource: "explicit",
      directCmdSpawnWouldBeUnsafe: false,
      spawnCommand: path.resolve(executable),
      spawnArgs: [...DEFAULT_APP_SERVER_ARGS],
    });
  });

  it.each([
    [".cmd", commandScript, "cmd"],
    [".bat", batchScript, "bat"],
  ] as const)(
    "uses absolute ComSpec and a fixed /d /s /c command line for %s launchers",
    (_extension, command, kind) => {
      const plan = resolveAppServerLaunch({
        command,
        cwd: projectDirectory,
        env: windowsEnvironment(),
        platform: "win32",
        fileAccess: filesFor(command),
      });

      expect(plan.command).toBe(path.resolve(comSpec));
      expect(plan.args).toEqual([
        "/d",
        "/s",
        "/c",
        `"${path.resolve(command)}" "app-server" "--listen" "stdio://"`,
      ]);
      expect(plan.options).toMatchObject({ shell: false, windowsHide: true });
      expect(plan.diagnostic).toMatchObject({
        commandKind: kind,
        directCmdSpawnWouldBeUnsafe: true,
        spawnCommand: path.resolve(comSpec),
      });
      expect(plan.command).not.toBe(path.resolve(command));
    },
  );

  it("rejects a .cmd command when ComSpec is unavailable", () => {
    expect(() =>
      resolveAppServerLaunch({
        command: commandScript,
        cwd: projectDirectory,
        env: windowsEnvironment({ ComSpec: undefined, COMSPEC: undefined }),
        platform: "win32",
        fileAccess: filesFor(commandScript),
      }),
    ).toThrow(/ComSpec is required/u);
  });

  it("rejects an unresolved bare codex command when PATH has no executable", () => {
    try {
      resolveAppServerLaunch({
        command: "codex",
        cwd: projectDirectory,
        env: { PATH: "C:\\does-not-exist", PATHEXT: ".EXE" },
        platform: "win32",
        homeDirectory: "C:\\no-fallback",
        fileAccess: filesFor(),
      });
      throw new Error("Expected codex command resolution to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerLaunchError);
      expect((error as AppServerLaunchError).message).toMatch(
        /Unable to resolve a readable Codex executable/u,
      );
      expect((error as AppServerLaunchError).diagnostic.commandSource).toBe(
        "unresolved",
      );
    }
  });

  it("rejects a non-existent cwd before attempting command resolution", () => {
    try {
      resolveAppServerLaunch({
        command: executable,
        cwd: "C:\\pto-launcher-tests\\missing-project",
        env: windowsEnvironment(),
        platform: "win32",
        fileAccess: filesFor(executable),
      });
      throw new Error("Expected cwd validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AppServerLaunchError);
      const launchError = error as AppServerLaunchError;
      expect(launchError.message).toMatch(/cwd is not an existing directory/u);
      expect(launchError.diagnostic.cwd).toMatchObject({
        exists: false,
        directory: null,
      });
    }
  });

  it("preserves synchronous spawn EPERM fields and logs only the approved environment metadata", () => {
    const spawnError = Object.assign(new Error("spawn EPERM"), {
      code: "EPERM",
      errno: -4048,
      syscall: "spawn",
      path: executable,
      spawnargs: [...DEFAULT_APP_SERVER_ARGS],
    });
    let caught: AppServerLaunchError | null = null;

    try {
      launchAppServerProcess({
        command: executable,
        cwd: projectDirectory,
        env: windowsEnvironment({ PTO_TEST_SECRET: "must-not-leak" }),
        platform: "win32",
        fileAccess: filesFor(executable),
        spawnProcess: () => {
          throw spawnError;
        },
      });
    } catch (error) {
      if (error instanceof AppServerLaunchError) {
        caught = error;
      }
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toBe("Could not spawn Codex App Server: spawn EPERM");
    expect(caught?.details).toEqual({
      name: "Error",
      message: "spawn EPERM",
      code: "EPERM",
      errno: -4048,
      syscall: "spawn",
      path: executable,
      spawnargs: [...DEFAULT_APP_SERVER_ARGS],
    });
    expect(Object.keys(caught?.diagnostic.environment ?? {}).sort()).toEqual([
      "CODEX_HOME",
      "ComSpec",
      "PATH",
      "PATHEXT",
    ]);
    expect(JSON.stringify(caught?.diagnostic)).not.toContain("must-not-leak");
  });

  it("rejects a WindowsApps PATH candidate and uses the readable sandbox fallback", () => {
    const windowsAppsDirectory = "C:\\Program Files\\WindowsApps";
    const windowsAppsCodex = `${windowsAppsDirectory}\\codex.exe`;
    const homeDirectory = "C:\\Users\\LauncherTest";
    const sandboxCodex = `${homeDirectory}\\.codex\\.sandbox-bin\\codex.exe`;
    const fileAccess = virtualFileAccess({
      [projectDirectory]: { readable: true, directory: true },
      [windowsAppsCodex]: { readable: true, directory: false },
      [sandboxCodex]: { readable: true, directory: false },
    });

    const plan = resolveAppServerLaunch({
      command: "codex",
      cwd: projectDirectory,
      env: windowsEnvironment({ PATH: windowsAppsDirectory }),
      platform: "win32",
      homeDirectory,
      fileAccess,
    });

    expect(plan.command).toBe(path.resolve(sandboxCodex));
    expect(plan.diagnostic).toMatchObject({
      commandSource: "windows-safe-fallback",
      commandKind: "exe",
      fallbackReason: expect.stringMatching(/WindowsApps/u),
    });
    expect(
      plan.diagnostic.candidates.some(
        (candidate) =>
          candidate.path.toLowerCase() ===
            path.resolve(windowsAppsCodex).toLowerCase() &&
          /WindowsApps/u.test(candidate.rejectedReason ?? ""),
      ),
    ).toBe(true);
  });
});
