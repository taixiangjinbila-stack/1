import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const AuditEntrySchema = z
  .object({
    milestone_id: z.string().min(1),
    old_thread_id: z.string().min(1),
    error_reason: z.string().min(1),
    classification: z.literal("ORPHAN_METADATA_ONLY"),
    evidence: z.record(z.string(), z.unknown()),
    preview_digest: z.string().length(64),
    operation_id: z.string().uuid(),
    cleanup_time: z.string().datetime().nullable(),
    app_server_delete_result: z.enum(["DELETED", "ALREADY_ABSENT", "CLEANUP_FAILED"]),
    reconciliation_result: z.enum(["ORPHAN_RECONCILED", "NOT_RECONCILED"]),
    replacement_thread_id: z.string().min(1).nullable(),
  })
  .strict();

const LegacyAuditEntrySchema = z.object({
  milestone_id: z.string().min(1),
  old_thread_id: z.string().min(1),
  error_reason: z.string().min(1),
  classification: z.literal("ORPHAN_METADATA_ONLY"),
  evidence: z.record(z.string(), z.unknown()),
  preview_digest: z.string().length(64),
  operation_id: z.string().uuid(),
  deleted_at: z.string().datetime().nullable(),
  deletion_result: z.enum(["DELETED", "FAILED"]),
  replacement_thread_id: z.string().min(1).nullable(),
}).strict();

const AuditSchema = z
  .object({
    schema_version: z.literal(1),
    entries: z.array(z.union([AuditEntrySchema, LegacyAuditEntrySchema])),
  })
  .strict();

export type OrphanCleanupAuditEntry = z.infer<typeof AuditEntrySchema>;

export function orphanCleanupAuditPathFor(projectCwd: string): string {
  return path.join(projectCwd, ".project-capsule", "orphan-cleanup-audit.json");
}

export function threadRegistryMarkdownPathFor(projectCwd: string): string {
  return path.join(projectCwd, "THREAD_REGISTRY.md");
}

export async function appendOrphanCleanupAudit(
  projectCwd: string,
  entries: OrphanCleanupAuditEntry[],
): Promise<void> {
  const target = orphanCleanupAuditPathFor(projectCwd);
  let existing: z.infer<typeof AuditSchema> = { schema_version: 1, entries: [] };
  try {
    existing = AuditSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw new Error(`orphan cleanup audit is corrupt; refusing to overwrite it: ${String(error)}`);
    }
  }
  await atomicWrite(target, `${JSON.stringify(AuditSchema.parse({
    schema_version: 1,
    entries: [...existing.entries, ...entries],
  }), null, 2)}\n`);
}

export async function appendThreadRegistryMarkdownAudit(
  projectCwd: string,
  entries: OrphanCleanupAuditEntry[],
): Promise<void> {
  const target = threadRegistryMarkdownPathFor(projectCwd);
  let existing = "# Thread Registry\n";
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
  const lines = [
    "",
    "## Orphan metadata cleanup audit",
    "",
    ...entries.map((entry) =>
      `- ${entry.milestone_id}: ${entry.app_server_delete_result} metadata-only orphan \`${entry.old_thread_id}\`; reconciliation: ${entry.reconciliation_result}; time ${entry.cleanup_time ?? "not reconciled"}; operation ${entry.operation_id}; replacement thread: ${entry.replacement_thread_id ?? "pending"}.`,
    ),
    "",
  ];
  await atomicWrite(target, `${existing.trimEnd()}\n${lines.join("\n")}`);
}

export async function recordOrphanReplacement(
  projectCwd: string,
  oldThreadId: string,
  replacementThreadId: string,
): Promise<void> {
  const target = orphanCleanupAuditPathFor(projectCwd);
  let existing: z.infer<typeof AuditSchema>;
  try {
    existing = AuditSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new Error(`orphan cleanup audit is corrupt; refusing to update replacement mapping: ${String(error)}`);
  }
  const entries = existing.entries.map((entry) =>
    entry.old_thread_id === oldThreadId && entry.replacement_thread_id === null
      ? { ...entry, replacement_thread_id: replacementThreadId }
      : entry,
  );
  await atomicWrite(target, `${JSON.stringify(AuditSchema.parse({ schema_version: 1, entries }), null, 2)}\n`);
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EEXIST"))) {
      await safeUnlink(temporary);
      throw error;
    }
    await writeFile(target, content, "utf8");
    await safeUnlink(temporary);
  }
}

async function safeUnlink(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
}
