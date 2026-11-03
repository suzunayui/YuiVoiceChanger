// Load the real desktop main process behind a private pipe fixture; no audio devices open.
const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-live-wire-'));
 const fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out'}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-live-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;global.liveWire=[];global.liveSpawns=0;
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 let ended=false;child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const emit=event=>child.stdout.write(JSON.stringify(event)+'\\n');
 const worker=args.some(arg=>arg.endsWith('worker.py'));
 child.stdin=new Writable({write(chunk,encoding,done){
  for(const line of chunk.toString().trim().split('\\n')){
   const request=JSON.parse(line);global.liveWire.push(request);
   if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
   if(request.command==='start')emit({type:'state',state:'running',device:'CPU',budget_ms:80,schedule_ms:160});
   if(request.command==='update-controls')emit({type:'controls-applied',controls:request.controls});
   if(request.command==='stop')emit({type:'state',state:'stopped'});
   if(request.command==='quit')setImmediate(()=>child.kill());
  }done();
 }});
 setImmediate(()=>{if(worker){global.liveSpawns++;emit({type:'ready'});}else{child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});
 return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 const app=await electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  await page.getByRole('button',{name:/声変換をはじめる/}).click();
  await page.getByRole('button',{name:/停止する/}).waitFor();
  const actions=[['音の高さ（ピッチ）を1半音減らす','beatrice_pitch',13],['声の響き（フォルマント）を1半音増やす','beatrice_formant',1],['入力ゲインを1dB減らす','input_gain',11],['出力ゲインを1dB減らす','gain',-1]];
  for(const [name,key,value] of actions){
   await page.getByRole('button',{name,exact:true}).click();
   await page.waitForFunction(async({key,value})=>(await window.yvc.invoke('config'))[key]===value,{key,value});
  }
  const commands=await app.evaluate(()=>global.liveWire);
  assert.equal(commands.filter(command=>command.command==='start').length,1);
  assert.equal(commands.filter(command=>command.command==='stop').length,0);
  assert.equal(await app.evaluate(()=>global.liveSpawns),1);
  const updates=commands.filter(command=>command.command==='update-controls');assert.equal(updates.length,4);
  assert.deepEqual(updates.at(-1).controls,{beatrice_pitch:13,beatrice_formant:1,input_gain:11,gain:-1});
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  assert(await page.getByRole('checkbox',{name:'固定遅延',exact:true}).isDisabled());
  await page.getByRole('button',{name:'バラード',exact:true}).click();
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).fx_reverb===20);
  const effectWire=await app.evaluate(()=>global.liveWire.filter(command=>command.command==='update-controls').at(-1));
  assert.equal(effectWire.effects.fx_enabled,true);assert.equal(effectWire.effects.fx_reverb,20);assert.equal(effectWire.effects.fx_echo_ms,375);
  assert.equal(await app.evaluate(()=>global.liveSpawns),1);
  const config=await page.evaluate(()=>window.yvc.invoke('config'));
  const preset=await page.evaluate(config=>window.yvc.invoke('save-preset',{name:'変換中の設定',config}),config);
  await page.evaluate(id=>window.yvc.invoke('apply-preset',id),preset.id);
  assert.equal(await app.evaluate(()=>global.liveSpawns),1);
  assert(await page.evaluate(async config=>window.yvc.invoke('save',{...config,output:22}).then(()=>false,()=>true),config));
  assert(await page.evaluate(async config=>window.yvc.invoke('save',{...config,singing_enabled:true}).then(()=>false,()=>true),config));
  assert.deepEqual(await page.evaluate(()=>window.yvc.invoke('config')),config);
  assert.equal(await page.getByRole('alert').count(),0);
  await page.getByRole('button',{name:/停止する/}).click();
  await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();
  await page.evaluate(id=>window.yvc.invoke('apply-preset',id),preset.id);
  const saved=JSON.parse(fs.readFileSync(path.join(home,'desktop.json')));
  assert.equal(saved.beatrice_pitch,13);assert.equal(saved.beatrice_formant,1);assert.equal(saved.input_gain,11);assert.equal(saved.gain,-1);
  console.log('PASS real desktop IPC: live controls and effect presets over one worker pipe, no conversion restart, structural/fixed timing changes blocked and controls persisted');
 }finally{await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
