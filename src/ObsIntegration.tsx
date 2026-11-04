import React,{useEffect,useRef,useState} from 'react';
import type {Config} from './main';
import ObsVideoSources,{type VideoSource} from './ObsVideoSources';
import Slider from './Slider';

export const obsDefaults={obs_enabled:false,obs_port:4455,obs_input_uuid:'',obs_input_name:'',obs_correction_ms:0,obs_delay_manual:false,obs_path_delay_ms:0,obs_path_signature:'',obs_video_enabled:false,obs_video_sources:[] as VideoSource[],obs_video_correction_ms:0};
export type ObsConfig=typeof obsDefaults;
type ObsStatus={state:string;videoInputs:{inputName:string;inputUuid:string}[];error:string;message:string;appliedOffset:number|null;appliedVideoOffset:number|null;autoVideoSources?:string[];hasPassword:boolean;canRemember:boolean};
const initial:ObsStatus={state:'disconnected',videoInputs:[],error:'',message:'',appliedOffset:null,appliedVideoOffset:null,hasPassword:false,canRemember:false};

export default function ObsIntegration({config,active,disabled,onUpdate,running=false}:{config:Config;active:boolean;disabled:boolean;running?:boolean;onUpdate:(patch:Partial<Config>)=>void}){
 const [status,setStatus]=useState(initial),[password,setPassword]=useState(''),[port,setPort]=useState(String(config.obs_port)),[remember,setRemember]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(false);
 const settings=useRef<HTMLDialogElement>(null);
 const [recovery,setRecovery]=useState(false);
 useEffect(()=>{if(editing&&!settings.current?.open)settings.current?.showModal();},[editing]);
 useEffect(()=>setPort(String(config.obs_port)),[config.obs_port]);
 useEffect(()=>{
  let cancelled=false,received=false;
  const unsubscribe=window.yvc.subscribe(event=>{if(event.type==='obs-status'){received=true;if(!cancelled)setStatus(event);}});
  window.yvc.invoke('obs-sync-info').then(value=>{if(!cancelled)setRecovery(value.recovery);}).catch(()=>{});
  window.yvc.invoke('obs-status').then(next=>{if(!cancelled&&!received)setStatus(next);}).catch(e=>{if(!cancelled)setError(String(e));});
  return()=>{cancelled=true;unsubscribe();};
 },[]);
 const connected=status.state==='connected',connecting=busy||status.state==='connecting';
 const videoInputs=status.videoInputs||[];
 const connect=async()=>{
  setError('');const value=Number(port);
  if(!/^\d+$/.test(port)||!Number.isInteger(value)||value<1||value>65535){const error='ポート番号は1〜65535で入力してください。';setError(error);return {ok:false,error};}
  setBusy(true);onUpdate({obs_port:value});
  try{setStatus(await window.yvc.invoke('obs-connect',{port:value,password,remember:remember&&status.canRemember}));setPassword('');setEditing(false);return {ok:true};}
  catch(e){const error=String(e);setError(error);return {ok:false,error};}finally{setBusy(false);}
 };
 const perform=async(action:string)=>{setBusy(true);setError('');try{setStatus(await window.yvc.invoke(action));}catch(e){setError(String(e));}finally{setBusy(false);}};
 const connectionForm=<div className="obs-connection">
   <div className="obs-connection-fields"><label title="このPCのOBSへ接続します。OBSの「ツール → WebSocketサーバー設定」にあるサーバーポートを入力してください。">ポート番号<input aria-label="OBSのポート番号" inputMode="numeric" value={port} disabled={active||connecting} onChange={e=>setPort(e.target.value)}/></label>
   <label title="OBSのWebSocketサーバー設定にあるパスワードです。認証なしの設定なら空欄にします。">パスワード<input type="password" aria-label="OBSのパスワード" autoComplete="off" placeholder={status.hasPassword?'保存済み':'OBSのパスワード'} value={password} disabled={connecting} onChange={e=>setPassword(e.target.value)}/></label>
   <button className="obs-button" disabled={connecting||disabled} onClick={connect}>接続する</button></div>
   {status.canRemember&&<label className="singing-toggle obs-remember" title="Windowsの暗号化機能でこのPCに保存します。設定JSONのエクスポートには含めません。"><input type="checkbox" checked={remember} disabled={connecting} onChange={e=>setRemember(e.target.checked)}/>パスワードを保存</label>}
  </div>;
 return <section className="card obs-integration" aria-label="OBS連携">
  <div className="section-title obs-heading"><h3>OBS連携</h3><span className="pill">{connecting?'接続中…':connected?'接続済み':'未接続'}</span><button className="obs-button" aria-label="OBS連携の設定" title="接続先・パスワード・一覧の更新" onClick={()=>setEditing(true)}>設定</button></div>
   {connected&&config.mix_enabled&&status.appliedVideoOffset!==null&&!!status.autoVideoSources?.length&&<p className="hint" role="status">{status.autoVideoSources.join('、')} の映像に {status.appliedVideoOffset} ms を自動反映</p>}
   {recovery&&connected&&<button className="obs-button" disabled={active||busy} onClick={async()=>{setBusy(true);try{await window.yvc.invoke('obs-sync-recover');setRecovery(false);}catch(e){setError(String(e));}finally{setBusy(false);}}}>以前のOBS測定設定を復元</button>}
   {config.mix_enabled&&<ObsVideoSources items={config.obs_video_sources} choices={videoInputs} enabled={config.obs_video_enabled} disabled={!connected||connecting||disabled} onEnabled={value=>onUpdate({obs_video_enabled:value})} onChange={(items,enabled)=>onUpdate({obs_video_sources:items,...(enabled!==undefined?{obs_video_enabled:enabled}:{})})}/>}
   {config.mix_enabled&&connected&&<Slider label="映像のずれ補正" help="OBS録画を見て、映像が音より早いときは＋、遅いときは−。同期対象の映像すべてに適用し、映像の遅延は0msまで減らせます。" value={config.obs_video_correction_ms} min={-1000} max={1000} unit="ms" disabled={connecting||disabled} onChange={value=>onUpdate({obs_video_correction_ms:value})}/>}
  {(error||status.error)&&<p className="hint danger" role="alert">{error||status.error}</p>}
  {editing&&<dialog ref={settings} className="latency-calibration obs-settings-dialog" aria-labelledby="obs-settings-title" onCancel={event=>{event.preventDefault();setEditing(false);}}>
   <div className="calibration-header"><h2 id="obs-settings-title">OBS連携の設定</h2><button aria-label="OBS連携の設定を閉じる" onClick={()=>setEditing(false)}>×</button></div>
   {connectionForm}
   {connected&&<div className="obs-connection-actions"><button className="obs-button" disabled={connecting} onClick={()=>perform('obs-refresh')}>一覧を更新</button><button className="obs-button" disabled={connecting||(config.mix_enabled&&running)} title="変換を停止してから切断してください。取り込み設定を元へ戻します。" onClick={()=>perform('obs-disconnect')}>切断する</button></div>}
   {(error||status.error)&&<p className="hint danger" role="alert">{error||status.error}</p>}
   <div className="calibration-actions"><button className="obs-button" onClick={()=>setEditing(false)}>閉じる</button></div>
  </dialog>}
 </section>;
}
