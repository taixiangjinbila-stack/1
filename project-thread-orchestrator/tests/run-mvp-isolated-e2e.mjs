import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const cwd="C:\\Users\\Lenovo\\Documents\\ProjectCapsuleMvpE2E";
const input={canonical_cwd:cwd,project_goal:"验证 Project Capsule MVP 能在同一个 Codex 项目目录下自动创建多个独立真实线程，并在重复调用时复用它们。",milestones:[
{milestone_id:"M0",name:"产品定义",objective:"定义一个最小本地任务管理器的产品范围、用户流程和验收标准。",dependencies:[],acceptance_criteria:["形成清晰、可执行且边界明确的产品定义。"]},
{milestone_id:"M1",name:"核心功能",objective:"规划任务创建、完成、搜索和本地持久化的核心逻辑。",dependencies:["M0"],acceptance_criteria:["核心功能职责、数据结构和测试边界清晰。"]},
{milestone_id:"M2",name:"最小界面与验收",objective:"规划最小桌面界面以及端到端验收流程。",dependencies:["M1"],acceptance_criteria:["界面范围、启动方式和端到端验收标准清晰。"]}]};
const child=spawn(process.execPath,[path.join(root,"mcp-server","dist","server.js")],{cwd:root,stdio:["pipe","pipe","pipe"],windowsHide:true});let buf="",err="",seq=0;const wait=new Map();child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stderr.on("data",x=>err+=x);child.stdout.on("data",x=>{buf+=x;let i;while((i=buf.indexOf("\n"))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;const m=JSON.parse(line);if(wait.has(m.id)){wait.get(m.id)(m);wait.delete(m.id);}}});
const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error(`timeout ${method}`)),30000);wait.set(id,m=>{clearTimeout(timer);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
try{await request("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"mvp-e2e",version:"1"}});child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized",params:{}})+"\n");const preview=await request("tools/call",{name:"preview_project_threads",arguments:input});const first=await request("tools/call",{name:"create_project_threads",arguments:{...input,confirmed:true}});const listed=await request("tools/call",{name:"list_project_threads",arguments:{canonical_cwd:cwd}});const second=await request("tools/call",{name:"create_project_threads",arguments:{...input,confirmed:true}});process.stdout.write(JSON.stringify({preview,first,listed,second,stderr:err},null,2));child.stdin.end();}catch(e){process.stderr.write(`${e.stack??e}\n${err}`);process.exitCode=1;}
