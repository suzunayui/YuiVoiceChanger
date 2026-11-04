const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-calibration-ui-')),fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:true,singing_latency_ms:500,obs_correction_ms:139}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-calibration-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;global.calibrationStarts=0;global.audioStarts=0;
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;
 child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const emit=event=>child.stdout.write(JSON.stringify(event)+'\\n');
 const calibration=args.some(arg=>arg.endsWith('latency_calibration.py')),worker=args.some(arg=>arg.endsWith('worker.py'));
 child.stdin=new Writable({write(chunk,encoding,done){for(const line of chunk.toString().trim().split('\\n')){
  const request=JSON.parse(line);
  if(calibration){
   if(request.command==='cancel'){emit({phase:'cancelled',message:'測定を中止しました。'});setImmediate(()=>child.kill());}
   else{global.calibrationStarts++;global.calibrationConfig=request;global.finishCalibration=event=>{emit(event);setImmediate(()=>child.kill());};emit({phase:'speaking',message:'マイクに向かって6秒ほどしゃべってください。',seconds_left:6,rms:.02,progress:.1});}
  }else{
   if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
   if(request.command==='start'){global.audioStarts++;emit({type:'state',state:'running',device:'CPU'});}
   if(request.command==='quit')setImmediate(()=>child.kill());
  }
 }done();}});
 setImmediate(()=>{if(worker)emit({type:'ready'});else if(!calibration){child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 const app=await electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  const automatic=page.getByRole('button',{name:'処理時間から設定',exact:true});
  await automatic.click();const modal=page.getByRole('dialog',{name:'固定遅延を自動設定',exact:true});await modal.waitFor();
  await modal.getByText('マイクに向かって6秒ほどしゃべってください。',{exact:true}).waitFor();
  assert(await page.getByRole('button',{name:/声変換をはじめる/}).isDisabled());
  assert(await page.getByRole('button',{name:'歌枠モードを解除',exact:true}).isDisabled());
  assert(await page.getByRole('button',{name:'ナチュラル',exact:true}).isDisabled());
  const before=await page.evaluate(()=>window.yvc.invoke('config'));
  assert(await page.evaluate(()=>window.yvc.invoke('apply-preset','any-id').then(()=>false,error=>/自動設定/.test(String(error)))));
  assert(await page.evaluate(async config=>window.yvc.invoke('save',{...config,beatrice_pitch:0}).then(()=>false,()=>true),before));
  assert(await page.evaluate(async config=>window.yvc.invoke('start',config).then(()=>false,()=>true),before));
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  await app.evaluate(()=>global.finishCalibration({phase:'completed',message:'固定遅延を自動設定しました。',recommended_ms:320,progress:1}));
  await modal.getByText('固定遅延を自動設定しました。',{exact:true}).waitFor();
  await page.waitForFunction(async()=>{const config=await window.yvc.invoke('config');return config.singing_enabled&&config.singing_latency_ms===320;});
  assert.equal(await page.getByRole('slider',{name:'固定遅延',exact:true}).inputValue(),'459');assert.equal(await modal.locator('.calibration-result').textContent(),'459 ms');
  assert.equal(await app.evaluate(()=>global.audioStarts),0);
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await automatic.click();await modal.getByText('マイクに向かって6秒ほどしゃべってください。',{exact:true}).waitFor();
  await modal.getByRole('button',{name:'中止する',exact:true}).click();await modal.getByText('測定を中止しました。',{exact:true}).waitFor();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).singing_latency_ms,320);
  await modal.getByRole('button',{name:'閉じる',exact:true}).click();
  await automatic.click();await modal.getByText('マイクに向かって6秒ほどしゃべってください。',{exact:true}).waitFor();
  await app.evaluate(()=>global.finishCalibration({phase:'failed',message:'声が小さいか、十分な音声がありませんでした。'}));
  await modal.getByRole('alert').waitFor();assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).singing_latency_ms,320);
  await modal.getByRole('button',{name:'もう一度測定',exact:true}).click();await modal.getByText('マイクに向かって6秒ほどしゃべってください。',{exact:true}).waitFor();
  await modal.press('Escape');await modal.getByText('測定を中止しました。',{exact:true}).waitFor();await modal.press('Escape');await modal.waitFor({state:'detached'});
  assert.equal(await app.evaluate(()=>global.calibrationStarts),4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'desktop.json'))).singing_latency_ms,320);
  assert.equal(await page.getByRole('alert').count(),0);
  console.log('PASS automatic latency UI/private pipe: voice prompt, progress, busy locks, no conversion start, applied and persisted result, silence/error retry, cancel/Escape preserve previous settings');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
