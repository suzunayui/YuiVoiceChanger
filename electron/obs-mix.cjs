// Reversible OBS routing for a completed stereo program mix.
const fs=require('node:fs'),path=require('node:path');
const identity=x=>x.inputUuid?{inputUuid:x.inputUuid}:{inputName:x.inputName};
const {isDeepStrictEqual:equal}=require('node:util');
class ObsMix{
 constructor(home,journal='obs-mix-routing.json'){this.file=home?path.join(home,journal):null;this.record=null;this.applied=null;
  if(this.file)try{this.record=JSON.parse(fs.readFileSync(this.file,'utf8'));if(this.record.version!==1||!Array.isArray(this.record.patches)||!Number.isInteger(this.record.port))throw Error('bad journal');}catch(e){if(e.code!=='ENOENT'){this.error=`OBSの復元情報を読み込めません。${journal}を確認してください。`;}}
 }
 get pending(){return !!this.record||!!this.error;}
 write(){if(!this.file)return;fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.record,null,2));fs.renameSync(temp,this.file);}
 async restore(connection){
  if(this.error)throw Error(this.error);
  if(!this.record)return;
  if(!connection?.identified||connection.port!==this.record.port)throw Error('MIXの取り込み設定を戻すため、元のOBSへ再接続してください。');
  while(this.record.patches.length){
   const patch=this.record.patches.at(-1);
   try{const current=await connection.request(patch.get,identity(patch.input));
    if(equal(current[patch.field],patch.value))await connection.request(patch.set,{...identity(patch.input),[patch.field]:patch.old});
   }catch(e){if(![600,602].includes(e.code))throw e;}
   this.record.patches.pop();this.write();
  }
  this.record=null;this.applied=null;if(this.file)fs.rmSync(this.file,{force:true});
 }
 async muteDesktops(connection,desktop){
  await this.restore(connection);
  this.record={version:1,port:connection.port,patches:[]};
  try{
   for(const {input} of desktop){
    if((await connection.request('GetInputMute',input)).inputMuted)continue;
    this.record.patches.push({input,get:'GetInputMute',set:'SetInputMute',field:'inputMuted',old:false,value:true});
    this.write();
    await connection.request('SetInputMute',{...input,inputMuted:true});
   }
  }catch(error){await this.restore(connection);throw error;}
 }
 async apply(connection,music,voice,current=()=>true){
  const key=JSON.stringify([connection.port,identity(music),identity(voice)]);
  if(this.applied?.connection===connection&&this.applied.key===key)return;
  if(this.record?.key===key&&!this.error){
   const checks=await Promise.all(this.record.patches.map(async patch=>equal((await connection.request(patch.get,identity(patch.input)))[patch.field],patch.value)));
   if(checks.every(Boolean)){this.applied={connection,key};return;}
  }
  if(this.pending)await this.restore(connection);
  const rpc=(type,input)=>connection.request(type,identity(input));
  const musicTracks=(await rpc('GetInputAudioTracks',music)).inputAudioTracks;
  const voiceTracks=(await rpc('GetInputAudioTracks',voice)).inputAudioTracks;
  const offset=(await rpc('GetInputAudioSyncOffset',voice)).inputAudioSyncOffset;
  const monitor=(await rpc('GetInputAudioMonitorType',voice)).monitorType;
  const muted=(await rpc('GetInputMute',voice)).inputMuted;
  if(!musicTracks||!voiceTracks||typeof offset!=='number'||typeof monitor!=='string'||typeof muted!=='boolean')throw Error('OBSのMIX取り込み設定を確認できません。');
  if(!current())return;
  this.record={version:1,port:connection.port,key,patches:[]};this.write();
  const patch=async(input,get,set,field,old,value)=>{
   if(equal(old,value))return;
   if(!current())throw Error('MIXの設定が変わりました。');
   this.record.patches.push({input:identity(input),get,set,field,old,value});this.write();
   await connection.request(set,{...identity(input),[field]:value});
  };
  try{
   const none=Object.fromEntries([1,2,3,4,5,6].map(x=>[String(x),false]));
   // Silence the separate accompaniment before enabling the completed mix.
   await patch(music,'GetInputAudioTracks','SetInputAudioTracks','inputAudioTracks',musicTracks,none);
   await patch(voice,'GetInputAudioSyncOffset','SetInputAudioSyncOffset','inputAudioSyncOffset',offset,0);
   await patch(voice,'GetInputAudioMonitorType','SetInputAudioMonitorType','monitorType',monitor,'OBS_MONITORING_TYPE_NONE');
   await patch(voice,'GetInputMute','SetInputMute','inputMuted',muted,false);
   const tracks=Object.fromEntries(Object.keys(none).map(track=>[track,!!(voiceTracks[track]||musicTracks[track])]));
   if(!Object.values(tracks).some(Boolean))tracks['1']=true;
   await patch(voice,'GetInputAudioTracks','SetInputAudioTracks','inputAudioTracks',voiceTracks,tracks);
   this.applied={connection,key};
  }catch(e){await this.restore(connection).catch(()=>{});throw e;}
 }
}
module.exports={ObsMix};
