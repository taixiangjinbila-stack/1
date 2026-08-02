import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { canonicalizeProjectCwd, formatUnknownError, validateProjectPlan } from "./plan-validator.js";
import { PLUGIN_VERSION, OrchestrateProjectCapsuleInputSchema, type ValidatedProjectPlan } from "./types.js";

const MANAGED_FILES = [
  "AGENTS.md", "SPEC.md", "FUTURES.md", "PLAN.md", "STATUS.md", "DECISIONS.md", "RISKS.md", "THREADS.md",
  ".project-capsule/plan-source.json", ".project-capsule/thread-plan.json", ".project-capsule/thread-create-plan.json",
] as const;
const HealthSchema = z.enum(["HEALTHY", "REPAIRABLE", "CONFLICT_REQUIRES_USER", "LEGACY_CAPSULE_MIGRATION_REQUIRED", "UNRECOVERABLE"]);
const ManifestSchema = z.object({
  schema_version: z.literal(1), plugin_version: z.string(), operation_id: z.string().uuid(), canonical_cwd: z.string(),
  generated_at: z.string().datetime(), last_verified_at: z.string().datetime(), health: HealthSchema,
  managed_files: z.record(z.string(), z.object({ owner: z.literal("PLUGIN_MANAGED"), checksum: z.string().length(64), classification: z.enum(["PLUGIN_MANAGED_UNCHANGED", "PLUGIN_MANAGED_DRIFTED", "USER_OWNED", "UNKNOWN", "CORRUPTED", "MISSING"]) }).strict()),
  migration_source: z.string().optional(), migration_audit_path: z.string().optional(), legacy_evidence: z.array(z.string()).optional(),
}).strict();
type CapsuleManifest = z.infer<typeof ManifestSchema>;
const LEGACY_MARKDOWN = ["AGENTS.md", "SPEC.md", "PLAN.md", "STATUS.md", "DECISIONS.md", "RISKS.md", "THREADS.md"] as const;

type LegacyMigration = { plan: ValidatedProjectPlan; evidence: string[]; warnings: string[]; thread_registry_present: boolean };

export class CapsuleService {
  public async doctor(raw: unknown): Promise<Record<string, unknown>> {
    const input = z.object({ project_cwd: z.string().trim().min(1) }).strict().parse(raw);
    const cwd = await canonicalizeProjectCwd(input.project_cwd);
    const result = await this.inspect(cwd);
    return { ok: result.health === "HEALTHY", project_cwd: cwd, ...result };
  }

  public async previewRepair(raw: unknown): Promise<Record<string, unknown>> {
    const input = z.object({ project_cwd: z.string().trim().min(1) }).strict().parse(raw);
    const cwd = await canonicalizeProjectCwd(input.project_cwd);
    const result = await this.inspect(cwd);
    return {
      ok: result.health === "REPAIRABLE" || result.health === "HEALTHY", project_cwd: cwd, health: result.health,
      actions: result.health === "REPAIRABLE" ? ["backup_plugin_managed_drift", "rebuild_from_plan_source", "atomic_apply", "revalidate"] : [],
      blockers: result.blockers, user_action_required: result.health === "CONFLICT_REQUIRES_USER",
    };
  }

  public async applyRepair(raw: unknown): Promise<Record<string, unknown>> {
    const input = z.object({ project_cwd: z.string().trim().min(1), confirmed: z.literal(true) }).strict().parse(raw);
    const cwd = await canonicalizeProjectCwd(input.project_cwd);
    const inspected = await this.inspect(cwd);
    if (inspected.health === "HEALTHY") return { ok: true, project_cwd: cwd, health: "HEALTHY", changed: false };
    if (inspected.health !== "REPAIRABLE" || inspected.plan === null) {
      return { ok: false, project_cwd: cwd, health: inspected.health, blockers: inspected.blockers };
    }
    await this.applyPlan(cwd, inspected.plan, true);
    return this.doctor({ project_cwd: cwd });
  }

