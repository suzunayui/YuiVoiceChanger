const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {ObsServer}=require('./helpers/obs-server.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let count=0;count<150;count++){if(predicate())return;await pause(20);}throw Error('Expected OBS change did not arrive.');}
(async()=>{
 const server=await new ObsServer().ready;
 server.inputs.push({inputUuid:'camera',inputName:'3Dモデル映像',noAudio:true,inputKind:'dshow_input',offset:0});server.filters.set('camera',[]);
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-obs-ui-')),fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const packaged=Boolean(process.env.YVC_TEST_EXECUTABLE);
 const launch=packaged?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[fixture]};
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python:packaged?'':python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:true,singing_latency_ms:500,obs_correction_ms:20,obs_port:server.port,mix_enabled:true,obs_enabled:true,obs_input_uuid:"desktop",mix_voice_uuid:"voice"}));
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
  let settings=await openSettings();await settings.getByRole('textbox',{name:'OBSのパスワード',exact:true}).fill('wrong');
  await settings.getByRole('button',{name:'接続する',exact:true}).click();
  await settings.getByRole('alert').filter({hasText:'パスワード'}).waitFor();
  await settings.getByRole('textbox',{name:'OBSのパスワード',exact:true}).fill(server.password);
  await settings.getByRole('button',{name:'接続する',exact:true}).click();await panel.getByText('接続済み',{exact:true}).first().waitFor();
  assert.equal(await panel.getByRole('combobox',{name:'伴奏の音声ソース',exact:true}).count(),0);
  assert.equal(await panel.getByRole('checkbox',{name:'同期オフセットを自動設定',exact:true}).count(),0);
  assert.equal(await panel.getByRole('combobox',{name:'3Dモデルの操作用プレビュー',exact:true}).count(),0);
  await panel.getByRole('button',{name:'映像ソースを追加',exact:true}).click();const video=panel.getByRole('combobox',{name:'映像ソース 1',exact:true});await video.selectOption('uuid:video');
  await panel.getByRole('button',{name:'映像ソースを追加',exact:true}).click();await panel.getByRole('combobox',{name:'映像ソース 2',exact:true}).selectOption('uuid:camera');
  assert.equal(await panel.getByRole('spinbutton').count(),0);
  assert.equal(await panel.getByRole('checkbox',{name:'映像も声に同期',exact:true}).isChecked(),true);
  settings=await openSettings();assert.equal(await settings.getByRole('slider',{name:'補正値',exact:true}).count(),0);
  await settings.getByRole('button',{name:'閉じる',exact:true}).click();
  const latency=page.getByRole('slider',{name:'固定遅延',exact:true});assert.equal(await latency.inputValue(),'500');
  await page.getByRole('button',{name:'固定遅延を1ms増やす',exact:true}).click();
  await page.waitForFunction(async()=>{const config=await window.yvc.invoke('config');return config.mix_latency_ms===501;});
  assert.equal(await latency.inputValue(),'501');assert.equal(await panel.getByLabel('設定する同期オフセット',{exact:true}).count(),0);assert.equal(server.writes().length,0);
  if(!packaged){
   await page.getByRole('button',{name:/声変換をはじめる/}).click();
   await until(()=>server.filters.get('video').length===2);assert.deepEqual(server.filters.get('video').map(filter=>filter.filterSettings.delay_ms),[500,1]);
   await until(()=>server.filters.get('camera').length===2);assert.deepEqual(server.filters.get('camera').map(filter=>filter.filterSettings.delay_ms),[500,1]);
   assert.equal(server.get('desktop').offset,23);assert.equal(server.get('voice').offset,0);assert.equal(server.writes().length,0);
   assert(await latency.isDisabled());
   await panel.getByRole('button',{name:'映像ソース 1 を削除',exact:true}).click();await until(()=>server.filters.get('video').length===0);assert.deepEqual(server.filters.get('camera').map(filter=>filter.filterSettings.delay_ms),[500,1]);
   await panel.getByRole('button',{name:'映像ソースを追加',exact:true}).click();await panel.getByRole('combobox',{name:'映像ソース 2',exact:true}).selectOption('uuid:video');await until(()=>server.filters.get('video').length===2);
   assert.equal(await app.evaluate(()=>global.obsAudioStarts),1);
   await page.getByRole('button',{name:/停止する/}).click();await until(()=>server.get('desktop').offset===23);
   await until(()=>server.filters.get('video').length===0);
   await until(()=>server.filters.get('camera').length===0);assert(!server.records.some(item=>item.type==='RemoveInput'));
  }
  for(const width of [1000,1280]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,570),width);
   await page.waitForFunction(width=>innerWidth===width,width);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const layout=await page.evaluate(()=>{const main=document.querySelector('main'),panel=document.querySelector('.obs-integration').getBoundingClientRect();return {w:innerWidth,sw:main.scrollWidth,mw:main.clientWidth,right:panel.right};});
   assert(layout.sw<=layout.mw&&layout.right<=layout.w,JSON.stringify(layout));
   if(width===1280&&process.env.YVC_TEST_SCREENSHOT){await page.locator('.obs-integration').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});}
  }
  const exported=path.join(home,'export.json');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},exported);
  await page.evaluate(()=>window.yvc.invoke('export-settings'));const data=fs.readFileSync(exported,'utf8');assert(!data.includes(server.password));assert.equal(JSON.parse(data).mix_latency_ms,501);assert.equal(JSON.parse(data).obs_correction_ms,20);assert.equal(JSON.parse(data).singing_latency_ms,500);
  assert.equal(JSON.parse(data).obs_video_sources.length,2);assert(JSON.parse(data).obs_video_sources.every(item=>!('offset_ms' in item)));assert(JSON.parse(data).obs_video_sources.some(item=>item.inputUuid==='video'));assert.equal(JSON.parse(data).obs_video_enabled,true);
  const status=await page.evaluate(()=>window.yvc.invoke('obs-status'));
  if(status.canRemember){assert(status.hasPassword);assert(!fs.readFileSync(path.join(home,'obs-password.bin')).includes(server.password));}
  if(process.platform==='win32'){
   const mode=page.getByRole('region',{name:'歌枠モード',exact:true});
   const desktop=new Map([['desktop',false],['desktop2',false],['voice',false]]);
   server.inputs.push({inputUuid:'desktop2',inputName:'デスクトップ音声 2'});
   server.handleRequest=(type,data)=>{
    if(type==='GetSpecialInputs')return {response:{desktop1:'デスクトップ音声',desktop2:'デスクトップ音声 2',mic1:'変換音声'}};
    if(type==='GetInputMute')return {response:{inputMuted:desktop.get(data.inputUuid)}};
    if(type==='SetInputMute'){desktop.set(data.inputUuid,data.inputMuted);return {};}
   };
   await app.evaluate(({dialog})=>{
    global.mutePrompts=[];
    dialog.showMessageBox=async(_window,options)=>{global.mutePrompts.push(options);return {response:global.mutePrompts.length===1?1:0};};
   });
   const enable=mode.getByRole('button',{name:'歌枠用設定にする',exact:true});
   const disable=mode.getByRole('button',{name:'歌枠モードを解除',exact:true});
   await disable.click();await enable.click();await disable.waitFor();
   assert.equal(desktop.get('desktop'),false);assert.equal(desktop.get('desktop2'),false);
   await disable.click();await enable.click();await disable.waitFor();
   assert.equal(desktop.get('desktop'),true);assert.equal(desktop.get('desktop2'),true);
   await disable.click();await enable.waitFor();
   assert.equal(desktop.get('desktop'),false);assert.equal(desktop.get('desktop2'),false);
   desktop.set('desktop2',true);
   await enable.click();await disable.waitFor();
   assert.equal(desktop.get('desktop'),true);
   await disable.click();await enable.waitFor();
   assert.equal(desktop.get('desktop'),false);assert.equal(desktop.get('desktop2'),true);
   assert.equal(desktop.get('voice'),false);
   const prompts=await app.evaluate(()=>global.mutePrompts);
   assert.equal(prompts.length,3);
   assert.match(prompts[0].message,/音が二重/);
   assert.equal(server.records.filter(item=>item.type==='SetInputMute').length,6);
   assert(!fs.existsSync(path.join(home,'obs-desktop-mute.json')));
  }
  await app.close();app=null;
  if(status.canRemember){
   app=await electron.launch({...launch,env:{...process.env,YVC_DESKTOP_HOME:home}});page=await app.firstWindow();
   if(packaged)await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
   await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
   const panel=page.getByRole('region',{name:'OBS連携',exact:true});
   await panel.getByText('接続済み',{exact:true}).waitFor();
   assert.equal(server.get('desktop').offset,23);
  }
  console.log('PASS OBS settings: video-only controls and synchronization, legacy audio settings ignored, restoration, authentication and export');
 }finally{if(app)await app.close();await server.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
