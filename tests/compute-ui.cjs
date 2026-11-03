const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-compute-'));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();
  await app.evaluate(({app})=>{
   global.computeTestDevices=[
    {id:'cpu',kind:'CPU',name:'Test CPU',available:true},
    {id:'cuda:0',kind:'GPU',name:'Test GPU A',available:true,memory_gb:8},
    {id:'cuda:1',kind:'GPU',name:'Test GPU B',available:true,memory_gb:16},
    {id:'unsupported:0',kind:'GPU',name:'Unsupported GPU',available:false,reason:'このGPUでの変換には対応していません。'}
   ];
   process.mainModule.require(app.getAppPath()+'/electron/compute-devices.cjs').computeDevices=async()=>({devices:global.computeTestDevices,warning:''});
  });
  await page.reload();
  const monitor=page.locator('.signal-card .gpu-name strong');
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await monitor.getByText('GPU · Test GPU A',{exact:true}).waitFor();
  await page.getByRole('button',{name:'⚙ 環境設定',exact:true}).click();
  await page.getByRole('radio',{name:/Test GPU B/}).waitFor();
  assert.equal(await page.getByRole('radio').count(),5);
  assert(await page.getByRole('radio',{name:/Unsupported GPU/}).isDisabled());
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  for(const [label,value,name] of [[/Test GPU B/,'cuda:1','GPU · Test GPU B'],[/Test CPU/,'cpu','CPU · Test CPU'],[/^推奨/,'auto','GPU · Test GPU A']]){
   await page.getByRole('radio',{name:label}).check();
   await page.waitForFunction(async expected=>(await window.yvc.invoke('config')).compute===expected,value);
   await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();await monitor.getByText(name,{exact:true}).waitFor();
   await page.getByRole('button',{name:'⚙ 環境設定',exact:true}).click();
  }
  // Display-only engine events verify actual-device reporting and stop/reset behavior.
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  for(const [device,name] of [['CPU','CPU · Test CPU'],['Test GPU B','GPU · Test GPU B']]){
   await app.evaluate(({BrowserWindow},device)=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state:'running',device}),device);
   await monitor.getByText(name,{exact:true}).waitFor();
  }
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state:'stopped'}));
  await monitor.getByText('GPU · Test GPU A',{exact:true}).waitFor();
  await page.reload();
  await page.getByRole('button',{name:'⚙ 環境設定',exact:true}).click();
  assert(await page.getByRole('radio',{name:/^推奨（GPU · Test GPU A）/}).isChecked());
  await app.evaluate(()=>{global.computeTestDevices=global.computeTestDevices.filter(device=>device.kind==='CPU');});
  await page.getByRole('button',{name:'一覧を再読み込み',exact:true}).click();
  await page.getByRole('radio',{name:/^推奨（CPU · Test CPU）/}).waitFor();
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();await monitor.getByText('CPU · Test CPU',{exact:true}).waitFor();
  await page.evaluate(async()=>{const config=await window.yvc.invoke('config');await window.yvc.invoke('save',{...config,compute:'cuda:1'});});
  await page.reload();await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await monitor.getByText('選択したGPUが見つかりません',{exact:true}).waitFor();
  console.log('PASS background detection, idle CPU/multiple GPU names, selected-device changes, actual runtime device, stop reset, CPU-only recommendation, missing pinned GPU and persistence');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
