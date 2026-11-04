const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsLink}=require('../electron/obs-link.cjs'),{ObsSync}=require('../electron/obs-sync.cjs'),{normalize}=require('../electron/config.cjs');
const {ObsSyncServer}=require('./helpers/obs-sync-server.cjs');
async function scenario(kind){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-obs-sync-'));const server=await new ObsSyncServer().ready;
 server.get('voice').monitorType='OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
 const config=normalize({python:'fixture.exe',beatrice_model:'fixture.pt.gz',input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out',singing_enabled:true,singing_latency_ms:380,obs_port:server.port,obs_enabled:true,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声',obs_correction_ms:kind==='confirm-change'?634:0});
 const obs=new ObsLink({reconnectDelay:20});obs.configure(config,true);
 let applied=0,metrics={},running=true;
 const sync=new ObsSync({home,engineRoot:path.resolve('.'),obs,verifyOutput:false,isRunning:()=>running,getMetrics:()=>metrics,onComplete:result=>{applied++;return {...config,obs_correction_ms:result.correction_ms};}});
 sync.ffmpeg=()=> 'fixture-ffmpeg.exe';
 if(kind==='manual-startup')sync.prepareEngine=async()=>({...config,singing_latency_ms:400,obs_correction_ms:-20,obs_delay_manual:true});
 let analyses=0,plays=0;const events=[];sync.notify=event=>events.push(event);
 sync.waitForStability=async()=>{if(kind==='stability-timeout')throw Error('音声出力が安定しなかったため測定しません。');if(kind==='confirm-cancel'&&plays===1)sync.cancel();sync.check();};
 const parameters=structuredClone(server.parameters),originalTracks=new Map(server.inputs.map(input=>[input.inputUuid,structuredClone(input.tracks)]));
 sync.playTest=async(request,progress,signal)=>{
  plays++;assert(signal instanceof AbortSignal);assert.deepEqual(Object.keys(request),['referenceStart']);assert.equal(typeof request.referenceStart,'function');
  assert.equal(applied,0,'No unconfirmed correction may be saved between recordings');
  assert.equal(server.recording,true);assert.equal(server.get('desktop').tracks['1'],false);assert.equal(server.inputs.find(input=>input.inputName.startsWith('YUI同期測定_目印_')).tracks['1'],true);assert.equal(server.get('voice').tracks['2'],true);assert.equal(server.get('voice').tracks['1'],false);
  assert.equal(server.parameters['SimpleOutput/RecTracks'],'3');assert(server.records.some(record=>record.type==='CreateInput'&&record.data.inputKind==='ffmpeg_source'));
  assert.equal(server.get('voice').monitorType,'OBS_MONITORING_TYPE_NONE');assert.equal(server.inputs.find(input=>input.inputName.startsWith('YUI同期測定_目印_')).monitorType,'OBS_MONITORING_TYPE_NONE');
  progress({phase:'testing',progress:.4});
  if(kind==='cancel')sync.cancel();
  if(kind==='stopped'){running=false;sync.cancel();}
  if(kind==='dropped')metrics={late_blocks:1};
  if(kind==='offset-change')server.get('voice').offset=20;
  if(kind==='stop-timeout')server.failNext='StopRecord';
 };
 sync.python=async(python,request)=>{
  assert.equal(request.mode,'analyze-probe');assert(!('dry_file' in request));assert(fs.existsSync(request.recording));assert.equal(request.music_offset_ms,380+config.obs_correction_ms);
  analyses++;if(kind==='manual-startup')assert.equal(request.fixed_ms,400,'Analyze the actual adjusted engine reservation');
  if(kind==='confirm-second-error'&&analyses===2)throw Error('確認測定に失敗しました。');
  if(kind==='silence')throw Error('テスト音声を録音できませんでした。');
  if(kind==='external')server.get('voice').tracks['6']=true;
  if(kind==='recovery')server.failNext='CreateProfile';
  if(kind==='recovery-existing')server.failNext='RemoveProfile';
  if(kind==='recovery-active')server.failNext='SetCurrentProfile';
  if(kind==='existing-profile')server.profiles.push(sync.journal.resetProfile);
  const corrections={'confirm-large':[634,646],'confirm-outlier':[634,139,145],'confirm-change':[139,145],'confirm-disagree':[634,139,-139],'confirm-negative':[-634,-640],'confirm-cancel':[634],'confirm-second-error':[634,139]};
  return {phase:'completed',method:'injected-voice',correction_ms:corrections[kind]?.[analyses-1]??120,matched:kind==='invalid-result'?5:8,spread_ms:5};
 };
 try{
  await obs.connect({port:server.port,password:'',remember:false});await obs.flush();
  if(kind==='application-music')server.get('desktop').inputKind='wasapi_process_output_capture';
  if(kind==='reference-create-error')server.failNext='CreateInput';
  if(kind==='streaming')server.streaming=true;
  if(kind==='existing-recording')server.recording=true;
  if(kind==='camera')server.camera=true;
  if(kind==='optional-unavailable')server.cameraAvailable=false;
  if(kind==='replay-running'){server.replay=true;server.replayAvailable=true;}
  if(kind==='replay-error')server.failNext='GetReplayBufferStatus';
  if(kind==='delayed-profile')server.profileDelay=30;
  if(kind==='stale-cache')server.inputs=server.inputs.filter(input=>input.inputUuid!=='music');
  if(kind==='renamed-voice')server.get('voice').inputName='名前を変更した声';
  if(kind==='missing-voice')server.inputs=server.inputs.filter(input=>input.inputUuid!=='voice');
  if(kind==='replaced-voice')server.get('voice').inputUuid='replacement';
  if(kind==='missing-music')server.inputs=server.inputs.filter(input=>input.inputUuid!=='desktop');
  let injected=false;
  server.beforeRequest=(type,data)=>{
   const target=['required-removed','required-renamed-removed'].includes(kind)?'voice':'music';
   if(kind==='required-renamed-removed'&&type==='GetInputList'&&server.get('voice'))server.get('voice').inputName='変更後の声';
   if(injected||data.inputUuid!==target)return;
   const read=['optional-removed','optional-no-audio','required-removed','required-renamed-removed','optional-read-error'].includes(kind)&&type==='GetInputAudioTracks';
   const write=['optional-write-removed','optional-write-error'].includes(kind)&&type==='SetInputAudioTracks';
   if(!read&&!write)return;
   injected=true;
   if(kind==='optional-read-error'||kind==='optional-write-error')server.failNext=type;
   else if(kind==='optional-no-audio')server.get(target).noAudio=true;
   else server.inputs=server.inputs.filter(input=>input.inputUuid!==target);
  };
  sync.start(config,{voice:'voice'},{prepare:kind==='manual-startup'});await sync.task;
  if(kind==='manual-startup')assert.equal(sync.status().result.total_delay_ms,520);
  if(kind==='stability-timeout'){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');assert(!server.records.some(record=>['StartRecord','SetInputAudioTracks','SetProfileParameter'].includes(record.type)));return;
  }
  if(kind.startsWith('confirm-')){
   const success=['confirm-large','confirm-outlier','confirm-change','confirm-negative'].includes(kind);
   assert.equal(applied,success?1:0);assert.equal(sync.status().phase,success?'completed':kind==='confirm-cancel'?'cancelled':'failed');
   const recordings=kind==='confirm-cancel'?1:['confirm-outlier','confirm-disagree'].includes(kind)?3:2;
   assert.equal(server.records.filter(item=>item.type==='StartRecord').length,recordings);
   assert.equal(server.records.filter(item=>item.type==='CreateProfile').length,1,'Only restore/reload OBS outputs once after all confirmation recordings');
   if(success){assert.equal(sync.status().result.confirmed,true);assert.equal(sync.status().result.correction_ms,{'confirm-large':640,'confirm-outlier':142,'confirm-change':142,'confirm-negative':-637}[kind]);}
   if(kind==='confirm-disagree')assert.match(sync.status().message,/一致しなかったため変更しません/);
   assert(!fs.existsSync(sync.journalFile));assert.equal(server.profile,'Original');assert.deepEqual(server.parameters,parameters);assert.equal(obs.maintenance,false);return;
  }
  if(['missing-voice','replaced-voice','missing-music'].includes(kind)){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');
   assert.match(sync.status().message,kind==='missing-music'?/伴奏ソース「デスクトップ音声」/:/変換後の声ソース「変換音声」/);
   assert(!server.records.some(record=>['SetInputAudioTracks','SetProfileParameter','StartRecord','CreateProfile'].includes(record.type)));
   assert(!fs.existsSync(sync.journalFile));return;
  }
  if(['required-removed','required-renamed-removed','optional-read-error','optional-write-error'].includes(kind)){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');
   assert.match(sync.status().message,kind==='required-renamed-removed'?/「変更後の声」.*600/:kind==='required-removed'?/「変換音声」.*600/:/「伴奏ブラウザー」.*500/);
   assert(!server.records.some(record=>record.type==='StartRecord'));
  }
  if(kind==='stale-cache')assert(!server.records.some(record=>record.type==='GetInputAudioTracks'&&record.data.inputUuid==='music'));
  if(kind==='optional-no-audio')assert(!server.records.some(record=>record.type==='SetInputAudioTracks'&&record.data.inputUuid==='music'));
  if(['streaming','existing-recording','camera','replay-running','replay-error'].includes(kind)){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');assert(!server.records.some(record=>record.type==='SetInputAudioTracks'||record.type==='StartRecord'||record.type==='StopRecord'));return;
  }
  if(['recovery','recovery-existing','recovery-active'].includes(kind)){
   assert.equal(applied,0);assert.equal(sync.status().phase,'failed');assert(sync.info().recovery);
   const creates=server.records.filter(record=>record.type==='CreateProfile').length;
   await sync.recover();assert.equal(sync.info().recovery,false);
   if(kind!=='recovery')assert.equal(server.records.filter(record=>record.type==='CreateProfile').length,creates,'Existing recovery profile must not be recreated');
  }else{
   const success=['success','application-music','manual-startup','external','optional-unavailable','existing-profile','delayed-profile','stale-cache','renamed-voice','optional-removed','optional-write-removed','optional-no-audio'].includes(kind);
   assert.equal(applied,success?1:0);
   assert.equal(sync.status().phase,success?'completed':['cancel','stopped'].includes(kind)?'cancelled':'failed');
   assert(!fs.existsSync(sync.journalFile));
  }
  assert.equal(server.recording,false);assert.equal(server.profile,'Original');assert.deepEqual(server.profiles,['Original']);assert.deepEqual(server.parameters,parameters);
  assert(!server.inputs.some(input=>input.inputName.startsWith('YUI同期測定_')));
  for(let index=0;index<server.inputs.length;index++){
   const expected=structuredClone(originalTracks.get(server.inputs[index].inputUuid));if(kind==='external'&&server.inputs[index].inputUuid==='voice')expected['6']=true;
   assert.deepEqual(server.inputs[index].tracks,expected);
  }
  if(server.get('voice'))assert.equal(server.get('voice').monitorType,'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT');
  assert.equal(obs.maintenance,false);
 }finally{server.streaming=false;server.recording=false;await obs.shutdown();await server.close();fs.rmSync(home,{recursive:true,force:true});}
}
(async()=>{for(const kind of ['success','application-music','reference-create-error','manual-startup','stability-timeout','confirm-large','confirm-outlier','confirm-change','confirm-disagree','confirm-negative','confirm-cancel','confirm-second-error','stale-cache','renamed-voice','missing-voice','replaced-voice','missing-music','optional-removed','optional-write-removed','optional-no-audio','required-removed','required-renamed-removed','optional-read-error','optional-write-error','optional-unavailable','cancel','stopped','silence','dropped','offset-change','stop-timeout','invalid-result','external','recovery','recovery-existing','recovery-active','existing-profile','delayed-profile','streaming','existing-recording','camera','replay-running','replay-error'])await scenario(kind);console.log('PASS OBS automatic test-voice calibration: automatic confirmation, startup outlier rejection, inconsistent/failed/cancelled measurements preserve correction, one profile cleanup, source races and recovery; no audio hardware used');})().catch(error=>{console.error(error);process.exitCode=1});
