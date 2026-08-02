# MCP workflow example

The public workflow deliberately spans at least two user turns.

1. Run `$project-thread-orchestrator:project-capsule-orchestrator`. Preserve the rich `.project-capsule/thread-plan.json`, derive and validate `.project-capsule/thread-create-plan.json`, then call `preview_project_threads` with that strict projection.
2. Show the complete dry-run result, including actions, differences, warnings, and confirmation expiry. Stop without creating anything.
3. After the user explicitly confirms the unchanged preview, call `create_project_threads` with the same plan, `dry_run: false`, and either `confirmed: true` or the returned `confirmation_token`.
4. Call `list_project_threads` to read the local registry. Use `sync_thread_registry` only when live App Server reconciliation is required.
5. Preview `archive_project_threads` first. Archive only after a separate explicit confirmation.

`create_project_threads` already performs the initialization-only turn. `initialize_project_threads` is a recovery operation for registered threads whose initialization did not finish; it is not a second creation route.

The two-thread manual smoke plan is intentionally unavailable as an MCP tool. It is isolated in `tests/manual-smoke.ts`, guarded by an environment variable and exact confirmation phrases, so the production 3–12 invariant cannot be weakened accidentally.
