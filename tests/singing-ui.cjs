const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-singing-'));
 const app=await electron.launch({args:[path.resolve('.')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const p=await app.firstWindow();await p.getByRole('button',{name:'◉ 声を変える'}).click();
  const checkbox=p.getByRole('checkbox',{name:'歌唱モード',exact:true});
  const threshold=p.getByRole('spinbutton',{name:'歌唱に切り替える高さ'});
  assert(await threshold.isDisabled());await checkbox.check();await threshold.fill('400');
  await p.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.beatrice_singing&&c.beatrice_singing_threshold===400});
  await checkbox.uncheck();await p.waitForFunction(async()=>!(await window.yvc.invoke('config')).beatrice_singing);
  assert(await threshold.isDisabled());assert.equal((await p.evaluate(()=>window.yvc.invoke('config'))).beatrice_pitch,12);
  console.log('PASS singing toggle/threshold persist without overwriting conversation pitch');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
