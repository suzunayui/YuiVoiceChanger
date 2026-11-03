const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {ObsServer}=require('./helpers/obs-server.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let count=0;count<150;count++){if(predicate())return;await pause(20);}throw Error('Expected OBS change did not arrive.');}
(async()=>{
 const server=await new ObsServer().ready;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-obs-ui-')),fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const packaged=Boolean(process.env.YVC_TEST_EXECUTABLE);
 const launch=packaged?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[fixture]};
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python:packaged?'':python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:true,singing_latency_ms:500,obs_port:server.port}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-obs-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;global.obsAudioStarts=0;
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;
 child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const emit=event=>child.stdout.write(JSON.stringify(event)+'\\n'),worker=args.some(arg=>arg.endsWith('worker.py'));
 child.stdin=new Writable({write(chunk,encoding,done){for(const line of chunk.toString().trim().split('\\n')){
  const request=JSON.parse(line);
  if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
  if(request.command==='start'){global.obsAudioStarts++;emit({type:'state',state:'running',device:'CPU',budget_ms:80,schedule_ms:415});}
  if(request.command==='stop')emit({type:'state',state:'stopped'});
  if(request.command==='quit')setImmediate(()=>child.kill());
 }done();}});
 setImmediate(()=>{if(worker)emit({type:'ready'});else{child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 let app;
 try{
  app=await electron.launch({...launch,env:{...process.env,YVC_DESKTOP_HOME:home}});let page=await app.firstWindow();
  if(packaged)await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  const panel=page.getByRole('region',{name:'OBS連携',exact:true});
  const openSettings=async()=>{await panel.getByRole('button',{name:'OBS連携の設定',exact:true}).click();return page.getByRole('dialog',{name:'OBS連携の設定',exact:true});};
  let settings=await openSettings();await settings.getByRole('textbox',{name:'OBSのパスワード',exact:true}).fill('wrong');await settings.getByRole('button',{name:'閉じる',exact:true}).click();
  const calibrationOpen=page.getByRole('button',{name:'ビープでOBSのずれを自動調整',exact:true});assert(await calibrationOpen.isEnabled());await calibrationOpen.click();
  const calibration=page.getByRole('dialog',{name:'ビープでOBSのずれを自動調整',exact:true});await calibration.getByRole('alert').filter({hasText:'パスワード'}).waitFor();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('obs-sync-status'))).busy,false);
  await calibration.getByRole('textbox',{name:'OBSのパスワード',exact:true}).fill(server.password);
  await calibration.getByRole('button',{name:'接続する',exact:true}).click();await panel.getByText('接続済み',{exact:true}).first().waitFor();
  assert.equal(await calibration.getByRole('alert').count(),0);await calibration.getByRole('button',{name:'閉じる',exact:true}).click();
  const source=panel.getByRole('combobox',{name:'伴奏の音声ソース',exact:true});
  assert.equal(await source.locator('option').count(),4);
  await source.selectOption('uuid:desktop');
  await panel.getByRole('checkbox',{name:'同期オフセットを自動設定',exact:true}).check();
  settings=await openSettings();const correction=settings.getByRole('slider',{name:'補正値',exact:true});await correction.focus();
  for(let count=0;count<20;count++)await correction.press('ArrowRight');
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).obs_correction_ms===20);
  await settings.getByRole('button',{name:'閉じる',exact:true}).click();
  assert.equal(await panel.getByLabel('設定する同期オフセット',{exact:true}).textContent(),'+520 ms');assert.equal(server.writes().length,0);
  if(!packaged){
   await page.getByRole('button',{name:/声変換をはじめる/}).click();await until(()=>server.get('desktop').offset===520);
   assert(await source.isDisabled());assert.equal(server.get('voice').offset,0);
   settings=await openSettings();await settings.getByRole('button',{name:'補正値を1ms増やす',exact:true}).click();await until(()=>server.get('desktop').offset===521);await settings.getByRole('button',{name:'閉じる',exact:true}).click();
   assert.equal(await app.evaluate(()=>global.obsAudioStarts),1);
   await page.getByRole('button',{name:/停止する/}).click();await until(()=>server.get('desktop').offset===23);
  }
  for(const width of [1000,1280]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,570),width);
   await page.waitForFunction(width=>innerWidth===width,width);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const layout=await page.evaluate(()=>{const main=document.querySelector('main'),panel=document.querySelector('.obs-integration').getBoundingClientRect();return {w:innerWidth,sw:main.scrollWidth,mw:main.clientWidth,right:panel.right};});
   assert(layout.sw<=layout.mw&&layout.right<=layout.w,JSON.stringify(layout));
   if(width===1280&&process.env.YVC_TEST_SCREENSHOT){await page.locator('.obs-integration').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});}
  }
  const exported=path.join(home,'export.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);
  await page.evaluate(()=>window.yvc.invoke('export-settings'));const data=fs.readFileSync(exported,'utf8');assert(!data.includes(server.password));assert.equal(JSON.parse(data).obs_correction_ms,packaged?20:21);
  const status=await page.evaluate(()=>window.yvc.invoke('obs-status'));
  if(status.canRemember){assert(status.hasPassword);assert(!fs.readFileSync(path.join(home,'obs-password.bin')).includes(server.password));}
  await app.close();app=null;
  if(status.canRemember){
   app=await electron.launch({...launch,env:{...process.env,YVC_DESKTOP_HOME:home}});page=await app.firstWindow();
   if(packaged)await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
   await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
   const panel=page.getByRole('region',{name:'OBS連携',exact:true});await panel.getByText('接続済み',{exact:true}).waitFor();
   assert.equal(await panel.getByRole('combobox',{name:'伴奏の音声ソース',exact:true}).inputValue(),'uuid:desktop');
   assert.equal(server.get('desktop').offset,23);
   await panel.getByRole('button',{name:'OBS連携の設定',exact:true}).click();
   const settings=page.getByRole('dialog',{name:'OBS連携の設定',exact:true});await settings.getByRole('button',{name:'切断する',exact:true}).click();await panel.getByText('未接続',{exact:true}).waitFor();await settings.getByRole('button',{name:'閉じる',exact:true}).click();
   await page.waitForFunction(async()=> !(await window.yvc.invoke('config')).obs_enabled);
   await page.getByRole('button',{name:'ビープでOBSのずれを自動調整',exact:true}).click();
   await panel.getByText('接続済み',{exact:true}).waitFor();
   const calibration=page.getByRole('dialog',{name:'ビープでOBSのずれを自動調整',exact:true});await calibration.getByRole('button',{name:'閉じる',exact:true}).click();
  }
  console.log(packaged?'PASS packaged desktop WebSocket: authentication error/retry, audio source selection, 500+20 preview, compact layout, encrypted password, export exclusion and restart connection; no microphone opened':'PASS actual desktop IPC/WebSocket: authentication error/retry, audio source selection, 500+20=520 on start, live correction without audio restart, restore on stop, compact layout, encrypted password, export exclusion and restart connection');
 }finally{if(app)await app.close();await server.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
