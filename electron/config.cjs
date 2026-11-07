const {effectDefaults,effectRanges}=require('./singing-config.cjs');
const {obsDefaults,obsKeys,normalizeVideoSources}=require('./obs-config.cjs');
const {mixDefaults}=require('./mix-config.cjs');
const defaults = () => ({
 engine_version:2, beatrice_model:'', beatrice_voice:0, beatrice_model_alias:'', beatrice_model_icon:'', beatrice_pitch:14, beatrice_formant:0,
 beatrice_block:.08, schedule_ms:160, input_gain:12, gain:0, python:'',
 input:-1, output:-1, input_name:'', output_name:'', singing_enabled:false,singing_latency_ms:400,singing_block_ms:80,...effectDefaults,...obsDefaults,...mixDefaults
 ,compute:'auto',training_source:'',training_audio:'',teacher_pitch:0,training_steps:10000,hotkeys_enabled:false
});
function normalize(value, {importing=false}={}) {
 if (!value || typeof value!=='object' || Array.isArray(value)) throw Error('設定ファイルの形式が正しくありません。');
 const base=defaults(), clean={};
 const videoSources=normalizeVideoSources(Object.hasOwn(value,'obs_video_sources')?value.obs_video_sources:(value.obs_video_uuid||value.obs_video_name)?[{inputUuid:value.obs_video_uuid,inputName:value.obs_video_name,offset_ms:0}]:[]);
 const legacy=value.engine_version!==2 && ('beatrice_vst' in value || 'beatrice_libs' in value || /\.toml$/i.test(value.beatrice_model||''));
 const ranges={beatrice_voice:[0,65535],beatrice_pitch:[-24,24],beatrice_formant:[-2,2],input_gain:[-12,18],gain:[-24,legacy?30:18],input:[-1,65535],output:[-1,65535],teacher_pitch:[-24,24],training_steps:[1,100000],obs_video_correction_ms:[-1000,1000]};
 for (const key of Object.keys(base)) if (Object.hasOwn(value,key)) {
  const v=value[key];
  if(key==='obs_video_sources'){clean[key]=videoSources;continue;}
  if (typeof v!==typeof base[key] || (typeof v==='number'&&!Number.isFinite(v))) throw Error(`設定値が正しくありません: ${key}`);
  const range=ranges[key]||effectRanges[key]||(key==='mix_latency_ms'?[200,3000]:key==='mix_music_gain'?[-24,6]:key==='singing_latency_ms'?[200,2000]:key==='singing_block_ms'?[80,400]:key==='obs_port'?[1,65535]:['obs_correction_ms','obs_path_delay_ms'].includes(key)?[-1000,1000]:null);
  if (range && (v<range[0]||v>range[1])) throw Error(`設定値が範囲外です: ${key}`);
  if ((key in effectRanges||['singing_latency_ms','obs_port','obs_correction_ms','obs_path_delay_ms','obs_video_correction_ms'].includes(key))&&!Number.isInteger(v)) throw Error(`設定値は整数で入力してください: ${key}`);
  if (['obs_input_uuid','obs_input_name','obs_video_uuid','obs_video_name'].includes(key)&&(v.length>512||/[\x00-\x1f\x7f]/.test(v)))throw Error('OBSのソース名が正しくありません。');
  if (['input','output'].includes(key)&&!Number.isInteger(v)) throw Error(`デバイス番号が正しくありません: ${key}`);
  if (key==='engine_version'&&v!==2) throw Error('未対応の設定バージョンです。');
  if (key==='compute'&&!/^(auto|cpu|cuda(?::(?:0|[1-9]\d{0,4}))?)$/.test(v))throw Error('実行先の設定が不正です。');
  if (key==='training_steps'&&!Number.isInteger(v))throw Error('学習回数は整数です。');
  if (key==='beatrice_voice'&&!Number.isInteger(v))throw Error('声の番号は整数です。');
  if (key==='beatrice_model_alias'&&(v.length>80||/[\x00-\x1f\x7f]/.test(v)))throw Error('別名は改行なしの80文字以内で入力してください。');
  if (key==='beatrice_model_icon'&&v!==''&&!/^[a-f0-9]{64}$/.test(v))throw Error('アイコンの指定が不正です。');
  if (key==='beatrice_formant'&&v*2!==Math.round(v*2)) throw Error('フォルマントは0.5半音刻みです。');
  if (!legacy&&key==='beatrice_block'&&v!==.08) throw Error('更新間隔は80msです。');
  if (key==='schedule_ms'&&v!==160) throw Error('出力の待ち時間は160msです。');
  if (key==='singing_block_ms'&&(!Number.isInteger(v)||v%80)) throw Error('変換の間隔は80〜400msの80ms刻みで指定してください。');
  if(key==='obs_path_signature'&&v.length>8192)throw Error('遅延の測定情報が正しくありません。');
  if(key.startsWith('mix_')&&typeof v==='string'&&(v.length>512||/[\x00-\x1f\x7f]/.test(v)))throw Error('MIXの音声デバイス・ソース名が正しくありません。');
  if(['mix_latency_ms','mix_music_gain'].includes(key)&&!Number.isInteger(v))throw Error('MIXの待ち時間・ゲインは整数で指定してください。');
  clean[key]=v;
 }
 if(importing&&!Object.keys(clean).length) throw Error('YuiVoiceChangerの設定が見つかりません。');
 if(importing){clean.obs_path_signature='';clean.obs_path_delay_ms=0;}
 if(legacy) Object.assign(clean,{beatrice_model:'',python:'',beatrice_block:.08,schedule_ms:160,input_gain:12,gain:0});
 const result={...base,...clean,obs_video_sources:videoSources};if(result.mix_enabled)result.singing_enabled=true;return result;
}
const controlKeys=['beatrice_pitch','beatrice_formant','input_gain','gain'];
function liveControls(current,next,state){
 const changed=Object.keys(next).filter(key=>next[key]!==current[key]&&!obsKeys.includes(key)&&!['beatrice_model_alias','beatrice_model_icon','hotkeys_enabled'].includes(key));
 if(state==='stopped'||!changed.length)return null;
 if(state!=='running'||changed.some(key=>!controlKeys.includes(key)&&!(key in effectDefaults)&&key!=='mix_music_gain'))throw Error('モデル・音声デバイス・実行先・固定遅延を変更する前に変換を停止してください。');
 return Object.fromEntries(controlKeys.map(key=>[key,next[key]]));
}
module.exports={defaults,normalize,liveControls};
