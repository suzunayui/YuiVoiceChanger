const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {exportDiagnosticLog,redactPaths,MAX_LOG_BYTES}=require('../electron/diagnostic-log.cjs');
const info={version:'1.2.3',electron:'45.2.3',platform:'win32',release:'10.0.26300',arch:'x64',now:new Date('2026-11-07T20:00:00')};
// Every spelling of a user folder has to lose the name, since people post these files.
assert.equal(redactPaths('C:\\Users\\mikan\\.YuiVoiceChanger\\runtime\\x.py','C:\\Users\\mikan'),'%USERPROFILE%\\.YuiVoiceChanger\\runtime\\x.py');
assert.equal(redactPaths('c:/users/MIKAN/a.py','C:\\Users\\mikan'),'%USERPROFILE%/a.py');
assert.equal(redactPaths('D:\\Users\\other\\a.py and /Users/person/b.py and /home/someone/c.py','C:\\Users\\mikan'),'D:\\Users\\<user>\\a.py and /Users/<user>/b.py and /home/<user>/c.py');
assert.equal(redactPaths('File "C:\\Program Files\\app\\x.py", line 3','C:\\Users\\mikan'),'File "C:\\Program Files\\app\\x.py", line 3');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-diag-'));
try{
 const log=path.join(folder,'independent-engine.log'),output=path.join(folder,'out.txt');
 assert.throws(()=>exportDiagnosticLog(log,output,'C:\\Users\\mikan',info),/診断ログはまだありません/);
 assert.equal(fs.existsSync(output),false);
 fs.writeFileSync(log,'2026-11-07 Audio report: callback_late=1\nFile "C:\\Users\\mikan\\a.py"\n');
 exportDiagnosticLog(log,output,'C:\\Users\\mikan',info);
 const text=fs.readFileSync(output,'utf8');
 assert.match(text,/YuiVoiceChanger 1\.2\.3/);assert.match(text,/Electron 45\.2\.3/);assert.match(text,/win32 10\.0\.26300 x64/);
 assert.match(text,/Audio report: callback_late=1/);assert.match(text,/%USERPROFILE%\\a\.py/);assert.doesNotMatch(text,/mikan/);
 // A long log keeps its newest lines and never starts mid-line.
 const old='OLD '+'x'.repeat(99)+'\n',recent='RECENT Audio report\n';
 fs.writeFileSync(log,old.repeat(Math.ceil(MAX_LOG_BYTES/old.length)+50)+recent);
 exportDiagnosticLog(log,output,'C:\\Users\\mikan',info);
 const long=fs.readFileSync(output,'utf8');
 assert(long.length<MAX_LOG_BYTES+1000);assert.match(long,/RECENT Audio report\n$/);
 assert.match(long,/古い部分を省略/);
 const body=long.slice(long.indexOf('省略')).split('\n').slice(1,3);assert.match(body[0]+body[1],/OLD x+/);
 console.log('PASS diagnostic log export hides user paths, keeps the newest lines and reports a missing log');
}finally{fs.rmSync(folder,{recursive:true,force:true});}
