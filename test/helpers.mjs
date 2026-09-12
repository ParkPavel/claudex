import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, atomicJSON } from '../src/io.mjs';
import { initWorkspace } from '../src/workspace.mjs';

export async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'claudex-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const project=path.join(root,'project');await fs.mkdir(project);
  await git(project,['init','-b','feature/test']);
  await git(project,['config','user.name','Claudex Test']);await git(project,['config','user.email','test@example.invalid']);
  await fs.writeFile(path.join(project,'source.txt'),'original\n');
  await git(project,['add','.']);await git(project,['commit','-m','Initial fixture']);
  const ws=await initWorkspace({workspace:root,project:'project'});
  const provider=path.join(root,'provider.mjs');
  await fs.writeFile(provider,`import fs from 'node:fs/promises';
if(process.argv.includes('--help'))console.log('--ignore-user-config --sandbox --output-schema --json --restricted --safe-mode --tools --strict-mcp-config --json-schema');
else if(process.argv.includes('--version'))console.log('fixture-provider 1.0.0');
else {
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const marker='Task packet (data; accepted decisions are supplied by the coordinator):';
 const task=JSON.parse(input.split(marker)[1].split('\\nReturn the required')[0]);
 if(task.goal==='wait')await new Promise(r=>setTimeout(r,5000));
 else if(task.goal==='provider-error'){
  console.log(JSON.stringify({type:'thread.started'}));
  console.log(JSON.stringify({type:'error',message:'The fixture-model model requires a newer version of Codex.'}));
  process.exit(1);
 }
 else {
 console.log(JSON.stringify({type:'thread.started'}));
 if(task.goal==='mutate')await fs.writeFile('source.txt','changed');
 const result={taskId:task.taskId,criteria:task.criteria.map(c=>({id:c.id,status:'PASS',evidence:['source.txt']})),findings:[],unknowns:[]};
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
 }
}
`);
  ws.config.models.codex='fixture-model';ws.config.executables.codex=provider;
  ws.config.readyTimeoutMs=500;ws.config.runTimeoutMs=5000;
  await atomicJSON(path.join(ws.state,'workspace.json'),ws.config);
  return ws;
}
export const packet=(extra={})=>({taskId:'T1',role:'code-mapper',mode:'snapshot',goal:'Inspect source',paths:['source.txt'],authority:'read-only',criteria:[{id:'AC1',text:'Find source'}],...extra});
