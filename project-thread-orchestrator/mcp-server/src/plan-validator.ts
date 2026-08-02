import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  MAX_PROJECT_THREADS,
  MilestoneTaskSchema,
  PreviewProjectThreadsInputSchema,
  SmokeThreadPlanSchema,
  type FieldDiff,
  type MilestoneTask,
  type PreviewProjectThreadsInput,
  type SmokeThreadPlan,
  type ValidatedProjectPlan,
} from "./types.js";

export class PlanValidationError extends Error {
  public readonly code = "PLAN_VALIDATION_FAILED";

  public constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "PlanValidationError";
  }
}

function normalizeRootCandidate(value: string): string {
  return value.trim().replace(/\//gu, "\\");
}

export function isFilesystemRootLike(value: string): boolean {
  const trimmed = value.trim();
  if (/^\/+$/u.test(trimmed)) {
    return true;
  }

  const windows = normalizeRootCandidate(trimmed);
  if (/^\\\\\?\\[A-Za-z]:\\*$/u.test(windows)) {
    return true;
  }
  if (/^\\\\\?\\UNC\\[^\\]+\\[^\\]+\\*$/iu.test(windows)) {
    return true;
  }
  if (/^[A-Za-z]:\\*$/u.test(windows)) {
    return true;
  }

  // A bare UNC share is a filesystem root for the purposes of this plugin.
  if (/^\\\\[^\\]+\\[^\\]+\\*$/u.test(windows)) {
    return true;
  }

  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed);
    return pathsEqual(resolved, path.parse(resolved).root);
  }

  return false;
}

export async function canonicalizeProjectCwd(projectCwd: string): Promise<string> {
  const trimmed = projectCwd.trim();
  if (isFilesystemRootLike(trimmed)) {
    throw new PlanValidationError(
      `project_cwd must be a dedicated project directory, not a filesystem root: ${trimmed}`,
    );
  }

  const absoluteForHost = path.isAbsolute(trimmed);
  const absoluteWindows = path.win32.isAbsolute(trimmed);
  if (!absoluteForHost && !(process.platform === "win32" && absoluteWindows)) {
    throw new PlanValidationError("project_cwd must be an absolute path");
  }

  try {
    await access(trimmed, constants.F_OK);
  } catch {
    throw new PlanValidationError(`project_cwd does not exist: ${trimmed}`);
  }

  let canonical: string;
  try {
    canonical = await realpath(trimmed);
  } catch (error) {
    throw new PlanValidationError(
      `project_cwd could not be canonicalized: ${trimmed}`,
      [formatUnknownError(error)],
    );
  }

  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) {
    throw new PlanValidationError(`project_cwd is not a directory: ${canonical}`);
  }
  if (isFilesystemRootLike(canonical)) {
    throw new PlanValidationError(
      `canonical project_cwd resolves to a filesystem root: ${canonical}`,
    );
  }

  return path.normalize(canonical);
}

export function normalizePathKey(value: string): string {
  return path.normalize(value).replace(/[\\/]+$/u, "");
}

export function pathsEqual(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function validateTaskPaths(
  projectCwd: string,
  task: MilestoneTask,
): Promise<string[]> {
  const errors: string[] = [];
  const allPaths = [
    ...task.allowed_paths.map((value) => ({ kind: "allowed_paths", value })),
    ...task.forbidden_paths.map((value) => ({ kind: "forbidden_paths", value })),
  ];

  for (const entry of allPaths) {
    const pathError = validateProjectRelativePath(entry.value);
    if (pathError !== null) {
      errors.push(
        `${task.milestone_id}.${entry.kind} is unsafe (${pathError}): ${entry.value}`,
      );
      continue;
    }

    const resolved = path.resolve(projectCwd, entry.value);
    if (!isPathInside(projectCwd, resolved)) {
      errors.push(
        `${task.milestone_id}.${entry.kind} escapes project_cwd: ${entry.value}`,
      );
      continue;
    }

    try {
      const existingCanonical = await realpath(resolved);
      if (!isPathInside(projectCwd, existingCanonical)) {
        errors.push(
          `${task.milestone_id}.${entry.kind} resolves outside project_cwd: ${entry.value}`,
        );
      }
    } catch {
      // Greenfield output paths may not exist. Their lexical containment is still enforced.
    }
  }
  return errors;
}

const WINDOWS_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;

export function validateProjectRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "empty path";
  }
  if (
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    /^[A-Za-z]:/u.test(trimmed) ||
    trimmed.startsWith("\\\\")
  ) {
    return "absolute, drive-relative, and UNC paths are forbidden";
  }

  const components = trimmed.split(/[\\/]/u);
  for (const component of components) {
    if (component === "..") {
      return "parent traversal is forbidden";
    }
    if (component === "") {
      return "empty path components are forbidden";
    }
    if (component !== "." && /[. ]$/u.test(component)) {
      return "Windows path components may not end in a dot or space";
    }
    if (component.includes(":")) {
      return "Windows alternate data stream and drive syntax are forbidden";
    }
    if (WINDOWS_DEVICE_NAME.test(component)) {
      return "Windows device names are forbidden";
    }
  }
  return null;
}

