import React,{useEffect,useState} from 'react';
import type {Config} from './main';
import ObsVideoSources,{type VideoSource} from './ObsVideoSources';
import Slider from './Slider';

export const obsDefaults={obs_enabled:false,obs_port:4455,obs_input_uuid:'',obs_input_name:'',obs_correction_ms:0,obs_delay_manual:false,obs_path_delay_ms:0,obs_path_signature:'',obs_video_enabled:false,obs_video_sources:[] as VideoSource[],obs_video_correction_ms:0};
export type ObsConfig=typeof obsDefaults;
type ObsStatus={state:string;videoInputs:{inputName:string;inputUuid:string}[];error:string;appliedVideoOffset:number|null;autoVideoSources?:string[]};
const initial:ObsStatus={state:'disconnected',videoInputs:[],error:'',appliedVideoOffset:null};

export default function ObsIntegration({config,disabled,onUpdate}:{config:Config;disabled:boolean;onUpdate:(patch:Partial<Config>)=>void}){
 const [status,setStatus]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let cancelled=false,received=false;
  const unsubscribe=window.yvc.subscribe(event=>{if(event.type==='obs-status'){received=true;if(!cancelled)setStatus(event);}});
  window.yvc.invoke('obs-status').then(next=>{if(!cancelled&&!received)setStatus(next);}).catch(e=>{if(!cancelled)setError(String(e));});
  return()=>{cancelled=true;unsubscribe();};
 },[]);
 const connected=status.state==='connected';
 const refresh=async()=>{setBusy(true);setError('');try{setStatus(await window.yvc.invoke('obs-refresh'));}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <section className="card obs-integration" aria-label="OBSプラグイン">
  <div className="section-title obs-heading">
   <h3>OBSプラグイン</h3>
   <span className="pill" title="環境設定からプラグインを導入し、OBSを再起動すると自動でつながります。">{connected?'接続済み':'OBSを待機中'}</span>
   <button className="obs-button" disabled={busy} onClick={refresh}>{busy?'確認中…':'一覧を更新'}</button>
  </div>
  {connected&&config.mix_enabled&&status.appliedVideoOffset!==null&&!!status.autoVideoSources?.length&&<p className="hint" role="status">{status.autoVideoSources.join('、')} の映像に {status.appliedVideoOffset} ms を自動反映</p>}
  {config.mix_enabled&&<ObsVideoSources items={config.obs_video_sources} choices={status.videoInputs} enabled={config.obs_video_enabled} disabled={!connected||busy||disabled} onEnabled={value=>onUpdate({obs_video_enabled:value})} onChange={(items,enabled)=>onUpdate({obs_video_sources:items,...(enabled!==undefined?{obs_video_enabled:enabled}:{})})}/>}
  {config.mix_enabled&&connected&&<Slider label="映像のずれ補正" help="OBS録画を見て、映像が音より早いときは＋、遅いときは−。同期対象の映像すべてに適用し、映像の遅延は0msまで減らせます。" value={config.obs_video_correction_ms} min={-1000} max={1000} unit="ms" disabled={busy||disabled} onChange={value=>onUpdate({obs_video_correction_ms:value})}/>}
  {(error||status.error)&&<p className="hint danger" role="alert">{error||status.error}</p>}
 </section>;
}
