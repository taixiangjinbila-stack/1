import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CodexAppServerPort } from "./types.js";

const Milestone = z.object({ milestone_id:z.string().regex(/^M[0-7]$/u), name:z.string().trim().min(1), objective:z.string().trim().min(1), dependencies:z.array(z.string().regex(/^M[0-7]$/u)), acceptance_criteria:z.array(z.string().trim().min(1)).min(1) }).strict();
export const MvpInput = z.object({ canonical_cwd:z.string().trim().min(1), project_goal:z.string().trim().min(1), milestones:z.array(Milestone).min(2).max(8) }).strict();
export const CwdInput = z.object({ canonical_cwd:z.string().trim().min(1) }).strict();
type Plan = z.infer<typeof MvpInput>;
type MilestoneRecord = z.infer<typeof Milestone> & { thread_id:string|null };
type Registry = { schema_version:1; canonical_cwd:string; project_goal:string; created_at:string; milestones:MilestoneRecord[] };

function registryPath(cwd:string){ return path.join(cwd,".project-capsule","mvp-thread-registry.json"); }
function displayName(m:z.infer<typeof Milestone>){ return `${m.milestone_id} ${m.name}`; }
function validate(plan:Plan){ const ids=new Set(plan.milestones.map(m=>m.milestone_id)); if(!ids.has("M0")) throw new Error("M0 is required"); if(ids.size!==plan.milestones.length) throw new Error("milestone ids must be unique"); for(const m of plan.milestones) if(m.dependencies.some(id=>!ids.has(id)||id===m.milestone_id)) throw new Error(`invalid dependency for ${m.milestone_id}`); }

export class MvpService {
  public constructor(private readonly app:CodexAppServerPort, private readonly now=()=>new Date()) {}
  public preview(raw:unknown){ const plan=MvpInput.parse(raw); validate(plan); return { ok:true, confirmation_required:true, project_goal:plan.project_goal, threads:plan.milestones.map(m=>({milestone_id:m.milestone_id,name:displayName(m),objective:m.objective,dependencies:m.dependencies,acceptance_criteria:m.acceptance_criteria})) }; }
  public async create(raw:unknown){ const plan=MvpInput.parse(raw); validate(plan); const existing=await this.load(plan.canonical_cwd); const registry:Registry=existing??{schema_version:1,canonical_cwd:plan.canonical_cwd,project_goal:plan.project_goal,created_at:this.now().toISOString(),milestones:plan.milestones.map(m=>({...m,thread_id:null}))}; const listed=await this.allThreads(plan.canonical_cwd); const created:string[]=[]; const reused:string[]=[]; for(const m of registry.milestones){ let id=m.thread_id; const match=id?listed.find(t=>t.id===id&&t.cwd===plan.canonical_cwd):undefined; if(match){ reused.push(m.milestone_id); continue; } const started=await this.app.startThread({cwd:plan.canonical_cwd,approvalPolicy:"never",sandbox:"read-only",ephemeral:false,serviceName:"project-thread-orchestrator"}); await this.app.setThreadName(started.id,displayName(m)); await this.app.setThreadGoal(started.id,`${m.objective}\n\nBefore starting: read AGENTS.md, SPEC.md, PLAN.md, THREADS.md, STATUS.md, DECISIONS.md, and RISKS.md. Execute only your own task card.`); m.thread_id=started.id; created.push(m.milestone_id); } await this.save(registry); return {ok:true,created,reused,missing:registry.milestones.filter(m=>m.thread_id===null).map(m=>m.milestone_id),errors:[],milestones:registry.milestones}; }
  public async list(raw:unknown){ const {canonical_cwd}=CwdInput.parse(raw); const r=await this.load(canonical_cwd); return {ok:true,canonical_cwd,milestones:r?.milestones??[]}; }
  public async sync(raw:unknown){ const {canonical_cwd}=CwdInput.parse(raw); const r=await this.load(canonical_cwd); if(!r)return {ok:true,canonical_cwd,milestones:[]}; const listed=await this.allThreads(canonical_cwd); for(const m of r.milestones) if(m.thread_id!==null&&!listed.some(t=>t.id===m.thread_id&&t.cwd===canonical_cwd)) m.thread_id=null; await this.save(r); return {ok:true,canonical_cwd,milestones:r.milestones}; }
  private async allThreads(cwd:string){ const all=[] as Awaited<ReturnType<CodexAppServerPort["listThreads"]>>["data"]; let cursor:string|null=null; do { const page=await this.app.listThreads({cwd,archived:false,...(cursor===null?{}:{cursor}),limit:100}); all.push(...page.data); cursor=page.nextCursor; } while(cursor!==null); return all; }
  private async load(cwd:string):Promise<Registry|null>{ try{return JSON.parse(await readFile(registryPath(cwd),"utf8")) as Registry;}catch{return null;} }
  private async save(r:Registry){ const target=registryPath(r.canonical_cwd); await mkdir(path.dirname(target),{recursive:true}); const tmp=`${target}.tmp`; await writeFile(tmp,JSON.stringify(r,null,2)+"\n","utf8"); await rename(tmp,target); }
}
