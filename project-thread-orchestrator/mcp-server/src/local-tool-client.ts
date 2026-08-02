import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { PLUGIN_VERSION } from "./types.js";

export interface ArchiveToolFlowOptions {
  server_entry: string;
  codex_command: string;
  project_cwd: string;
  milestone_ids: string[];
}

export async function runArchiveProjectThreadsTool(
  options: ArchiveToolFlowOptions,
  validatePreview: (preview: Record<string, unknown>) => void,
): Promise<{
  preview: Record<string, unknown>;
  archive: Record<string, unknown>;
}> {
  if (
    !path.isAbsolute(options.server_entry) ||
    !path.isAbsolute(options.codex_command) ||
    !path.isAbsolute(options.project_cwd)
  ) {
    throw new Error(
      "The MCP server entry, Codex command, and project cwd must be absolute paths",
    );
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.server_entry],
    cwd: path.dirname(options.server_entry),
    env: {
      ...getDefaultEnvironment(),
      PTO_CODEX_COMMAND: options.codex_command,
    },
    stderr: "inherit",
  });
  const client = new Client({
    name: "project-thread-orchestrator-manual-smoke",
    version: PLUGIN_VERSION,
  });
  try {
    await client.connect(transport);
    const preview = readStructuredToolResult(
      await client.callTool({
        name: "archive_project_threads",
        arguments: {
          project_cwd: options.project_cwd,
          milestone_ids: options.milestone_ids,
          dry_run: true,
          confirmed: false,
        },
      }),
    );
    validatePreview(preview);
    const confirmation = requireObject(preview, "confirmation");
    const token = confirmation.token;
    if (typeof token !== "string" || token.length < 16) {
      throw new Error(
        "archive_project_threads preview returned no valid confirmation token",
      );
    }
    const archive = readStructuredToolResult(
      await client.callTool({
        name: "archive_project_threads",
        arguments: {
          project_cwd: options.project_cwd,
          milestone_ids: options.milestone_ids,
          dry_run: false,
          confirmed: true,
          confirmation_token: token,
        },
      }),
    );
    return { preview, archive };
  } finally {
    await client.close();
  }
}

function readStructuredToolResult(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP tool returned a non-object result");
  }
  const result = value as Record<string, unknown>;
  if (result.isError === true) {
    throw new Error(
      `archive_project_threads returned an MCP error: ${JSON.stringify(result.content ?? null)}`,
    );
  }
  const structured = result.structuredContent;
  if (
    structured === null ||
    typeof structured !== "object" ||
    Array.isArray(structured)
  ) {
    throw new Error(
      "archive_project_threads returned no structuredContent object",
    );
  }
  return structured as Record<string, unknown>;
}

function requireObject(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const candidate = value[field];
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    throw new Error(`${field} must be an object`);
  }
  return candidate as Record<string, unknown>;
}
