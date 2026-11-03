const {_electron:electron,expect}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {ObsSyncServer}=require('./helpers/obs-sync-server.cjs');
(async()=>{
 const server=await new ObsSyncServer().ready,home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-obs-sync-ui-')),fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz'),ffmpeg=path.join(home,'ffmpeg.exe');for(const file of [python,model,ffmpeg])fs.writeFileSync(file,'fixture');
 fs.writeFileSync(path.join(home,'obs-sync-tools.json'),JSON.stringify({ffmpeg}));
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:false,singing_latency_ms:380,obs_enabled:false,obs_port:server.port,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声'}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-sync-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;global.analysisFail=false;global.finishBeep=null;global.audioStarts=0;global.failStart=false;global.holdStart=false;global.finishStart=null;
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;
 const emit=event=>{if(!ended)child.stdout.write(JSON.stringify(event)+'\\n');};
 child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const worker=args.some(arg=>arg.endsWith('worker.py')),sync=args.some(arg=>arg.endsWith('obs_sync.py'));
 child.stdin=new Writable({write(chunk,encoding,done){for(const line of chunk.toString().trim().split('\\n')){
  const request=JSON.parse(line);
  if(sync){
   if(request.command==='cancel'){emit({phase:'cancelled',message:'測定を中止しました。'});setImmediate(()=>child.kill());}
   else if(request.mode==='play'){global.finishBeep=()=>{require('node:fs').writeFileSync(request.dry_file,'fixture');emit({phase:'completed'});setImmediate(()=>child.kill());};emit({phase:'speaking',beat:1,progress:.4});}
   else{emit(global.analysisFail?{phase:'failed',message:'発声タイミングのばらつきが大きいため補正しません。'}:{phase:'completed',correction_ms:120,matched:8,spread_ms:7});setImmediate(()=>child.kill());}
  }else{
   if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
   if(request.command==='start'){
    global.audioStarts++;
    const run=()=>emit({type:'state',state:'running',device:'CPU',budget_ms:80,schedule_ms:295});
    if(global.failStart){emit({type:'error',message:'Fixture engine startup failed'});emit({type:'state',state:'stopped'});}
    else if(global.holdStart)global.finishStart=run;
    else run();
   }
   if(request.command==='stop')emit({type:'state',state:'stopped'});
   if(request.command==='quit')setImmediate(()=>child.kill());
  }
 }done();}});
 setImmediate(()=>{if(worker)emit({type:'ready'});else if(!sync){child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 const app=await electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  const panel=page.getByRole('region',{name:'OBS連携',exact:true});await panel.getByText('未接続',{exact:true}).first().waitFor();
  const automatic=panel.getByRole('checkbox',{name:'同期オフセットを自動設定',exact:true});await expect(automatic).not.toBeChecked();
  const open=page.locator('.singing-timing').getByRole('button',{name:'ビープでOBSのずれを自動調整',exact:true});await expect(open).toHaveText('自動設定');await expect(open).toBeEnabled();assert.equal(await panel.getByRole('button',{name:'ビープでOBSのずれを自動調整',exact:true}).count(),0);await open.click();
  assert.equal(await app.evaluate(()=>global.audioStarts),0,'Opening the dialog must not start audio');
  const dialog=page.getByRole('dialog',{name:'ビープでOBSのずれを自動調整',exact:true});
  await page.waitForFunction(async()=> (await window.yvc.invoke('obs-status')).state==='connected');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1000,560));
  assert(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth));
  await expect(dialog.getByRole('combobox')).toHaveCount(1);await expect(dialog.getByText('生声はアプリで選択中のマイクから直接取得します。')).toBeVisible();
  // An invalid start must not enable OBS integration as a side effect.
  assert(await page.evaluate(async()=>window.yvc.invoke('obs-sync-start',{config:await window.yvc.invoke('config'),voice:'missing'}).then(()=>false,()=>true)));
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).obs_enabled,false);
  await dialog.getByLabel('OBSで変換後の声を取り込むソース').selectOption('voice');await expect(dialog.getByRole('button',{name:'測定を開始',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'1 / 8'}).waitFor();
  await expect(automatic).toBeChecked();const started=await page.evaluate(()=>window.yvc.invoke('config'));assert.equal(started.obs_enabled,true);assert.equal(started.singing_enabled,true);assert.equal(server.get('desktop').offset,380);assert.equal(await app.evaluate(()=>global.audioStarts),1);
  assert(await page.evaluate(()=>window.yvc.invoke('save',{gain:1}).then(()=>false,error=>/同期測定/.test(String(error)))));
  await expect(page.getByRole('slider',{name:'入力→出力の遅延（目標）',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'ナチュラル',exact:true})).toBeDisabled();
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  await app.evaluate(()=>global.finishBeep());await dialog.getByRole('status').filter({hasText:'自動設定しました'}).waitFor();
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).obs_correction_ms===120);
  await expect(dialog.locator('.obs-sync-result strong')).toHaveText('+120 ms');assert.equal(server.recording,false);assert.equal(server.profile,'Original');assert.equal(await app.evaluate(()=>global.audioStarts),1);
  await app.evaluate(()=>global.analysisFail=true);await dialog.getByRole('button',{name:'もう一度測定'}).click();await dialog.getByRole('status').filter({hasText:'1 / 8'}).waitFor();
  await app.evaluate(()=>global.finishBeep());await dialog.getByRole('alert').filter({hasText:'ばらつき'}).waitFor();assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).obs_correction_ms,120);
  await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();await dialog.getByRole('status').filter({hasText:'1 / 8'}).waitFor();await page.keyboard.press('Escape');
  await expect(dialog.getByRole('button',{name:'測定を開始',exact:true})).toBeEnabled();assert.equal(server.recording,false);assert.equal(server.inputs.some(input=>input.inputName.startsWith('YUI同期測定_生声_')),false);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).obs_correction_ms,120);
  // A failed output reconstruction leaves a recoverable journal and no new correction.
  await app.evaluate(()=>global.analysisFail=false);await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();await dialog.getByRole('status').filter({hasText:'1 / 8'}).waitFor();server.failNext='RemoveProfile';
  await app.evaluate(()=>global.finishBeep());await dialog.getByRole('button',{name:'前回の測定設定を復元'}).waitFor();
  assert.equal(server.profiles.length,2);const createdProfiles=server.records.filter(record=>record.type==='CreateProfile').length;
  await page.evaluate(()=>window.yvc.invoke('stop'));await dialog.getByRole('button',{name:'前回の測定設定を復元'}).click();
  await dialog.getByRole('status').filter({hasText:'前回の測定設定を復元しました'}).waitFor();
  await expect(dialog.getByRole('button',{name:'前回の測定設定を復元'})).toHaveCount(0);
  assert.equal(server.profile,'Original');assert.equal(fs.existsSync(path.join(home,'obs-sync-recovery.json')),false);
  assert.deepEqual(server.profiles,['Original']);assert.equal(server.records.filter(record=>record.type==='CreateProfile').length,createdProfiles);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).obs_correction_ms,120);
  await dialog.getByRole('button',{name:'閉じる',exact:true}).click();await automatic.uncheck();
  await page.waitForFunction(async()=>!(await window.yvc.invoke('config')).obs_enabled);
  await expect(open).toBeEnabled();await open.click();
  await expect(dialog.getByRole('button',{name:'測定を開始',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'1 / 8'}).waitFor();await expect(automatic).toBeChecked();assert.equal(server.get('desktop').offset,500);
  await page.keyboard.press('Escape');await expect(dialog.getByRole('button',{name:'測定を開始',exact:true})).toBeEnabled();
  await page.evaluate(()=>window.yvc.invoke('stop'));await app.evaluate(()=>global.failStart=true);
  let records=server.records.filter(record=>record.type==='StartRecord').length;
  await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Fixture engine startup failed'}).waitFor();
  assert.equal(server.records.filter(record=>record.type==='StartRecord').length,records);assert.equal((await page.evaluate(()=>window.yvc.invoke('obs-sync-status'))).busy,false);
  await app.evaluate(()=>{global.failStart=false;global.holdStart=true;});await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();
  await expect.poll(()=>app.evaluate(()=>typeof global.finishStart)).toBe('function');await dialog.getByRole('button',{name:'中止する',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'測定を開始',exact:true})).toBeEnabled();await app.evaluate(()=>global.finishStart());
  assert.equal(server.records.filter(record=>record.type==='StartRecord').length,records);assert.equal((await page.evaluate(()=>window.yvc.invoke('obs-sync-status'))).busy,false);
  await app.evaluate(()=>global.holdStart=false);await dialog.getByRole('button',{name:'閉じる',exact:true}).click();
  await page.getByRole('checkbox',{name:'固定遅延',exact:true}).uncheck();
  await page.waitForFunction(async()=>!(await window.yvc.invoke('config')).singing_enabled);
  await page.getByRole('button',{name:/声変換をはじめる/}).click();await page.getByText('変換中',{exact:true}).waitFor();
  const normalStarts=await app.evaluate(()=>global.audioStarts);await open.click();await dialog.getByRole('button',{name:'測定を開始',exact:true}).click();
  await dialog.getByRole('status').filter({hasText:'1 / 8'}).waitFor();assert.equal(await app.evaluate(()=>global.audioStarts),normalStarts+1);assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).singing_enabled,true);
  await page.keyboard.press('Escape');await expect(dialog.getByRole('button',{name:'測定を開始',exact:true})).toBeEnabled();
  console.log('PASS OBS sync real IPC/WebSocket/private Python pipes: opens while disconnected and stopped, automatically connects, fixed timing and OBS sync off are prepared on start, stable running conversion is reused, normal conversation switches to fixed timing, retry after recovery, startup failure and cancellation cannot record or restart later; no microphone or speaker opened');
 }finally{await app.close();await server.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
