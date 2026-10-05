import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const directories=['server','src','shared','src-tauri/src'];
const code=/\.(?:tsx?|rs)$/;
const files=[];
function walk(directory){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);if(entry.isDirectory())walk(file);else if(code.test(entry.name)&&! /\.(?:test|spec)\.tsx?$/.test(entry.name))files.push(file);}}
for(const directory of directories)walk(path.join(root,directory));
for(const name of ['db_layer.ts','server.ts','launcher.ts'])if(fs.existsSync(name))files.push(path.resolve(name));
const limit=3000;
const large=files.map(file=>({file:path.relative(root,file).replace(/\\/g,'/'),lines:fs.readFileSync(file,'utf8').split(/\r?\n/).length})).filter(file=>file.lines>limit);
if(large.length){console.error('[module-size] Production modules exceed '+limit+' lines:\n'+large.map(file=>file.file+': '+file.lines).join('\n'));process.exitCode=1;}else console.log('[module-size] '+files.length+' production TS/TSX/Rust files: none exceeds '+limit+' lines.');
