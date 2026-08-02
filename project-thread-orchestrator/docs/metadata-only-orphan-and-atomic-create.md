# Metadata-only orphan audit and atomic-create contract

## Observed failed generation

The three ProjectCapsuleE2ETest IDs have registry/SQLite metadata, but a new App Server cannot read their turns and `thread/resume` returns `no rollout found for thread id`. They are therefore not recoverable stored threads.

The implementation that produced the generation sent `thread/start` with `ephemeral:false`. Its effective order was:

1. start one lazy App Server process and perform `initialize` → `initialized`;
2. call `thread/start`;
3. immediately copy the response ID into the formal registry and mark `CREATED`;
4. call `thread/name/set`, `thread/goal/set`, `turn/start`, wait, and `thread/read` on the same connection;
5. reuse that lazy connection until MCP shutdown.

It did not wait for `thread/started`, did not require a completed first turn before publishing the formal ID, and did not launch a fresh App Server to prove `thread/read(includeTurns=true)` → `thread/resume` → `thread/loaded/list`. The observed first turns failed (`thread not found` or Responses stream disconnection), so metadata existed without a durable rollout. The code does not prove that an early process close alone caused the loss; the precise defect is that unsuccessful/unverified rollout persistence was still committed as a created thread.

## Fixed commit protocol

Each milestone now uses a creation session followed by a fresh verification session. The formal `thread_id` remains null while the response ID is kept in `provisional_thread_id`. The registry transitions through `RESERVED`, `CREATING`, `VERIFYING_PERSISTENCE`, then `CREATED` only after a fresh process can resume the same ID, list it as loaded, and read the expected name, canonical cwd, and completed first turn.

Any missing `thread/started`, explicit first-turn failure, close failure, no-rollout resume, loaded-list mismatch, or final-read mismatch becomes `CREATE_PERSISTENCE_FAILED`. Later milestones are not started, no replacement is created automatically, and READY/WAITING is not published.

## ORPHAN_METADATA_ONLY proof

Classification requires all of the following evidence:

- a registry-owned thread ID;
- metadata in `thread/list` (or an independently audited SQLite record);
- unreadable history from `thread/read(includeTurns=true)`;
- `thread/resume` explicitly reports no rollout;
- no active or archived recoverable rollout.

`preview_orphan_thread_cleanup` performs the read-only public-RPC portion and binds the preview to exact registry-owned IDs. This build intentionally has no deletion execution tool. The generated local protocol confirms `thread/delete({threadId})` exists, but a future destructive tool must require a fresh explicit confirmation and repeat every proof before invoking it.
