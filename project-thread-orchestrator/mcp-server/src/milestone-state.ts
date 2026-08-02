import type { ThreadRegistry } from "./registry.js";

export type CompletionStatus = "NONE" | "ACCEPTED" | "NEEDS_REWORK";
export type ExecutionGrantStatus = "NONE" | "ACTIVE";

export function deriveMilestoneState(input: {
  milestone_id: string;
  dependencies: readonly string[];
  completion_status: CompletionStatus;
  execution_grant_status: ExecutionGrantStatus;
  dependencies_accepted: boolean;
}): "READY" | "WAITING" | "EXECUTING" | "ACCEPTED" | "NEEDS_REWORK" {
  void input.milestone_id;
  if (input.completion_status === "ACCEPTED") return "ACCEPTED";
  if (input.completion_status === "NEEDS_REWORK") return "NEEDS_REWORK";
  if (input.execution_grant_status === "ACTIVE") return "EXECUTING";
  return input.dependencies.length === 0 || input.dependencies_accepted ? "READY" : "WAITING";
}

/** Runtime fields such as loaded/notLoaded must never affect this result. */
export function reconcileMilestoneStates(registry: ThreadRegistry): boolean {
  let changed = false;
  for (const record of Object.values(registry.milestones)) {
    const current = record.milestone_status;
    const next = deriveMilestoneState({
      milestone_id: record.milestone_id,
      dependencies: record.plan_snapshot.dependencies,
      completion_status: current === "ACCEPTED" || current === "NEEDS_REWORK" ? current : "NONE",
      execution_grant_status: current === "EXECUTING" ? "ACTIVE" : "NONE",
      dependencies_accepted: record.plan_snapshot.dependencies.every((id) => registry.milestones[id]?.milestone_status === "ACCEPTED"),
    });
    if (current !== next) { record.milestone_status = next; changed = true; }
  }
  return changed;
}
