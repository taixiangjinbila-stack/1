import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MvpService } from "../mcp-server/src/mvp-service.js";
import { MvpCapsuleService } from "../mcp-server/src/mvp-capsule-service.js";
import type { CodexAppServerPort } from "../mcp-server/src/types.js";

class MvpMock {
  public events:string[]=[]; public threads:Array<{id:string;cwd:string;name?:string}> = []; private next=0;
  async listThreads({cwd}:{cwd:string}){this.events.push("thread/list");return {data:this.threads.filter(t=>t.cwd===cwd),nextCursor:null};}
  async startThread({cwd}:{cwd:string}){this.events.push("thread/start");const t={id:`mvp-${++this.next}`,cwd};this.threads.push(t);return t;}
  async setThreadName(id:string,name:string){this.events.push("thread/name/set");this.threads.find(t=>t.id===id)!.name=name;}
  public goals:string[]=[]; async setThreadGoal(_id:string,goal:string){this.events.push("thread/goal/set");this.goals.push(goal);}
}
const plan=(cwd:string)=>({canonical_cwd:cwd,project_goal:"demo",milestones:["产品定义","核心功能","最小界面"].map((name,index)=>({milestone_id:`M${index}`,name,objective:`完成${name}`,dependencies:index? [`M${index-1}`]:[],acceptance_criteria:["完成"]}))});
describe("MVP service",()=>{let cwd:string; let mock:MvpMock; let service:MvpService; beforeEach(async()=>{cwd=await mkdtemp(path.join(tmpdir(),"mvp-service-"));mock=new MvpMock();service=new MvpService(mock as unknown as CodexAppServerPort);});afterEach(async()=>rm(cwd,{recursive:true,force:true}));
it("previews without App Server calls",()=>{const value=service.preview(plan(cwd));expect(value.threads).toHaveLength(3);expect(mock.events).toEqual([]);});
it("creates once, persists IDs, then reuses notLoaded threads",async()=>{const first=await service.create(plan(cwd));expect(first.created).toEqual(["M0","M1","M2"]);expect(mock.events.filter(x=>x==="thread/name/set")).toHaveLength(3);expect(mock.events.filter(x=>x==="thread/goal/set")).toHaveLength(3);expect(new Set(mock.threads.map(t=>t.cwd))).toEqual(new Set([cwd]));const registry=JSON.parse(await readFile(path.join(cwd,".project-capsule","mvp-thread-registry.json"),"utf8"));expect(registry.milestones.every((m:{thread_id:string})=>m.thread_id)).toBe(true);expect(JSON.stringify(registry)).not.toMatch(/READY|WAITING|grant|Doctor|migration|loaded/iu);const second=await service.create(plan(cwd));expect(second.created).toEqual([]);expect(second.reused).toEqual(["M0","M1","M2"]);});
it("lists and syncs without mutating threads",async()=>{await service.create(plan(cwd));const listed=await service.list({canonical_cwd:cwd});expect(listed.milestones).toHaveLength(3);mock.events=[];await service.sync({canonical_cwd:cwd});expect(mock.events).toEqual(["thread/list"]);});
it("initializes shared files safely before creation and goals require reading them",async()=>{await writeFile(path.join(cwd,"SPEC.md"),"user note\n","utf8");const capsule=new MvpCapsuleService();const initialized=await capsule.initialize(plan(cwd));expect(initialized.changed).toHaveLength(7);for(const file of ["AGENTS.md","SPEC.md","PLAN.md","THREADS.md","STATUS.md","DECISIONS.md","RISKS.md"])expect(await readFile(path.join(cwd,file),"utf8")).toContain("project-thread-orchestrator:capsule");expect(await readFile(path.join(cwd,"SPEC.md"),"utf8")).toContain("user note");await service.create(plan(cwd));expect(mock.goals.every(goal=>goal.includes("read AGENTS.md, SPEC.md, PLAN.md, THREADS.md, STATUS.md, DECISIONS.md, and RISKS.md"))).toBe(true);});
it("persists shared decisions and milestone bindings across a service restart",async()=>{const capsule=new MvpCapsuleService();await capsule.initialize(plan(cwd));await service.create(plan(cwd));const decisions=await readFile(path.join(cwd,"DECISIONS.md"),"utf8");await writeFile(path.join(cwd,"DECISIONS.md"),decisions+"\nM0 decision: use local storage.\n","utf8");const restarted=new MvpService(mock as unknown as CodexAppServerPort);expect(await readFile(path.join(cwd,"DECISIONS.md"),"utf8")).toContain("M0 decision: use local storage.");expect((await restarted.list({canonical_cwd:cwd})).milestones).toHaveLength(3);});
});
