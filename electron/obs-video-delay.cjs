const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const sourceIdentity=input=>input.inputUuid?{sourceUuid:input.inputUuid}:{sourceName:input.inputName};
const isWindowCapture=input=>/^(window_capture(?:_v\d+)?|screen_capture|sck_capture|dshow_input|av_capture_input(?:_v\d+)?|syphon-input|spout_capture)$/.test(input.unversionedInputKind||input.inputKind||'');
const previewFilter='yui_preview_delay';
const delayFilter=kind=>kind==='gpu_delay'||kind===previewFilter;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const filterRequests=['GetSourceFilterList','CreateSourceFilter','RemoveSourceFilter','SetSourceFilterEnabled'];
function delayParts(target){
 if(!Number.isInteger(target)||target<0||target>4000)throw Error('映像の遅延は0〜4000msにしてください。負の補正で映像を早めることはできません。');
 const parts=[];for(let remaining=target;remaining>0;remaining-=500)parts.push(Math.min(500,remaining));return parts;
}
class ObsVideoDelay{
 constructor(home,{file=home?path.join(home,'obs-video-delay.json'):null}={}){
  this.file=file;this.record=null;this.connection=null;this.loadError='';
  if(this.file)try{
   const saved=JSON.parse(fs.readFileSync(this.file,'utf8'));
   const validName=name=>typeof name==='string'&&name.length<=512&&!/[\x00-\x1f\x7f]/.test(name);
   if(saved.version!==1||!Number.isInteger(saved.port)||saved.port<1||saved.port>65535||!saved.input||!validName(saved.input.inputName)||!validName(saved.input.inputUuid)||!(/^[a-f0-9-]{36}$/.test(saved.id))||!Array.isArray(saved.created)||saved.created.length>8||!Array.isArray(saved.disabled)||saved.disabled.length>128||saved.created.some(item=>!item.name?.startsWith(`YUI映像同期 ${saved.id} `)||!Number.isInteger(item.delay)||item.delay<1||item.delay>500||(item.kind!==undefined&&!delayFilter(item.kind)))||saved.disabled.some(item=>!validName(item.filterName)||!delayFilter(item.filterKind)||!item.filterSettings||typeof item.filterSettings!=='object'))throw Error('Invalid video delay recovery');
   delayParts(saved.target);this.record=saved;
  }catch(error){if(error.code!=='ENOENT')this.loadError='映像同期の復元情報を読み込めませんでした。obs-video-delay.jsonを確認してください。';}
 }
 get pending(){return Boolean(this.record||this.loadError);}
 write(){
  if(!this.file)return;
  if(!this.record){fs.rmSync(this.file,{force:true});return;}
  fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.record,null,2));fs.renameSync(tmp,this.file);
 }
 async list(connection,input){return (await connection.request('GetSourceFilterList',sourceIdentity(input))).filters;}
 async restore(connection){
  if(this.loadError)throw Error(this.loadError);
  const record=this.record;if(!record)return;
  if(!connection?.identified||connection.port!==record.port)throw Error('映像の遅延を戻すため、元のOBSへ再接続してください。');
  record.complete=false;this.connection=null;this.write();
  let filters;
  try{filters=await this.list(connection,record.input);}catch(error){if(error.code!==600)throw error;this.record=null;this.connection=null;this.write();return;}
  const id=sourceIdentity(record.input);
  for(const item of [...record.created].reverse()){
   const current=filters.find(filter=>filter.filterName===item.name);
   if(current?.filterKind===(item.kind||'gpu_delay')&&current.filterEnabled===true&&current.filterSettings?.delay_ms===item.delay){
    try{await connection.request('RemoveSourceFilter',{...id,filterName:item.name});}catch(error){if(error.code!==600)throw error;}
   }
   // Keep filters manually edited/renamed in OBS rather than undoing those edits.
   record.created=record.created.filter(filter=>filter.name!==item.name);this.write();
  }
  for(const item of [...record.disabled]){
   const current=filters.find(filter=>filter.filterName===item.filterName);
   if(current?.filterKind===item.filterKind&&current.filterEnabled===false&&equal(current.filterSettings,item.filterSettings)){
    try{await connection.request('SetSourceFilterEnabled',{...id,filterName:item.filterName,filterEnabled:true});}catch(error){if(error.code!==600)throw error;}
   }
   record.disabled=record.disabled.filter(filter=>filter.filterName!==item.filterName);this.write();
  }
  this.record=null;this.connection=null;this.write();
 }
 async apply(connection,input,target,current=()=>true){
  if(this.loadError)throw Error(this.loadError);
  const parts=delayParts(target);
  if(this.record?.complete&&this.connection===connection&&this.record.port===connection.port&&this.record.input.inputUuid===input.inputUuid&&this.record.input.inputName===input.inputName&&this.record.target===target)return true;
  await this.restore(connection);if(!current())return false;
  const settings=await connection.request('GetInputSettings',input.inputUuid?{inputUuid:input.inputUuid}:{inputName:input.inputName});
  if(!isWindowCapture(settings))throw Error('映像同期にはウィンドウキャプチャか映像キャプチャデバイスを選んでください。');
  const filters=await this.list(connection,input);if(!Array.isArray(filters))throw Error('映像フィルターの一覧を読み取れませんでした。');
  let filterKind='gpu_delay';
  if(parts.length&&connection.availableRequests?.includes('GetSourceFilterDefaultSettings')){
   try{
    await connection.request('GetSourceFilterDefaultSettings',{filterKind:previewFilter});
    filterKind=previewFilter;
   }catch(error){if(error.code!==607)throw error;}
  }
  if(!current())return false;
  this.record={version:1,id:randomUUID(),port:connection.port,input:{inputUuid:input.inputUuid||'',inputName:input.inputName},target,disabled:[],created:[],complete:false};this.write();
  const record=this.record,id=sourceIdentity(input);
  const check=()=>{if(!current())throw Object.assign(Error('映像同期の設定が変更されました。'),{stale:true});};
  try{
   for(const filter of filters.filter(item=>delayFilter(item.filterKind)&&item.filterEnabled)){
    check();record.disabled.push({filterName:filter.filterName,filterKind:filter.filterKind,filterSettings:filter.filterSettings});this.write();
    await connection.request('SetSourceFilterEnabled',{...id,filterName:filter.filterName,filterEnabled:false});
   }
   for(const [index,delay] of parts.entries()){
    check();const item={name:`YUI映像同期 ${record.id} ${index+1}`,delay,kind:filterKind};record.created.push(item);this.write();
    try{await connection.request('CreateSourceFilter',{...id,filterName:item.name,filterKind,filterSettings:{delay_ms:delay}});}
    catch(error){if(error.code===601){record.created.pop();this.write();}throw error;}
   }
   check();record.complete=true;this.connection=connection;this.write();return true;
  }catch(error){
   try{await this.restore(connection);}catch(restoreError){throw Error(`映像同期の設定を戻せませんでした。OBSへ再接続してください。${restoreError.message}`);}
   if(error.stale)return false;throw error;
  }
 }
}
module.exports={ObsVideoDelay,delayParts,isWindowCapture,filterRequests};
