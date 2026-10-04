// Network integration test: a clean profile, no configured/system Python.
const {_electron:electron}=require('@playwright/test');
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc setup 日本語 '));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('button',{name:'必要な環境を自動セットアップ',exact:true}).click();
  await page.getByRole('status').filter({hasText:'準備完了'}).waitFor({timeout:180000});
  const config=await page.evaluate(()=>window.yvc.invoke('config'));assert(config.python.startsWith(home));assert(fs.existsSync(config.python));
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('select option').length>2,{timeout:30000});
  assert.equal(await page.getByRole('alert').count(),0);
  console.log('PASS clean profile button setup, verified downloads, imports and worker device enumeration');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
