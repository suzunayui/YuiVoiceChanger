// Exercise real main IPC with simulated worker processes. No audio device is opened.
const {_electron:electron,expect}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-preset-live-')),fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe');fs.writeFileSync(python,'fixture');
 const models=Object.fromEntries(['base','other','broken','slow'].map(name=>{const file=path.join(home,name+'.pt.gz');fs.writeFileSync(file,'fixture');return [name,file];}));
 const config=require('../electron/config.cjs').normalize({engine_version:2,python,beatrice_model:models.base,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out'});
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify(config));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-preset-live-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;global.presetWire=[];global.presetSpawns=0;global.finishSlow=null;
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;
 const emit=event=>{if(!ended)child.stdout.write(JSON.stringify(event)+'\\n');};
 child.kill=()=>{if(!ended){emit({type:'state',state:'stopped'});ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const worker=args.some(arg=>arg.endsWith('worker.py'));
 child.stdin=new Writable({write(chunk,encoding,done){for(const line of chunk.toString().trim().split('\\n')){
  const request=JSON.parse(line);global.presetWire.push(request);
  if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
  if(request.command==='start'){
   const run=()=>emit({type:'state',state:'running',device:'CPU',budget_ms:80,schedule_ms:160});
   if(request.config.beatrice_model.includes('broken.pt.gz')||(request.config.singing_enabled&&request.config.singing_latency_ms===201))setImmediate(()=>{emit({type:'error',message:'Fixture model or timing failed'});emit({type:'state',state:'stopped'});});
   else if(request.config.beatrice_model.includes('slow.pt.gz'))global.finishSlow=run;
   else setImmediate(run);
  }
  if(request.command==='stop')emit({type:'state',state:'stopped'});
  if(request.command==='quit')setImmediate(()=>child.kill());
 }done();}});
 setImmediate(()=>{if(worker){global.presetSpawns++;emit({type:'ready'});}else{child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 const app=await electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('heading',{name:'音声のルート'}).waitFor();
  const save=async(name,changes)=>page.evaluate(({name,config})=>window.yvc.invoke('save-preset',{name,config}),{name,config:{...config,...changes}});
  await save('調整のみ',{beatrice_pitch:6,fx_enabled:true,fx_reverb:14});
  await save('別モデル',{beatrice_model:models.other,beatrice_pitch:10,singing_enabled:true,singing_latency_ms:500});
  await save('読み込み失敗',{beatrice_model:models.broken});
  await save('ファイルなし',{beatrice_model:path.join(home,'missing.pt.gz')});
  await save('準備が長い',{beatrice_model:models.slow});
  await save('歌枠（同じモデル）',{beatrice_pitch:6,fx_enabled:true,fx_reverb:14,singing_enabled:true,singing_latency_ms:500});
  await save('表示とOBSだけ',{beatrice_pitch:6,fx_enabled:true,fx_reverb:14,beatrice_model_alias:'表示名',obs_port:4456});
  await save('遅延が短すぎる',{singing_enabled:true,singing_latency_ms:201});
  await page.getByRole('button',{name:/声変換をはじめる/}).click();await page.getByText('変換中',{exact:true}).waitFor();
  const card=page.getByRole('region',{name:'プリセット',exact:true});
  await card.getByRole('button',{name:'調整のみ',exact:true}).click();await expect(card.getByRole('button',{name:'調整のみ',exact:true})).toHaveAttribute('aria-pressed','true');
  let commands=await app.evaluate(()=>global.presetWire);
  assert.equal(commands.filter(command=>command.command==='start').length,1);assert.equal(commands.filter(command=>command.command==='quit').length,0);
  assert.equal(commands.filter(command=>command.command==='update-controls').at(-1).effects.fx_reverb,14);
  await card.getByRole('button',{name:'別モデル',exact:true}).click();await expect(card.getByRole('button',{name:'別モデル',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByText('変換中',{exact:true}).waitFor();
  let actual=await page.evaluate(()=>window.yvc.invoke('config'));assert.equal(actual.beatrice_model,models.other);assert.equal(actual.singing_latency_ms,500);
  commands=await app.evaluate(()=>global.presetWire);assert.equal(commands.filter(command=>command.command==='start').length,2);assert.equal(commands.filter(command=>command.command==='quit').length,1);
  await card.getByRole('button',{name:'ファイルなし',exact:true}).click();await card.getByRole('alert').filter({hasText:'モデルファイル'}).waitFor();
  assert.equal((await app.evaluate(()=>global.presetWire)).filter(command=>command.command==='start').length,2);await expect(card.getByRole('button',{name:'別モデル',exact:true})).toHaveAttribute('aria-pressed','true');
  await card.getByRole('button',{name:'読み込み失敗',exact:true}).click();await card.getByRole('alert').filter({hasText:'元の設定で変換を再開'}).waitFor();
  actual=await page.evaluate(()=>window.yvc.invoke('config'));assert.equal(actual.beatrice_model,models.other);assert.equal(actual.beatrice_pitch,10);await page.getByText('変換中',{exact:true}).waitFor();
  await expect(card.getByRole('button',{name:'別モデル',exact:true})).toHaveAttribute('aria-pressed','true');await expect(card.getByRole('button',{name:'読み込み失敗',exact:true})).toHaveAttribute('aria-pressed','false');
  commands=await app.evaluate(()=>global.presetWire);assert.equal(commands.filter(command=>command.command==='start').length,4);
  await card.getByRole('button',{name:'準備が長い',exact:true}).click();await expect.poll(()=>app.evaluate(()=>typeof global.finishSlow)).toBe('function');
  await expect(card.getByRole('button',{name:'別モデル',exact:true})).toBeDisabled();await expect(page.getByRole('slider',{name:'音の高さ（ピッチ）',exact:true})).toBeDisabled();
  assert(await page.evaluate(()=>window.yvc.invoke('apply-preset','any').then(()=>false,error=>/切り替え/.test(String(error)))));
  assert(await page.evaluate(()=>window.yvc.invoke('setup-runtime').then(()=>false,error=>/切り替え/.test(String(error)))));
  await page.getByRole('button',{name:/停止する/}).click();await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();
  await app.evaluate(()=>global.finishSlow());await expect(card.getByRole('button',{name:'準備が長い',exact:true})).toHaveAttribute('aria-pressed','false');
  commands=await app.evaluate(()=>global.presetWire);assert.equal(commands.filter(command=>command.command==='start').length,5);
  await expect(page.getByRole('button',{name:/声変換をはじめる/})).toBeEnabled();
  await card.getByRole('button',{name:'調整のみ',exact:true}).click();await expect(card.getByRole('button',{name:'調整のみ',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:/声変換をはじめる/}).click();await page.getByText('変換中',{exact:true}).waitFor();
  const before=await app.evaluate(()=>({starts:global.presetWire.filter(x=>x.command==='start').length,quits:global.presetWire.filter(x=>x.command==='quit').length,stops:global.presetWire.filter(x=>x.command==='stop').length,spawns:global.presetSpawns}));
  await card.getByRole('button',{name:'歌枠（同じモデル）',exact:true}).click();await expect(card.getByRole('button',{name:'歌枠（同じモデル）',exact:true})).toHaveAttribute('aria-pressed','true');
  await card.getByRole('button',{name:'調整のみ',exact:true}).click();await expect(card.getByRole('button',{name:'調整のみ',exact:true})).toHaveAttribute('aria-pressed','true');
  await card.getByRole('button',{name:'表示とOBSだけ',exact:true}).click();await expect(card.getByRole('button',{name:'表示とOBSだけ',exact:true})).toHaveAttribute('aria-pressed','true');
  const after=await app.evaluate(()=>({starts:global.presetWire.filter(x=>x.command==='start').length,quits:global.presetWire.filter(x=>x.command==='quit').length,stops:global.presetWire.filter(x=>x.command==='stop').length,spawns:global.presetSpawns}));
  assert.equal(after.starts,before.starts+2);assert.equal(after.stops,before.stops+2);assert.equal(after.quits,before.quits);assert.equal(after.spawns,before.spawns);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_alias,'表示名');await page.getByText('変換中',{exact:true}).waitFor();
  await card.getByRole('button',{name:'遅延が短すぎる',exact:true}).click();await card.getByRole('alert').filter({hasText:'元の設定で変換を再開'}).waitFor();
  await expect(card.getByRole('button',{name:'表示とOBSだけ',exact:true})).toHaveAttribute('aria-pressed','true');
  const restored=await app.evaluate(()=>({starts:global.presetWire.filter(x=>x.command==='start').length,quits:global.presetWire.filter(x=>x.command==='quit').length,spawns:global.presetSpawns}));
  assert.equal(restored.starts,after.starts+2);assert.equal(restored.quits,after.quits);assert.equal(restored.spawns,after.spawns);
  console.log('PASS: running preset controls without restart; model/fixed timing restart and resume; successful highlight; missing model keeps current stream; failed load rollback; Stop cancels loading without late restart; concurrent changes locked; no audio devices opened');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