  public async previewLegacyMigration(raw: unknown): Promise<Record<string, unknown>> {
    const input = z.object({ project_cwd: z.string().trim().min(1) }).strict().parse(raw);
    const cwd = await canonicalizeProjectCwd(input.project_cwd);
    const inspected = await this.inspect(cwd);
    if (inspected.health !== "LEGACY_CAPSULE_MIGRATION_REQUIRED") return { ok: false, project_cwd: cwd, health: inspected.health, blockers: inspected.blockers };
    const migration = await this.buildLegacyMigration(cwd);
    if (migration === null) return { ok: false, project_cwd: cwd, health: "CONFLICT_REQUIRES_USER", blockers: ["legacy sources do not contain a complete, non-conflicting M0-M2 plan"] };
    return { ok: true, project_cwd: cwd, health: inspected.health, message: "检测到旧版项目胶囊，可以安全升级。现有项目目标和线程不会被删除。", actions: ["stage_validated_canonical_plan", "backup_damaged_capsule_files", "atomic_apply", "revalidate"], evidence: migration.evidence, warnings: migration.warnings, existing_threads_preserved: migration.thread_registry_present, proposed_milestones: migration.plan.threads.map((task) => ({ milestone_id: task.milestone_id, name: task.name, dependencies: task.dependencies })) };
  }

  public async applyLegacyMigration(raw: unknown): Promise<Record<string, unknown>> {
    const input = z.object({ project_cwd: z.string().trim().min(1), confirmed: z.literal(true) }).strict().parse(raw);
    const cwd = await canonicalizeProjectCwd(input.project_cwd);
    const inspected = await this.inspect(cwd);
    if (inspected.health === "HEALTHY") return { ok: true, project_cwd: cwd, health: "HEALTHY", changed: false };
    if (inspected.health !== "LEGACY_CAPSULE_MIGRATION_REQUIRED") return { ok: false, project_cwd: cwd, health: inspected.health, blockers: inspected.blockers };
    const migration = await this.buildLegacyMigration(cwd);
    if (migration === null) return { ok: false, project_cwd: cwd, health: "CONFLICT_REQUIRES_USER", blockers: ["legacy sources do not contain a complete, non-conflicting M0-M2 plan"] };
    await this.applyLegacyPlan(cwd, migration.plan, migration.evidence);
    return this.doctor({ project_cwd: cwd });
  }

  public async orchestrate(raw: unknown): Promise<Record<string, unknown>> {
    const input = OrchestrateProjectCapsuleInputSchema.parse(raw);
    const { dry_run, confirmed, ...rawPlan } = input;
    const plan = await validateProjectPlan({ ...rawPlan, recreate_archived: false });
    if (dry_run) return { ok: true, dry_run: true, project_cwd: plan.project_cwd, milestone_count: plan.threads.length, next_step: "confirm capsule application" };
    if (!confirmed) return { ok: false, dry_run: false, message: "explicit confirmation is required before applying capsule files" };
    await this.applyPlan(plan.project_cwd, plan, false);
    return { ok: true, dry_run: false, project_cwd: plan.project_cwd, health: "HEALTHY", next_step: "preview_project_threads" };
  }

