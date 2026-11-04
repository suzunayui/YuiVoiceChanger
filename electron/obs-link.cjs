const {createHash}=require('node:crypto');
const {obsDefaults,obsKeys,offsetFor}=require('./obs-config.cjs');
const {isWindowCapture,filterRequests}=require('./obs-video-delay.cjs');
const {ObsVideoSources}=require('./obs-video-sources.cjs');
const hash=value=>createHash('sha256').update(value).digest('base64');
const identity=input=>input.inputUuid?{inputUuid:input.inputUuid}:{inputName:input.inputName};
const keyOf=input=>input.inputUuid?'uuid:'+input.inputUuid:'name:'+input.inputName;
class ObsRequestError extends Error{constructor(code,requestType='',comment=''){super(`OBSで操作できませんでした（${code}）。音声ソースを確認してください。`);this.code=code;this.requestType=requestType;this.comment=typeof comment==='string'?comment.slice(0,500):'';}}

class ObsSocket{
 constructor(port,password,{WebSocketImpl=globalThis.WebSocket,timeout=5000,onClose=()=>{}}={}){
  this.port=port;this.timeout=timeout;this.onClose=onClose;this.pending=new Map();this.sequence=0;this.identified=false;this.intentional=false;this.hello=false;
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.socket=new WebSocketImpl(`ws://127.0.0.1:${port}`);
  this.timer=setTimeout(()=>this.fail(Error('OBSへの接続が時間切れになりました。WebSocketの設定を確認してください。')),timeout);
  this.socket.addEventListener('message',event=>{
   try{
    if(typeof event.data!=='string'||event.data.length>4*1024*1024)throw Error('OBSの応答を読み取れませんでした。');
    const {op,d}=JSON.parse(event.data);
    if(op===0){
     if(this.hello||!d||d.rpcVersion<1)throw Error('OBS WebSocket 5以降が必要です。');
     this.hello=true;
     const auth=d.authentication;
     if(auth&&(typeof auth.salt!=='string'||typeof auth.challenge!=='string'))throw Error('OBSの認証情報を読み取れませんでした。');
     this.socket.send(JSON.stringify({op:1,d:{rpcVersion:1,eventSubscriptions:0,...(auth?{authentication:hash(hash(password+auth.salt)+auth.challenge)}:{})}}));
    }else if(op===2){
     if(!this.hello||d?.negotiatedRpcVersion!==1)throw Error('OBS WebSocketのバージョンに対応していません。');
     this.identified=true;clearTimeout(this.timer);this.resolveReady(this);
    }else if(op===7){
     const pending=this.pending.get(d?.requestId);if(!pending)return;
     this.pending.delete(d.requestId);clearTimeout(pending.timer);
     if(d.requestType!==pending.type)pending.reject(Error('OBSの応答が一致しません。'));
     else if(!d.requestStatus?.result)pending.reject(new ObsRequestError(d.requestStatus?.code??0,pending.type,d.requestStatus?.comment));
     else pending.resolve(d.responseData||{});
    }
   }catch(error){this.fail(error);}
  });
  this.socket.addEventListener('error',()=>this.fail(Error('OBSに接続できません。OBSの「ツール → WebSocketサーバー設定」を確認してください。')));
  this.socket.addEventListener('close',event=>{
   const error=Error(event.code===4009?'OBSのパスワードが違います。':event.code===4011?'OBS側で接続が解除されました。「接続する」で再接続できます。':'OBSとの接続が切れました。');
   error.closeCode=event.code;
   this.rejectAll(error);
   if(!this.intentional)this.onClose(error);
  });
 }
 rejectAll(error){clearTimeout(this.timer);this.rejectReady(error);for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();this.identified=false;}
 fail(error){const established=this.identified;this.rejectAll(error);this.close();if(established)this.onClose(error);}
 close(){this.intentional=true;clearTimeout(this.timer);this.socket.close();this.rejectAll(Error('OBSとの接続を終了しました。'));}
 request(type,data={}){
  if(!this.identified)return Promise.reject(Error('OBSに接続してください。'));
  const id=String(++this.sequence);
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('OBSの応答が時間切れになりました。'));},this.timeout);
   this.pending.set(id,{resolve,reject,timer,type});
   try{this.socket.send(JSON.stringify({op:6,d:{requestType:type,requestId:id,requestData:data}}));}
   catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
  });
 }
}

