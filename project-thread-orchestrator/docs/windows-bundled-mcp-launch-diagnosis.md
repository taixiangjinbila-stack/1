# Windows bundled MCP App Server launch diagnosis

Date: 2026-08-01

## Scope

This record covers the installed bundled MCP runtime only. It did not call
`create_project_threads`, did not alter `ProjectCapsuleE2ETest`, and did not
create, archive, or delete any Codex thread.

## Failure point and evidence

The only production App Server child-process call was the direct
`child_process.spawn()` in `mcp-server/src/app-server-client.ts`. The installed
`0.1.0` bundle used the bare command `codex` with `shell: false`.

The actual Windows resolution placed an extensionless Linux ELF named `codex`
ahead of `codex.exe` in the packaged WindowsApps resources. Direct Node spawn
from the bundled MCP runtime failed synchronously, before an `error` event or
any App Server RPC:

```json
{
  "name": "Error",
  "message": "spawn EPERM",
  "code": "EPERM",
  "errno": -4048,
  "syscall": "spawn",
  "path": null,
  "spawnargs": null,
  "cwd": "<installed-plugin-root>",
  "platform": "win32",
  "arch": "x64"
}
```

The packaged `codex.exe` is also blocked by the host execution policy in this
MCP runtime. This is a command-resolution/ACL boundary, not a plan, registry,
`thread/start`, or idempotency failure. All three failed milestone records
remained `CREATE_FAILED` with `thread_id: null`; no orphan or duplicate thread
was created.

## Minimal fix

`mcp-server/src/app-server-launcher.ts` now owns all App Server process
launches:

- Windows resolves a concrete absolute file instead of spawning bare `codex`.
- A normal `.exe` is started directly with `shell: false` and `windowsHide`.
- A `.cmd` or `.bat` is started only through an absolute `ComSpec` with fixed
  `/d /s /c` arguments; user plan content is never interpolated into a shell.
- WindowsApps candidates are rejected before spawn. If necessary, the resolver
  uses the readable Codex runtime copy at
  `%USERPROFILE%\.codex\.sandbox-bin\codex.exe`, recording that host-runtime
  compatibility fallback in the diagnostic object.
- Synchronous spawn errors preserve `name`, `message`, `code`, `errno`,
  `syscall`, `path`, and `spawnargs`. A stalled initial handshake is
  non-ambiguous, terminates the child, and is safe to retry.
- `thread_id` is still assigned only after a successful `thread/start` result.

The fallback remains a local Codex runtime implementation detail, not a new
protocol or UI-automation route. If it is absent or blocked, the launcher
fails closed; it does not enable full access, broaden approvals, or invoke a
shell fallback.

## Read-only diagnostic

The bundled development script is:

```powershell
node "<installed-plugin-root>\mcp-server\dist\diagnose_app_server_launch.js" --json
```

It only resolves the command, probes the executable/cwd, runs `codex
--version`, performs `initialize` then `initialized`, and closes the child. It
does not construct any thread RPC or touch a registry/project file. Captured
stdout/stderr and environment data are structurally redacted before output;
only `ComSpec`, `PATH`, `PATHEXT`, and `CODEX_HOME` are included from the
environment.

On this machine the diagnostic selected
`C:\Users\Lenovo\.codex\.sandbox-bin\codex.exe`, returned
`codex-cli 0.146.0-alpha.9.2`, and completed the public stdio handshake.

## Tests

The launcher test suite covers direct `.exe`, `.cmd`/`.bat` through `ComSpec`,
missing `ComSpec`, missing PATH command, invalid cwd, synchronous `EPERM`,
WindowsApps fallback, handshake timeout, invalid handshake response, and
three failed creates with null IDs followed by a safe retry. No test creates a
real Codex thread.

## Installation status

The cache-busted package version is
`0.1.1+codex.local-20260801-145640`. Its fresh source build passed all local
quality gates. A first cache copy was created, but a subsequent formal
reinstall could not back up the in-use cache entry (`os error 5: Access is
denied`). Do not delete or overwrite the old cache manually. Fully exit/restart
Codex Desktop to release the active plugin cache, then rerun the official
local marketplace install command and verify the installed bundle's
`serverInfo.version` before any E2E retry.
