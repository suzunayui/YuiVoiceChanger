const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class ObsBroadcast{
 constructor(sync){this.sync=sync;this.ready=null;this.preparation=null;this.attempted=null;this.error='';}
 invalidate(){this.ready=null;this.attempted=null;}
 watch(){
  const s=this.sync,connection=s.obs.connection;if(!connection?.identified||this.watched===connection)return;
  this.watched=connection;
  try{connection.socket.send(JSON.stringify({op:3,d:{eventSubscriptions:66}}));}catch{return;}
  connection.socket.addEventListener('message',event=>{try{
   const message=JSON.parse(event.data);if(message.op!==5)return;
   const type=message.d?.eventType;
   if(['CurrentProfileChanged','CurrentSceneCollectionChanged','ExitStarted'].includes(type)||(type==='StreamStateChanged'&&message.d.eventData?.outputState==='OBS_WEBSOCKET_OUTPUT_STOPPED')){
    this.invalidate();if(s.liveSession&&s.busy)s.cancel();
    const timer=setTimeout(()=>{if(this.watched===s.obs.connection)void this.prepare();},1500);timer.unref?.();
   }
  }catch{}});
 }
 async settings(){
  const s=this.sync,get=async(category,name,fallback=null)=>((await s.rpc('GetProfileParameter',{parameterCategory:category,parameterName:name})).parameterValue??fallback);
  const profile=await s.profile(),mode=await get('Output','Mode'),category=mode==='Advanced'?'AdvOut':'SimpleOutput';
  if(!['Advanced','Simple'].includes(mode))throw Error('OBSの出力モードを確認できませんでした。');
  const values={profile,mode,quality:category==='SimpleOutput'?await get(category,'RecQuality'):await get(category,'RecType'),format:await get(category,'RecFormat2'),encoder:await get(category,'RecEncoder'),audio:await get(category,'RecAudioEncoder'),multitrack:await get('Stream1','EnableMultitrackVideo','false')};
  values.channels=await get('Audio','ChannelSetup','Stereo');
  if(values.channels!=='Stereo')throw Error('配信中の測定にはOBSの音声チャンネルをステレオにしてください。');
  if(values.multitrack==='true')throw Error('OBSのマルチトラック映像配信では測定用トラックを分離できません。');
  let mask=3;
  if(mode==='Advanced'){
   const track=Number(await get(category,'TrackIndex','1')),vod=Number(await get(category,'VodTrackIndex','2')),multi=Number(await get(category,'StreamMultiTrackAudioMixes','0'));
   if(!Number.isInteger(track)||track<1||track>6||!Number.isInteger(vod)||vod<1||vod>6||!Number.isInteger(multi)||multi<0||multi>63)throw Error('OBSの配信用音声トラックを確認できませんでした。');
   mask=(1<<(track-1))|(1<<(vod-1))|multi;Object.assign(values,{track,vod,multi});
  }
  const track=[6,5,4,3,2,1].find(track=>!(mask&(1<<(track-1))));
  if(!track)throw Error('OBSに測定専用の空き音声トラックがありません。');
  if(!/^(mkv|mp4|mov|hybrid_mp4|hybrid_mov|fragmented_mp4|fragmented_mov)$/.test(values.format||'')||(mode==='Simple'?!['Small','HQ'].includes(values.quality):values.quality!=='Standard'))throw Error('配信前にOBSの録画をMKV／MP4・高品質以上（詳細設定では標準）にしてください。');
  return {profile,category,track,signature:JSON.stringify(values)};
 }
 async ensure(){
  if(this.preparation)await this.preparation;
  const setup=await this.settings();
  if(!this.ready||this.ready.connection!==this.sync.obs.connection||this.ready.signature!==setup.signature||this.ready.track!==setup.track)throw Error('配信中測定の準備ができていません。配信を始める前にYuiVoiceChangerで声変換を開始し、OBSに接続してください。');
  return setup;
 }
 prepare(){
  const s=this.sync;
  this.watch();
  if(this.preparation||s.busy||s.isMonitoring?.()||!s.isRunning()||!s.obs.connection?.identified||fs.existsSync(s.journalFile)||this.attempted===s.obs.connection)return this.preparation||Promise.resolve(false);
  this.attempted=s.obs.connection;
  this.preparation=this.run().catch(error=>{this.error=error.message;if(!s.isRunning())this.attempted=null;return false;}).finally(()=>{this.preparation=null;});return this.preparation;
 }
 async run(){
  const s=this.sync;let success=false;
  await s.idleOutputs(false,{allowStream:false});const setup=await this.settings();
  const connection=s.obs.connection;s.cancelled=false;s.preparingBroadcast=true;s.obs.maintenance=true;clearTimeout(s.obs.syncTimer);clearTimeout(s.obs.retryTimer);
  const id=randomUUID(),folder=path.join(s.home,'obs-sync-recordings',id);fs.mkdirSync(folder,{recursive:true});
  s.journal={version:1,id,folder,profile:setup.profile,patches:[],recording:false,resetProfile:'YUI同期測定_復元_'+id,prepareOnly:true};s.writeJournal();
  try{
   await s.patchProfile(setup.category,'RecTracks',String(1<<(setup.track-1)));
   await s.patchProfile(setup.category,setup.category==='AdvOut'?'RecFilePath':'FilePath',folder);
   await s.patchProfile('Output','FilenameFormatting','YUI-Prepare-%CCYY-%MM-%DD-%hh-%mm-%ss');
   await s.patchProfile('Video','AutoRemux','false');
   await s.idleOutputs(false,{allowStream:false});s.journal.recording=true;s.writeJournal();
   await s.rpc('StartRecord');await s.waitRecord(true);await wait(500);s.check();await s.stopRecording();success=true;
  }finally{
   try{await s.cleanup();}finally{s.preparingBroadcast=false;s.obs.maintenance=false;await s.obs.flush();}
  }
  if(success&&connection===s.obs.connection){this.ready={...setup,connection};this.error='';return true;}return false;
 }
}
module.exports={ObsBroadcast};
