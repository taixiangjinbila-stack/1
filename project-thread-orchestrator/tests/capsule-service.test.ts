import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CapsuleService } from "../mcp-server/src/capsule-service.js";
import { makePlan, makeTasks } from "./test-helpers.js";

const projects: string[] = [];
afterEach(async () => { await Promise.all(projects.splice(0).map((project) => rm(project, { recursive: true, force: true }))); });
async function project(): Promise<string> { const value = await mkdtemp(path.join(tmpdir(), "胶囊-")); projects.push(value); return value; }

describe("capsule transaction and doctor", () => {
  it("writes only validated JSON from one canonical model without Git", async () => {
    const cwd = await project(); const service = new CapsuleService(); const plan = makePlan(cwd, makeTasks(3)) as Record<string, unknown>;
    await expect(service.orchestrate({ ...plan, dry_run: false, confirmed: true })).resolves.toMatchObject({ health: "HEALTHY" });
    expect(JSON.parse(await readFile(path.join(cwd, ".project-capsule", "thread-plan.json"), "utf8"))).toMatchObject({ threads: expect.any(Array) });
    await expect(service.doctor({ project_cwd: cwd })).resolves.toMatchObject({ health: "HEALTHY" });
  });

  it("backs up and repairs a corrupted plugin-managed plan from canonical source", async () => {
    const cwd = await project(); const service = new CapsuleService(); const plan = makePlan(cwd, makeTasks(3)) as Record<string, unknown>;
    await service.orchestrate({ ...plan, dry_run: false, confirmed: true });
    const planPath = path.join(cwd, ".project-capsule", "thread-plan.json"); await writeFile(planPath, '{"threads":[}', "utf8");
    await expect(service.doctor({ project_cwd: cwd })).resolves.toMatchObject({ health: "REPAIRABLE" });
    await expect(service.applyRepair({ project_cwd: cwd, confirmed: true })).resolves.toMatchObject({ health: "HEALTHY" });
    expect(JSON.parse(await readFile(planPath, "utf8")).threads).toHaveLength(3);
  });

  it("does not repair without a valid canonical source", async () => {
    const cwd = await project(); const service = new CapsuleService();
    await writeFile(path.join(cwd, "README.md"), "user owned\n", "utf8");
    await expect(service.doctor({ project_cwd: cwd })).resolves.toMatchObject({ health: "UNRECOVERABLE" });
  });

  it("migrates a Markdown-only legacy capsule atomically without changing its registry", async () => {
    const cwd = await project(); const service = new CapsuleService(); const capsule = path.join(cwd, ".project-capsule"); await mkdir(capsule, { recursive: true });
    const cards = ["M0 范围", "M1 核心", "M2 界面"].map((value, index) => `### ${value}\n目标：${value}目标\n依赖：${index === 0 ? "无" : `M${index - 1}`}\n状态：WAITING`).join("\n\n");
    await Promise.all([writeFile(path.join(cwd, "THREADS.md"), cards, "utf8"), writeFile(path.join(cwd, "PLAN.md"), "M0 -> M1 -> M2", "utf8"), writeFile(path.join(cwd, "SPEC.md"), "legacy", "utf8"), writeFile(path.join(cwd, "STATUS.md"), "WAITING", "utf8"), writeFile(path.join(capsule, "thread-plan.json"), "{ damaged", "utf8")]);
    const original = await readFile(path.join(cwd, "THREADS.md"), "utf8");
    await expect(service.doctor({ project_cwd: cwd })).resolves.toMatchObject({ health: "LEGACY_CAPSULE_MIGRATION_REQUIRED" });
    await expect(service.previewLegacyMigration({ project_cwd: cwd })).resolves.toMatchObject({ ok: true, existing_threads_preserved: false });
    await expect(service.applyLegacyMigration({ project_cwd: cwd, confirmed: true })).resolves.toMatchObject({ health: "HEALTHY" });
    expect(JSON.parse(await readFile(path.join(capsule, "plan-source.json"), "utf8")).threads).toHaveLength(3);
    expect(await readFile(path.join(cwd, "THREADS.md"), "utf8")).toBe(original);
    const manifest = JSON.parse(await readFile(path.join(capsule, "capsule-manifest.json"), "utf8"));
    await expect(stat(path.join(capsule, "backups", manifest.operation_id, ".project-capsule", "thread-plan.json"))).resolves.toBeDefined();
    await expect(service.applyLegacyMigration({ project_cwd: cwd, confirmed: true })).resolves.toMatchObject({ changed: false });
  });
});
