import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { MvpInput } from "./mvp-service.js";

const files=["AGENTS.md","SPEC.md","PLAN.md","THREADS.md","STATUS.md","DECISIONS.md","RISKS.md"] as const;
const begin="<!-- project-thread-orchestrator:capsule:begin -->";
const end="<!-- project-thread-orchestrator:capsule:end -->";
function block(body:string){return `${begin}\n${body}\n${end}\n`;}
function merge(existing:string,managed:string){const s=existing.indexOf(begin),e=existing.indexOf(end);if(s>=0&&e>=s)return existing.slice(0,s)+managed+existing.slice(e+end.length).replace(/^\r?\n/u,"");return existing+(existing.trim()?"\n\n":"")+managed;}
export class MvpCapsuleService {
  public async initialize(raw:unknown):Promise<Record<string,unknown>>{const p=MvpInput.parse(raw);const cards=p.milestones.map(m=>`## ${m.milestone_id} ${m.name}\n\nGoal: ${m.objective}\n\nDependencies: ${m.dependencies.join(", ")||"none"}\n\nAcceptance: ${m.acceptance_criteria.map(x=>`- ${x}`).join("\n")}\n`).join("\n");const contents:Record<string,string>={
    "AGENTS.md":block("# Shared project capsule\n\nBefore working, read SPEC.md, PLAN.md, THREADS.md, STATUS.md, DECISIONS.md, and RISKS.md. Execute only your own THREADS.md task card. Append important decisions to DECISIONS.md and update STATUS.md when blocked or complete."),
    "SPEC.md":block(`# Specification\n\n${p.project_goal}`),"PLAN.md":block(`# Plan\n\n${p.milestones.map(m=>`- ${m.milestone_id}: ${m.name}`).join("\n")}`),"THREADS.md":block(`# Milestone task cards\n\n${cards}`),"STATUS.md":block("# Status\n\nCapsule initialized. No milestone executes automatically."),"DECISIONS.md":block("# Decisions\n\nNo decisions recorded."),"RISKS.md":block("# Risks\n\nNo risks recorded.")};
    const changed:string[]=[];for(const f of files){const target=path.join(p.canonical_cwd,f);let prior="";try{prior=await readFile(target,"utf8");}catch{}const content=contents[f];if(content===undefined)throw new Error(`missing capsule content: ${f}`);const next=merge(prior,content);if(next!==prior){await mkdir(path.dirname(target),{recursive:true});const tmp=`${target}.tmp`;await writeFile(tmp,next,"utf8");await rename(tmp,target);changed.push(f);}}
    return {ok:true,canonical_cwd:p.canonical_cwd,changed,registry_path:path.join(p.canonical_cwd,".project-capsule","mvp-thread-registry.json"),next_step:"create_project_threads"};
  }
}
