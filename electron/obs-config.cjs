const obsDefaults={obs_enabled:false,obs_port:4455,obs_input_uuid:'',obs_input_name:'',obs_correction_ms:0,obs_delay_manual:false,obs_path_delay_ms:0,obs_path_signature:'',obs_video_enabled:false,obs_video_sources:[],obs_video_correction_ms:0};
const obsKeys=Object.keys(obsDefaults);
const obsConnectionKeys=['obs_port','obs_input_uuid','obs_input_name'];
function offsetFor(config){
 const value=config.mix_enabled?config.mix_latency_ms:config.singing_latency_ms+config.obs_correction_ms;
 if(!Number.isInteger(value)||value< -950||value>20000)throw Error('OBSの同期オフセットは−950〜20000msにしてください。');
 return value;
}
function normalizeVideoSources(value){
 if(!Array.isArray(value)||value.length>8)throw Error('同期する映像ソースは8個以内で指定してください。');
 const ids=new Set(),sources=new Set();
 return value.map((item,index)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))throw Error('映像ソースの設定が正しくありません。');
  const id=item.id??`source-${index+1}`,inputUuid=item.inputUuid??'',inputName=item.inputName??'',offset_ms=item.offset_ms??0;
  if(typeof id!=='string'||!(/^[a-zA-Z0-9_-]{1,64}$/.test(id))||ids.has(id))throw Error('映像ソースの識別子が正しくありません。');
  if([inputUuid,inputName].some(value=>typeof value!=='string'||value.length>512||/[\x00-\x1f\x7f]/.test(value)))throw Error('OBSの映像ソース名が正しくありません。');
  if(!Number.isInteger(offset_ms)||offset_ms< -1000||offset_ms>1000)throw Error('映像の補正は−1000〜1000msの整数で指定してください。');
  const key=inputUuid?'uuid:'+inputUuid:inputName?'name:'+inputName:'';
  if(key&&sources.has(key))throw Error('同じ映像ソースを複数指定することはできません。');
  ids.add(id);if(key)sources.add(key);return {id,inputUuid,inputName};
 });
}
module.exports={obsDefaults,obsKeys,obsConnectionKeys,offsetFor,normalizeVideoSources};
