import {useEffect,useState,type ReactNode} from 'react';
import type {Config} from './main';
import Slider from './Slider';
import errorText from './errorText';
export const mixDefaults={mix_enabled:false,mix_latency_ms:500,mix_device_id:'default',mix_device_name:'',mix_music_gain:-6,mix_voice_uuid:'',mix_voice_name:''};
export type MixConfig=typeof mixDefaults;
type Device={id:string;name:string;default:boolean};
const playbackHelp='自分には伴奏をそのまま再生し、配信には声と伴奏をまとめて送ります。変換音声の出力先には、CABLE Inputなど、伴奏の再生先とは別のデバイスを選んでください。';
const METER_FLOOR_DB=-60;
export default function StreamMix({config,active,disabled,running,metrics,onUpdate,children}:{config:Config;active:boolean;disabled:boolean;running:boolean;metrics:any;children:ReactNode;onUpdate:(patch:Partial<Config>)=>void}){
 const [devices,setDevices]=useState<Device[]>([]),[error,setError]=useState('');
 const [switching,setSwitching]=useState(false),[switchError,setSwitchError]=useState('');
 useEffect(()=>{
  if(!config.mix_enabled||!config.python)return;
  let cancelled=false;const unsubscribe=window.yvc.subscribe(e=>{if(e.type==='mix-devices'&&!cancelled)setDevices(e.devices);});
  window.yvc.invoke('mix-devices').catch(e=>{if(!cancelled)setError(errorText(e));});
  return()=>{cancelled=true;unsubscribe();};
 },[config.mix_enabled,config.python]);
 const currentDefault=devices.find(x=>x.default);
 const supportsMix=window.yvc.platform==='win32';
 const enabled=config.mix_enabled||config.singing_enabled;
 const toggle=async()=>{
  setSwitchError('');setSwitching(true);
  try{onUpdate(await window.yvc.invoke('set-singing-mode',!enabled));}
  catch(e){setSwitchError(errorText(e));}
  finally{setSwitching(false);}
 };
 return <section className="card stream-mix" aria-label="歌枠モード">
  <div className="section-title">
   <h3>歌枠モード</h3>
   <button type="button" className="obs-button" disabled={active||switching} title={enabled?'歌枠モードを終了します。変更は停止中に行います。':supportsMix?'声と伴奏を同期して配信へ送ります。変更は停止中に行います。':'声の出力タイミングを一定にします。変更は停止中に行います。'} onClick={toggle}>{enabled?'歌枠モードを解除':'歌枠用設定にする'}</button>
  </div>
  {enabled&&children}
  {config.mix_enabled&&<>
   <label className="mix-device-label" title={playbackHelp}>自分が聴く伴奏の再生先<select aria-label="伴奏の再生先" aria-describedby="mix-playback-help" value={config.mix_device_id} disabled={active} onChange={e=>{const choice=devices.find(x=>x.id===e.target.value);onUpdate({mix_device_id:e.target.value,mix_device_name:choice?.name||''});}}>
    <option value="default">既定{currentDefault?`（${currentDefault.name}）`:''}</option>
    {config.mix_device_id!=='default'&&!devices.some(x=>x.id===config.mix_device_id)&&<option value={config.mix_device_id}>{config.mix_device_name||'選択した再生先'}（未確認）</option>}
    {devices.map(x=><option key={x.id} value={x.id} disabled={x.name===config.output_name}>{x.name}</option>)}
   </select></label>
   <span id="mix-playback-help" hidden>{playbackHelp}</span>
   <Slider label="伴奏ゲイン" help="配信へ送る伴奏の音量です。自分が聴く音量は変えません。変換中も調整できます。" value={config.mix_music_gain} min={-24} max={6} unit="dB" signed disabled={disabled} onChange={value=>onUpdate({mix_music_gain:value})}/>
   {running&&<p className="hint" role="status">声と伴奏をアプリ内で同期してMIX中</p>}
   {running&&Number.isFinite(metrics.music_db)&&<div className="mix-music-level" title="伴奏ゲインをかける前の、再生先から取り込んだ音量です。">
    <span>取り込んだ伴奏</span>
    <div className="mix-music-meter" role="meter" aria-label="取り込んだ伴奏の音量" aria-valuemin={METER_FLOOR_DB} aria-valuemax={0} aria-valuenow={Math.round(Math.max(METER_FLOOR_DB,metrics.music_db))}><i style={{width:`${Math.min(100,Math.max(0,(metrics.music_db-METER_FLOOR_DB)/-METER_FLOOR_DB*100))}%`}}/></div>
    <strong>{metrics.music_db<=METER_FLOOR_DB?'— dB':`${Math.round(metrics.music_db)} dB`}</strong>
   </div>}
   {running&&metrics.music_low&&<p className="hint danger" role="status">取り込んだ伴奏が小さいです。カラオケアプリの音量か、Windowsの音量ミキサーのアプリ別音量を上げてください。</p>}
  </>}
  {!supportsMix&&<p className="hint">声と伴奏のミックスはWindowsで利用できます。</p>}
  {error&&<p className="hint danger" role="alert">{error}</p>}
  {switchError&&<p className="hint danger" role="alert">{switchError}</p>}
 </section>;
}
