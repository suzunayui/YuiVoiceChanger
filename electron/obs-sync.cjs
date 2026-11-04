const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const {writeReference,startReference}=require('./obs-reference.cjs');
const identity=item=>item.inputUuid?{inputUuid:item.inputUuid}:{inputName:item.inputName};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
class ObsSync{
 constructor({home,engineRoot,obs,notify=()=>{},onComplete=()=>{},prepareEngine=async()=>{},resetEngine=async()=>{},playTest=async()=>{throw Error('テスト音声の再生処理が接続されていません。');},verifyOutput=true,isRunning=()=>false,isMonitoring=()=>false,getMetrics=()=>({}),spawnProcess=spawn}){
  Object.assign(this,{home,engineRoot,obs,notify,onComplete,prepareEngine,resetEngine,playTest,verifyOutput,isRunning,isMonitoring,getMetrics,spawnProcess});this.busy=false;this.state={phase:'idle',message:''};this.child=null;
  this.broadcast=new (require('./obs-broadcast.cjs').ObsBroadcast)(this);
  this.journalFile=path.join(home,'obs-sync-recovery.json');this.toolsFile=path.join(home,'obs-sync-tools.json');
 }
 status(){return {...this.state,busy:this.busy};}
 update(patch){this.state={...this.state,...patch};this.notify({type:'obs-sync',...this.status()});}
 ffmpeg(){
  let chosen='';try{chosen=JSON.parse(fs.readFileSync(this.toolsFile,'utf8')).ffmpeg;}catch{}
  const name=process.platform==='darwin'?'ffmpeg':'ffmpeg.exe';
  const candidates=[chosen,path.join(this.home,'tools',name),...(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir.replace(/^"|"$/g,''),name)),...(process.platform==='darwin'?['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg']:[])];
  return candidates.find(file=>typeof file==='string'&&file&&fs.statSync(file,{throwIfNoEntry:false})?.isFile())||'';
 }
 setFfmpeg(file){if(this.busy)throw Error('測定が終わるまでお待ちください。');if(typeof file!=='string'||path.basename(file).toLowerCase()!==(process.platform==='darwin'?'ffmpeg':'ffmpeg.exe')||!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw Error('ffmpeg.exeを選んでください。');fs.mkdirSync(this.home,{recursive:true});fs.writeFileSync(this.toolsFile,JSON.stringify({ffmpeg:file}));return this.info();}
 info(){return {ffmpeg:!!this.ffmpeg(),recovery:fs.existsSync(this.journalFile)&&!this.preparingBroadcast,broadcastReady:!!this.broadcast.ready&&this.broadcast.ready.connection===this.obs.connection,broadcastError:this.broadcast.error};}
 check(){if(this.cancelled)throw Error('測定を中止しました。');if(!this.isRunning())throw Error('声変換が停止したため測定を中止しました。');}
 async rpc(type,data={},inputName=''){
  if(!this.obs.connection?.identified)throw Error('OBSとの接続が切れました。再接続して測定設定を復元してください。');
  try{return await this.obs.connection.request(type,data);}catch(error){
   const labels={GetStreamStatus:'配信状態の確認',GetRecordStatus:'録画状態の確認',GetReplayBufferStatus:'リプレイバッファの状態確認',GetVirtualCamStatus:'仮想カメラの状態確認',GetProfileList:'プロファイルの確認',GetProfileParameter:'録画設定の確認',GetInputMute:'音声ソースのミュート確認',GetInputSettings:'音声デバイスの確認',GetInputPropertiesListPropertyItems:'音声デバイス一覧の取得',CreateInput:'測定用音声の追加',GetInputAudioMonitorType:'音声モニターの確認',SetInputAudioMonitorType:'音声モニターの設定・復元',GetMediaInputStatus:'測定音声の再生時刻の確認',TriggerMediaInputAction:'測定音声の再生',GetInputAudioTracks:'音声トラックの確認',SetInputAudioTracks:'音声トラックの設定・復元',SetProfileParameter:'録画設定の変更・復元',StartRecord:'テスト録画の開始',StopRecord:'テスト録画の終了',CreateProfile:'録画出力の再読み込み',SetCurrentProfile:'プロファイルの復元',RemoveProfile:'一時プロファイルの後片付け'};
   const name=inputName||data.inputName;
   const source=typeof name==='string'&&name?`「${name}」の`:'';
   error.message=`OBSで${source}${labels[type]||type}に失敗しました${error.code?`（${error.code}）`:''}。${error.code===600&&source?'対象のソースが見つかりません。OBSで削除・作り直しされた可能性があります。':error.code?'対象の設定やソースの状態を確認してください。':error.message}`;
   throw error;
  }
 }
 inputRpc(type,input,data={}){return this.rpc(type,{...identity(input),...data},input.inputName);}
 async optionalOutput(type){
  try{return await this.rpc(type);}catch(error){
   // OBS returns InvalidResourceState when these optional outputs do not exist,
   // including the normal case where the replay buffer is disabled in settings.
   // Only these two read-only queries may interpret 604 as unavailable/inactive.
   if(error.code===604&&['GetReplayBufferStatus','GetVirtualCamStatus'].includes(type))return {outputActive:false,available:false};
   throw error;
  }
 }
 writeJournal(){fs.mkdirSync(this.home,{recursive:true});const tmp=this.journalFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.journal,null,2));fs.renameSync(tmp,this.journalFile);}
 async idleOutputs(allowRecording=false,{allowStream=this.liveSession||this.journal?.live||false}={}){
  const [stream,record,replay,camera]=await Promise.all([this.rpc('GetStreamStatus'),this.rpc('GetRecordStatus'),this.optionalOutput('GetReplayBufferStatus'),this.optionalOutput('GetVirtualCamStatus')]);
  if((stream.outputActive&&!allowStream)||replay.outputActive||camera.outputActive||(!allowRecording&&record.outputActive))throw Error(allowStream?'OBSの録画・リプレイバッファ・仮想カメラを停止してから測定してください。':'OBSの配信・録画・リプレイバッファ・仮想カメラを停止してから測定してください。');
  return record;
 }
 async profile(){return (await this.rpc('GetProfileList')).currentProfileName;}
 async profiles(){
  const result=await this.rpc('GetProfileList');
  if(typeof result.currentProfileName!=='string'||!Array.isArray(result.profiles)||result.profiles.some(name=>typeof name!=='string'))throw Error('OBSのプロファイル一覧を読み取れませんでした。');
  return result;
 }
 async waitProfiles(predicate){
  for(let index=0;index<150;index++){
   const result=await this.profiles();if(predicate(result))return result;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('OBSのプロファイル操作の完了を確認できませんでした。再接続して測定設定を復元してください。');
 }
 async switchProfile(name){
  await this.rpc('SetCurrentProfile',{profileName:name});
  await this.waitProfiles(result=>result.currentProfileName===name);
 }
 async waitRecord(active){
  for(let index=0;index<60;index++){
   const state=await this.rpc('GetRecordStatus');if(state.outputActive===active)return;
   if(active&&this.cancelled)throw Error('測定を中止しました。');
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error(active?'OBSのテスト録画を開始できませんでした。':'OBSのテスト録画の終了を確認できませんでした。');
 }
 async stopRecording(){
  const stopped=await this.rpc('StopRecord');await this.waitRecord(false);
  this.journal.recording=false;this.writeJournal();return stopped;
 }
 async waitForStability(attempt=1){
  this.update({phase:'stabilizing',progress:0,message:(attempt>1?`確認測定 ${attempt}回目：`:'')+'音声出力が安定するまで待っています…'});
  await require('./audio-stability.cjs').waitForAudioStability({getMetrics:()=>this.getMetrics(),check:()=>this.check()});
 }
 async startRecording(attempt=1){
  this.check();await this.idleOutputs();
  this.journal.recording=true;this.writeJournal();
  await this.rpc('StartRecord');await this.waitRecord(true);
  this.update({phase:'preparing',progress:0,message:(attempt>1?`確認測定 ${attempt}回目：`:'')+'OBSの録音が安定するまで待っています…'});
  await require('./audio-stability.cjs').waitForRecordingProgress({readStatus:()=>this.idleOutputs(true),check:()=>this.check()});
  this.monitor=setInterval(()=>this.idleOutputs(true).then(record=>{
   if(!record.outputActive||record.outputPaused)throw Error('テスト録画が停止・一時停止されました。');
   return this.liveSession?this.checkBroadcastRoute().then(()=>this.profile()):this.profile();
  }).then(profile=>{if(profile!==this.journal?.profile)throw Error('OBSのプロファイルが変更されました。');})
   .catch(error=>{this.failure=error.message;this.cancel();}),500);
 }
 async checkBroadcastRoute(){
  if(!(await this.rpc('GetStreamStatus')).outputActive)throw Error('配信状態が変わったため測定を中止しました。');
  await this.broadcast.ensure();
  for(const patch of this.journal?.patches||[]){
   if(patch.kind!=='tracks')continue;
   const tracks=(await this.inputRpc('GetInputAudioTracks',patch.input)).inputAudioTracks;
   if(Object.keys(patch.value).some(key=>tracks[key]!==patch.value[key]))throw Error('OBSの音声ルートが変更されたため測定を中止しました。');
  }
 }
 async checkBroadcastFilters(input){
  const filters=(await this.rpc('GetSourceFilterList',input.inputUuid?{sourceUuid:input.inputUuid}:{sourceName:input.inputName},input.inputName)).filters;
  const known=new Set(['gain_filter','noise_suppress_filter','noise_suppress_filter_v2','noise_gate_filter','compressor_filter','upward_compressor_filter','limiter_filter','expander_filter','invert_polarity_filter','eq_filter']);
  if(!Array.isArray(filters)||filters.some(filter=>filter.filterEnabled&&!known.has(filter.filterKind)))throw Error(`OBSの声ソース「${input.inputName}」に、測定音の残響を安全に消せるか確認できないフィルターがあります。この構成では配信前に測定してください。`);
 }
 validateResult(result){
  if(!result||!Number.isInteger(result.correction_ms)||Math.abs(result.correction_ms)>1000||!Number.isInteger(result.matched)||result.matched<6||result.matched>8||!Number.isFinite(result.spread_ms)||result.spread_ms<0||result.spread_ms>55)throw Error('測定結果が正しくありません。');
  return result;
 }
 async patchProfile(category,name,value){
  this.check();
  const old=(await this.rpc('GetProfileParameter',{parameterCategory:category,parameterName:name})).parameterValue;
  this.journal.patches.push({kind:'profile',category,name,old,value});this.writeJournal();
  await this.rpc('SetProfileParameter',{parameterCategory:category,parameterName:name,parameterValue:value});
 }
 async patchTracks(input,tracks,{required=true}={}){
  this.check();
  let old;
  try{old=(await this.inputRpc('GetInputAudioTracks',input)).inputAudioTracks;}
  catch(error){if(!required&&[600,602,604].includes(error.code))return;throw error;}
  if(!old||typeof old!=='object')throw Error('OBSの音声トラックを取得できませんでした。');
  const value={...old,...tracks};this.journal.patches.push({kind:'tracks',input,old,value});this.writeJournal();
  try{await this.inputRpc('SetInputAudioTracks',input,{inputAudioTracks:value});}
  catch(error){if(!required&&error.code===600)return;throw error;}
 }
 python(python,request,onProgress=()=>{}){
  return new Promise((resolve,reject)=>{
   if(this.cancelled){reject(Error('測定を中止しました。'));return;}
   let result=null,done=false;
   const child=this.spawnProcess(python,['-I','-u',path.join(this.engineRoot,'backend','obs_sync.py')],{cwd:this.engineRoot,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});
   this.child=child;child.stderr.resume();child.stdin.on('error',()=>{});
   const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(this.child===child)this.child=null;error?reject(error):resolve(result);};
   const timer=setTimeout(()=>{child.kill();finish(Error('測定処理が時間切れになりました。'));},90000);
   readline.createInterface({input:child.stdout}).on('line',line=>{try{
    const event=JSON.parse(line);
    if(['completed','failed','cancelled'].includes(event.phase)){result=event;child.stdin.end();}
    else onProgress(event);
   }catch{}});
   child.once('error',()=>finish(Error('測定用のPythonを起動できませんでした。')));
   child.once('exit',code=>finish(this.cancelled?Error('測定を中止しました。'):code===0&&result?.phase==='completed'?null:Error(result?.message||'測定処理を完了できませんでした。')));
   child.stdin.write(JSON.stringify(request)+'\n');
  });
 }
 async prepare(config,voice){
  await this.idleOutputs();
  if(this.liveSession&&this.journal?.live){
   this.obs.maintenance=true;const music=this.journal.music;
   const musicOffset=(await this.inputRpc('GetInputAudioSyncOffset',music)).inputAudioSyncOffset;
   this.journal.observed=[{input:music,offset:musicOffset},{input:voice,offset:(await this.inputRpc('GetInputAudioSyncOffset',voice)).inputAudioSyncOffset}];this.writeJournal();
   await this.startRecording();return {reference:this.journal.reference,musicOffset};
  }
  // Cached sources may have been removed or renamed since the dialog opened.
  await this.obs.inputs();this.check();
  const available=this.obs.status().inputs;
  const find=selected=>available.find(input=>selected.inputUuid?input.inputUuid===selected.inputUuid:input.inputName===selected.inputName);
  const selectedVoice=voice;
  const music=find({inputUuid:config.obs_input_uuid,inputName:config.obs_input_name});
  voice=find(selectedVoice);
  for(const [input,selected,role] of [[music,{inputName:config.obs_input_name},'伴奏'],[voice,selectedVoice,'変換後の声']]){
   if(!input)throw Error(`OBSの${role}ソース「${selected.inputName}」が見つかりません。ソース一覧を更新しました。使用するソースを選んでください。`);
  }
  if(equal(identity(music),identity(voice)))throw Error('伴奏と変換後の声は、別々のOBSソースを選んでください。');
  await this.obs.flush();this.check();
  const version=await this.rpc('GetVersion');
  for(const type of ['GetProfileParameter','SetProfileParameter','GetInputAudioTracks','SetInputAudioTracks','StartRecord','StopRecord','GetCurrentProgramScene','CreateInput','RemoveInput','GetInputAudioMonitorType','SetInputAudioMonitorType','GetMediaInputStatus','TriggerMediaInputAction'])if(!version.availableRequests?.includes(type))throw Error('このOBSは自動同期測定に必要な操作に対応していません。');
  const mode=(await this.rpc('GetProfileParameter',{parameterCategory:'Output',parameterName:'Mode'})).parameterValue;
  const category=mode==='Advanced'?'AdvOut':'SimpleOutput';
  const get=async name=>(await this.rpc('GetProfileParameter',{parameterCategory:category,parameterName:name})).parameterValue;
  const format=await get('RecFormat2');
  if(!/^(mkv|mp4|mov|hybrid_mp4|hybrid_mov|fragmented_mp4|fragmented_mov)$/.test(format||''))throw Error('OBSの録画形式をMKVまたはMP4にしてください。');
  if(category==='SimpleOutput'&&!['Small','HQ'].includes(await get('RecQuality')))throw Error('OBSの録画品質を「高品質」または「超高品質」にしてください。');
  if(category==='AdvOut'&&(await get('RecType'))!=='Standard')throw Error('OBSの録画種別を「標準」にしてください。');
  for(const input of [music,voice])if((await this.inputRpc('GetInputMute',input)).inputMuted)throw Error('測定する音声ソースのミュートを解除してください。');
  const live=this.liveSession?await this.broadcast.ensure():null;
  if(live&&!['GetInputAudioBalance','SetInputAudioBalance'].every(type=>version.availableRequests?.includes(type)))throw Error('このOBSは配信中の自動調整に対応していません。');
  if(live)await this.checkBroadcastFilters(voice);
  this.obs.maintenance=true;clearTimeout(this.obs.syncTimer);clearTimeout(this.obs.retryTimer);
  const id=randomUUID();const folder=path.join(this.home,'obs-sync-recordings',id);fs.mkdirSync(folder,{recursive:true});
  this.journal={version:1,id,folder,profile:await this.profile(),patches:[],recording:false,resetProfile:'YUI同期測定_復元_'+id,referenceName:'YUI同期測定_目印_'+id,...(live?{live:true,privateTrack:live.track}:{})};this.writeJournal();
  const voiceSettings=live?await this.inputRpc('GetInputSettings',voice):null;
  for(const input of available){
   const selected=equal(identity(input),identity(voice));let duplicate=false;
   if(live&&!selected){
    const settings=await this.inputRpc('GetInputSettings',input);
    duplicate=(settings.inputKind===voiceSettings.inputKind&&settings.inputSettings?.device_id===voiceSettings.inputSettings?.device_id)||/^(wasapi_input_capture|coreaudio_input_capture)/.test(settings.inputKind||'')||(/process_output_capture/.test(settings.inputKind||'')&&/(python|YuiVoiceChanger)\.exe/i.test(JSON.stringify(settings.inputSettings)));
    if(duplicate&&equal(identity(input),identity(music)))throw Error('伴奏ソースも変換後の声と同じデバイスを取り込んでいます。伴奏を別の音声ソースにしてください。');
   }
   const tracks=live?(selected||duplicate?Object.fromEntries([1,2,3,4,5,6].map(track=>[String(track),selected&&track===live.track])):{[String(live.track)]:false}):{'1':false,'2':selected};
   await this.patchTracks(input,tracks,{required:equal(identity(input),identity(music))||selected});
   if(live&&duplicate){
    await this.checkBroadcastFilters(input);
    const old=(await this.inputRpc('GetInputAudioMonitorType',input)).monitorType;
    this.journal.patches.push({kind:'monitor',input,old,value:'OBS_MONITORING_TYPE_NONE'});this.writeJournal();
    await this.inputRpc('SetInputAudioMonitorType',input,{monitorType:'OBS_MONITORING_TYPE_NONE'});
   }
  }
  // Disable only OBS monitoring; source recording and gain stay untouched.
  const oldMonitor=(await this.inputRpc('GetInputAudioMonitorType',voice)).monitorType;
  if(!['OBS_MONITORING_TYPE_NONE','OBS_MONITORING_TYPE_MONITOR_ONLY','OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'].includes(oldMonitor))throw Error('OBSの音声モニター設定を確認できませんでした。');
  this.journal.patches.push({kind:'monitor',input:voice,old:oldMonitor,value:'OBS_MONITORING_TYPE_NONE'});this.writeJournal();
  await this.inputRpc('SetInputAudioMonitorType',voice,{monitorType:'OBS_MONITORING_TYPE_NONE'});
  if(live){
   const old=(await this.inputRpc('GetInputAudioBalance',voice)).inputAudioBalance;
   if(!Number.isFinite(old)||old<0||old>1)throw Error('OBSの音声バランスを確認できませんでした。');
   this.journal.patches.push({kind:'balance',input:voice,old,value:1});this.writeJournal();
   await this.inputRpc('SetInputAudioBalance',voice,{inputAudioBalance:1});
  }
  const file=path.join(folder,'reference.wav');writeReference(file);
  const scene=await this.rpc('GetCurrentProgramScene');
  const created=await this.rpc('CreateInput',{sceneName:scene.currentProgramSceneName,inputName:this.journal.referenceName,inputKind:'ffmpeg_source',inputSettings:{is_local_file:true,local_file:file,looping:false,restart_on_activate:false,close_when_inactive:false,ffmpeg_options:'max_size=96'},sceneItemEnabled:false});
  const reference={inputName:this.journal.referenceName,...(created.inputUuid?{inputUuid:created.inputUuid}:{})};
  await this.inputRpc('SetInputAudioMonitorType',reference,{monitorType:'OBS_MONITORING_TYPE_NONE'});
  await this.inputRpc('SetInputAudioTracks',reference,{inputAudioTracks:Object.fromEntries([1,2,3,4,5,6].map(track=>[String(track),track===(live?.track||1)]))});
  if(live)await this.inputRpc('SetInputAudioBalance',reference,{inputAudioBalance:0});
  this.journal.reference=reference;this.writeJournal();
  await this.rpc('SetSceneItemEnabled',{sceneName:scene.currentProgramSceneName,sceneItemId:created.sceneItemId,sceneItemEnabled:true});
  await this.patchProfile(category,'RecTracks',live?String(1<<(live.track-1)):'3');
  await this.patchProfile(category,category==='AdvOut'?'RecFilePath':'FilePath',folder);
  await this.patchProfile('Output','FilenameFormatting','YUI-Sync-%CCYY-%MM-%DD-%hh-%mm-%ss');
  await this.patchProfile('Video','AutoRemux','false');
  this.check();await this.idleOutputs();
  const musicOffset=(await this.inputRpc('GetInputAudioSyncOffset',music)).inputAudioSyncOffset;
  const voiceOffset=(await this.inputRpc('GetInputAudioSyncOffset',voice)).inputAudioSyncOffset;
  this.journal.observed=[{input:music,offset:musicOffset},{input:voice,offset:voiceOffset}];
  this.journal.music=music;this.journal.musicOffset=musicOffset;this.writeJournal();
  await this.startRecording();
  return {reference,musicOffset};
 }
 validateStart(config,payload,{requireRunning=true}={}){
  if(config.mix_enabled)throw Error('MIXモードでは声と伴奏を合成して送るため、OBSの音声自動調整は使用しません。');
  if(this.busy)throw Error('OBSの同期測定は実行中です。');
  if(fs.existsSync(this.journalFile)&&!this.preparingBroadcast)throw Error('前回の測定設定を復元してから開始してください。');
  if(!this.ffmpeg())throw Error('解析用のffmpeg.exeを指定してください。');
  if((requireRunning&&!this.isRunning())||!config.singing_enabled||!config.obs_enabled)throw Error('固定遅延とOBSの自動設定を有効にし、声変換を開始してください。');
  if(!this.obs.connection?.identified)throw Error('OBSに接続してから測定してください。');
  const inputs=this.obs.status().inputs;
  const music=inputs.find(input=>config.obs_input_uuid?input.inputUuid===config.obs_input_uuid:input.inputName===config.obs_input_name);
  const voice=this.obs.status().inputs.find(input=>input.inputUuid===payload?.voice||input.inputName===payload?.voice);
  if(!voice)throw Error('測定するOBSの声ソースを選んでください。');
  if(!music||equal(identity(music),identity(voice)))throw Error('伴奏と変換後の声は、別々のOBSソースを選んでください。');
  return voice;
 }
 start(config,payload,{prepare=false}={}){
  const voice=this.validateStart(config,payload,{requireRunning:!prepare});
  this.startAbort=new AbortController();
  this.busy=true;this.cancelled=false;this.failure='';this.state={phase:'preparing',message:'OBSのテスト録音を準備しています…'};this.update({});
  this.task=this.run({...config},voice,prepare);return this.status();
 }
 async run(config,voice,prepare=false){
  let result=null,error=null;
  try{
   if(this.broadcast.preparation)await this.broadcast.preparation;
   this.liveSession=(await this.rpc('GetStreamStatus')).outputActive===true;
   if(this.liveSession){
    if(!/(CABLE|VB-Audio|Voicemeeter|BlackHole|Loopback)/i.test(config.output_name||''))throw Error('配信中の測定では、変換音声の出力先をCABLE Inputなどの仮想音声デバイスにしてください。');
    await this.broadcast.ensure();
   }
   if(prepare){
    await this.idleOutputs();
    if(this.cancelled)throw Error('測定を中止しました。');
    config=await this.prepareEngine(config,this.startAbort.signal)||config;this.check();
   }
   await this.waitForStability();
   const prepared=await this.prepare(config,voice);this.check();
   const results=[];
   for(let attempt=1;attempt<=3;attempt++){
    if(attempt>1){
     this.update({phase:'confirming',message:`測定値を確認するためテスト音声を自動で再生します（${attempt}回目）。`,progress:0});
     await this.waitForStability(attempt);await this.startRecording(attempt);
    }
    const measured=this.validateResult(await this.measure(config,prepared,attempt));this.check();results.push(measured);
    if(attempt===1&&Math.abs(measured.correction_ms)<=300&&Math.abs(measured.correction_ms-config.obs_correction_ms)<=150){result=measured;break;}
    const previous=results.slice(0,-1).find(item=>Math.abs(item.correction_ms-measured.correction_ms)<=40);
    if(previous){
     result={...measured,correction_ms:Math.round((previous.correction_ms+measured.correction_ms)/2),spread_ms:Math.max(previous.spread_ms,measured.spread_ms,Math.ceil(Math.abs(previous.correction_ms-measured.correction_ms)/2)),matched:Math.min(previous.matched,measured.matched),confirmed:true};break;
    }
   }
   if(!result)throw Error(`再測定で固定遅延の値が一致しなかったため変更しません（${results.map(item=>`${config.singing_latency_ms+item.correction_ms}ms`).join(' / ')}）。音声ルートと処理負荷を確認してください。`);
   if(this.verifyOutput){
    // Restoring the recording profile can change OBS's effective audio timing.
    // Check a new recording after the candidate has actually been applied.
    await this.restoreMeasurement();
    let verified=false,stableChecks=0;
    for(let check=1;check<=4;check++){
     this.check();
     const candidate={...config,obs_correction_ms:result.correction_ms};
     this.obs.configure(candidate,true);await this.obs.flush();
     this.update({phase:'verifying',message:`補正後のずれを録音で確認しています（${check} / 4）…`,progress:0});
     await this.waitForStability();
     const reference=await this.prepare(candidate,voice);this.check();
     const measured=this.validateResult(await this.measure(candidate,reference,check,true));this.check();
     const residual=measured.correction_ms-result.correction_ms;
     await this.restoreMeasurement();
     if(Math.abs(residual)<=15){
      result={...result,verified:true,verification_residual_ms:residual,verification_matched:measured.matched,
       spread_ms:Math.max(result.spread_ms,measured.spread_ms),verification_attempts:check};
      if(++stableChecks>=2){verified=true;break;}
      continue;
     }
     stableChecks=0;
     result={...measured,confirmed:result.confirmed};
    }
    if(!verified)throw Error('補正後の録音のずれが安定しなかったため保存しません。音声デバイスとOBSの状態を確認してください。');
   }
   result={...result,total_delay_ms:config.singing_latency_ms+result.correction_ms,voice_delay_ms:config.singing_latency_ms+result.correction_ms};
  }catch(reason){error=reason;}
  clearInterval(this.monitor);this.monitor=null;
  try{if(this.journal)await this.cleanup();}catch(reason){error=Error(`OBSの測定設定を完全に復元できませんでした。「前回の測定設定を復元」を押してください。${reason.message}`);}
  this.obs.maintenance=false;
  if(error||this.cancelled)this.obs.configure(config,this.isRunning());
  else if(this.liveSession&&result)this.obs.configure({...config,obs_correction_ms:result.correction_ms},this.isRunning());
  try{await this.obs.flush();}catch(reason){error=error||reason;}
  this.busy=false;let nextConfig;
  if(!error&&!this.cancelled&&result){
   try{this.validateResult(result);nextConfig=this.onComplete(result,config);}
   catch(reason){error=reason;this.obs.configure(config,this.isRunning());try{await this.obs.flush();}catch{}}
  }
  const cancelled=this.cancelled&&!this.failure&&!fs.existsSync(this.journalFile);
  this.state={phase:error||this.cancelled?(cancelled?'cancelled':'failed'):'completed',message:error||this.cancelled?(this.failure||error?.message||'測定を中止しました。'):'固定遅延を自動設定しました。',...(result&&!error&&!this.cancelled?{result}:{})};
  this.notify({type:'obs-sync',...this.status(),...(nextConfig?{config:nextConfig}:{})});
  this.liveSession=false;
 }
 async restoreMeasurement(){
  clearInterval(this.monitor);this.monitor=null;
  if(this.journal&&!this.journal.live)await this.cleanup();
  this.obs.maintenance=false;
 }
 async measure(config,{reference,musicOffset},attempt,verification=false){
   const before={...this.getMetrics()};
   if(this.liveSession)await this.checkBroadcastRoute();
   await this.playTest({referenceStart:()=>startReference({rpc:(type,data)=>this.rpc(type,data),input:identity(reference),delayMs:musicOffset,check:()=>this.check()}),...(verification?{verification:true}:{})},event=>{
    this.update({phase:verification?'verifying':'testing',progress:event.progress||0,message:this.liveSession?(verification?'配信の声を一時停止して、補正後のずれを確認しています…':'配信の声を一時停止して測定しています…'):verification?'補正後のずれをテスト音声で確認しています…':(attempt>1?`確認測定 ${attempt}回目：`:'')+'テスト音声を自動再生しています…'});
   },this.startAbort.signal);
   clearInterval(this.monitor);this.monitor=null;this.check();
   if(this.liveSession)await this.checkBroadcastRoute();
   const after=this.getMetrics();if(['late_blocks','dropped','device_errors','missing_ms'].some(key=>(after[key]||0)>(before[key]||0)))throw Error('測定中に音声の処理落ちがあったため補正しません。他の処理を減らして再測定してください。');
   const stopped=await this.stopRecording();
   const file=path.resolve(stopped.outputPath||'');
   if(!file.startsWith(path.resolve(this.journal.folder)+path.sep))throw Error('テスト録画の保存先が一致しません。');
   for(const observed of this.journal.observed){
    const current=(await this.inputRpc('GetInputAudioSyncOffset',observed.input)).inputAudioSyncOffset;
    if(current!==observed.offset)throw Error('測定中にOBSの同期オフセットが変更されたため補正しません。');
   }
   this.update({phase:'analyzing',message:'OBSに録音されたテスト音声を解析しています…',progress:.95});
   return this.python(config.python,{mode:this.liveSession?'analyze-stereo-probe':'analyze-probe',ffmpeg:this.ffmpeg(),recording:file,music_offset_ms:musicOffset,fixed_ms:config.singing_latency_ms,correction_ms:config.obs_correction_ms});
 }
 async cleanup(){
  const j=this.journal;const record=await this.idleOutputs(true,{allowStream:!!(j.live||j.prepareOnly)});
  let currentProfile=await this.profile();if(currentProfile===j.resetProfile){await this.switchProfile(j.profile);currentProfile=j.profile;}
  if(currentProfile!==j.profile)throw Error('測定時と異なるOBSプロファイルが選択されています。元のプロファイルを選んでください。');
  if(record.outputActive){if(!j.recording)throw Error('別の録画が開始されています。録画を停止してください。');await this.stopRecording();}
  if(j.live&&!j.engineCleared){
   // Keep owned test sources isolated while queued conversion/effect audio is
   // discarded, including cancellation caused by an external routing change.
   const voice=j.patches.find(patch=>patch.kind==='tracks'&&patch.value[String(j.privateTrack)])?.input;
   for(const input of [voice,j.reference].filter(Boolean)){
    try{await this.inputRpc('SetInputAudioTracks',input,{inputAudioTracks:Object.fromEntries([1,2,3,4,5,6].map(track=>[String(track),track===j.privateTrack]))});}catch(error){if(error.code!==600)throw error;}
   }
   await this.resetEngine();
   // OBS source offsets can retain already-converted packets after the device
   // stream has been reset. Drain the observed route before restoring voice.
   const drainMs=Math.max(500,...(j.observed||[]).map(item=>Math.max(0,item.offset)+500));
   await new Promise(resolve=>setTimeout(resolve,drainMs));j.engineCleared=true;this.writeJournal();
  }
  for(const patch of [...j.patches].reverse()){
   if(patch.kind==='profile'){
    const data={parameterCategory:patch.category,parameterName:patch.name};
    if((await this.rpc('GetProfileParameter',data)).parameterValue===patch.value)await this.rpc('SetProfileParameter',{...data,parameterValue:patch.old});
   }else if(patch.kind==='balance'){
    try{if((await this.inputRpc('GetInputAudioBalance',patch.input)).inputAudioBalance===patch.value)await this.inputRpc('SetInputAudioBalance',patch.input,{inputAudioBalance:patch.old});}catch(error){if(![600,602,604].includes(error.code))throw error;}
   }else if(patch.kind==='monitor'){
    try{const current=(await this.inputRpc('GetInputAudioMonitorType',patch.input)).monitorType;if(current===patch.value)await this.inputRpc('SetInputAudioMonitorType',patch.input,{monitorType:patch.old});}catch(error){if(![600,602,604].includes(error.code))throw error;}
   }else{
    try{
     const current=(await this.inputRpc('GetInputAudioTracks',patch.input)).inputAudioTracks;
     const restored={...current};for(const key of Object.keys(patch.old))if(current[key]===patch.value[key])restored[key]=patch.old[key];
     if(!equal(current,restored))await this.inputRpc('SetInputAudioTracks',patch.input,{inputAudioTracks:restored});
    }
    catch(error){if(![600,602,604].includes(error.code))throw error;}
   }
  }
  if(j.referenceName){const inputs=(await this.rpc('GetInputList')).inputs||[];const reference=inputs.find(input=>input.inputName===j.referenceName);if(reference)await this.rpc('RemoveInput',identity(reference));}
  if(j.rawName){const inputs=(await this.rpc('GetInputList')).inputs||[];const raw=inputs.find(input=>input.inputName===j.rawName);if(raw)await this.rpc('RemoveInput',identity(raw));}
  // Recreate OBS's output handler after changing track counts, so encoders for
  // extra temporary tracks cannot remain attached to subsequent user recordings.
  if(!j.live&&!j.prepareOnly){
  this.broadcast.invalidate();const {profiles}=await this.profiles();
  if(!profiles.includes(j.resetProfile)){
   try{
    await this.rpc('CreateProfile',{profileName:j.resetProfile});
    // CreateProfile queues UI work and can return before activation finishes.
    await this.waitProfiles(result=>result.profiles.includes(j.resetProfile)&&result.currentProfileName===j.resetProfile);
   }catch(error){
    if(error.code!==601||!(await this.profiles()).profiles.includes(j.resetProfile))throw error;
    await this.switchProfile(j.resetProfile);
   }
  }else await this.switchProfile(j.resetProfile);
  await this.idleOutputs();await this.switchProfile(j.profile);
  await this.idleOutputs();
  await this.rpc('RemoveProfile',{profileName:j.resetProfile});
  await this.waitProfiles(result=>!result.profiles.includes(j.resetProfile)&&result.currentProfileName===j.profile);
  }
  const root=path.resolve(this.home,'obs-sync-recordings');const folder=path.resolve(j.folder);
  if(folder.startsWith(root+path.sep)&&path.basename(folder)===j.id)await fs.promises.rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  fs.unlinkSync(this.journalFile);this.journal=null;
 }
 async recover(){
  if(this.preparingBroadcast)throw Error('配信中の自動調整を準備しています。少しお待ちください。');
  if(this.busy)throw Error('測定が終わるまでお待ちください。');
  const saved=JSON.parse(fs.readFileSync(this.journalFile,'utf8'));
  if(saved.version!==1||!(/^[a-f0-9-]{36}$/.test(saved.id))||!Array.isArray(saved.patches)||saved.patches.length>512||typeof saved.profile!=='string'||typeof saved.folder!=='string'||saved.resetProfile!=='YUI同期測定_復元_'+saved.id||(saved.referenceName&&saved.referenceName!=='YUI同期測定_目印_'+saved.id)||(saved.rawName&&saved.rawName!=='YUI同期測定_生声_'+saved.id)||path.resolve(saved.folder)!==path.resolve(this.home,'obs-sync-recordings',saved.id))throw Error('復元ファイルを確認してください。');
  const allowed={SimpleOutput:['RecTracks','FilePath'],AdvOut:['RecTracks','RecFilePath'],Output:['FilenameFormatting'],Video:['AutoRemux']};
  if(saved.patches.some(patch=>patch.kind==='profile'?!allowed[patch.category]?.includes(patch.name):patch.kind==='balance'?(!patch.input||patch.value!==1||!Number.isFinite(patch.old)||patch.old<0||patch.old>1):patch.kind==='monitor'?(!patch.input||patch.value!=='OBS_MONITORING_TYPE_NONE'||!['OBS_MONITORING_TYPE_NONE','OBS_MONITORING_TYPE_MONITOR_ONLY','OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'].includes(patch.old)):patch.kind!=='tracks'||!patch.input||!patch.old||!patch.value||Object.entries(patch.old).some(([key,value])=>!(/^[1-6]$/.test(key))||typeof value!=='boolean')))throw Error('復元ファイルの設定項目を確認してください。');
  if((saved.live!==undefined&&saved.live!==true)||(saved.prepareOnly!==undefined&&saved.prepareOnly!==true)||(saved.live&&(!Number.isInteger(saved.privateTrack)||saved.privateTrack<1||saved.privateTrack>6)))throw Error('復元ファイルの設定項目を確認してください。');
  this.busy=true;this.update({phase:'restoring',message:'前回の測定設定を戻しています…'});
  this.journal=saved;this.obs.maintenance=true;
  this.task=(async()=>{try{await this.cleanup();this.state={phase:'idle',message:'前回の測定設定を復元しました。'};}catch(error){this.state={phase:'failed',message:error.message};throw error;}finally{this.obs.maintenance=false;this.busy=false;await this.obs.flush();this.update({});}})();
  await this.task;return this.info();
 }
 cancel(){if(!this.busy)return this.status();this.cancelled=true;this.startAbort?.abort();this.update({phase:'cancelling',message:'測定を中止し、OBSの設定を戻しています…'});if(this.child?.stdin.writable)this.child.stdin.write('{"command":"cancel"}\n');const child=this.child;if(child)setTimeout(()=>{if(this.child===child)child.kill();},1500).unref?.();return this.status();}
 async shutdown(){if(this.busy){this.cancel();await this.task;}if(this.broadcast.preparation)await this.broadcast.preparation;}
}
module.exports={ObsSync};
