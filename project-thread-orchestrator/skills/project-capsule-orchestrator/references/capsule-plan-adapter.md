# Rich Capsule Plan Adapter

Use this adapter when collaborating with the standalone `project-capsule-orchestrator` Skill. Its
validated `.project-capsule/thread-plan.json` is the durable, rich planning record; it is not the
strict request body accepted by this plugin.

Never overwrite or weaken the rich plan. Derive and save a separate execution projection:

```text
.project-capsule/thread-create-plan.json
```

The projection contains exactly:

```json
{
  "project_cwd": "C:\\absolute\\project",
  "project_name": "Project name",
  "initialize_only": true,
  "threads": []
}
```

## Deterministic field mapping

For each source `milestones[]` item:

| Strict field | Rich source and rule |
| --- | --- |
| `milestone_id` | Copy exactly. |
| `name` | Remove exactly the leading `<milestone_id><space>` from the rich full title. Reject a mismatched prefix; do not guess. |
| `goal` | Copy exactly. |
| `initial_prompt` | Copy exactly. Rich rationale, risks, gates, and other durable context remain in the capsule files that initialization reads. |
| `dependencies` | Copy exactly, preserving the validated DAG. |
| `allowed_paths` | Copy exactly. An empty list is valid only when the derived sandbox is `read-only`. |
| `forbidden_paths` | Copy exactly. |
| `acceptance_criteria` | Copy exactly. |
| `validation_commands` | Copy exactly; reject the projection if the plugin's stricter safety validator rejects any command. Never silently rewrite a command. |
| `initial_status` | Map `READY` to `READY`; map `DRAFT`, `WAITING`, and `BLOCKED` to `WAITING`. Reject `ACTIVE`, `REVIEW`, `DONE`, or `ARCHIVED` for new-thread creation and ask the user to reconcile project state. |
| `sandbox_mode` | Map `readonly` to `read-only`; map `local` or `worktree` to `workspace-write`; map `hardware-gated` or `production-gated` to `read-only` and require the derived status to be `WAITING`. |

Before preview, fail closed unless:

- the source rich plan passed its own schema and validator;
- every milestone `project_cwd` resolves to the same canonical top-level `project_cwd`;
- source and projection contain the same 3–12 milestone IDs and identical dependencies;
- every transformed name has a non-empty concise suffix;
- every open safety gate forces each affected milestone to `WAITING`;
- `workspace-write` has at least one `allowed_paths` entry;
- the strict projection passes the discovered `preview_project_threads` input schema.

Show both file paths and explain that the source is authoritative planning memory while the
projection is a lossless execution boundary for the fields the MCP server needs. Any source-plan
change invalidates the projection, preview, digest, and confirmation.

When this plugin is installed alongside a standalone Skill with the same base name, explicitly use
the namespaced invocation:

```text
$project-thread-orchestrator:project-capsule-orchestrator
```

Do not rely on an unqualified `$project-capsule-orchestrator` when both are discoverable.
