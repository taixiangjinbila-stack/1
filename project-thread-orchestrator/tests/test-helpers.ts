import type { MilestoneTask } from "../mcp-server/src/types.js";

export function makeTask(
  index: number,
  overrides: Partial<MilestoneTask> = {},
): MilestoneTask {
  return {
    milestone_id: `M${index}`,
    name: `Task ${index}`,
    goal: `Establish milestone ${index} without changing business code.`,
    initial_prompt: `Initialize milestone M${index}, report READY or WAITING, then stop.`,
    dependencies: [],
    allowed_paths: [`src/m${index}`],
    forbidden_paths: [".git"],
    acceptance_criteria: [`Milestone M${index} initialization is reported.`],
    validation_commands: ["node --version"],
    initial_status: "READY",
    sandbox_mode: "read-only",
    ...overrides,
  };
}

export function makeTasks(count: number): MilestoneTask[] {
  return Array.from({ length: count }, (_, index) => makeTask(index));
}

export function makePlan(projectCwd: string, threads: MilestoneTask[]): unknown {
  return {
    project_cwd: projectCwd,
    project_name: "Unit Test Project",
    initialize_only: true,
    threads,
  };
}
