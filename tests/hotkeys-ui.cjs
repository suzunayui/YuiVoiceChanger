// Real main process and renderer behind a fixture worker. Shortcuts are real registrations;
// their handlers are invoked directly because a test cannot press keys system-wide.
const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const MUTE='CommandOrControl+Alt+M',PRESET_1='CommandOrControl+Alt+1',PRESET_2='CommandOrControl+Alt+2';
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-hotkeys-'));
 const fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out'}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-hotkeys-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const {globalShortcut}=require('electron');
const register=globalShortcut.register.bind(globalShortcut);
global.hotkeyHandlers={};
globalShortcut.register=(key,handler)=>{const result=register(key,handler);if(result)global.hotkeyHandlers[key]=handler;return result;};
const original=cp.spawn;global.liveWire=[];
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 let ended=false;child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const emit=event=>child.stdout.write(JSON.stringify(event)+'\\n');
 const worker=args.some(arg=>arg.endsWith('worker.py'));
 child.stdin=new Writable({write(chunk,encoding,done){
  for(const line of chunk.toString().trim().split('\\n')){
   const request=JSON.parse(line);global.liveWire.push(request);
   if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2},{id:2,name:'Other out',host:'Windows WASAPI',inputs:0,outputs:2}]});
   if(request.command==='start')emit({type:'state',state:'running',device:'CPU',budget_ms:80,schedule_ms:160});
   if(request.command==='stop')emit({type:'state',state:'stopped'});
   if(request.command==='quit')setImmediate(()=>child.kill());
  }done();
 }});
 setImmediate(()=>{if(worker)emit({type:'ready'});else{child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});
 return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 const launch=()=>electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});
 let app=await launch();
 try{
  let page=await app.firstWindow();await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  const isRegistered=key=>app.evaluate(({globalShortcut},key)=>globalShortcut.isRegistered(key),key);
  const fire=key=>app.evaluate((_electron,key)=>{global.hotkeyHandlers[key]();},key);
  const wire=command=>app.evaluate((_electron,command)=>global.liveWire.filter(item=>item.command===command),command);
  assert.equal(await isRegistered(MUTE),false,'global shortcuts are opt-in');
  await page.getByRole('button',{name:'⚙ 環境設定'}).click();
  const toggle=page.getByRole('checkbox',{name:/キーで操作する/});
  await toggle.check();
  await page.waitForFunction(async()=>(await window.yvc.invoke('hotkeys-status')).enabled);
  if((await page.evaluate(()=>window.yvc.invoke('hotkeys-status'))).failed.includes(MUTE))throw Error('Ctrl+Alt+M is taken by another app on this machine');
  assert.equal(await isRegistered(MUTE),true);
  await page.getByRole('button',{name:'◉ 声を変える'}).click();

  const config=await page.evaluate(()=>window.yvc.invoke('config'));
  const first=await page.evaluate(config=>window.yvc.invoke('save-preset',{name:'高め',config:{...config,beatrice_pitch:5}}),config);
  const second=await page.evaluate(config=>window.yvc.invoke('save-preset',{name:'別の出力',config:{...config,beatrice_pitch:5,output:2,output_name:'Other out'}}),config);
  assert(first.id&&second.id);

  await page.getByRole('button',{name:/声変換をはじめる/}).click();
  const muteButton=page.getByRole('button',{name:/^ミュート/});
  await muteButton.waitFor();
  assert.equal(await muteButton.getAttribute('aria-pressed'),'false');

  await fire(MUTE);
  await page.getByText('ミュート中',{exact:true}).first().waitFor();
  assert.equal(await muteButton.getAttribute('aria-pressed'),'true');
  assert.deepEqual((await wire('set-mute')).at(-1),{command:'set-mute',muted:true});
  await muteButton.click();
  await page.waitForFunction(()=>document.querySelector('.mute-button')?.getAttribute('aria-pressed')==='false');
  assert.deepEqual((await wire('set-mute')).at(-1),{command:'set-mute',muted:false});

  await fire(PRESET_1);
  await page.getByText('「高め」を適用しました。').waitFor();
  assert.equal(await page.getByRole('slider',{name:/^音の高さ/}).inputValue(),'5');
  assert.equal((await wire('start')).length,1,'a live preset does not restart');

  await new Promise(resolve=>setTimeout(resolve,500));
  await fire(MUTE);
  await page.getByText('ミュート中',{exact:true}).first().waitFor();
  await fire(PRESET_2);
  await page.getByText('「別の出力」を適用しました。').waitFor();
  const starts=await wire('start');
  assert.equal(starts.length,2,'a new output restarts the audio');
  assert.equal(starts[1].config.muted,true,'the mute survives a preset restart');
  assert.equal(await muteButton.getAttribute('aria-pressed'),'true');

  await new Promise(resolve=>setTimeout(resolve,500));
  await fire('CommandOrControl+Alt+9');
  await page.getByText('9番目のプリセットはまだありません。').waitFor();

  await page.getByRole('button',{name:/停止する/}).click();
  await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();
  assert.equal(await muteButton.count(),0);
  await new Promise(resolve=>setTimeout(resolve,500));
  await fire(MUTE);
  await page.getByText('声変換の実行中だけミュートできます。').waitFor();
  await page.getByRole('button',{name:/声変換をはじめる/}).click();
  await muteButton.waitFor();
  assert.equal((await wire('start')).at(-1).config.muted,undefined,'a manual start is audible');
  assert.equal(await muteButton.getAttribute('aria-pressed'),'false');
  await page.getByRole('button',{name:/停止する/}).click();
  await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();

  await page.getByRole('slider',{name:/^出力ゲイン/}).press('ArrowLeft');
  await page.waitForFunction(async()=>(await window.yvc.invoke('config')).gain===-1);
  await app.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'desktop.json'))).gain,-1,'a pending save is written on quit');

  app=await launch();
  page=await app.firstWindow();await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  assert.equal(await app.evaluate(({globalShortcut},key)=>globalShortcut.isRegistered(key),MUTE),true,'the choice is kept across restarts');
  console.log('PASS hotkeys: opt-in, mute by key and button, presets by key, mute kept across preset restarts and cleared by manual start, pending save flushed on quit');
 }finally{await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
