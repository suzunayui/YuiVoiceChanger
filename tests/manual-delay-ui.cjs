const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-manual-delay-')),fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');for(const file of [python,model])fs.writeFileSync(file,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:true,singing_latency_ms:200,obs_correction_ms:690}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-manual-delay-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;
 child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const emit=event=>child.stdout.write(JSON.stringify(event)+'\\n');
 child.stdin=new Writable({write(chunk,encoding,done){for(const line of chunk.toString().trim().split('\\n')){
  const request=JSON.parse(line);
  if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
  if(request.command==='start'){const c=request.config,legacy=!c.obs_delay_manual,base=legacy?380:500;emit({type:'state',state:'running',device:'GPU · Fixture',budget_ms:80,schedule_ms:base-120,manual_timing:{...(legacy?{legacy_timing:true}:{}),previous_base_ms:c.singing_latency_ms,previous_correction_ms:c.obs_correction_ms,singing_latency_ms:base,obs_correction_ms:0}});}
  if(request.command==='stop')emit({type:'state',state:'stopped'});
  if(request.command==='quit')setImmediate(()=>child.kill());
 }done();}});
 setImmediate(()=>{if(args.some(arg=>arg.endsWith('worker.py')))emit({type:'ready'});else{child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 let app;
 try{
  app=await electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});const page=await app.firstWindow();
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();const slider=page.getByRole('slider',{name:'固定遅延',exact:true});
  assert.equal(await slider.inputValue(),'890');assert.equal(await slider.getAttribute('min'),'200');
  // Start directly from the user's old file, without moving the slider first.
  await page.getByRole('button',{name:/声変換をはじめる/}).click();await page.getByRole('button',{name:/停止する/}).waitFor();
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.singing_latency_ms===380&&c.obs_correction_ms===0&&c.obs_delay_manual;});
  assert.equal(await slider.inputValue(),'380');assert.equal(await page.getByRole('alert').count(),0);
  await page.getByRole('button',{name:/停止する/}).click();await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();
  await page.evaluate(async()=>{const c=await window.yvc.invoke('config');await window.yvc.invoke('save',{...c,singing_latency_ms:200,obs_correction_ms:690,obs_delay_manual:false});});
  await page.reload();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  await slider.evaluate(el=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'500');el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.singing_latency_ms===200&&c.obs_correction_ms===300&&c.obs_delay_manual;});
  await page.getByRole('button',{name:/声変換をはじめる/}).click();await page.getByRole('button',{name:/停止する/}).waitFor();
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.singing_latency_ms===500&&c.obs_correction_ms===0;});
  assert.equal(await slider.inputValue(),'500');assert.equal(await page.getByRole('alert').count(),0);
  const saved=JSON.parse(fs.readFileSync(path.join(home,'desktop.json'),'utf8'));assert.equal(saved.singing_latency_ms,500);assert.equal(saved.obs_correction_ms,0);
  await page.getByRole('button',{name:/停止する/}).click();await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();
  await page.reload();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();assert.equal(await slider.inputValue(),'500');
  assert.equal(await page.getByRole('alert').count(),0);
  console.log('PASS old 890ms floor can be lowered to 500ms; startup schedules voice at 500ms, persists the same total and updates the UI without opening audio hardware');
 }finally{if(app)await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
