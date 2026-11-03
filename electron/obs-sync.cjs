const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),{randomUUID}=require('node:crypto'),{spawn}=require('node:child_process');
const identity=item=>item.inputUuid?{inputUuid:item.inputUuid}:{inputName:item.inputName};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
class ObsSync{
 constructor({home,engineRoot,obs,notify=()=>{},onComplete=()=>{},prepareEngine=async()=>{},isRunning=()=>false,getMetrics=()=>({}),spawnProcess=spawn}){
  Object.assign(this,{home,engineRoot,obs,notify,onComplete,prepareEngine,isRunning,getMetrics,spawnProcess});this.busy=false;this.state={phase:'idle',message:''};this.child=null;
  this.journalFile=path.join(home,'obs-sync-recovery.json');this.toolsFile=path.join(home,'obs-sync-tools.json');
 }
 status(){return {...this.state,busy:this.busy};}
 update(patch){this.state={...this.state,...patch};this.notify({type:'obs-sync',...this.status()});}
 ffmpeg(){
  let chosen='';try{chosen=JSON.parse(fs.readFileSync(this.toolsFile,'utf8')).ffmpeg;}catch{}
  const candidates=[chosen,path.join(this.home,'tools','ffmpeg.exe'),...(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir.replace(/^"|"$/g,''),'ffmpeg.exe'))];
  return candidates.find(file=>typeof file==='string'&&file&&fs.statSync(file,{throwIfNoEntry:false})?.isFile())||'';
 }
 setFfmpeg(file){if(this.busy)throw Error('測定が終わるまでお待ちください。');if(typeof file!=='string'||path.basename(file).toLowerCase()!=='ffmpeg.exe'||!fs.statSync(file,{throwIfNoEntry:false})?.isFile())throw Error('ffmpeg.exeを選んでください。');fs.mkdirSync(this.home,{recursive:true});fs.writeFileSync(this.toolsFile,JSON.stringify({ffmpeg:file}));return this.info();}
 info(){return {ffmpeg:!!this.ffmpeg(),recovery:fs.existsSync(this.journalFile)};}
 check(){if(this.cancelled)throw Error('測定を中止しました。');if(!this.isRunning())throw Error('声変換が停止したため測定を中止しました。');}
 async rpc(type,data={}){
  if(!this.obs.connection?.identified)throw Error('OBSとの接続が切れました。再接続して測定設定を復元してください。');
  try{return await this.obs.connection.request(type,data);}catch(error){
   const labels={GetStreamStatus:'配信状態の確認',GetRecordStatus:'録画状態の確認',GetReplayBufferStatus:'リプレイバッファの状態確認',GetVirtualCamStatus:'仮想カメラの状態確認',GetProfileList:'プロファイルの確認',GetProfileParameter:'録画設定の確認',GetInputMute:'音声ソースのミュート確認',GetInputSettings:'音声デバイスの確認',GetInputPropertiesListPropertyItems:'音声デバイス一覧の取得',CreateInput:'測定用マイクの追加',GetInputAudioTracks:'音声トラックの確認',SetInputAudioTracks:'音声トラックの設定・復元',SetProfileParameter:'録画設定の変更・復元',StartRecord:'テスト録画の開始',StopRecord:'テスト録画の終了',CreateProfile:'録画出力の再読み込み',SetCurrentProfile:'プロファイルの復元',RemoveProfile:'一時プロファイルの後片付け'};
   const source=typeof data.inputName==='string'?`「${data.inputName}」の`:'';
   error.message=`OBSで${source}${labels[type]||type}に失敗しました${error.code?`（${error.code}）`:''}。${error.code?'対象の設定やソースの状態を確認してください。':error.message}`;
   throw error;
  }
 }
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
 async idleOutputs(allowRecording=false){
  const [stream,record,replay,camera]=await Promise.all([this.rpc('GetStreamStatus'),this.rpc('GetRecordStatus'),this.optionalOutput('GetReplayBufferStatus'),this.optionalOutput('GetVirtualCamStatus')]);
  if(stream.outputActive||replay.outputActive||camera.outputActive||(!allowRecording&&record.outputActive))throw Error('OBSの配信・録画・リプレイバッファ・仮想カメラを停止してから測定してください。');
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
 async patchProfile(category,name,value){
  this.check();
  const old=(await this.rpc('GetProfileParameter',{parameterCategory:category,parameterName:name})).parameterValue;
  this.journal.patches.push({kind:'profile',category,name,old,value});this.writeJournal();
  await this.rpc('SetProfileParameter',{parameterCategory:category,parameterName:name,parameterValue:value});
 }
 async patchTracks(input,tracks){
  this.check();
  const old=(await this.rpc('GetInputAudioTracks',identity(input))).inputAudioTracks;
  if(!old||typeof old!=='object')throw Error('OBSの音声トラックを取得できませんでした。');
  const value={...old,...tracks};this.journal.patches.push({kind:'tracks',input,old,value});this.writeJournal();
  await this.rpc('SetInputAudioTracks',{...identity(input),inputAudioTracks:value});
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
  await this.obs.flush();await this.idleOutputs();
  const version=await this.rpc('GetVersion');
  for(const type of ['GetProfileParameter','SetProfileParameter','GetInputAudioTracks','SetInputAudioTracks','StartRecord','StopRecord'])if(!version.availableRequests?.includes(type))throw Error('このOBSは自動同期測定に必要な操作に対応していません。');
  const mode=(await this.rpc('GetProfileParameter',{parameterCategory:'Output',parameterName:'Mode'})).parameterValue;
  const category=mode==='Advanced'?'AdvOut':'SimpleOutput';
  const get=async name=>(await this.rpc('GetProfileParameter',{parameterCategory:category,parameterName:name})).parameterValue;
  const format=await get('RecFormat2');
  if(!/^(mkv|mp4|mov|hybrid_mp4|hybrid_mov|fragmented_mp4|fragmented_mov)$/.test(format||''))throw Error('OBSの録画形式をMKVまたはMP4にしてください。');
  if(category==='SimpleOutput'&&!['Small','HQ'].includes(await get('RecQuality')))throw Error('OBSの録画品質を「高品質」または「超高品質」にしてください。');
  if(category==='AdvOut'&&(await get('RecType'))!=='Standard')throw Error('OBSの録画種別を「標準」にしてください。');
  const available=this.obs.status().inputs;
  const music=available.find(input=>config.obs_input_uuid?input.inputUuid===config.obs_input_uuid:input.inputName===config.obs_input_name);
  if(!music||!voice||equal(identity(music),identity(voice)))throw Error('伴奏と変換後の声は、別々のOBSソースを選んでください。');
  for(const input of [music,voice])if((await this.rpc('GetInputMute',identity(input))).inputMuted)throw Error('測定する音声ソースのミュートを解除してください。');
  const musicSettings=await this.rpc('GetInputSettings',identity(music));
  if(!/^wasapi_output_capture/.test(musicSettings.inputKind||''))throw Error('ビープを録音する伴奏ソースには「デスクトップ音声／音声出力キャプチャ」を選んでください。');
  let playbackName='';
  const device=musicSettings.inputSettings?.device_id;
  if(device&&device!=='default'){
   const list=await this.rpc('GetInputPropertiesListPropertyItems',{...identity(music),propertyName:'device_id'});
   playbackName=list.propertyItems?.find(item=>item.itemValue===device)?.itemName;
   if(!playbackName)throw Error('デスクトップ音声の再生デバイスを確認できませんでした。');
  }
  this.obs.maintenance=true;clearTimeout(this.obs.syncTimer);clearTimeout(this.obs.retryTimer);
  const id=randomUUID();const folder=path.join(this.home,'obs-sync-recordings',id);fs.mkdirSync(folder,{recursive:true});
  this.journal={version:1,id,folder,profile:await this.profile(),patches:[],recording:false,resetProfile:'YUI同期測定_復元_'+id};this.writeJournal();
  for(const input of available){
   const tracks={'1':equal(identity(input),identity(music)),'2':equal(identity(input),identity(voice))};
   await this.patchTracks(input,tracks);
  }
  await this.patchProfile(category,'RecTracks','3');
  await this.patchProfile(category,category==='AdvOut'?'RecFilePath':'FilePath',folder);
  await this.patchProfile('Output','FilenameFormatting','YUI-Sync-%CCYY-%MM-%DD-%hh-%mm-%ss');
  await this.patchProfile('Video','AutoRemux','false');
  this.check();await this.idleOutputs();
  const musicOffset=(await this.rpc('GetInputAudioSyncOffset',identity(music))).inputAudioSyncOffset;
  const voiceOffset=(await this.rpc('GetInputAudioSyncOffset',identity(voice))).inputAudioSyncOffset;
  this.journal.observed=[{input:music,offset:musicOffset},{input:voice,offset:voiceOffset}];
  this.journal.music=music;this.journal.musicOffset=musicOffset;this.journal.recording=true;this.writeJournal();
  await this.rpc('StartRecord');
  await this.waitRecord(true);this.check();
  this.monitor=setInterval(()=>this.idleOutputs(true).then(record=>{
   if(!record.outputActive||record.outputPaused)throw Error('テスト録画が停止・一時停止されました。');
   return this.profile();
  }).then(profile=>{if(profile!==this.journal?.profile)throw Error('OBSのプロファイルが変更されました。');})
   .catch(error=>{this.failure=error.message;this.cancel();}),500);
  return {playbackName,musicOffset};
 }
 validateStart(config,payload,{requireRunning=true}={}){
  if(this.busy)throw Error('OBSの同期測定は実行中です。');
  if(fs.existsSync(this.journalFile))throw Error('前回の測定設定を復元してから開始してください。');
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
   if(prepare){
    await this.idleOutputs();
    if(this.cancelled)throw Error('測定を中止しました。');
    await this.prepareEngine(config,this.startAbort.signal);this.check();
   }
   const {playbackName,musicOffset}=await this.prepare(config,voice);this.check();const before={...this.getMetrics()};
   const dryFile=path.join(this.journal.folder,'raw.wav');
   await this.python(config.python,{mode:'play',device_name:playbackName,input_name:config.input_name,input:config.input,dry_file:dryFile},event=>{
    const beat=event.beat;
    this.update({phase:'speaking',beat,progress:event.progress,message:beat<=0?'カウントの後、拍に合わせて短く「た」と発声してください。':beat<=8?`拍に合わせて「た」：${beat} / 8`:'録音の終わりを待っています…'});
   });
   clearInterval(this.monitor);this.monitor=null;this.check();
   const after=this.getMetrics();if(['late_blocks','dropped','device_errors'].some(key=>(after[key]||0)>(before[key]||0)))throw Error('測定中に音声の処理落ちがあったため補正しません。他の処理を減らして再測定してください。');
   const stopped=await this.stopRecording();
   const file=path.resolve(stopped.outputPath||'');
   if(!file.startsWith(path.resolve(this.journal.folder)+path.sep))throw Error('テスト録画の保存先が一致しません。');
   for(const observed of this.journal.observed){
    const current=(await this.rpc('GetInputAudioSyncOffset',identity(observed.input))).inputAudioSyncOffset;
    if(current!==observed.offset)throw Error('測定中にOBSの同期オフセットが変更されたため補正しません。');
   }
   this.update({phase:'analyzing',message:'録音したビープ・生声・変換後の声を解析しています…',progress:.95});
   result=await this.python(config.python,{mode:'analyze',ffmpeg:this.ffmpeg(),recording:file,dry_file:dryFile,music_offset_ms:musicOffset,fixed_ms:config.singing_latency_ms,correction_ms:config.obs_correction_ms});this.check();
  }catch(reason){error=reason;}
  clearInterval(this.monitor);this.monitor=null;
  try{if(this.journal)await this.cleanup();}catch(reason){error=Error(`OBSの測定設定を完全に復元できませんでした。「前回の測定設定を復元」を押してください。${reason.message}`);}
  this.obs.maintenance=false;
  try{await this.obs.flush();}catch(reason){error=error||reason;}
  this.busy=false;let nextConfig;
  if(!error&&!this.cancelled&&result){
   try{if(!Number.isInteger(result.correction_ms)||Math.abs(result.correction_ms)>1000||!Number.isInteger(result.matched)||result.matched<6||result.matched>8||!Number.isFinite(result.spread_ms)||result.spread_ms<0||result.spread_ms>55)throw Error('測定結果が正しくありません。');nextConfig=this.onComplete(result,config);}
   catch(reason){error=reason;}
  }
  const cancelled=this.cancelled&&!this.failure&&!fs.existsSync(this.journalFile);
  this.state={phase:error||this.cancelled?(cancelled?'cancelled':'failed'):'completed',message:error||this.cancelled?(this.failure||error?.message||'測定を中止しました。'):'OBSの同期補正を自動設定しました。',...(result&&!error&&!this.cancelled?{result}:{})};
  this.notify({type:'obs-sync',...this.status(),...(nextConfig?{config:nextConfig}:{})});
 }
 async cleanup(){
  const j=this.journal;const record=await this.idleOutputs(true);
  let currentProfile=await this.profile();if(currentProfile===j.resetProfile){await this.switchProfile(j.profile);currentProfile=j.profile;}
  if(currentProfile!==j.profile)throw Error('測定時と異なるOBSプロファイルが選択されています。元のプロファイルを選んでください。');
  if(record.outputActive){if(!j.recording)throw Error('別の録画が開始されています。録画を停止してください。');await this.stopRecording();}
  for(const patch of [...j.patches].reverse()){
   if(patch.kind==='profile'){
    const data={parameterCategory:patch.category,parameterName:patch.name};
    if((await this.rpc('GetProfileParameter',data)).parameterValue===patch.value)await this.rpc('SetProfileParameter',{...data,parameterValue:patch.old});
   }else{
    try{
     const current=(await this.rpc('GetInputAudioTracks',identity(patch.input))).inputAudioTracks;
     const restored={...current};for(const key of Object.keys(patch.old))if(current[key]===patch.value[key])restored[key]=patch.old[key];
     if(!equal(current,restored))await this.rpc('SetInputAudioTracks',{...identity(patch.input),inputAudioTracks:restored});
    }
    catch(error){if(![600,602].includes(error.code))throw error;}
   }
  }
  if(j.rawName){const inputs=(await this.rpc('GetInputList')).inputs||[];const raw=inputs.find(input=>input.inputName===j.rawName);if(raw)await this.rpc('RemoveInput',identity(raw));}
  // Recreate OBS's output handler after changing track counts, so encoders for
  // extra temporary tracks cannot remain attached to subsequent user recordings.
  const {profiles}=await this.profiles();
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
  const root=path.resolve(this.home,'obs-sync-recordings');const folder=path.resolve(j.folder);
  if(folder.startsWith(root+path.sep)&&path.basename(folder)===j.id)fs.rmSync(folder,{recursive:true,force:true});
  fs.unlinkSync(this.journalFile);this.journal=null;
 }
 async recover(){
  if(this.busy)throw Error('測定が終わるまでお待ちください。');
  const saved=JSON.parse(fs.readFileSync(this.journalFile,'utf8'));
  if(saved.version!==1||!(/^[a-f0-9-]{36}$/.test(saved.id))||!Array.isArray(saved.patches)||saved.patches.length>512||typeof saved.profile!=='string'||typeof saved.folder!=='string'||saved.resetProfile!=='YUI同期測定_復元_'+saved.id||(saved.rawName&&saved.rawName!=='YUI同期測定_生声_'+saved.id)||path.resolve(saved.folder)!==path.resolve(this.home,'obs-sync-recordings',saved.id))throw Error('復元ファイルを確認してください。');
  const allowed={SimpleOutput:['RecTracks','FilePath'],AdvOut:['RecTracks','RecFilePath'],Output:['FilenameFormatting'],Video:['AutoRemux']};
  if(saved.patches.some(patch=>patch.kind==='profile'?!allowed[patch.category]?.includes(patch.name):patch.kind!=='tracks'||!patch.input||!patch.old||!patch.value||Object.entries(patch.old).some(([key,value])=>!(/^[1-6]$/.test(key))||typeof value!=='boolean')))throw Error('復元ファイルの設定項目を確認してください。');
  this.busy=true;this.update({phase:'restoring',message:'前回の測定設定を戻しています…'});
  this.journal=saved;this.obs.maintenance=true;
  this.task=(async()=>{try{await this.cleanup();this.state={phase:'idle',message:'前回の測定設定を復元しました。'};}catch(error){this.state={phase:'failed',message:error.message};throw error;}finally{this.obs.maintenance=false;this.busy=false;await this.obs.flush();this.update({});}})();
  await this.task;return this.info();
 }
 cancel(){if(!this.busy)return this.status();this.cancelled=true;this.startAbort?.abort();this.update({phase:'cancelling',message:'測定を中止し、OBSの設定を戻しています…'});if(this.child?.stdin.writable)this.child.stdin.write('{"command":"cancel"}\n');const child=this.child;if(child)setTimeout(()=>{if(this.child===child)child.kill();},1500).unref?.();return this.status();}
 async shutdown(){if(this.busy){this.cancel();await this.task;}}
}
module.exports={ObsSync};
