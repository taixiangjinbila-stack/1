import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PlanValidationError,
  isFilesystemRootLike,
  validateProjectPlan,
  validateProjectRelativePath,
} from "../mcp-server/src/plan-validator.js";
import type { MilestoneTask } from "../mcp-server/src/types.js";
import { makePlan, makeTask, makeTasks } from "./test-helpers.js";

const temporaryProjects: string[] = [];

async function createTemporaryProject(): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), "pto-plan-validator-"));
  temporaryProjects.push(project);
  return project;
}

async function expectSemanticFailure(
  projectCwd: string,
  threads: MilestoneTask[],
): Promise<PlanValidationError> {
  try {
    await validateProjectPlan(makePlan(projectCwd, threads));
  } catch (error) {
    expect(error).toBeInstanceOf(PlanValidationError);
    return error as PlanValidationError;
  }
  throw new Error("expected project plan validation to fail");
}

afterEach(async () => {
  const pending = temporaryProjects.splice(0);
  await Promise.all(
    pending.map((project) => rm(project, { force: true, recursive: true })),
  );
});

describe("project thread count validation", () => {
  it.each([3, 12])("accepts a plan containing %i threads", async (count) => {
    const project = await createTemporaryProject();

    const validated = await validateProjectPlan(
      makePlan(project, makeTasks(count)),
    );

    expect(validated.threads).toHaveLength(count);
    expect(validated.project_cwd).toBe(path.normalize(await realpath(project)));
    expect(validated.plan_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a public plan containing fewer than three threads", async () => {
    const project = await createTemporaryProject();

    await expect(
      validateProjectPlan(makePlan(project, makeTasks(2))),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("rejects a plan containing more than twelve threads", async () => {
    const project = await createTemporaryProject();

    await expect(
      validateProjectPlan(makePlan(project, makeTasks(13))),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("capsule plan projection compatibility", () => {
  it("accepts an empty allowed_paths list for a read-only milestone", async () => {
    const project = await createTemporaryProject();
    const tasks = makeTasks(3);
    tasks[0] = makeTask(0, {
      allowed_paths: [],
      sandbox_mode: "read-only",
    });

    const validated = await validateProjectPlan(makePlan(project, tasks));

    expect(validated.threads[0]?.allowed_paths).toEqual([]);
  });

  it("requires an explicit allowed path for workspace-write", async () => {
    const project = await createTemporaryProject();
    const tasks = makeTasks(3);
    tasks[0] = makeTask(0, {
      allowed_paths: [],
      sandbox_mode: "workspace-write",
    });

    await expect(
      validateProjectPlan(makePlan(project, tasks)),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("project root and Windows path safety", () => {
  it.each([
    "/",
    "///",
    "C:\\",
    "C:/",
    "\\\\?\\C:\\",
    "\\\\server\\share",
    "\\\\server\\share\\",
    "\\\\?\\UNC\\server\\share\\",
  ])("recognizes %j as a forbidden filesystem root", (candidate) => {
    expect(isFilesystemRootLike(candidate)).toBe(true);
  });

  it("rejects the host filesystem root as project_cwd", async () => {
    const root = path.parse(process.cwd()).root;

    await expect(
      validateProjectPlan(makePlan(root, makeTasks(3))),
    ).rejects.toMatchObject({
      name: "PlanValidationError",
      code: "PLAN_VALIDATION_FAILED",
    });
  });

  it("accepts ordinary Windows-style relative paths", () => {
    expect(validateProjectRelativePath("src\\feature\\index.ts")).toBeNull();
    expect(validateProjectRelativePath("docs/计划.md")).toBeNull();
  });

  it.each([
    ["C:\\repo\\file.ts", "absolute"],
    ["C:repo\\file.ts", "absolute"],
    ["\\\\server\\share\\file.ts", "absolute"],
    ["..\\outside.txt", "parent traversal"],
    ["src\\file.txt:secret", "alternate data stream"],
    ["CON", "device names"],
    ["src\\trailing.\\file.ts", "end in a dot or space"],
    ["src\\\\file.ts", "empty path components"],
  ])("rejects unsafe Windows path %j", (candidate, expectedReason) => {
    expect(validateProjectRelativePath(candidate)).toContain(expectedReason);
  });
});

describe("dependency DAG validation", () => {
  it("accepts an acyclic dependency graph", async () => {
    const project = await createTemporaryProject();
    const threads = [
      makeTask(0),
      makeTask(1, { dependencies: ["M0"] }),
      makeTask(2, { dependencies: ["M0", "M1"] }),
    ];

    const validated = await validateProjectPlan(makePlan(project, threads));

    expect(validated.threads.map((task) => task.milestone_id)).toEqual([
      "M0",
      "M1",
      "M2",
    ]);
  });

  it("rejects dependency cycles", async () => {
    const project = await createTemporaryProject();
    const error = await expectSemanticFailure(project, [
      makeTask(0, { dependencies: ["M2"] }),
      makeTask(1, { dependencies: ["M0"] }),
      makeTask(2, { dependencies: ["M1"] }),
    ]);

    expect(error.details.join("\n")).toContain("dependency cycle detected");
  });

  it("rejects dependencies on unknown milestones", async () => {
    const project = await createTemporaryProject();
    const error = await expectSemanticFailure(project, [
      makeTask(0),
      makeTask(1),
      makeTask(2, { dependencies: ["M9"] }),
    ]);

    expect(error.details).toContain("M2 depends on unknown milestone M9");
  });

  it("rejects self-dependencies and duplicate dependency entries", async () => {
    const project = await createTemporaryProject();
    const error = await expectSemanticFailure(project, [
      makeTask(0),
      makeTask(1, { dependencies: ["M1"] }),
      makeTask(2, { dependencies: ["M0", "M0"] }),
    ]);

    expect(error.details).toEqual(
      expect.arrayContaining([
        "M1 may not depend on itself",
        "M2.dependencies contains duplicates",
      ]),
    );
  });

  it("rejects duplicate milestone identifiers", async () => {
    const project = await createTemporaryProject();
    const error = await expectSemanticFailure(project, [
      makeTask(0),
      makeTask(1),
      makeTask(2, { milestone_id: "M1", name: "Second M1" }),
    ]);

    expect(error.details).toContain("milestone_id values must be unique");
  });
});
