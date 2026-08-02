#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodexAppServerClient } from "./app-server-client.js";
import { PLUGIN_VERSION } from "./types.js";
import { CwdInput, MvpInput, MvpService } from "./mvp-service.js";
import { MvpCapsuleService } from "./mvp-capsule-service.js";

const app=new CodexAppServerClient();
const service=new MvpService(app);
const capsule=new MvpCapsuleService();
const server=new McpServer({name:"project-thread-orchestrator",version:PLUGIN_VERSION},{instructions:"Project Capsule MVP: preview milestones, confirm once, create persistent project threads, and list or sync them. Never execute project work."});
const result=(value:Record<string,unknown>)=>({content:[{type:"text" as const,text:JSON.stringify(value,null,2)}],structuredContent:value});
server.registerTool("preview_project_threads",{title:"Preview project threads",description:"Preview 2-8 milestone threads without creating anything.",inputSchema:MvpInput,annotations:{readOnlyHint:true,destructiveHint:false}},async args=>result(service.preview(args)));
server.registerTool("initialize_project_capsule",{title:"Initialize shared project capsule",description:"After plan confirmation, safely creates or updates shared capsule files without creating or executing threads.",inputSchema:MvpInput,annotations:{readOnlyHint:false,destructiveHint:false}},async args=>result(await capsule.initialize(args)));
server.registerTool("create_project_threads",{title:"Create project threads",description:"After one confirmation, create or reuse persistent threads in one project.",inputSchema:MvpInput.extend({confirmed:z.literal(true)}),annotations:{readOnlyHint:false}},async ({confirmed:_,...args})=>result(await service.create(args)));
server.registerTool("list_project_threads",{title:"List project threads",description:"List MVP milestone-to-thread bindings.",inputSchema:CwdInput,annotations:{readOnlyHint:true}},async args=>result(await service.list(args)));
server.registerTool("sync_project_threads",{title:"Sync project threads",description:"Synchronize registered IDs with threads in the same cwd; never creates or executes.",inputSchema:CwdInput,annotations:{readOnlyHint:false}},async args=>result(await service.sync(args)));
await server.connect(new StdioServerTransport());
process.stdin.once("end", () => { void server.close().finally(() => process.exit(0)); });