class ObsLink{
 constructor({home,notify=()=>{},credentials={load:()=>'',save:()=>{},available:()=>false},WebSocketImpl,timeout=5000,reconnectDelay=3000}={}){
  this.notify=notify;this.credentials=credentials;this.WebSocketImpl=WebSocketImpl;this.timeout=timeout;this.reconnectDelay=reconnectDelay;
  this.config={...obsDefaults,singing_enabled:false,singing_latency_ms:400};this.running=false;this.connection=null;this.applied=null;this.queue=Promise.resolve();this.closing=false;this.blocked=false;this.sessionPassword='';this.revision=0;
  this.maintenance=false;
  this.video=new ObsVideoSources(home);
  this.previewSplit=new (require('./obs-preview-split.cjs').ObsPreviewSplit)(home);
  this.mix=new (require('./obs-mix.cjs').ObsMix)(home);
  this.desktopMute=new (require('./obs-mix.cjs').ObsMix)(home,'obs-desktop-mute.json');
  this.keepDesktopMuted=false;
  this.state={state:'disconnected',inputs:[],videoInputs:[],message:'',error:'',appliedOffset:null,appliedVideoOffset:null};
 }
 status(){return {...this.state,hasPassword:Boolean(this.credentials.load()),canRemember:this.credentials.available()};}
 async confirmDesktopMute(confirm){
  const connection=this.connection;
  if(!connection?.identified)return;
  const {desktop1,desktop2}=await connection.request('GetSpecialInputs');
  const names=[...new Set([desktop1,desktop2].filter(Boolean))];
  if(!names.length)return;
  const {inputs}=await connection.request('GetInputList');
  const desktop=(await Promise.all(names.map(async name=>{
   const input=identity(inputs.find(item=>item.inputName===name)||{inputName:name});
   const {inputMuted}=await connection.request('GetInputMute',input);
   return inputMuted?null:{name,input};
  }))).filter(Boolean);
  if(!desktop.length||!await confirm(desktop.map(({name})=>name)))return;
  await this.enqueue(async()=>{
   if(this.connection!==connection||!connection.identified)throw Error('OBSに再接続してからお試しください。');
   await this.desktopMute.muteDesktops(connection,desktop);
   this.keepDesktopMuted=true;
  });
 }
 releaseDesktopMute(){
  this.keepDesktopMuted=false;
  return this.enqueue(()=>this.desktopMute.restore(this.connection));
 }
 publish(patch){Object.assign(this.state,patch);this.notify({type:'obs-status',...this.status()});}
 enqueue(task){const operation=this.queue.then(task);this.queue=operation.catch(error=>{this.publish({error:error.message});});return operation;}
 configure(config,running){
  const before=JSON.stringify([this.config,this.running]);
  if(this.config.mix_enabled&&!config.mix_enabled)this.keepDesktopMuted=false;
  this.config=Object.fromEntries([...obsKeys,'singing_enabled','singing_latency_ms','mix_enabled','mix_latency_ms','mix_voice_uuid','mix_voice_name'].map(key=>[key,config[key]]));this.running=running;
  if(before===JSON.stringify([this.config,this.running])||this.closing)return;
  this.revision++;
  clearTimeout(this.syncTimer);
  if(this.maintenance)return;
  this.syncTimer=setTimeout(()=>this.enqueue(()=>this.sync()).catch(()=>{}),150);
 }
 flush(){clearTimeout(this.syncTimer);return this.enqueue(()=>this.sync());}
 wantsConnection(){
  return Boolean(this.credentials.load()||this.config.obs_enabled||(this.config.mix_enabled&&this.running)||
   this.video.pending||this.mix.pending||this.desktopMute.pending||this.previewSplit.pending);
 }
 retry(){
  clearTimeout(this.retryTimer);
  if(this.closing||this.blocked||!this.wantsConnection())return;
  this.retryTimer=setTimeout(()=>this.enqueue(()=>this.sync()).catch(()=>this.retry()),this.reconnectDelay);
  this.retryTimer.unref?.();
 }
 async open(port,password){
  this.publish({state:'connecting',error:'',message:'OBSに接続しています…'});
  const connection=new ObsSocket(port,password,{WebSocketImpl:this.WebSocketImpl,timeout:this.timeout,onClose:error=>{
   if(this.connection!==connection)return;
   this.connection=null;
   if([4009,4010,4011].includes(error.closeCode))this.blocked=true;
   this.publish({state:'disconnected',inputs:[],videoInputs:[],appliedOffset:null,appliedVideoOffset:null,error:error.message,message:''});this.retry();
  }});
  this.connection=connection;
  try{
   await connection.ready;
   const version=await connection.request('GetVersion');
   connection.availableRequests=version.availableRequests||[];
   if(!['GetInputAudioSyncOffset','SetInputAudioSyncOffset'].every(name=>version.availableRequests?.includes(name)))throw Error('このOBSは音声の同期オフセット操作に対応していません。');
   this.publish({state:'connected',error:'',message:'接続済み'});
   await this.inputs();
  }catch(error){
   if([4009,4010,4011].includes(error.closeCode))this.blocked=true;
   connection.close();if(this.connection===connection)this.connection=null;
   this.publish({state:'disconnected',inputs:[],videoInputs:[],appliedOffset:null,appliedVideoOffset:null,error:error.message,message:''});throw error;
  }
 }
 async inputs(){
  const connection=this.connection;if(!connection?.identified)throw Error('OBSに接続してください。');
  const [list,special]=await Promise.all([connection.request('GetInputList'),connection.request('GetSpecialInputs')]);
  const candidates=(list.inputs||[]).filter(input=>typeof input.inputName==='string');
  for(const name of Object.values(special))if(typeof name==='string'&&!candidates.some(input=>input.inputName===name))candidates.push({inputName:name});
  const audio=await Promise.all(candidates.map(async input=>{
   try{const offset=await connection.request('GetInputAudioSyncOffset',identity(input));return {inputName:input.inputName,inputUuid:input.inputUuid||'',offset:offset.inputAudioSyncOffset};}
   catch(error){if(error instanceof ObsRequestError&&[600,602,604].includes(error.code))return null;throw error;}
  }));
  const videoInputs=candidates.filter(isWindowCapture).map(input=>({inputName:input.inputName,inputUuid:input.inputUuid||''}));
  this.publish({inputs:audio.filter(Boolean).sort((a,b)=>a.inputName.localeCompare(b.inputName,'ja')),videoInputs:videoInputs.sort((a,b)=>a.inputName.localeCompare(b.inputName,'ja'))});
 }
 async restoreAudio(){
  const applied=this.applied;if(!applied)return;
  if(!this.connection?.identified||this.connection.port!==applied.port)throw Error('元の同期オフセットへ戻せませんでした。OBSに再接続してください。');
  try{
   const current=await this.connection.request('GetInputAudioSyncOffset',identity(applied));
   if(current.inputAudioSyncOffset===applied.target){
    await this.connection.request('SetInputAudioSyncOffset',{...identity(applied),inputAudioSyncOffset:applied.original});
    this.publish({message:'元の同期オフセットに戻しました。'});
   }else this.publish({message:'OBS側で変更された値を保持しました。'});
  }catch(error){if(!(error instanceof ObsRequestError&&[600,602].includes(error.code)))throw error;}
  this.applied=null;this.publish({appliedOffset:null});
 }
 async restore(){
  const errors=[];
  this.keepDesktopMuted=false;
  try{await this.desktopMute.restore(this.connection);}catch(error){errors.push(error.message);}
  try{await this.previewSplit.restore(this.connection);}catch(error){errors.push(error.message);}
  try{await this.mix.restore(this.connection);}catch(error){errors.push(error.message);}
  try{await this.restoreAudio();}catch(error){errors.push(error.message);}
  try{await this.video.restore(this.connection);this.publish({appliedVideoOffset:null});}catch(error){errors.push(error.message);}
  if(errors.length)throw Error(errors.join(' '));
 }
 async syncVideo(target,revision){
  if(this.config.mix_enabled)target=Math.max(0,target+(this.config.obs_video_correction_ms??0));
  const manual=(this.config.mix_enabled||this.config.obs_enabled)&&this.config.obs_video_enabled?this.config.obs_video_sources||[]:[];
  const inputs=manual.filter(item=>item.inputUuid||item.inputName).map(selected=>{
   const input=this.state.videoInputs.find(item=>keyOf(item)===keyOf(selected));
   if(!input)throw Error(`同期する映像「${selected.inputName||selected.inputUuid}」が見つかりません。OBSのソース一覧を更新してください。`);
   return input;
  });
  const automatic=[];
  if(this.config.mix_enabled){
   const {inputs:candidates}=await this.connection.request('GetInputList');
   for(const input of candidates.filter(item=>/^(window_capture(?:_v\d+)?|spout_capture)$/.test(item.unversionedInputKind||item.inputKind||''))){
    const {inputSettings}=await this.connection.request('GetInputSettings',identity(input));
    if(!/joysound/i.test(`${input.inputName} ${inputSettings?.window||''} ${inputSettings?.spoutsenders||''}`))continue;
    const source={inputName:input.inputName,inputUuid:input.inputUuid||''};
    automatic.push(source.inputName);
    if(!inputs.some(item=>keyOf(item)===keyOf(source)))inputs.push(source);
   }
  }
  if(revision!==this.revision||this.closing)return;
  if(inputs.length&&!filterRequests.every(type=>this.connection.availableRequests.includes(type)))throw Error('このOBSは映像の遅延フィルター操作に対応していません。');
  const current=()=>revision===this.revision&&!this.closing;
  if(inputs.length){if(!await this.video.apply(this.connection,inputs,target,current))return;}
  else await this.video.restore(this.connection);
  if(current())this.publish({appliedVideoOffset:inputs.length?target:null,autoVideoSources:automatic,error:''});
 }
 async sync(){
  if(this.closing||this.maintenance)return;
  const revisionAtStart=this.revision;
  const desired=this.config.obs_enabled&&this.config.singing_enabled&&this.running;
  const automaticVideo=this.config.mix_enabled&&this.running;
  const selected={inputUuid:this.config.obs_input_uuid,inputName:this.config.obs_input_name};
  if(this.connection&&this.connection.port!==this.config.obs_port){await this.restore();this.connection.close();this.connection=null;this.publish({state:'disconnected',inputs:[]});}
  if(!this.connection&&!this.blocked&&this.wantsConnection()){
   try{await this.open(this.config.obs_port,this.sessionPassword||this.credentials.load());}
   catch(error){this.retry();throw error;}
  }
  if(revisionAtStart!==this.revision)return;
  if(!this.keepDesktopMuted&&this.desktopMute.pending)await this.desktopMute.restore(this.connection);
  if(this.previewSplit.pending)await this.previewSplit.restore(this.connection);
  if(!desired||!this.config.mix_enabled)await this.mix.restore(this.connection);
  if(this.applied&&(!desired||this.applied.port!==this.config.obs_port||keyOf(this.applied)!==keyOf(selected)))await this.restore();
  if(revisionAtStart!==this.revision)return;
  if(!desired){
   if(automaticVideo&&this.connection?.identified){await this.syncVideo(offsetFor(this.config),revisionAtStart);return;}
   if(this.video.pending)await this.video.restore(this.connection);
   if(this.connection?.identified)this.publish({error:'',appliedVideoOffset:null,autoVideoSources:[],message:this.config.obs_enabled?(this.config.singing_enabled?'変換開始時に反映します。':'固定遅延を有効にしてください。'):'接続済み'});
   return;
  }
  if(!this.connection?.identified)return;
  if(this.config.mix_enabled){
   await this.restoreAudio();
   const music=this.state.inputs.find(x=>keyOf(x)===keyOf(selected));
   const voice=this.state.inputs.find(x=>this.config.mix_voice_uuid?x.inputUuid===this.config.mix_voice_uuid:this.config.mix_voice_name?x.inputName===this.config.mix_voice_name:x.inputName==='マイク');
   if(!music||!voice||keyOf(music)===keyOf(voice))throw Error('OBSで、元の伴奏ソースとCABLE Outputを取り込むMIX音声ソースを選んでください。');
   await this.mix.apply(this.connection,music,voice,()=>this.revision===revisionAtStart&&!this.closing);
   await this.syncVideo(offsetFor(this.config),revisionAtStart);
   this.publish({error:'',message:'完成したMIX音声を取り込みます。元の伴奏は配信・録画から外しています。',appliedOffset:null});return;
  }
  if(!selected.inputName&&!selected.inputUuid)throw Error('伴奏の音声ソースを選んでください。');
  const target=offsetFor(this.config),revision=this.revision;
  const input=this.state.inputs.find(input=>keyOf(input)===keyOf(selected));
  if(!input)throw Error('選択した伴奏の音声ソースが見つかりません。一覧を更新して選び直してください。');
  if(this.applied?.confirmed&&this.applied.connection===this.connection&&this.applied.target===target){await this.syncVideo(target,revision);return;}
  const current=await this.connection.request('GetInputAudioSyncOffset',identity(input));
  if(revision!==this.revision)return;
  const previous=this.applied;
  this.applied={...input,port:this.config.obs_port,original:previous?.original??current.inputAudioSyncOffset,target,connection:this.connection,confirmed:false};
  // Remember the attempted write before sending: a timeout may still have applied it.
  await this.connection.request('SetInputAudioSyncOffset',{...identity(input),inputAudioSyncOffset:target});
  this.applied.confirmed=true;
  this.publish({error:'',message:'同期オフセットを反映しました。',appliedOffset:target});
  await this.syncVideo(target,revision);
 }
 connect({port,password='',remember=true}){
  if(!Number.isInteger(port)||port<1||port>65535||typeof password!=='string'||password.length>1024||typeof remember!=='boolean')return Promise.reject(Error('OBSの接続設定が正しくありません。'));
  clearTimeout(this.retryTimer);this.blocked=false;
  const secret=password||this.sessionPassword||this.credentials.load();
  return this.enqueue(async()=>{
   if(this.connection?.identified)await this.restore();
   else if((this.applied&&this.applied.port!==port)||(this.video.record&&this.video.record.port!==port)||(this.mix.record&&this.mix.record.port!==port)||(this.desktopMute.record&&this.desktopMute.record.port!==port)||(this.previewSplit.record&&this.previewSplit.record.port!==port))throw Error('先に元のポートへ再接続して同期設定を戻してください。');
   this.connection?.close();this.connection=null;
   this.sessionPassword=secret;
   await this.open(port,secret);
   await this.restore();
   this.credentials.save(secret,remember);
   this.publish({});await this.sync();return this.status();
  });
 }
 refresh(){return this.enqueue(async()=>{await this.inputs();await this.sync();return this.status();});}
 disconnect(){
  clearTimeout(this.syncTimer);clearTimeout(this.retryTimer);this.blocked=true;
  return this.enqueue(async()=>{await this.restore();this.connection?.close();this.connection=null;this.publish({state:'disconnected',inputs:[],videoInputs:[],error:'',message:'',appliedOffset:null,appliedVideoOffset:null});return this.status();});
 }
 shutdown(){
  this.closing=true;clearTimeout(this.syncTimer);clearTimeout(this.retryTimer);
  return this.enqueue(async()=>{try{await this.restore();}finally{this.connection?.close();this.connection=null;}});
 }
}
module.exports={ObsLink,ObsSocket};
