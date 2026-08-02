import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { digestTask, digestValue } from "../mcp-server/src/plan-validator.js";
import {
  RegistryCorruptError,
  RegistryLockError,
  RegistryStore,
  createEmptyRegistry,
  createReservedRecord,
  registryPathFor,
} from "../mcp-server/src/registry.js";
import { makeTask } from "./test-helpers.js";

const NOW = "2026-07-29T00:00:00.000Z";
const temporaryProjects: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), "pto-registry-"));
  temporaryProjects.push(project);
  return project;
}

async function writeRawRegistry(
  projectCwd: string,
  contents: string,
): Promise<string> {
  const registryPath = registryPathFor(projectCwd);
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, contents, "utf8");
  return registryPath;
}

afterEach(async () => {
  const pending = temporaryProjects.splice(0);
  await Promise.all(
    pending.map((project) => rm(project, { force: true, recursive: true })),
  );
});

describe("registry persistence and basic idempotency", () => {
  it("round-trips one milestone without creating a duplicate on repeated saves", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));
    const task = makeTask(0);
    const registry = createEmptyRegistry(project, "Registry Test", NOW);
    const record = createReservedRecord({
      task,
      taskDigest: digestTask(task),
      projectPlanDigest: digestValue({ project, threads: [task] }),
      expectedName: "M0 Task 0",
      now: NOW,
    });
    record.thread_id = "thread-existing-m0";
    record.status = "READY";
    record.last_successful_step = "TURN_COMPLETED";
    record.initialization.status = "COMPLETED";
    record.initialization.turn_id = "turn-existing-m0";
    record.initialization.turn_status = "completed";
    record.initialization.completed_at = NOW;
    registry.milestones.M0 = record;

    await store.save(registry);
    const firstLoad = await store.load(project);
    await store.save(firstLoad.registry);
    const secondLoad = await store.load(project);

    expect(firstLoad.exists).toBe(true);
    expect(Object.keys(secondLoad.registry.milestones)).toEqual(["M0"]);
    expect(secondLoad.registry.milestones.M0).toMatchObject({
      reservation_id: record.reservation_id,
      thread_id: "thread-existing-m0",
      status: "READY",
      generation: 1,
    });
  });

  it("returns an empty, unsaved registry when no registry exists", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));

    const result = await store.load(project, { projectName: "Fresh Project" });

    expect(result.exists).toBe(false);
    expect(result.recovered_from_corruption).toBe(false);
    expect(result.registry.project).toMatchObject({
      name: "Fresh Project",
      cwd: project,
    });
    expect(result.registry.milestones).toEqual({});
    await expect(readFile(registryPathFor(project), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("registry project lock", () => {
  it("rejects an overlapping mutation and releases the lock afterward", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));
    let releaseFirst!: () => void;
    let reportEntered!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      reportEntered = resolve;
    });

    const firstMutation = store.withProjectLock(project, async () => {
      reportEntered();
      await firstMayFinish;
      return "first-complete";
    });
    await firstEntered;

    await expect(
      store.withProjectLock(project, async () => "must-not-run"),
    ).rejects.toBeInstanceOf(RegistryLockError);

    releaseFirst();
    await expect(firstMutation).resolves.toBe("first-complete");
    await expect(
      store.withProjectLock(project, async () => "second-complete"),
    ).resolves.toBe("second-complete");
  });

  it("releases the lock when the protected action throws", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));

    await expect(
      store.withProjectLock(project, async () => {
        throw new Error("simulated mutation failure");
      }),
    ).rejects.toThrow("simulated mutation failure");

    await expect(
      store.withProjectLock(project, async () => "recovered"),
    ).resolves.toBe("recovered");
  });
});

describe("corrupt registry recovery and fail-closed behavior", () => {
  it("fails closed and preserves corrupt bytes when recovery is not explicit", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));
    const corruptContents = "{ this is not valid JSON";
    const registryPath = await writeRawRegistry(project, corruptContents);

    await expect(store.load(project)).rejects.toBeInstanceOf(
      RegistryCorruptError,
    );

    expect(await readFile(registryPath, "utf8")).toBe(corruptContents);
    const siblingNames = await readdir(path.dirname(registryPath));
    expect(
      siblingNames.filter((name) => name.includes(".corrupt.")),
    ).toHaveLength(0);
  });

  it("moves corrupt bytes aside only during explicit recovery and marks reconciliation required", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));
    const corruptContents = JSON.stringify({
      schema_version: "future-version",
      milestones: {},
    });
    const registryPath = await writeRawRegistry(project, corruptContents);

    const recovered = await store.load(project, {
      projectName: "Recovered Project",
      recoverCorruption: true,
    });

    expect(recovered.exists).toBe(true);
    expect(recovered.recovered_from_corruption).toBe(true);
    expect(recovered.registry.recovery).toMatchObject({
      required: true,
      reason: expect.stringContaining("fail-closed"),
    });
    const backupPath = recovered.registry.recovery.corrupt_backup;
    expect(backupPath).not.toBeNull();
    expect(await readFile(backupPath as string, "utf8")).toBe(corruptContents);

    const persistedRecovery = JSON.parse(
      await readFile(registryPath, "utf8"),
    ) as {
      recovery: { required: boolean; corrupt_backup: string | null };
    };
    expect(persistedRecovery.recovery).toEqual({
      required: true,
      reason:
        "The prior registry failed JSON/schema validation. Creation is fail-closed until a confirmed sync reconciles real threads.",
      corrupt_backup: backupPath,
    });
  });

  it("keeps the recovery-required marker on subsequent normal loads", async () => {
    const project = await createTemporaryProject();
    const store = new RegistryStore(() => new Date(NOW));
    await writeRawRegistry(project, "not-json");
    await store.load(project, {
      projectName: "Recovered Project",
      recoverCorruption: true,
    });

    const subsequent = await store.load(project);

    expect(subsequent.recovered_from_corruption).toBe(false);
    expect(subsequent.registry.recovery.required).toBe(true);
    expect(subsequent.registry.recovery.corrupt_backup).toContain(
      "thread-registry.corrupt.",
    );
  });
});
