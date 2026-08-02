#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
} from "../../../mcp-server/node_modules/ajv/dist/2020.js";
import * as formatsNamespace from "../../../mcp-server/node_modules/ajv-formats/dist/index.js";
import {
  PreviewProjectThreadsInputSchema,
  type PreviewProjectThreadsInput,
} from "../../../mcp-server/src/types.js";
import {
  isFilesystemRootLike,
  validateProjectPlan,
  validateProjectRelativePath,
} from "../../../mcp-server/src/plan-validator.js";

interface RichSafetyGate {
  gate_id: string;
  applies_to: string[];
  approval_required: boolean;
  status: "OPEN" | "SATISFIED" | "WAIVED";
}

type RichInitialStatus =
  | "DRAFT"
  | "READY"
  | "WAITING"
  | "BLOCKED"
  | "ACTIVE"
  | "REVIEW"
  | "DONE"
  | "ARCHIVED";

type RichExecutionMode =
  | "readonly"
  | "local"
  | "worktree"
  | "hardware-gated"
  | "production-gated";

interface RichMilestone {
  milestone_id: string;
  name: string;
  goal: string;
  dependencies: string[];
  initial_status: RichInitialStatus;
  critical_path: boolean;
  parallel_group: string | null;
  execution_mode: RichExecutionMode;
  project_cwd: string;
  required_files: string[];
  allowed_paths: string[];
  forbidden_paths: string[];
  outputs: string[];
  acceptance_criteria: string[];
  validation_commands: string[];
  stop_conditions: string[];
  capsule_updates: string[];
  initial_prompt: string;
}

export interface RichThreadPlan {
  schema_version: "1.0.0";
  project_name: string;
  project_cwd: string;
  generated_at: string;
  selected_strategy: "ROBUST" | "LEVERAGE" | "BREAKTHROUGH";
  critical_path: string[];
  safety_gates: RichSafetyGate[];
  milestones: RichMilestone[];
}

export interface ThreadCreateProjection {
  project_cwd: string;
  project_name: string;
  initialize_only: true;
  threads: PreviewProjectThreadsInput["threads"];
}

export interface ValidationResult {
  rich_plan: RichThreadPlan;
  projection: ThreadCreateProjection;
  warnings: string[];
}

export class CapsulePlanValidationError extends Error {
  public constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = "CapsulePlanValidationError";
  }
}

interface CliOptions {
  planPath: string;
  schemaPath: string;
  projectOutput?: string;
  quiet: boolean;
}

const defaultSchemaPath = fileURLToPath(
  new URL("../schemas/thread-plan.schema.json", import.meta.url),
);
const addFormats = (
  "default" in formatsNamespace
    ? formatsNamespace.default
    : formatsNamespace
) as unknown as (ajv: Ajv2020) => Ajv2020;

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, "")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CapsulePlanValidationError(`${label} is not valid JSON`, [
      message,
    ]);
  }
}

function formatSchemaError(error: ErrorObject): string {
  const location = error.instancePath === "" ? "$" : `$${error.instancePath}`;
  return `${location}: ${error.message ?? error.keyword}`;
}

function normalizedPortableCwd(value: string): string {
  const trimmed = value.trim().replace(/\//gu, "\\").replace(/\\+$/gu, "");
  return /^[A-Za-z]:\\/u.test(trimmed) || trimmed.startsWith("\\\\")
    ? trimmed.toLocaleLowerCase("en-US")
    : value.trim().replace(/\/+$/gu, "");
}

function isAbsoluteProjectDirectory(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || isFilesystemRootLike(trimmed)) {
    return false;
  }
  return path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed);
}

function findDependencyCycle(
  dependencies: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) {
      return null;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle !== null) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const id of dependencies.keys()) {
    const cycle = visit(id);
    if (cycle !== null) {
      return cycle;
    }
  }
  return null;
}