function validateGraph(tasks: MilestoneTask[]): string[] {
  const errors: string[] = [];
  const byId = new Map(tasks.map((task) => [task.milestone_id, task]));

  if (byId.size !== tasks.length) {
    errors.push("milestone_id values must be unique");
  }

  for (const task of tasks) {
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      errors.push(`${task.milestone_id}.dependencies contains duplicates`);
    }
    for (const dependency of task.dependencies) {
      if (dependency === task.milestone_id) {
        errors.push(`${task.milestone_id} may not depend on itself`);
      } else if (!byId.has(dependency)) {
        errors.push(
          `${task.milestone_id} depends on unknown milestone ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (visiting.has(id)) {
      errors.push(`dependency cycle detected: ${[...trail, id].join(" -> ")}`);
      return;
    }
    if (visited.has(id)) {
      return;
    }
    const task = byId.get(id);
    if (task === undefined) {
      return;
    }
    visiting.add(id);
    for (const dependency of task.dependencies) {
      visit(dependency, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };

  for (const task of tasks) {
    visit(task.milestone_id, []);
  }
  return errors;
}

function validateTaskNames(tasks: MilestoneTask[]): string[] {
  const errors: string[] = [];
  for (const task of tasks) {
    const prefixPattern = new RegExp(`^${task.milestone_id}\\s+`, "iu");
    if (prefixPattern.test(task.name)) {
      errors.push(
        `${task.milestone_id}.name must be the concise name only; the server adds the milestone prefix`,
      );
    }
    if (task.allowed_paths.some((value) => value.trim() === "")) {
      errors.push(`${task.milestone_id}.allowed_paths may not contain blanks`);
    }
  }
  return errors;
}

export function expectedThreadName(task: MilestoneTask): string {
  return `${task.milestone_id} ${task.name.trim()}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export function digestTask(task: MilestoneTask): string {
  return digestValue(MilestoneTaskSchema.parse(task));
}

function buildPlanDigest(input: {
  project_cwd: string;
  project_name: string;
  initialize_only: true;
  threads: MilestoneTask[];
}): string {
  return digestValue({
    project_cwd: normalizePathKey(input.project_cwd),
    project_name: input.project_name,
    initialize_only: input.initialize_only,
    threads: [...input.threads].sort((left, right) =>
      left.milestone_id.localeCompare(right.milestone_id, undefined, {
        numeric: true,
      }),
    ),
  });
}

async function finishValidation(
  input: PreviewProjectThreadsInput,
): Promise<ValidatedProjectPlan> {
  const projectCwd = await canonicalizeProjectCwd(input.project_cwd);
  const errors = [
    ...validateGraph(input.threads),
    ...validateTaskNames(input.threads),
  ];
  for (const task of input.threads) {
    errors.push(...(await validateTaskPaths(projectCwd, task)));
  }
  if (errors.length > 0) {
    throw new PlanValidationError("thread plan failed semantic validation", errors);
  }

  const normalized = {
    project_cwd: projectCwd,
    project_name: input.project_name,
    initialize_only: true as const,
    threads: input.threads,
  };
  return {
    ...normalized,
    plan_digest: buildPlanDigest(normalized),
  };
}

export async function validateProjectPlan(
  raw: unknown,
): Promise<ValidatedProjectPlan> {
  const input = PreviewProjectThreadsInputSchema.parse(raw);
  return finishValidation(input);
}

export async function validateSmokePlan(
  raw: unknown,
): Promise<ValidatedProjectPlan> {
  const smoke = SmokeThreadPlanSchema.parse(raw) as SmokeThreadPlan;
  const input: PreviewProjectThreadsInput = {
    project_cwd: smoke.project_cwd,
    project_name: smoke.project_name,
    initialize_only: true,
    threads: [...smoke.threads],
    recreate_archived: false,
  };

  // The smoke-only schema is the sole exception to the public 3-12 invariant.
  if (input.threads.length !== 2 || input.threads.length > MAX_PROJECT_THREADS) {
    throw new PlanValidationError("smoke plan must contain exactly two threads");
  }

  const projectCwd = await canonicalizeProjectCwd(input.project_cwd);
  const errors = [
    ...validateGraph(input.threads),
    ...validateTaskNames(input.threads),
  ];
  for (const task of input.threads) {
    errors.push(...(await validateTaskPaths(projectCwd, task)));
  }
  if (errors.length > 0) {
    throw new PlanValidationError("smoke plan failed semantic validation", errors);
  }

  const normalized = {
    ...input,
    project_cwd: projectCwd,
  };
  return {
    ...normalized,
    plan_digest: buildPlanDigest(normalized),
  };
}

export function diffValues(previous: unknown, proposed: unknown): FieldDiff[] {
  const differences: FieldDiff[] = [];
  const walk = (left: unknown, right: unknown, currentPath: string): void => {
    if (stableStringify(left) === stableStringify(right)) {
      return;
    }
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const keys = new Set([
        ...Object.keys(left as Record<string, unknown>),
        ...Object.keys(right as Record<string, unknown>),
      ]);
      for (const key of [...keys].sort()) {
        walk(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          `${currentPath}/${key}`,
        );
      }
      return;
    }
    differences.push({
      path: currentPath || "/",
      previous: left,
      proposed: right,
    });
  };
  walk(previous, proposed, "");
  return differences;
}

export function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
