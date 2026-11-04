// Passive observer. Never writes OBS settings, inserts audio, or starts/stops outputs.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
class ObsMonitor{
 constructor({obs,engineRoot,events,request,isRunning,ffmpeg,notify=()=>{},platform=process.platform,spawnProcess=spawn,interval=5000}){
  Object.assign(this,{obs,engineRoot,events,request,isRunning,ffmpeg,notify,platform,spawnProcess,interval});this.active=false;this.state={phase:'idle',message:''};this.pending=new Map();
  this.listener=event=>{
   if(event.type==='passive-reference'){
    const pending=this.pending.get(event.id);if(pending){this.pending.delete(event.id);clearTimeout(pending.timer);event.error?pending.reject(Error(event.error)):pending.resolve(event.voice);}
   }
   if(event.type==='state'&&event.state!=='running'&&this.active)void this.stop('声変換が停止したため確認を終了しました。');
  };events.on('event',this.listener);
 }
 status(){return {...this.state,active:this.active};}
 update(patch){this.state={...patch};this.notify({type:'obs-monitor',...this.status()});}
 reference(command){return new Promise((resolve,reject)=>{
  const id=randomUUID();const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('声の参照音声を取得できませんでした。'));},3000);
  this.pending.set(id,{resolve,reject,timer});try{this.request(command,{id});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
 });}
 rpc(type,data={}){if(!this.obs.connection?.identified)throw Error('OBSとの接続が切れました。');return this.obs.connection.request(type,data);}
 async info(config,voiceKey){
  const inputs=(await this.rpc('GetInputList')).inputs;
  for(const input of this.obs.status?.().inputs||[])if(!inputs.some(x=>x.inputName===input.inputName))inputs.push(input);
  const music=inputs.find(x=>config.obs_input_uuid?x.inputUuid===config.obs_input_uuid:x.inputName===config.obs_input_name);
  const voice=inputs.find(x=>x.inputUuid===voiceKey||x.inputName===voiceKey);
  if(!music||!voice||(voice.inputUuid||voice.inputName)===(music.inputUuid||music.inputName))throw Error('伴奏と変換後の声は別々のOBSソースを選んでください。');
  const identity=x=>x.inputUuid?{inputUuid:x.inputUuid}:{inputName:x.inputName};
  const ms=await this.rpc('GetInputSettings',identity(music)),vs=await this.rpc('GetInputSettings',identity(voice));
  if(!['wasapi_output_capture','wasapi_process_output_capture','wasapi_process_output_capture_v2'].includes(ms.inputKind))throw Error('伴奏はデスクトップ音声またはアプリケーション音声キャプチャを選んでください。');
  const get=async(category,name)=>(await this.rpc('GetProfileParameter',{parameterCategory:category,parameterName:name})).parameterValue;
  const mode=await get('Output','Mode'),category=mode==='Advanced'?'AdvOut':'SimpleOutput';
  const format=await get(category,'RecFormat2');
  if(!['mkv','hybrid_mp4','fragmented_mp4'].includes(format))throw Error('ずれの確認には、OBSの録画形式をMKVまたはHybrid MP4にしてください。');
  const mask=Number(await get(category,'RecTracks'))||1;
  const vt=(await this.rpc('GetInputAudioTracks',identity(voice))).inputAudioTracks;
  const mt=(await this.rpc('GetInputAudioTracks',identity(music))).inputAudioTracks;
  const recorded=[1,2,3,4,5,6].filter(x=>mask&(1<<(x-1)));const track=recorded.find(x=>vt[String(x)]&&mt[String(x)]);
  if(!track)throw Error('声と伴奏が一緒に入る録画トラックが必要です。OBSの音声詳細プロパティを確認してください。');
  for(const input of [voice,music])if((await this.rpc('GetInputMute',identity(input))).inputMuted)throw Error('確認する声・伴奏ソースのミュートを解除してください。');
  // Process capture has no render endpoint ID: use the user's default playback endpoint.
  return {device_id:ms.inputKind==='wasapi_output_capture'?(ms.inputSettings.device_id||'default'):'default',track:recorded.indexOf(track),voice:voice.inputUuid||voice.inputName,music:music.inputUuid||music.inputName,voice_device:vs.inputSettings?.device_id||'',profile:(await this.rpc('GetProfileList')).currentProfileName};
 }
 async recording(){
  const status=await this.rpc('GetRecordStatus');if(!status.outputActive||status.outputPaused)return null;
  const outputs=(await this.rpc('GetOutputList')).outputs;
  for(const output of outputs){
   const name=output.outputName;
   if(!/file|record|mp4|mkv/i.test(name))continue;
   const result=await this.rpc('GetOutputSettings',{outputName:name});const candidate=result.outputSettings?.path||result.outputSettings?.url;
   if(typeof candidate==='string'&&/\.(mkv|mp4)$/i.test(candidate)&&fs.statSync(candidate,{throwIfNoEntry:false})?.isFile())return candidate;
  }
  return null;
 }
 async start(config,payload){
  if(this.active)throw Error('ずれを確認中です。');
  if(this.stopping)throw Error('確認の停止が終わるまでお待ちください。');
  if(this.platform!=='win32')throw Error('ずれの確認は現在Windowsに対応しています。');
  if(!this.isRunning()||!config.singing_enabled)throw Error('固定遅延を有効にして声変換を開始してください。');
  const ffmpeg=this.ffmpeg();if(!ffmpeg)throw Error('OBSの自動設定で解析用のffmpegを指定してください。');
  const info=await this.info(config,payload?.voice);
  this.active=true;this.update({phase:'waiting',message:'声と伴奏がそろうのを待っています。'});
  try{
   await this.reference('passive-start');if(!this.active)return this.status();
   this.child=this.spawnProcess(config.python,['-I','-u',path.join(this.engineRoot,'backend/passive_monitor.py')],{cwd:this.engineRoot,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'1'},stdio:['pipe','pipe','pipe']});
   const child=this.child;this.finished=new Promise(resolve=>{child.once('exit',resolve);child.once('close',resolve);child.once('error',resolve);});child.stderr.resume();child.stdin.on('error',()=>{});
   readline.createInterface({input:child.stdout}).on('line',line=>{
    if(!this.active)return;
    try{const event=JSON.parse(line);if(event.phase==='ready'){this.schedule(config,info,0);return;}this.measuring=false;clearTimeout(this.watchdog);
     if(event.phase==='failed'){void this.stop(event.message);return;}
     if(event.phase==='measured'){
      if(!Number.isInteger(event.delta_ms)||Math.abs(event.delta_ms)>3000)throw Error('測定結果が正しくありません。');
      this.update({...event,updated_at:Date.now()});
     }else this.update({phase:'waiting',message:event.message||'判定待ち'});
     this.schedule(config,info);
    }catch{void this.stop('確認用の音声処理が終了しました。');}
   });
   child.once('error',()=>{if(this.active)void this.stop('確認用の音声処理を起動できませんでした。');});
   child.once('exit',()=>{if(this.active)void this.stop('確認用の音声処理が終了しました。');});
   child.stdin.write(JSON.stringify({ffmpeg,device_id:info.device_id})+'\n');
   this.watchdog=setTimeout(()=>{if(this.active)void this.stop('伴奏の音声取得を開始できませんでした。');},8000);
   return this.status();
  }catch(error){await this.stop(error.message);throw error;}
 }
 schedule(config,info,delay=this.interval){clearTimeout(this.timer);if(this.active)this.timer=setTimeout(()=>void this.tick(config,info),delay);}
 async tick(config,info){
  if(!this.active||this.measuring)return;this.measuring=true;clearTimeout(this.watchdog);
  try{
   if(!this.isRunning())throw Error('声変換が停止しました。');
   const current=await this.info(config,info.voice);
   if(JSON.stringify(current)!==JSON.stringify(info))throw Error('OBSの音声ルートが変更されました。確認を開始し直してください。');
   const recording=await this.recording();
   if(!recording){this.measuring=false;this.update({phase:'waiting',message:'OBSの録画を開始すると確認できます。'});this.schedule(config,info);return;}
   const voice=await this.reference('passive-snapshot');if(!this.active)return;
   this.child.stdin.write(JSON.stringify({command:'measure',recording,track:info.track,voice})+'\n');
   this.watchdog=setTimeout(()=>{if(this.active)void this.stop('解析が間に合わないため確認を停止しました。');},18000);
  }catch(error){this.measuring=false;if(this.active)await this.stop(error.message);}
 }
 async stop(message=''){
  if(this.stopping)return this.stopping;
  if(!this.active&&!this.child&&!this.pending.size)return this.status();
  const child=this.child,finished=this.finished;this.child=null;this.active=false;this.measuring=false;clearTimeout(this.timer);clearTimeout(this.watchdog);
  this.update({phase:message?'waiting':'idle',message});
  this.stopping=(async()=>{
   try{if(this.isRunning())await this.reference('passive-stop');}catch{}
   if(child){if(child.stdin.writable)child.stdin.end('{"command":"stop"}\n');const timer=setTimeout(()=>child.kill(),15000);await finished;clearTimeout(timer);}
   for(const [id,pending] of this.pending){clearTimeout(pending.timer);pending.reject(Error('確認を停止しました。'));this.pending.delete(id);}
  })();
  try{await this.stopping;}finally{this.stopping=null;}return this.status();
 }
 async shutdown(){await this.stop();this.events.off('event',this.listener);}
}
module.exports={ObsMonitor};