function semanticChecks(plan: RichThreadPlan): {
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const milestones = plan.milestones;
  const ids = milestones.map((milestone) => milestone.milestone_id);
  const idSet = new Set(ids);

  if (!isAbsoluteProjectDirectory(plan.project_cwd)) {
    errors.push(
      "$.project_cwd must be an absolute project directory below a filesystem/share root",
    );
  }
  if (milestones.length < 3 || milestones.length > 12) {
    errors.push("$.milestones must contain between 3 and 12 milestones");
  }
  if (idSet.size !== ids.length) {
    errors.push("$.milestones milestone_id values must be unique");
  }

  const dependencies = new Map<string, readonly string[]>();
  const normalizedCwd = normalizedPortableCwd(plan.project_cwd);
  const pathFields: Array<keyof Pick<
    RichMilestone,
    "required_files" | "allowed_paths" | "forbidden_paths" | "capsule_updates"
  >> = [
    "required_files",
    "allowed_paths",
    "forbidden_paths",
    "capsule_updates",
  ];

  for (const [index, milestone] of milestones.entries()) {
    const base = `$.milestones[${index}]`;
    const expectedPrefix = `${milestone.milestone_id} `;
    if (!milestone.name.startsWith(expectedPrefix)) {
      errors.push(
        `${base}.name must start with the exact milestone_id and one space`,
      );
    }
    if (
      normalizedPortableCwd(milestone.project_cwd) !== normalizedCwd
    ) {
      errors.push(`${base}.project_cwd must equal the top-level project_cwd`);
    }

    dependencies.set(milestone.milestone_id, milestone.dependencies);
    if (new Set(milestone.dependencies).size !== milestone.dependencies.length) {
      errors.push(`${base}.dependencies must not contain duplicates`);
    }
    for (const [dependencyIndex, dependency] of milestone.dependencies.entries()) {
      if (dependency === milestone.milestone_id) {
        errors.push(
          `${base}.dependencies[${dependencyIndex}] may not be a self-dependency`,
        );
      } else if (!idSet.has(dependency)) {
        errors.push(
          `${base}.dependencies[${dependencyIndex}] references unknown milestone ${dependency}`,
        );
      }
    }

    for (const field of pathFields) {
      for (const [entryIndex, entry] of milestone[field].entries()) {
        const pathError = validateProjectRelativePath(entry);
        if (pathError !== null) {
          errors.push(`${base}.${field}[${entryIndex}] is unsafe: ${pathError}`);
        }
      }
    }

    const requiredPromptFragments = [
      plan.project_cwd,
      milestone.milestone_id,
      milestone.name,
      `执行 ${milestone.milestone_id}`,
      ...milestone.required_files,
    ];
    for (const fragment of requiredPromptFragments) {
      if (!milestone.initial_prompt.includes(fragment)) {
        errors.push(
          `${base}.initial_prompt must contain ${JSON.stringify(fragment)}`,
        );
      }
    }
    if (!/初始化|首次运行|initiali[sz]|first\s+run/iu.test(milestone.initial_prompt)) {
      warnings.push(`${base}.initial_prompt does not explicitly mention initialization`);
    }
    if (!/停止|stop|wait/iu.test(milestone.initial_prompt)) {
      warnings.push(`${base}.initial_prompt does not explicitly instruct stop/wait`);
    }

    if (
      ["ACTIVE", "REVIEW", "DONE", "ARCHIVED"].includes(
        milestone.initial_status,
      )
    ) {
      errors.push(
        `${base}.initial_status ${milestone.initial_status} cannot be projected into a new initialization-only thread`,
      );
    }
  }

  const cycle = findDependencyCycle(dependencies);
  if (cycle !== null) {
    errors.push(`$.milestones dependency cycle detected: ${cycle.join(" -> ")}`);
  }

  for (const [index, milestoneId] of plan.critical_path.entries()) {
    if (!idSet.has(milestoneId)) {
      errors.push(`$.critical_path[${index}] references unknown milestone ${milestoneId}`);
    }
  }
  const flagged = new Set(
    milestones
      .filter((milestone) => milestone.critical_path)
      .map((milestone) => milestone.milestone_id),
  );
  if (
    flagged.size !== plan.critical_path.length ||
    plan.critical_path.some((id) => !flagged.has(id))
  ) {
    errors.push(
      "$.critical_path must exactly match milestones whose critical_path flag is true",
    );
  }
  for (let index = 1; index < plan.critical_path.length; index += 1) {
    const previous = plan.critical_path[index - 1];
    const current = plan.critical_path[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      !(dependencies.get(current) ?? []).includes(previous)
    ) {
      errors.push(
        `$.critical_path[${index}] ${current} must directly depend on preceding critical milestone ${previous}`,
      );
    }
  }

  const gateIds = new Set<string>();
  const gatesByMilestone = new Map<string, RichSafetyGate[]>(
    ids.map((id) => [id, []]),
  );
  for (const [index, gate] of plan.safety_gates.entries()) {
    if (gateIds.has(gate.gate_id)) {
      errors.push(`$.safety_gates[${index}].gate_id is duplicated`);
    }
    gateIds.add(gate.gate_id);
    for (const [targetIndex, target] of gate.applies_to.entries()) {
      const targetGates = gatesByMilestone.get(target);
      if (targetGates === undefined) {
        errors.push(
          `$.safety_gates[${index}].applies_to[${targetIndex}] references unknown milestone ${target}`,
        );
      } else {
        targetGates.push(gate);
      }
    }
  }

  for (const [index, milestone] of milestones.entries()) {
    const gates = gatesByMilestone.get(milestone.milestone_id) ?? [];
    const openApprovalGate = gates.some(
      (gate) => gate.approval_required && gate.status === "OPEN",
    );
    if (
      ["hardware-gated", "production-gated"].includes(
        milestone.execution_mode,
      ) &&
      !gates.some((gate) => gate.approval_required)
    ) {
      errors.push(
        `$.milestones[${index}] ${milestone.execution_mode} requires an approval_required safety gate`,
      );
    }
    if (
      openApprovalGate &&
      ["READY", "ACTIVE", "REVIEW", "DONE"].includes(
        milestone.initial_status,
      )
    ) {
      errors.push(
        `$.milestones[${index}].initial_status cannot be ${milestone.initial_status} while an applicable approval gate is OPEN`,
      );
    }
  }

  const parallelGroups = new Map<string, RichMilestone[]>();
  for (const milestone of milestones) {
    if (milestone.parallel_group !== null) {
      const members = parallelGroups.get(milestone.parallel_group) ?? [];
      members.push(milestone);
      parallelGroups.set(milestone.parallel_group, members);
    }
  }
  for (const [group, members] of parallelGroups) {
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const leftMember = members[left];
        const rightMember = members[right];
        if (leftMember === undefined || rightMember === undefined) {
          continue;
        }
        const overlap = leftMember.allowed_paths.filter((candidate) =>
          rightMember.allowed_paths.includes(candidate),
        );
        if (overlap.length > 0) {
          warnings.push(
            `parallel_group ${group} has exact allowed_paths overlap: ${overlap.join(", ")}`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

function projectInitialStatus(
  milestone: RichMilestone,
  applicableGates: readonly RichSafetyGate[],
): "READY" | "WAITING" {
  if (
    applicableGates.some((gate) => gate.status === "OPEN") ||
    ["hardware-gated", "production-gated"].includes(milestone.execution_mode)
  ) {
    return "WAITING";
  }
  return milestone.initial_status === "READY" ? "READY" : "WAITING";
}

function projectSandboxMode(
  mode: RichExecutionMode,
): "read-only" | "workspace-write" {
  return mode === "local" || mode === "worktree"
    ? "workspace-write"
    : "read-only";
}

function deriveProjection(plan: RichThreadPlan): PreviewProjectThreadsInput {
  const gatesByMilestone = new Map<string, RichSafetyGate[]>(
    plan.milestones.map((milestone) => [milestone.milestone_id, []]),
  );
  for (const gate of plan.safety_gates) {
    for (const target of gate.applies_to) {
      gatesByMilestone.get(target)?.push(gate);
    }
  }

  return PreviewProjectThreadsInputSchema.parse({
    project_cwd: plan.project_cwd,
    project_name: plan.project_name,
    initialize_only: true,
    threads: plan.milestones.map((milestone) => {
      const prefix = `${milestone.milestone_id} `;
      const conciseName = milestone.name.startsWith(prefix)
        ? milestone.name.slice(prefix.length).trim()
        : "";
      return {
        milestone_id: milestone.milestone_id,
        name: conciseName,
        goal: milestone.goal,
        initial_prompt: milestone.initial_prompt,
        dependencies: [...milestone.dependencies],
        allowed_paths: [...milestone.allowed_paths],
        forbidden_paths: [...milestone.forbidden_paths],
        acceptance_criteria: [...milestone.acceptance_criteria],
        validation_commands: [...milestone.validation_commands],
        initial_status: projectInitialStatus(
          milestone,
          gatesByMilestone.get(milestone.milestone_id) ?? [],
        ),
        sandbox_mode: projectSandboxMode(milestone.execution_mode),
      };
    }),
  });
}

export async function validateAndProject(
  rawPlan: unknown,
  rawSchema: unknown,
): Promise<ValidationResult> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);
  const validate = ajv.compile(rawSchema as AnySchema);
  if (!validate(rawPlan)) {
    throw new CapsulePlanValidationError(
      "thread-plan.json failed JSON Schema validation",
      (validate.errors ?? []).map(formatSchemaError),
    );
  }

  const richPlan = rawPlan as RichThreadPlan;
  const semantics = semanticChecks(richPlan);
  if (semantics.errors.length > 0) {
    throw new CapsulePlanValidationError(
      "thread-plan.json failed semantic validation",
      semantics.errors,
    );
  }

  const projected = deriveProjection(richPlan);
  const strictPlan = await validateProjectPlan(projected);
  return {
    rich_plan: richPlan,
    projection: {
      project_cwd: strictPlan.project_cwd,
      project_name: strictPlan.project_name,
      initialize_only: true,
      threads: strictPlan.threads,
    },
    warnings: semantics.warnings,
  };
}

function parseCli(argv: readonly string[]): CliOptions {
  let planPath: string | undefined;
  let schemaPath = defaultSchemaPath;
  let projectOutput: string | undefined;
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--schema") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CapsulePlanValidationError("--schema requires a path");
      }
      schemaPath = path.resolve(value);
      index += 1;
    } else if (argument === "--project-output") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new CapsulePlanValidationError(
          "--project-output requires a path",
        );
      }
      projectOutput = path.resolve(value);
      index += 1;
    } else if (argument === "--quiet") {
      quiet = true;
    } else if (argument?.startsWith("-") === true) {
      throw new CapsulePlanValidationError(`unknown option: ${argument}`);
    } else if (planPath === undefined && argument !== undefined) {
      planPath = path.resolve(argument);
    } else {
      throw new CapsulePlanValidationError(
        `unexpected positional argument: ${String(argument)}`,
      );
    }
  }

  if (planPath === undefined) {
    throw new CapsulePlanValidationError(
      "usage: validate-thread-plan.mjs <thread-plan.json> [--schema path] [--project-output path] [--quiet]",
    );
  }
  return {
    planPath,
    schemaPath,
    ...(projectOutput === undefined ? {} : { projectOutput }),
    quiet,
  };
}

async function atomicWriteJson(outputPath: string, value: unknown): Promise<void> {
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, outputPath);
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseCli(argv);
    const [planText, schemaText] = await Promise.all([
      readFile(options.planPath, "utf8"),
      readFile(options.schemaPath, "utf8"),
    ]);
    const result = await validateAndProject(
      parseJson(planText, options.planPath),
      parseJson(schemaText, options.schemaPath),
    );
    if (options.projectOutput !== undefined) {
      await atomicWriteJson(options.projectOutput, result.projection);
    }
    if (!options.quiet) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: true,
            project_cwd: result.projection.project_cwd,
            project_name: result.projection.project_name,
            milestone_count: result.projection.threads.length,
            milestone_ids: result.projection.threads.map(
              (thread) => thread.milestone_id,
            ),
            projection_path: options.projectOutput ?? null,
            warnings: result.warnings,
          },
          null,
          2,
        )}\n`,
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof CapsulePlanValidationError) {
      process.stderr.write(`ERROR: ${error.message}\n`);
      for (const detail of error.details) {
        process.stderr.write(`- ${detail}\n`);
      }
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ERROR: ${message}\n`);
    }
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main(process.argv.slice(2));
}
