import type { AppThread, AppThreadListPage, AppTurn, CodexAppServerPort, LoadedThreadListPage, ThreadStartParams, TurnStartParams } from "../mcp-server/src/types.js";
export class ActivationMockAppServer implements CodexAppServerPort {
  public events:Array<{method:string;params:unknown}>=[]; public threads=new Map<string,AppThread>(); public loaded=new Set<string>(); public turns=0; public starts=0;
  public seed(cwd:string,id="fixture-m0"){const t:AppThread={id,cwd,name:"M0 产品范围与技术基线",status:{type:"idle"},turns:[]};this.threads.set(id,t);return t;}
  async startThread(p:ThreadStartParams){this.starts++;this.events.push({method:"thread/start",params:p});return this.seed(p.cwd,`new-${this.starts}`)}
  async waitForThreadStarted(id:string){return this.require(id)}
  async resumeThread(id:string){this.events.push({method:"thread/resume",params:{threadId:id}});this.loaded.add(id);return this.require(id)}
  async listLoadedThreadIds():Promise<LoadedThreadListPage>{this.events.push({method:"thread/loaded/list",params:{}});return {data:[...this.loaded],nextCursor:null}}
  async setThreadName(){} async setThreadGoal(){}
  async startTurn(p:TurnStartParams):Promise<AppTurn>{this.events.push({method:"turn/start",params:p});if(!this.loaded.has(p.threadId))throw new Error("thread not loaded");const t:AppTurn={id:`turn-${++this.turns}`,status:"completed"};this.require(p.threadId).turns?.push(t);return t}
  async waitForTurnCompletion(_id:string,id:string){return {id,status:"completed"}} async interruptTurn(){}
  async readThread(id:string){this.events.push({method:"thread/read",params:{threadId:id}});return this.require(id)}
  async listThreads(p:{cwd:string;archived:boolean;cursor?:string|null;limit?:number}):Promise<AppThreadListPage>{return {data:[...this.threads.values()].filter(t=>t.cwd===p.cwd),nextCursor:null}}
  async archiveThread(){} async deleteThread(){} async close(){}
  private require(id:string){const t=this.threads.get(id);if(!t)throw new Error("thread not found");return structuredClone(t)}
}
