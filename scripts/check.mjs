import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, exec, exists, readJSON } from '../src/io.mjs';
const failures=[];
let scripts=0,documents=0;
async function walk(dir) {
 for(const item of await fs.readdir(dir,{withFileTypes:true})) {
  if(['.git','node_modules','.local'].includes(item.name))continue;
  const file=path.join(dir,item.name);
  if(item.isDirectory()){await walk(file);continue;}
  if(item.name.endsWith('.mjs')){try{await exec(process.execPath,['--check',file]);scripts++;}catch{failures.push(`Syntax: ${path.relative(ROOT,file)}`);}}
  if(item.name.endsWith('.json')){try{await readJSON(file);}catch{failures.push(`JSON: ${path.relative(ROOT,file)}`);}}
  if(item.name.endsWith('.md')) {
   documents++;const text=await fs.readFile(file,'utf8');
   if(text.includes('\uFFFD'))failures.push(`Encoding: ${file}`);
   for(const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target=match[1];if(/^(https?:|#|mailto:)/.test(target))continue;
    if(!(await exists(path.resolve(path.dirname(file),target.split('#')[0]))))failures.push(`Link: ${path.relative(ROOT,file)} -> ${target}`);
   }
  }
 }
}
await walk(ROOT);
const roles=await readJSON(path.join(ROOT,'config/roles.json'));
for(const [name,role] of Object.entries(roles))for(const skill of role.skills)if(!(await exists(path.join(ROOT,'skills',skill,'SKILL.md'))))failures.push(`${name}: missing skill ${skill}`);
console.log(JSON.stringify({scripts,documents,failures},null,2));if(failures.length)process.exitCode=1;
