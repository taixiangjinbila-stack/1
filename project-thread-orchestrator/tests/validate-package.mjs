#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(testDirectory, "..");
const errors = [];

async function readText(relativePath) {
  return await readFile(path.join(pluginRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readText(relativePath));
  } catch (error) {
    errors.push(`${relativePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

async function requireFile(relativePath) {
  try {
    await access(path.join(pluginRoot, relativePath));
  } catch {
    errors.push(`required file is missing: ${relativePath}`);
  }
}

function requireString(object, key, label) {
  const value = object?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label}.${key} must be a non-empty string`);
    return null;
  }
  return value;
}

const manifest = await readJson(".codex-plugin/plugin.json");
const mcpPackage = await readJson("mcp-server/package.json");
const sourceTypes = await readText("mcp-server/src/types.ts");
if (manifest !== null) {
  const allowedManifestKeys = new Set([
    "name",
    "version",
    "description",
    "author",
    "skills",
    "interface",
    "mcpServers",
  ]);
  for (const key of Object.keys(manifest)) {
    if (!allowedManifestKeys.has(key)) {
      errors.push(`plugin.json contains unsupported field: ${key}`);
    }
  }
  if (manifest.name !== "project-thread-orchestrator") {
    errors.push("plugin.json name must be project-thread-orchestrator");
  }
  const version = requireString(manifest, "version", "plugin.json");
  if (version !== null && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
    errors.push("plugin.json version must be valid SemVer");
  }
  requireString(manifest, "description", "plugin.json");
  if (manifest.skills !== "./skills/") {
    errors.push("plugin.json skills must be ./skills/");
  }
  if (manifest.mcpServers !== "./.mcp.json") {
    errors.push("plugin.json mcpServers must be ./.mcp.json");
  }
  const interfaceBlock = manifest.interface;
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
    "defaultPrompt",
  ]) {
    requireString(interfaceBlock, field, "plugin.json.interface");
  }
  if (
    typeof interfaceBlock?.defaultPrompt === "string" &&
    !interfaceBlock.defaultPrompt.includes(
      "$project-thread-orchestrator:project-capsule-orchestrator",
    )
  ) {
    errors.push("plugin defaultPrompt must invoke the namespaced bundled Skill");
  }
}

if (manifest !== null && mcpPackage !== null) {
  if (mcpPackage.version !== manifest.version) {
    errors.push(
      "mcp-server/package.json version must match .codex-plugin/plugin.json version",
    );
  }
  const sourceVersion = /export const PLUGIN_VERSION = "([^"]+)";/u.exec(
    sourceTypes,
  )?.[1];
  if (sourceVersion !== manifest.version) {
    errors.push(
      "mcp-server/src/types.ts PLUGIN_VERSION must match .codex-plugin/plugin.json version",
    );
  }
}

const mcpManifest = await readJson(".mcp.json");
if (mcpManifest !== null) {
  const server = mcpManifest.mcpServers?.["project-thread-orchestrator"];
  if (server?.command !== "node") {
    errors.push(".mcp.json server command must be node");
  }
  if (
    !Array.isArray(server?.args) ||
    server.args.length !== 1 ||
    server.args[0] !== "./mcp-server/dist/server.js"
  ) {
    errors.push(".mcp.json must launch only ./mcp-server/dist/server.js");
  }
  if (server?.cwd !== ".") {
    errors.push(".mcp.json server cwd must be the plugin root");
  }
}

const skillText = await readText(
  "skills/project-capsule-orchestrator/SKILL.md",
);
const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(skillText);
if (frontmatterMatch === null) {
  errors.push("SKILL.md must begin with YAML front matter");
} else {
  const frontmatter = frontmatterMatch[1];
  const topLevelKeys = [...frontmatter.matchAll(/^([A-Za-z0-9_-]+):/gmu)].map(
    (match) => match[1],
  );
  const allowedKeys = new Set(["name", "description"]);
  for (const key of topLevelKeys) {
    if (key !== undefined && !allowedKeys.has(key)) {
      errors.push(`SKILL.md front matter contains unsupported field: ${key}`);
    }
  }
  const name = /^name:\s*(\S+)\s*$/mu.exec(frontmatter)?.[1];
  if (name !== "project-capsule-orchestrator") {
    errors.push("SKILL.md front matter name is invalid");
  }
  if (!/^description:\s*(?:>[-+]?|\|[-+]?|.+)$/mu.test(frontmatter)) {
    errors.push("SKILL.md front matter description is missing");
  }
}

