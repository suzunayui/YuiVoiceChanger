import React,{useEffect,useRef,useState} from 'react';
import type {Config} from './main';
import Slider from './Slider';
import ObsSyncCalibration from './ObsSyncCalibration';

export const obsDefaults={obs_enabled:false,obs_port:4455,obs_input_uuid:'',obs_input_name:'',obs_correction_ms:0};
export type ObsConfig=typeof obsDefaults;
type ObsInput={inputName:string;inputUuid:string;offset:number};
type ObsStatus={state:string;inputs:ObsInput[];error:string;message:string;appliedOffset:number|null;hasPassword:boolean;canRemember:boolean};
const initial:ObsStatus={state:'disconnected',inputs:[],error:'',message:'',appliedOffset:null,hasPassword:false,canRemember:false};
const keyOf=(input:ObsInput)=>input.inputUuid?'uuid:'+input.inputUuid:'name:'+input.inputName;

export default function ObsIntegration({config,active,disabled,onUpdate,running=false,beepTarget,latencySettings}:{config:Config;active:boolean;disabled:boolean;running?:boolean;onUpdate:(patch:Partial<Config>)=>void;beepTarget:HTMLElement|null;latencySettings:React.ReactNode}){
 const [status,setStatus]=useState(initial),[password,setPassword]=useState(''),[port,setPort]=useState(String(config.obs_port)),[remember,setRemember]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[editing,setEditing]=useState(false);
 const settings=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(editing&&!settings.current?.open)settings.current?.showModal();},[editing]);
 useEffect(()=>setPort(String(config.obs_port)),[config.obs_port]);
 useEffect(()=>{
  let cancelled=false,received=false;
  const unsubscribe=window.yvc.subscribe(event=>{if(event.type==='obs-status'){received=true;if(!cancelled)setStatus(event);}});
  window.yvc.invoke('obs-status').then(next=>{if(!cancelled&&!received)setStatus(next);}).catch(e=>{if(!cancelled)setError(String(e));});
  return()=>{cancelled=true;unsubscribe();};
 },[]);
 const connected=status.state==='connected',connecting=busy||status.state==='connecting';
 const selected=config.obs_input_uuid?'uuid:'+config.obs_input_uuid:config.obs_input_name?'name:'+config.obs_input_name:'';
 const known=status.inputs.some(input=>keyOf(input)===selected);
 const target=config.singing_latency_ms+config.obs_correction_ms;
 const connect=async()=>{
  setError('');const value=Number(port);
  if(!/^\d+$/.test(port)||!Number.isInteger(value)||value<1||value>65535){const error='ポート番号は1〜65535で入力してください。';setError(error);return {ok:false,error};}
  setBusy(true);onUpdate({obs_port:value});
  try{setStatus(await window.yvc.invoke('obs-connect',{port:value,password,remember:remember&&status.canRemember}));setPassword('');setEditing(false);return {ok:true};}
  catch(e){const error=String(e);setError(error);return {ok:false,error};}finally{setBusy(false);}
 };
 const perform=async(action:string)=>{setBusy(true);setError('');try{setStatus(await window.yvc.invoke(action));if(action==='obs-disconnect')onUpdate({obs_enabled:false});}catch(e){setError(String(e));}finally{setBusy(false);}};
 const connectionForm=<div className="obs-connection">
   <div className="obs-connection-fields"><label title="このPCのOBSへ接続します。OBSの「ツール → WebSocketサーバー設定」にあるサーバーポートを入力してください。">ポート番号<input aria-label="OBSのポート番号" inputMode="numeric" value={port} disabled={active||connecting} onChange={e=>setPort(e.target.value)}/></label>
   <label title="OBSのWebSocketサーバー設定にあるパスワードです。認証なしの設定なら空欄にします。">パスワード<input type="password" aria-label="OBSのパスワード" autoComplete="off" placeholder={status.hasPassword?'保存済み':'OBSのパスワード'} value={password} disabled={connecting} onChange={e=>setPassword(e.target.value)}/></label>
   <button className="obs-button" disabled={connecting||disabled} onClick={connect}>接続する</button></div>
   {status.canRemember&&<label className="singing-toggle obs-remember" title="Windowsの暗号化機能でこのPCに保存します。設定JSONのエクスポートには含めません。"><input type="checkbox" checked={remember} disabled={connecting} onChange={e=>setRemember(e.target.checked)}/>パスワードを保存</label>}
  </div>;
 return <section className="card obs-integration" aria-label="OBS連携">
  <div className="section-title obs-heading"><h3>OBS連携</h3><span className="pill">{connecting?'接続中…':connected?'接続済み':'未接続'}</span><button className="obs-button" aria-label="OBS連携の設定" title="接続先・パスワード・一覧の更新・手動補正" onClick={()=>setEditing(true)}>設定</button></div>
   <div className="obs-source-heading"><label htmlFor="obs-music-source">伴奏の音声ソース</label></div>
   <select id="obs-music-source" disabled={!connected||active||connecting} title="OBSのミキサーで伴奏が入っている項目を選びます。デスクトップ音声に声も混ざる場合は、伴奏をアプリケーション音声キャプチャで分けてください。" value={selected} onChange={event=>{const input=status.inputs.find(input=>keyOf(input)===event.target.value);onUpdate({obs_input_uuid:input?.inputUuid||'',obs_input_name:input?.inputName||''});}}>
    <option value="">伴奏の音声ソースを選択</option>{selected&&!known&&<option value={selected}>{config.obs_input_name||'選択済みの音声ソース'}（未確認）</option>}{status.inputs.map(input=><option key={keyOf(input)} value={keyOf(input)}>{input.inputName}</option>)}
   </select>
   <div className="obs-sync-summary"><label className="singing-toggle obs-auto" title="伴奏へ固定遅延＋補正値を自動反映します。測定開始時にも自動で有効になります。停止時は元の値へ戻します。"><input aria-label="同期オフセットを自動設定" type="checkbox" checked={config.obs_enabled} disabled={disabled||connecting||(!config.obs_enabled&&(!connected||!known||!config.singing_enabled))} onChange={e=>onUpdate({obs_enabled:e.target.checked})}/>自動反映</label><output aria-label="設定する同期オフセット" title={`OBSへ反映する値：固定遅延 ${config.singing_latency_ms}ms ＋ 補正 ${config.obs_correction_ms}ms`}>{target>0?'+':''}{target}<small> ms</small></output></div>
  {(error||status.error)&&<p className="hint danger" role="alert">{error||status.error}</p>}
  <ObsSyncCalibration config={config} inputs={status.inputs} connected={connected} connectionPending={connecting} disabled={disabled} connect={connect} connectionForm={connectionForm} connectionError={error||status.error} launcherTarget={beepTarget}/>
  {editing&&<dialog ref={settings} className="latency-calibration obs-settings-dialog" aria-labelledby="obs-settings-title" onCancel={event=>{event.preventDefault();setEditing(false);}}>
   <div className="calibration-header"><h2 id="obs-settings-title">OBS連携の設定</h2><button aria-label="OBS連携の設定を閉じる" onClick={()=>setEditing(false)}>×</button></div>
   {connectionForm}
   {connected&&<div className="obs-connection-actions"><button className="obs-button" disabled={connecting} onClick={()=>perform('obs-refresh')}>一覧を更新</button><button className="obs-button" disabled={connecting} title="同期オフセットを元に戻して切断します。" onClick={()=>perform('obs-disconnect')}>切断する</button></div>}
   {(error||status.error)&&<p className="hint danger" role="alert">{error||status.error}</p>}
   <div className="obs-latency-settings"><span>固定遅延の目標</span>{latencySettings}</div>
   <Slider label="補正値" help="正の値で伴奏をさらに遅らせます。固定遅延と足した値をOBSへ設定します。ビープ測定でも自動設定できます。" value={config.obs_correction_ms} min={-1000} max={1000} unit="ms" disabled={disabled||connecting} onChange={value=>onUpdate({obs_correction_ms:value})}/>
   <div className="calibration-actions"><button className="obs-button" onClick={()=>setEditing(false)}>閉じる</button></div>
  </dialog>}
 </section>;
}
