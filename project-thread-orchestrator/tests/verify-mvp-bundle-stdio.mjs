import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn(process.execPath, [path.join(root, "mcp-server", "dist", "server.js")], { cwd: root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stderr = ""; let buffer = ""; let sequence = 0;
const pending = new Map();
child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { buffer += chunk; for (;;) { const lineEnd=buffer.indexOf("\n"); if(lineEnd<0)return; const line=buffer.slice(0,lineEnd).trim(); buffer=buffer.slice(lineEnd+1); if(!line)continue; const message=JSON.parse(line); if(message.id!==undefined&&pending.has(message.id)){pending.get(message.id)(message);pending.delete(message.id);} } });
function request(method, params={}) { const id=++sequence; child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id,method,params})}\n`); return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`timeout: ${method}`));},5000); pending.set(id,value=>{clearTimeout(timer);resolve(value);});}); }
function notify(method,params={}){child.stdin.write(`${JSON.stringify({jsonrpc:"2.0",method,params})}\n`);}
try {
  const initialized=await request("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"mvp-bundle-test",version:"1"}});
  if(!initialized.result?.serverInfo) throw new Error("initialize response missing serverInfo");
  notify("notifications/initialized");
  const listed=await request("tools/list");
const expected=["create_project_threads","initialize_project_capsule","list_project_threads","preview_project_threads","sync_project_threads"];
  const actual=(listed.result?.tools??[]).map(tool=>tool.name).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error(`unexpected tools: ${JSON.stringify(actual)}`);
  child.stdin.end();
  const exit=await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill();resolve(null);},5000);child.once("exit",code=>{clearTimeout(timer);resolve(code);});});
  if(exit!==0) throw new Error(`bundle exit code ${exit}; ${stderr}`);
  if(/(?:uncaught|unhandled|fatal|error:)/iu.test(stderr)) throw new Error(`bundle stderr: ${stderr}`);
  process.stdout.write(JSON.stringify({ok:true,initialize:true,tools:actual,exit_code:exit,stderr},null,2)+"\n");
} catch (error) { child.kill(); process.stderr.write(`${error instanceof Error?error.stack:String(error)}\n`); process.exitCode=1; }
