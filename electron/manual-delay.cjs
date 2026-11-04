// Changing the displayed total must change voice timing as well as OBS timing.
function latencySignature(config){
 return JSON.stringify([config.beatrice_model||'',config.beatrice_voice||0,config.compute||'auto',
  config.input_name||(config.input??-1),config.output_name||(config.output??-1),
  config.obs_port??4455,config.obs_input_uuid||config.obs_input_name||'']);
}
function calibrationStartConfig(config){
 if(!config.obs_delay_manual)return config;
 const correction=config.obs_path_signature===latencySignature(config)?config.obs_path_delay_ms:0;
 const base=Math.max(200,Math.min(2000,config.singing_latency_ms+config.obs_correction_ms-correction));
 // Calibration must be able to start even when a manual target is too short.
 return {...config,singing_latency_ms:base,obs_correction_ms:correction,obs_delay_manual:false};
}
// Manual adjustments preserve the total; legacy migration drops unverified data.
function adoptManualTiming(config, timing){
 if(!config.singing_enabled||!timing)return null;
 const legacy=timing.legacy_timing===true;
 if(legacy?config.obs_delay_manual:!config.obs_delay_manual)return null;
 const {previous_base_ms,previous_correction_ms,singing_latency_ms,obs_correction_ms}=timing;
 if(previous_base_ms!==config.singing_latency_ms||previous_correction_ms!==config.obs_correction_ms)return null;
 if(!Number.isInteger(singing_latency_ms)||singing_latency_ms<200||singing_latency_ms>2000||!Number.isInteger(obs_correction_ms)||Math.abs(obs_correction_ms)>1000)return null;
 if(legacy){
  const expected=config.obs_path_signature===latencySignature(config)?config.obs_path_delay_ms:0;
  if(obs_correction_ms!==expected||singing_latency_ms<config.singing_latency_ms)return null;
 }else if(singing_latency_ms+obs_correction_ms!==config.singing_latency_ms+config.obs_correction_ms)return null;
 return {...config,singing_latency_ms,obs_correction_ms,obs_delay_manual:true};
}
module.exports={adoptManualTiming,latencySignature,calibrationStartConfig};
