import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CapsulePlanValidationError,
  validateAndProject,
} from "../skills/project-capsule-orchestrator/scripts/validate-thread-plan.mjs";

const schemaPath = path.resolve(
  "..",
  "skills",
  "project-capsule-orchestrator",
  "schemas",
  "thread-plan.schema.json",
);
let schema: unknown;
const temporaryProjects: string[] = [];

beforeAll(async () => {
  schema = JSON.parse(await readFile(schemaPath, "utf8")) as unknown;
});

afterEach(async () => {
  await Promise.all(
    temporaryProjects
      .splice(0)
      .map((project) => rm(project, { recursive: true, force: true })),
  );
});

async function createProject(): Promise<string> {
  const project = await mkdtemp(path.join(tmpdir(), "pto-capsule-plan-"));
  temporaryProjects.push(project);
  return project;
}

function makeRichPlan(projectCwd: string, count = 3): Record<string, unknown> {
  const milestones = Array.from({ length: count }, (_, index) => {
    const milestoneId = `M${index}`;
    const name = `${milestoneId} Test milestone ${index}`;
    const requiredFiles = [
      "AGENTS.md",
      "SPEC.md",
      "PLAN.md",
      "STATUS.md",
      "DECISIONS.md",
      "RISKS.md",
      "THREADS.md",
      ".project-capsule/thread-plan.json",
    ];
    return {
      milestone_id: milestoneId,
      name,
      goal: `Establish the verifiable outcome for ${milestoneId}.`,
      rationale: `This milestone isolates test responsibility ${index}.`,
      dependencies: index === 0 ? [] : [`M${index - 1}`],
      initial_status: index === 0 ? "READY" : "WAITING",
      critical_path: true,
      parallel_group: null,
      execution_mode: "readonly",
      project_cwd: projectCwd,
      required_files: requiredFiles,
      allowed_paths: [],
      forbidden_paths: [".git"],
      outputs: [`Verified output for ${milestoneId}`],
      acceptance_criteria: [`${milestoneId} has an observable result.`],
      validation_commands: ["node --version"],
      risks: [
        {
          description: `Risk for ${milestoneId}`,
          severity: "LOW",
          likelihood: "LOW",
          mitigation: "Stop and report evidence.",
        },
      ],
      stop_conditions: ["Stop when evidence conflicts with the plan."],
      capsule_updates: ["STATUS.md"],
      initial_prompt: [
        "Initialization only. Read the required project capsule and report scope.",
        `Canonical cwd: ${projectCwd}.`,
        `Milestone: ${milestoneId}.`,
        `Task card: ${name}.`,
        `Required files: ${requiredFiles.join(", ")}.`,
        `Do not begin implementation until the user explicitly says 执行 ${milestoneId}.`,
        "Finish with READY or WAITING, then stop.",
      ].join(" "),
    };
  });

  return {
    schema_version: "1.0.0",
    project_name: "Capsule validator test",
    project_cwd: projectCwd,
    generated_at: "2026-07-31T00:00:00+08:00",
    project_summary:
      "A deterministic test plan for the bundled capsule-to-thread validator.",
    selected_strategy: "ROBUST",
    critical_path: milestones.map((milestone) => milestone.milestone_id),
    assumptions: [],
    unresolved_questions: [],
    safety_gates: [],
    milestones,
  };
}

describe("bundled rich thread-plan validator", () => {
  it("validates a rich plan and deterministically projects the strict MCP plan", async () => {
    const project = await createProject();
    const plan = makeRichPlan(project);
    const milestones = plan.milestones as Array<Record<string, unknown>>;
    milestones[0] = {
      ...milestones[0],
      execution_mode: "local",
      allowed_paths: ["docs"],
    };
    const before = JSON.stringify(plan);

    const result = await validateAndProject(plan, schema);

    expect(result.projection).toMatchObject({
      project_cwd: path.normalize(project),
      project_name: "Capsule validator test",
      initialize_only: true,
      threads: [
        {
          milestone_id: "M0",
          name: "Test milestone 0",
          initial_status: "READY",
          sandbox_mode: "workspace-write",
        },
        {
          milestone_id: "M1",
          name: "Test milestone 1",
          initial_status: "WAITING",
          sandbox_mode: "read-only",
        },
        {
          milestone_id: "M2",
          name: "Test milestone 2",
          initial_status: "WAITING",
          sandbox_mode: "read-only",
        },
      ],
    });
    expect(JSON.stringify(plan)).toBe(before);
  });

  it.each([2, 13])("rejects a rich plan containing %i milestones", async (count) => {
    const project = await createProject();
    await expect(
      validateAndProject(makeRichPlan(project, count), schema),
    ).rejects.toBeInstanceOf(CapsulePlanValidationError);
  });

  it("accepts both supported rich-plan count boundaries", async () => {
    const project = await createProject();
    await expect(
      validateAndProject(makeRichPlan(project, 3), schema),
    ).resolves.toMatchObject({
      projection: { threads: expect.any(Array) },
    });
    await expect(
      validateAndProject(makeRichPlan(project, 12), schema),
    ).resolves.toMatchObject({
      projection: { threads: expect.any(Array) },
    });
  });

  it("rejects a dependency cycle", async () => {
    const project = await createProject();
    const plan = makeRichPlan(project);
    const milestones = plan.milestones as Array<Record<string, unknown>>;
    milestones[0] = { ...milestones[0], dependencies: ["M2"] };

    await expect(validateAndProject(plan, schema)).rejects.toMatchObject({
      name: "CapsulePlanValidationError",
      details: expect.arrayContaining([
        expect.stringMatching(/dependency cycle detected/u),
      ]),
    });
  });

  it.each(["C:\\", "/", "\\\\server\\share"])(
    "rejects filesystem or share root project_cwd %s",
    async (rootCwd) => {
      const plan = makeRichPlan(rootCwd);
      await expect(validateAndProject(plan, schema)).rejects.toBeInstanceOf(
        CapsulePlanValidationError,
      );
    },
  );
});
