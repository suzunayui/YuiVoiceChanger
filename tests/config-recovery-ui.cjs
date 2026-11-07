// Unreadable settings are kept aside and reported; IPC errors reach the screen without Electron's wrapper text.
const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
async function scenario(contents,check){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-config-recovery-'));
 fs.writeFileSync(path.join(home,'desktop.json'),contents);
 const app=await electron.launch({args:[path.resolve(__dirname,'..')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{await check(await app.firstWindow(),home,app);}
 finally{await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});}
}
const backups=home=>fs.readdirSync(home).filter(name=>/^desktop\.unreadable-.*\.json$/.test(name));
(async()=>{
 for(const broken of ['{"beatrice_pitch":3,','{"engine_version":2,"beatrice_pitch":999}'])await scenario(broken,async(page,home)=>{
  await page.getByRole('alert').filter({hasText:'設定ファイルを読み込めなかったため'}).waitFor();
  const [backup]=backups(home);assert(backup,'the unreadable file is kept');
  assert.equal(fs.readFileSync(path.join(home,backup),'utf8'),broken);
 });
 await scenario(JSON.stringify({engine_version:2,python:path.join(os.tmpdir(),'yvc-missing-python.exe')}),async(page,home)=>{
  const alert=page.getByRole('alert').filter({hasText:'環境設定でPython実行ファイルを指定してください。'});
  await alert.waitFor();
  assert.doesNotMatch(await alert.innerText(),/Error|invoking/);
  assert.equal(backups(home).length,0);
 });
 console.log('PASS unreadable settings are preserved and reported; IPC errors show only the message');
})().catch(error=>{console.error(error);process.exitCode=1;});
