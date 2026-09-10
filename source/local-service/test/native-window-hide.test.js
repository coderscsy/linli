import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
function method(source,name){
 const lines=source.replace(/\r/g,'').split('\n');
 const start=lines.findIndex(line=>/^        (public|private) /.test(line)&&line.includes(` ${name}(`));
 const end=lines.findIndex((line,index)=>index>start&&line==='        }');
 assert.ok(start>=0&&end>start);return lines.slice(start,end+1).join('\n');
}
test('one close hides the native maximized window as well as its content and reopens at the same state',{skip:process.platform!=='win32'},()=>{
 const source=readFileSync(new URL('../native-host/MainForm.cs',import.meta.url),'utf8');
 const fixture=readFileSync(new URL('./fixtures/native-window-hide/Harness.cs',import.meta.url),'utf8');
 const code=fixture.replace('/* HANDLERS */',['OnFormClosing','HideToTray','ShowFromTray'].map(name=>method(source,name)).join('\n'));
 const dir=mkdtempSync(join(tmpdir(),'native-window-hide-'));
 try{
  const file=join(dir,'Harness.cs'),exe=join(dir,'Harness.exe');writeFileSync(file,code);
  const framework=join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319');
  const dotnet=join(process.env.ProgramFiles||'C:\\Program Files','dotnet','dotnet.exe');
  const sdkRoot=join(dotnet,'..','sdk'),sdk=readdirSync(sdkRoot).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})).at(-1);
  const compile=spawnSync(dotnet,[join(sdkRoot,sdk,'Roslyn','bincore','csc.dll'),'/nologo','/target:exe','/nostdlib+',...['mscorlib','System','System.Core','System.Drawing','System.Windows.Forms'].map(name=>`/reference:${join(framework,name+'.dll')}`),'/out:'+exe,file],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(compile.status,0,compile.stdout+compile.stderr);
  const run=spawnSync(exe,[],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(run.status,0,run.stdout+run.stderr);console.log(run.stdout.trim());
 }finally{rmSync(dir,{recursive:true,force:true});}
});
