const obsDefaults={obs_enabled:false,obs_port:4455,obs_input_uuid:'',obs_input_name:'',obs_correction_ms:0};
const obsKeys=Object.keys(obsDefaults);
const obsConnectionKeys=['obs_port','obs_input_uuid','obs_input_name'];
function offsetFor(config){
 const value=config.singing_latency_ms+config.obs_correction_ms;
 if(!Number.isInteger(value)||value< -950||value>20000)throw Error('OBSの同期オフセットは−950〜20000msにしてください。');
 return value;
}
module.exports={obsDefaults,obsKeys,obsConnectionKeys,offsetFor};
