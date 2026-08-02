# Real Codex App Server smoke test

## Result

The two-thread real App Server smoke test, its guarded idempotency
rerun, and the explicitly confirmed archive flow passed. No new thread
was created by the rerun, no initialization turn was started again,
and both existing threads were archived without deletion.

- Test project:
  `C:\Users\Lenovo\Documents\CodexThreadSmokeTest`
- Canonical cwd used by both threads:
  `C:\Users\Lenovo\Documents\CodexThreadSmokeTest`
- Desktop project: `CodexThreadSmokeTest`
- Idempotency verification time:
  `2026-07-30 02:11:40 +08:00`
- Archive execution:
  - M0: `2026-07-30 02:23:31.662 +08:00`
  - M1: `2026-07-30 02:23:31.687 +08:00`
- Archive verification record:
  `2026-07-30 02:23:35.545 +08:00`

## Runtime versions

- Codex Desktop package: `26.721.4979.0`
- Codex CLI and App Server: `codex-cli 0.146.0-alpha.3.1`
- Node.js: `v24.16.0`
- npm: `11.13.0`

The App Server handshake identified itself as
`Codex Desktop/0.146.0-alpha.3.1` on Windows. The audited executable was
`C:\Users\Lenovo\.codex\.sandbox-bin\codex.exe`.

## Threads and initialization

| Milestone | Visible name | Thread ID | Initialization turn | Result |
| --- | --- | --- | --- | --- |
| M0 | M0 测试信息确认 | `019faf02-e1bf-7263-8abd-74e2ff72cc69` | `019faf02-eca6-7823-b0f0-46ffc97464f6` (`completed`) | `READY` |
| M1 | M1 测试构建基线 | `019faf03-1734-7b52-a515-a53fd82fdbe4` | `019faf03-2067-7510-98f5-11d044e2f663` (`completed`) | `WAITING` |

Before archival, fresh `thread/list` queries used the exact canonical
cwd, requested `cli`, `vscode`, and `appServer` source kinds, excluded
archived threads, and used a page size of 100. The result contained
exactly the two IDs above. Fresh `thread/read` calls confirmed both
visible names, the same exact cwd, the two completed initialization
turns, and the expected terminal replies. No command execution, file
change, MCP tool call, dynamic tool call, or web-search item was
present in either initialization turn.

The returned `sourceKind` was `vscode`, which is the source identity
used by this Codex Desktop build for these persisted tasks.

## Desktop visibility and project grouping

The user manually verified in Codex Windows Desktop that:

- the project `CodexThreadSmokeTest` is visible;
- `M0 测试信息确认` and `M1 测试构建基线` are both visible;
- both tasks are grouped under that same project.

This is a manual observation. The test did not use mouse, keyboard,
window-coordinate, or other UI automation.

## Idempotency rerun

The rerun used the same project cwd, project name, milestone IDs,
visible names, goals, prompts, dependency graph, path policy,
acceptance criteria, validation commands, initial statuses, sandbox
mode, and plan digest as the original run.

Before the formal create flow, a fail-closed preflight required:

- exactly two active threads and zero archived threads;
- exact equality with both approved thread IDs;
- exact visible names and canonical cwd.

The preview returned `reuse` for M0 and M1. The formal create flow then
returned:

- classification: `EXISTING_NOT_RECREATED`;
- `created: []`;
- two original entries in `reused`;
- `failed: []`;
- active thread count after reconciliation: `2`.

The reuse branch did not call `thread/start`, `thread/name/set`,
`thread/goal/set`, or `turn/start`. Independent `thread/read` snapshots
taken before and after the flow showed unchanged thread IDs, names,
cwd values, creation/update timestamps, turn IDs, turn statuses, and
turn contents. Therefore no initialization turn was repeated and no
existing history was changed.

## Registries

The two files have separate, backward-compatible responsibilities:

- `C:\Users\Lenovo\Documents\CodexThreadSmokeTest\.project-capsule\thread-registry.json`
  is the operational registry. Each milestone records its milestone
  ID, real thread ID, expected and live visible name, canonical and
  live cwd, current milestone/live status, initialization turn and
  status, creation time, last synchronization time, and archive time.
