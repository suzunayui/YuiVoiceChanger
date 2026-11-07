const {_electron:electron,expect}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-system-'));
 const app=await electron.launch({args:[path.resolve('.')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 // Display-only events in an isolated profile; no microphone or inference starts.
 const send=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',event),event);
 const sample={cpu:{total:42.4,busiest:88.6},ramFreeRatio:.25,ramFreeGb:4,ramTotalGb:16,gpu:{name:'RTX',util:97,encoder:5,vramUsedMb:6144,vramTotalMb:8192,temperature:70,thermalLimit:false}};
 try{
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'⚙ 環境設定'}).click();
  const section=page.getByRole('region',{name:'PCの状態',exact:true});
  await expect(section.getByRole('status')).toHaveText('声変換を開始すると確認します。');
  await send({type:'state',state:'running',budget_ms:80,schedule_ms:160});
  await expect(section.getByRole('status')).toContainText('測定中');
  await send({type:'system-status',sample,behind:false,verdicts:[{kind:'ok',message:'問題は見つかりませんでした。'}],found:{},summary:[]});
  await expect(section.getByRole('status')).toHaveText('問題は見つかりませんでした。');
  await expect(section).toContainText('42%');await expect(section).toContainText('89%');
  await expect(section).toContainText('4.0 / 16.0 GB');await expect(section).toContainText('97%');await expect(section).toContainText('6.0 / 8.0 GB');
  const message='GPUの処理が足りていません。';
  await send({type:'system-status',sample,behind:true,verdicts:[{kind:'gpu',message}],found:{gpu:2},summary:[{kind:'gpu',count:2,message}]});
  await expect(section.getByText(message)).toBeVisible();
  await expect(section).toContainText('この変換中に2回');
  // What was found stays visible once the conversion recovers, and across tab changes.
  await send({type:'system-status',sample,behind:false,verdicts:[{kind:'ok',message:'問題は見つかりませんでした。'}],found:{gpu:2},summary:[{kind:'gpu',count:2,message}]});
  await expect(section.getByText(message)).toBeVisible();
  await page.getByRole('button',{name:'◉ 声を変える'}).click();
  await page.getByRole('button',{name:'⚙ 環境設定'}).click();
  await expect(section.getByText(message)).toBeVisible();
  await send({type:'system-status',sample:{...sample,gpu:null},behind:false,verdicts:[],found:{},summary:[]});
  await expect(section).toContainText('取得できません');
  await expect(section).not.toContainText('GPUメモリ');
  // The result stays readable after stopping, and a new conversion starts clean.
  await send({type:'state',state:'stopped'});
  await expect(section).toContainText('取得できません');
  await send({type:'state',state:'running',budget_ms:80,schedule_ms:160});
  await expect(section.getByRole('status')).toContainText('測定中');
  assert.equal(await section.getByRole('alert').count(),0);
  console.log('PASS PC status shows values and verdicts, keeps findings across recovery and tabs, and resets on a new conversion');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
