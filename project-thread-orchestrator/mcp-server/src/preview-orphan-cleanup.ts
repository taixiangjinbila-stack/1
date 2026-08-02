import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const input = z
  .tuple([
    z.string().refine(path.isAbsolute),
    z.string().refine(path.isAbsolute),
    z.string().min(1),
  ])
  .rest(z.string().min(1))
  .parse(process.argv.slice(2));
const [serverEntry, projectCwd, ...threadIds] = input;
const codexCommand = process.env.PTO_CODEX_COMMAND;
if (codexCommand === undefined || !path.isAbsolute(codexCommand)) {
  throw new Error("PTO_CODEX_COMMAND must be an absolute audited Codex path");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: path.dirname(path.dirname(path.dirname(serverEntry))),
  env: {
    ...getDefaultEnvironment(),
    PTO_CODEX_COMMAND: codexCommand,
  },
  stderr: "inherit",
});
const client = new Client({ name: "orphan-preview", version: "1.0.0" });
try {
  await client.connect(transport);
  const result = await client.callTool({
    name: "preview_orphan_thread_cleanup",
    arguments: {
      project_cwd: projectCwd,
      thread_ids: threadIds,
    },
  });
  process.stdout.write(
    `${JSON.stringify(result.structuredContent, null, 2)}\n`,
  );
} finally {
  await client.close();
}