  private async inspect(cwd: string): Promise<{ health: z.infer<typeof HealthSchema>; blockers: string[]; plan: ValidatedProjectPlan | null; files: Record<string, string> }> {
    const capsule = path.join(cwd, ".project-capsule");
    const manifestPath = path.join(capsule, "capsule-manifest.json");
    const files: Record<string, string> = {};
    let manifest: CapsuleManifest | null = null;
    try { manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))); } catch { /* absent/corrupt handled below */ }
    let plan: ValidatedProjectPlan | null = null;
    let sourceValid = false;
    try { plan = await validateProjectPlan(JSON.parse(await readFile(path.join(capsule, "plan-source.json"), "utf8"))); sourceValid = true; } catch { /* no canonical repair source */ }
    const blockers: string[] = [];
    for (const relative of MANAGED_FILES) {
      const absolute = path.join(cwd, relative);
      try {
        const checksum = await checksumFile(absolute);
        const entry = manifest?.managed_files[relative];
        files[relative] = entry === undefined ? "UNKNOWN" : entry.checksum === checksum ? "PLUGIN_MANAGED_UNCHANGED" : "PLUGIN_MANAGED_DRIFTED";
      } catch { files[relative] = "MISSING"; }
    }
    const staging = path.join(capsule, ".staging");
    try { if ((await stat(staging)).isDirectory() && (await readdir(staging)).length > 0) blockers.push("incomplete staging transaction detected"); } catch { /* none */ }
    if (!sourceValid) {
      if (await this.isLegacyCapsule(cwd, capsule, manifest)) {
        blockers.push("legacy project capsule detected; migration preview is required before thread operations");
        return { health: "LEGACY_CAPSULE_MIGRATION_REQUIRED", blockers, plan: null, files };
      }
      blockers.push("valid canonical .project-capsule/plan-source.json is required for automatic repair");
      return { health: manifest === null ? "UNRECOVERABLE" : "CONFLICT_REQUIRES_USER", blockers, plan: null, files };
    }
    const drift = Object.entries(files).some(([relative, state]) => manifest?.managed_files[relative] !== undefined && (state === "PLUGIN_MANAGED_DRIFTED" || state === "MISSING" || state === "UNKNOWN"));
    try { await validateProjectPlan(JSON.parse(await readFile(path.join(capsule, "thread-plan.json"), "utf8"))); } catch { blockers.push("thread-plan.json is invalid or missing"); }
    if (blockers.length > 0 || drift || manifest === null || manifest.canonical_cwd !== cwd) return { health: "REPAIRABLE", blockers, plan, files };
    return { health: "HEALTHY", blockers: [], plan, files };
  }

  private async isLegacyCapsule(cwd: string, capsule: string, manifest: CapsuleManifest | null): Promise<boolean> {
    if (manifest !== null) return false;
    const source = path.join(capsule, "plan-source.json");
    const modernManifest = path.join(capsule, "capsule-manifest.json");
    try { await stat(source); return false; } catch { /* expected */ }
    try { await stat(modernManifest); return false; } catch { /* expected */ }
    const markdownCount = (await Promise.all(LEGACY_MARKDOWN.map(async (file): Promise<number> => { try { await stat(path.join(cwd, file)); return 1; } catch { return 0; } }))).reduce((a, b) => a + b, 0);
    if (markdownCount < 2) return false;
    for (const candidate of ["thread-plan.json", "thread-registry.json"]) { try { await stat(path.join(capsule, candidate)); return true; } catch { /* continue */ } }
    return markdownCount >= 5;
  }

  private async buildLegacyMigration(cwd: string): Promise<LegacyMigration | null> {
    const read = async (relative: string): Promise<string> => { try { return await readFile(path.join(cwd, relative), "utf8"); } catch { return ""; } };
    const [threads, plan, spec, status, registry] = await Promise.all([read("THREADS.md"), read("PLAN.md"), read("SPEC.md"), read("STATUS.md"), read(".project-capsule/thread-registry.json")]);
    const parsed = parseLegacyCards(threads, plan, spec, status);
    if (parsed === null) return null;
    try { return { plan: await validateProjectPlan({ project_cwd: cwd, project_name: path.basename(cwd), initialize_only: true, threads: parsed }), evidence: ["THREADS.md", "PLAN.md", "SPEC.md", "STATUS.md", ...(registry ? [".project-capsule/thread-registry.json"] : [])], warnings: ["Damaged thread-plan.json was used only as diagnostic evidence and will be backed up."], thread_registry_present: registry.length > 0 }; } catch { return null; }
  }

  private async applyLegacyPlan(cwd: string, plan: ValidatedProjectPlan, evidence: string[]): Promise<void> {
    const operationId = randomUUID(); const capsule = path.join(cwd, ".project-capsule"); const staging = path.join(capsule, ".staging", operationId); const backups = path.join(capsule, "backups", operationId);
    await mkdir(staging, { recursive: true });
    const source = { project_cwd: plan.project_cwd, project_name: plan.project_name, initialize_only: true, threads: plan.threads, recreate_archived: false };
    const rendered = `${JSON.stringify(source, null, 2)}\n`;
    const artifacts: Record<string, string> = { ".project-capsule/plan-source.json": rendered, ".project-capsule/thread-plan.json": rendered, ".project-capsule/thread-create-plan.json": rendered };
    const managed_files: CapsuleManifest["managed_files"] = {};
    for (const [relative, content] of Object.entries(artifacts)) managed_files[relative] = { owner: "PLUGIN_MANAGED", checksum: checksumContent(content), classification: "PLUGIN_MANAGED_UNCHANGED" };
    artifacts[".project-capsule/capsule-manifest.json"] = `${JSON.stringify({ schema_version: 1, plugin_version: PLUGIN_VERSION, operation_id: operationId, canonical_cwd: cwd, generated_at: new Date().toISOString(), last_verified_at: new Date().toISOString(), health: "HEALTHY", managed_files, migration_source: "LEGACY_CAPSULE", migration_audit_path: ".project-capsule/backups/" + operationId, legacy_evidence: evidence }, null, 2)}\n`;
    const applied: string[] = [];
    try {
      for (const [relative, content] of Object.entries(artifacts)) { const target = path.join(staging, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content, "utf8"); }
      await validateProjectPlan(JSON.parse(await readFile(path.join(staging, ".project-capsule", "thread-plan.json"), "utf8")));
      for (const relative of [...Object.keys(artifacts), ".project-capsule/thread-registry.json"]) { const current = path.join(cwd, relative); try { await mkdir(path.dirname(path.join(backups, relative)), { recursive: true }); await copyFile(current, path.join(backups, relative)); } catch { /* absent is valid */ } }
      for (const relative of Object.keys(artifacts)) { const target = path.join(cwd, relative); await mkdir(path.dirname(target), { recursive: true }); await renameReplace(path.join(staging, relative), target); applied.push(relative); }
    } catch (error) {
      for (const relative of applied.reverse()) { const backup = path.join(backups, relative); const target = path.join(cwd, relative); try { await copyFile(backup, target); } catch { await rm(target, { force: true }); } }
      throw new Error(`legacy capsule migration ${operationId} failed and was rolled back: ${formatUnknownError(error)}`);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  private async applyPlan(cwd: string, plan: ValidatedProjectPlan, repairing: boolean): Promise<void> {
    const operationId = randomUUID();
    const capsule = path.join(cwd, ".project-capsule");
    const staging = path.join(capsule, ".staging", operationId);
    await mkdir(staging, { recursive: true });
    const artifacts = this.renderArtifacts(plan, operationId);
    const applied: string[] = [];
    const backups = path.join(staging, ".rollback");
    try {
      for (const [relative, content] of Object.entries(artifacts)) {
        const target = path.join(staging, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
      }
      await validateProjectPlan(JSON.parse(await readFile(path.join(staging, ".project-capsule", "thread-plan.json"), "utf8")));
      for (const relative of Object.keys(artifacts)) {
        const source = path.join(staging, relative); const target = path.join(cwd, relative);
        await mkdir(path.dirname(target), { recursive: true });
        try {
          const rollback = path.join(backups, relative);
          await mkdir(path.dirname(rollback), { recursive: true });
          await copyFile(target, rollback);
          if (repairing) await copyFile(target, `${target}.backup-${operationId}`);
        } catch { /* new file */ }
        await renameReplace(source, target);
        applied.push(relative);
      }
    } catch (error) {
      for (const relative of applied.reverse()) {
        const target = path.join(cwd, relative); const rollback = path.join(backups, relative);
        try { await renameReplace(rollback, target); } catch { await rm(target, { force: true }); }
      }
      throw new Error(`capsule transaction ${operationId} failed before completion: ${formatUnknownError(error)}`);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  private renderArtifacts(plan: ValidatedProjectPlan, operationId: string): Record<string, string> {
    const source = { project_cwd: plan.project_cwd, project_name: plan.project_name, initialize_only: true, threads: plan.threads, recreate_archived: false };
    const markdown = (title: string, body: string) => `# ${title}\n\n${body}\n`;
    const artifacts: Record<string, string> = {
      "AGENTS.md": markdown("Project rules", "Capsule and thread infrastructure is plugin-managed. Milestone threads must not repair capsule artifacts."),
      "SPEC.md": markdown("Specification", plan.project_name), "FUTURES.md": markdown("Strategy", "Selected strategy is recorded by the project owner."),
      "PLAN.md": markdown("Plan", plan.threads.map((task) => `${task.milestone_id}: ${task.name}`).join("\n")),
      "STATUS.md": markdown("Status", "Capsule generated; milestones are not executing."), "DECISIONS.md": markdown("Decisions", ""), "RISKS.md": markdown("Risks", ""),
      "THREADS.md": markdown("Milestone cards", plan.threads.map((task) => `## ${task.milestone_id} ${task.name}\n${task.goal}\nDependencies: ${task.dependencies.join(", ") || "none"}`).join("\n\n")),
      ".project-capsule/plan-source.json": `${JSON.stringify(source, null, 2)}\n`,
      ".project-capsule/thread-plan.json": `${JSON.stringify(source, null, 2)}\n`,
      ".project-capsule/thread-create-plan.json": `${JSON.stringify(source, null, 2)}\n`,
    };
    const managed_files: CapsuleManifest["managed_files"] = {};
    for (const [relative, content] of Object.entries(artifacts)) managed_files[relative] = { owner: "PLUGIN_MANAGED", checksum: checksumContent(content), classification: "PLUGIN_MANAGED_UNCHANGED" };
    artifacts[".project-capsule/capsule-manifest.json"] = `${JSON.stringify({ schema_version: 1, plugin_version: PLUGIN_VERSION, operation_id: operationId, canonical_cwd: plan.project_cwd, generated_at: new Date().toISOString(), last_verified_at: new Date().toISOString(), health: "HEALTHY", managed_files }, null, 2)}\n`;
    return artifacts;
  }
}

function checksumContent(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
async function checksumFile(file: string): Promise<string> { return checksumContent(await readFile(file, "utf8")); }
async function renameReplace(source: string, target: string): Promise<void> { try { await rename(source, target); } catch { await copyFile(source, target); await rm(source, { force: true }); } }

/**
 * Conservative parser for the human-readable v0 milestone cards.  It never
 * treats malformed JSON as a source of truth: Markdown supplies the business
 * facts, while safe defaults only describe this paused, initialization-only
 * projection.  A missing M0/M1/M2 card fails closed.
 */
function parseLegacyCards(threads: string, plan: string, spec: string, status: string): Array<Record<string, unknown>> | null {
  void plan; void spec; void status;
  const cardPattern = /^#{2,4}\s+(M(?:0|[1-9][0-9]?))\s+([^\r\n]+)/gmu;
  const headings = [...threads.matchAll(cardPattern)];
  const byId = new Map<string, { name: string; body: string }>();
  for (let index = 0; index < headings.length; index += 1) {
    const hit = headings[index];
    if (hit === undefined) continue;
    const end = headings[index + 1]?.index ?? threads.length;
    const milestoneId = hit[1]; const heading = hit[2]; const whole = hit[0];
    if (milestoneId === undefined || heading === undefined || whole === undefined) continue;
    byId.set(milestoneId, { name: heading.trim().replace(new RegExp(`^${milestoneId}\\s+`, "u"), "").trim(), body: threads.slice((hit.index ?? 0) + whole.length, end) });
  }
  const ids = ["M0", "M1", "M2"];
  if (!ids.every((id) => byId.has(id))) return null;
  return ids.map((id, index) => {
    const card = byId.get(id)!;
    const goal = /(?:目标|goal)\s*[：:]\s*([^\r\n]+)/iu.exec(card.body)?.[1]?.trim() || `${id} ${card.name}`;
    const dependencyText = /(?:依赖|dependencies?)\s*[：:]\s*([^\r\n]+)/iu.exec(card.body)?.[1] ?? "";
    const dependencies = [...dependencyText.matchAll(/M(?:0|[1-9][0-9]?)/gu)].flatMap((match) => match[0] === undefined ? [] : [match[0]]);
    const inferredDependencies = dependencies.length > 0 ? dependencies : index === 0 ? [] : [ids[index - 1]];
    const allowed = readList(card.body, "allowed_paths"); const forbidden = readList(card.body, "forbidden_paths");
    return { milestone_id: id, name: card.name || `${id} legacy milestone`, goal, initial_prompt: `Legacy capsule migration initialized ${id}. Read the project capsule and remain paused until the user explicitly authorizes execution.`, dependencies: inferredDependencies, allowed_paths: allowed, forbidden_paths: forbidden.length > 0 ? forbidden : [".git", ".env", "secrets", "production", "hardware"], acceptance_criteria: [goal], validation_commands: ["node --version"], initial_status: /状态\s*[：:]\s*READY/iu.test(card.body) ? "READY" : "WAITING", sandbox_mode: "read-only" };
  });
}

function readList(body: string, key: string): string[] {
  const found = new RegExp(`${key}\\s*[：:]\\s*\\[([^\\]]*)\\]`, "iu").exec(body)?.[1];
  return found === undefined ? [] : [...found.matchAll(/["']([^"']+)["']/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1].trim()]).filter(Boolean);
}