- `C:\Users\Lenovo\Documents\CodexThreadSmokeTest\.project-capsule\smoke-test-registry.json`
  is the test evidence record. It records the real preflight and
  postflight lists, full read verification, initialization results,
  idempotency preview/result, archive preview/result, registry
  synchronization result, manual desktop visibility, and correct
  project grouping. The prior idempotency evidence is retained inside
  `prior_test_record`.

The operational registry was synchronized at
`2026-07-30 02:23:34 +08:00`. Recovery is not required. Both records
have `status: "ARCHIVED"`, `archived: true`, and non-null
`archived_at` values while retaining their original `created_at`,
initialization turn IDs, completion states, and result summaries. The
smoke registry keeps `archive_allowed: false`. No existing registry
was deleted or replaced with an incompatible schema.

## Reconciliation result

- Active threads for the canonical cwd: `0`
- Archived threads for the canonical cwd: `2`
- Duplicate threads: `0`
- Orphan threads: `0`
- Failed threads: `0`
- Unknown project threads: `0`

## Archive execution and verification

The current Codex session did not expose the locally developed plugin
as an already-installed MCP tool. To avoid bypassing the plugin, the
test started its built stdio MCP Server and invoked its registered
`archive_project_threads` tool. That tool called the public Codex App
Server `thread/archive` method.

The fail-closed preflight used `thread/list` and `thread/read` and
required exact equality for both approved IDs, their visible names,
the canonical cwd, and the active/non-archived state. The archive
preview contained exactly M0 followed by M1 and reported no
already-archived target. The formal result was:

- archived IDs:
  `019faf02-e1bf-7263-8abd-74e2ff72cc69` and
  `019faf03-1734-7b52-a515-a53fd82fdbe4`;
- failed targets: `0`;
- active query before/after: `2` / `0`;
- archived query before/after: `0` / `2`.

The post-archive archived query contained exactly those two IDs and no
other thread. `thread/read` continued to return both names, the exact
cwd, original creation timestamps, initialization turn IDs, user
messages, agent replies, and completed turn statuses. A structured
before/after comparison reported `complete_turn_history_preserved:
true`. No other thread was present under the cwd, so no unrelated
thread was archived.

The locally generated App Server protocol includes
`thread/unarchive`, so the underlying Codex store supports restoring an
archived thread. Codex Desktop can expose that capability. Plugin
version `0.1.0` does not yet expose a guarded
`unarchive_project_threads` tool, so restoration is not currently an
operation of this plugin. No unarchive was performed during this test.

## Known limitations

- Desktop visibility and sidebar project grouping require a human
  observation; the public App Server result alone does not prove what
  a particular rendered Desktop window currently shows. Post-archive
  placement in the Desktop archived view remains a manual check.
- This protocol version's `thread/read` result does not expose the
  stored long-term goal as a comparable field. The rerun's reuse path
  never invoked `thread/goal/set`, and all exposed metadata and history
  remained unchanged, but the goal cannot be independently read back
  through this response shape.
- The initialization agents returned the required terminal words, but
  their prose did not repeat the App Server display names accurately:
  M0 said `CodexThreadSmokeTest`, and M1 said `/root`. App Server
  metadata and the Desktop UI nevertheless showed the two requested
  names correctly.
- Runtime-generated fields that require the experimental API remain
  capability-gated. This smoke test used only fields accepted by the
  locally generated `0.146.0-alpha.3.1` protocol.

## Why this is not strict exactly-once

The local registry and the App Server's thread store are separate
durability domains and do not provide a shared transaction or
two-phase commit. `thread/start` also has no milestone-scoped
idempotency key. A process can therefore fail after the App Server
persists a thread but before its real ID is durably written to the
registry, or after a request is sent but before its outcome is known.

Reservations, a per-project lock, exact plan digests, fail-closed
ambiguous states, and `thread/list`/`thread/read` reconciliation make
normal repeated calls idempotent and reduce duplicate risk. They
cannot prove strict exactly-once behavior across every crash window,
so the supported guarantee remains “best effort duplicate avoidance
with explicit ambiguity recovery.”

## Final retained state

The two test threads are archived, not deleted. Their histories and
the dedicated test project remain intact. No global plugin install,
GitHub publication, OpenVibe change, replacement thread, or automatic
next-stage action was performed.