const agentYaml = await readText(
  "skills/project-capsule-orchestrator/agents/openai.yaml",
);
const agentChecks = [
  [/^interface:\s*$/mu, "agent YAML interface"],
  [/^\s+display_name:\s*".+"\s*$/mu, "agent YAML display_name"],
  [/^\s+short_description:\s*".+"\s*$/mu, "agent YAML short_description"],
  [
    /^\s+default_prompt:\s*".*\$project-thread-orchestrator:project-capsule-orchestrator.*"\s*$/mu,
    "agent YAML namespaced default_prompt",
  ],
  [/^dependencies:\s*$/mu, "agent YAML dependencies"],
  [/^\s+tools:\s*$/mu, "agent YAML tools dependency"],
  [/^\s+- type:\s*"mcp"\s*$/mu, "agent YAML MCP dependency type"],
  [
    /^\s+value:\s*"project-thread-orchestrator"\s*$/mu,
    "agent YAML MCP dependency value",
  ],
  [/^\s+transport:\s*"stdio"\s*$/mu, "agent YAML MCP stdio transport"],
];
for (const [pattern, label] of agentChecks) {
  if (!pattern.test(agentYaml)) {
    errors.push(`${label} is missing or invalid`);
  }
}

const requiredSkillFiles = [
  "skills/project-capsule-orchestrator/references/capsule-plan-adapter.md",
  "skills/project-capsule-orchestrator/references/capsule-templates.md",
  "skills/project-capsule-orchestrator/references/decomposition-rules.md",
  "skills/project-capsule-orchestrator/references/initialization-policy.md",
  "skills/project-capsule-orchestrator/references/interview-protocol.md",
  "skills/project-capsule-orchestrator/references/project-audit-protocol.md",
  "skills/project-capsule-orchestrator/references/strategic-futures.md",
  "skills/project-capsule-orchestrator/references/thread-card-template.md",
  "skills/project-capsule-orchestrator/references/thread-plan-contract.md",
  "skills/project-capsule-orchestrator/schemas/thread-plan.schema.json",
  "skills/project-capsule-orchestrator/scripts/validate-thread-plan.mts",
  "skills/project-capsule-orchestrator/scripts/validate-thread-plan.mjs",
  "mcp-server/dist/server.js",
  "mcp-server/dist/diagnose_app_server_launch.js",
  "README.md",
];
await Promise.all(requiredSkillFiles.map(requireFile));

const richSchema = await readJson(
  "skills/project-capsule-orchestrator/schemas/thread-plan.schema.json",
);
if (richSchema !== null) {
  if (richSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    errors.push("thread-plan schema must declare JSON Schema 2020-12");
  }
  if (
    richSchema.properties?.milestones?.minItems !== 3 ||
    richSchema.properties?.milestones?.maxItems !== 12
  ) {
    errors.push("thread-plan schema must enforce 3 through 12 milestones");
  }
  if (richSchema.$defs?.milestoneId?.pattern !== "^M(?:0|[1-9][0-9]?)$") {
    errors.push("thread-plan schema must restrict milestone IDs to M0 through M99");
  }
}

const localMarketplacePath = path.resolve(
  pluginRoot,
  "..",
  ".agents",
  "plugins",
  "marketplace.json",
);
try {
  const marketplace = JSON.parse(
    await readFile(localMarketplacePath, "utf8"),
  );
  const entry = marketplace.plugins?.find(
    (candidate) => candidate?.name === "project-thread-orchestrator",
  );
  if (marketplace.name !== "project-thread-orchestrator-marketplace") {
    errors.push("marketplace name must be project-thread-orchestrator-marketplace");
  }
  if (
    entry?.source?.source !== "local" ||
    entry?.source?.path !== "./project-thread-orchestrator"
  ) {
    errors.push(
      "local marketplace must point project-thread-orchestrator at ./project-thread-orchestrator",
    );
  }
} catch (error) {
  errors.push(
    `local marketplace is missing or invalid at ${localMarketplacePath}: ${error.message}`,
  );
}

if (errors.length > 0) {
  process.stderr.write("PACKAGE VALIDATION FAILED\n");
  for (const error of errors) {
    process.stderr.write(`- ${error}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        plugin_root: pluginRoot,
        plugin: manifest?.name,
        version: manifest?.version,
        skill: "project-capsule-orchestrator",
        mcp_server: "project-thread-orchestrator",
        bundled_skill_files: requiredSkillFiles.length,
        local_marketplace: localMarketplacePath,
      },
      null,
      2,
    )}\n`,
  );
}
