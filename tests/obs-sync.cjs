const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsLink}=require('../electron/obs-link.cjs'),{ObsSync}=require('../electron/obs-sync.cjs'),{normalize}=require('../electron/config.cjs');
const {ObsSyncServer}=require('./helpers/obs-sync-server.cjs');
async function scenario(kind){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-obs-sync-'));const server=await new ObsSyncServer().ready;
 const config=normalize({python:'fixture.exe',beatrice_model:'fixture.pt.gz',input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:true,singing_latency_ms:380,obs_port:server.port,obs_enabled:true,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声'});
 const obs=new ObsLink({reconnectDelay:20});obs.configure(config,true);
 let applied=0,metrics={},running=true;
 const sync=new ObsSync({home,engineRoot:path.resolve('.'),obs,isRunning:()=>running,getMetrics:()=>metrics,onComplete:result=>{applied++;return {...config,obs_correction_ms:result.correction_ms};}});
 sync.ffmpeg=()=> 'fixture-ffmpeg.exe';
 const parameters=structuredClone(server.parameters),originalTracks=server.inputs.map(input=>structuredClone(input.tracks));
 sync.python=async(python,request,progress)=>{
  if(request.mode==='play'){
   assert.equal(server.recording,true);assert.equal(server.get('desktop').tracks['1'],true);assert.equal(server.get('voice').tracks['2'],true);assert.equal(server.get('voice').tracks['1'],false);
   assert.equal(server.parameters['SimpleOutput/RecTracks'],'3');
   assert(!server.records.some(record=>record.type==='CreateInput'));
   assert.equal(request.input_name,'Fixture mic');assert.equal(request.input,0);
   assert.equal(request.dry_file,path.join(sync.journal.folder,'raw.wav'));fs.writeFileSync(request.dry_file,'fixture');
   progress({phase:'speaking',beat:1,progress:.4});
   if(kind==='cancel')sync.cancel();
   if(kind==='stopped'){running=false;sync.cancel();}
   if(kind==='dropped')metrics={late_blocks:1};
   if(kind==='offset-change')server.get('voice').offset=20;
   if(kind==='stop-timeout')server.failNext='StopRecord';
  }else{
   assert(fs.existsSync(request.recording));assert(fs.existsSync(request.dry_file));assert.equal(request.music_offset_ms,380);assert(!('dry_offset_ms' in request));
   if(kind==='silence')throw Error('声が小さいため補正しません。');
   if(kind==='external')server.get('voice').tracks['6']=true;
   if(kind==='recovery')server.failNext='CreateProfile';
   if(kind==='recovery-existing')server.failNext='RemoveProfile';
   if(kind==='recovery-active')server.failNext='SetCurrentProfile';
   if(kind==='existing-profile')server.profiles.push(sync.journal.resetProfile);
  }
  return {phase:'completed',correction_ms:120,matched:kind==='invalid-result'?5:8,spread_ms:5};
 };
 try{
  await obs.connect({port:server.port,password:'',remember:false});await obs.flush();
  if(kind==='streaming')server.streaming=true;
  if(kind==='existing-recording')server.recording=true;
  if(kind==='camera')server.camera=true;
  if(kind==='optional-unavailable')server.cameraAvailable=false;
  if(kind==='replay-running'){server.replay=true;server.replayAvailable=true;}
  if(kind==='replay-error')server.failNext='GetReplayBufferStatus';
  if(kind==='delayed-profile')server.profileDelay=30;
  sync.start(config,{voice:'voice'});await sync.task;
  if(['streaming','existing-recording','camera','replay-running','replay-error'].includes(kind)){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');assert(!server.records.some(record=>record.type==='SetInputAudioTracks'||record.type==='StartRecord'||record.type==='StopRecord'));return;
  }
  if(['recovery','recovery-existing','recovery-active'].includes(kind)){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');assert(sync.info().recovery);
   const creates=server.records.filter(record=>record.type==='CreateProfile').length;
   await sync.recover();assert.equal(sync.info().recovery,false);
   if(kind!=='recovery')assert.equal(server.records.filter(record=>record.type==='CreateProfile').length,creates,'Existing recovery profile must not be recreated');
  }else{
   const success=['success','external','optional-unavailable','existing-profile','delayed-profile'].includes(kind);
   assert.equal(applied,success?1:0);
   assert.equal(sync.status().phase,success?'completed':['cancel','stopped'].includes(kind)?'cancelled':'failed');
   assert(!fs.existsSync(sync.journalFile));
  }
  assert.equal(server.recording,false);assert.equal(server.profile,'Original');assert.deepEqual(server.profiles,['Original']);assert.deepEqual(server.parameters,parameters);
  assert(!server.inputs.some(input=>input.inputName.startsWith('YUI同期測定_生声_')));
  for(let index=0;index<server.inputs.length;index++){
   const expected=structuredClone(originalTracks[index]);if(kind==='external'&&server.inputs[index].inputUuid==='voice')expected['6']=true;
   assert.deepEqual(server.inputs[index].tracks,expected);
  }
  assert.equal(obs.maintenance,false);
 }finally{server.streaming=false;server.recording=false;await obs.shutdown();await server.close();fs.rmSync(home,{recursive:true,force:true});}
}
(async()=>{for(const kind of ['success','optional-unavailable','cancel','stopped','silence','dropped','offset-change','stop-timeout','invalid-result','external','recovery','recovery-existing','recovery-active','existing-profile','delayed-profile','streaming','existing-recording','camera','replay-running','replay-error'])await scenario(kind);console.log('PASS OBS beep calibration over real WebSocket: actual string profile list, delayed profile completion, recovery with existing/active temporary profiles, disabled optional outputs (604), stem routing and cancel/failure restore; no audio hardware used');})().catch(error=>{console.error(error);process.exitCode=1});
