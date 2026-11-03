import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';
import './presets.css';
import ModelTraining from './ModelTraining';
import ModelLibrary from './ModelLibrary';
import Help from './Help';
import Slider from './Slider';
import PresetCard from './PresetCard';
import SingingSettings,{effectDefaults,type EffectConfig} from './SingingSettings';
import {obsDefaults,type ObsConfig} from './ObsIntegration';
import {idleCalibration,type CalibrationStatus} from './LatencyCalibration';

export type Config=EffectConfig&ObsConfig&{singing_enabled:boolean;singing_latency_ms:number;engine_version:number;beatrice_model:string;beatrice_voice:number;beatrice_model_alias:string;beatrice_model_icon:string;beatrice_pitch:number;beatrice_formant:number;beatrice_block:number;schedule_ms:number;input_gain:number;gain:number;python:string;input:number;output:number;input_name:string;output_name:string;compute:string;training_source:string;training_audio:string;teacher_pitch:number;training_steps:number};
type Device={id:number;name:string;host:string;inputs:number;outputs:number};
type ComputeDevice={id:string;kind:string;name:string;available:boolean;reason?:string;memory_gb?:number};
type RecentModel={id:string;path:string;voice:number;label:string;alias:string;icon:string;available:boolean};
declare global{interface Window{yvc:{platform:string;invoke:(action:string,payload?:unknown)=>Promise<any>;subscribe:(callback:(event:any)=>void)=>()=>void}}}
const empty:Config={...effectDefaults,...obsDefaults,singing_enabled:false,singing_latency_ms:400,engine_version:2,beatrice_model:'',beatrice_voice:0,beatrice_model_alias:'',beatrice_model_icon:'',beatrice_pitch:14,beatrice_formant:0,beatrice_block:.08,schedule_ms:160,input_gain:12,gain:0,python:'',input:-1,output:-1,input_name:'',output_name:'',compute:'auto',training_source:'',training_audio:'',teacher_pitch:0,training_steps:10000};
const supported=['win32','darwin'].includes(window.yvc.platform);
const audioHost=window.yvc.platform==='darwin'?'Core Audio':'Windows WASAPI';
const basename=(value:string)=>value.split(/[\\/]/).pop()||'モデル未選択';
const samePath=(a:string,b:string)=>a.replace(/\\/g,'/').toLowerCase()===b.replace(/\\/g,'/').toLowerCase();

function App(){
 const [config,setConfig]=useState<Config>(empty),[tab,setTab]=useState('voice'),[state,setState]=useState('stopped');
 const [devices,setDevices]=useState<Device[]>([]),[metrics,setMetrics]=useState<any>({});
 const [calibration,setCalibration]=useState<CalibrationStatus>(idleCalibration);
 const [presetSwitching,setPresetSwitching]=useState(false);
 const [obsSyncBusy,setObsSyncBusy]=useState(false);
 const [modelHistory,setModelHistory]=useState<RecentModel[]>([]);
 const [selectedModelId,setSelectedModelId]=useState('');
 const [iconImages,setIconImages]=useState<Record<string,string>>({}),[changingIcon,setChangingIcon]=useState(false);
 const [library,setLibrary]=useState(false);
 const [actualDevice,setActualDevice]=useState('');
 const [job,setJob]=useState<any>({phase:'idle',busy:false}),[inspecting,setInspecting]=useState(false);
 const [message,setMessage]=useState(''),[error,setError]=useState('');
 const [loaded,setLoaded]=useState(false),[settingUp,setSettingUp]=useState(false),[setupMessage,setSetupMessage]=useState('');
 const [installingOfficial,setInstallingOfficial]=useState(false),[officialMessage,setOfficialMessage]=useState(''),[officialError,setOfficialError]=useState('');
 const [computeDevices,setComputeDevices]=useState<ComputeDevice[]>([]),[computeLoading,setComputeLoading]=useState(true),[computeWarning,setComputeWarning]=useState(''),[computeRefresh,setComputeRefresh]=useState(0);
 const converting=state!=='stopped'||presetSwitching;
 const active=converting||settingUp||job.busy||inspecting||installingOfficial||changingIcon||calibration.busy||presetSwitching||obsSyncBusy;
 const adjustmentsDisabled=settingUp||job.busy||inspecting||installingOfficial||changingIcon||calibration.busy||presetSwitching||obsSyncBusy||!['stopped','running'].includes(state);
 const iconIds=[...new Set([config.beatrice_model_icon,...(library?modelHistory:[]).map(item=>item.icon)].filter(Boolean))].sort().join(',');
 useEffect(()=>{setSelectedModelId('');},[config.beatrice_model,config.beatrice_voice]);
 useEffect(()=>{
  let cancelled=false;
  if(!iconIds){setIconImages({});return;}
  Promise.all(iconIds.split(',').map(async id=>[id,await window.yvc.invoke('model-icon',id)]))
   .then(entries=>{if(!cancelled)setIconImages(Object.fromEntries(entries));})
   .catch(e=>{if(!cancelled)setError(String(e));});
  return()=>{cancelled=true;};
 },[iconIds]);
 useEffect(()=>{if(loaded&&!presetSwitching&&!obsSyncBusy)window.yvc.invoke('save',config).catch(e=>setError(String(e)));},[config,loaded,presetSwitching,obsSyncBusy]);
 useEffect(()=>{
  if(!loaded||!devices.length)return;
  setConfig(prev=>{
   const next={...prev};
   for(const [key,name,channel] of [['input','input_name','inputs'],['output','output_name','outputs']] as const){
    const d=devices.find(x=>x[channel]>0&&x.host===audioHost&&(prev[name]?x.name===prev[name]:x.id===prev[key]));
    next[key]=d?d.id:-1;if(d)next[name]=d.name;
   }
   return next;
  });
 },[loaded,devices]);
 useEffect(()=>{
  const unsubscribe=window.yvc.subscribe(event=>{
   if(event.type==='setup')setSetupMessage(event.message);
   if(event.type==='official-model-progress')setOfficialMessage(event.message);
   if(event.type==='training')setJob(event);
   if(event.type==='latency-calibration'){setCalibration(event);if(event.config)setConfig(event.config);}
   if(event.type==='model-history')setModelHistory(event.models);
   if(event.type==='preset-switch')setPresetSwitching(event.busy);
   if(event.type==='obs-sync'){setObsSyncBusy(event.busy);if(event.config)setConfig(event.config);}
   if(event.type==='preset-config'){setConfig(event.config);setMetrics({});}
   if(event.type==='devices')setDevices(event.devices);
   if(event.type==='state'){
    setState(event.state);
    if(event.state==='running'){setActualDevice(event.device);setMetrics((p:any)=>({...p,budget_ms:event.budget_ms,schedule_ms:event.schedule_ms}));setMessage('');}
    else{if(event.state==='stopped')setActualDevice('');setMessage(event.state==='loading'?'変換エンジンを準備しています…':'');}
   }
   if(event.type==='loading')setMessage(event.message);
   if(event.type==='metrics')setMetrics(event);
   if(event.type==='error')setError(event.message);
  });
  window.yvc.invoke('config').then(c=>{
   setConfig(c);setLoaded(true);
   if(!c.python){setTab('setup');setMessage('変換環境をセットアップしてください。');}
   else if(!c.beatrice_model)setMessage('モデル一覧から声のモデルを選択してください。');
   return window.yvc.invoke('devices');
  }).catch(e=>setError(String(e)));
  window.yvc.invoke('training-status').then(setJob).catch(e=>setError(String(e)));
  window.yvc.invoke('latency-calibration-status').then(setCalibration).catch(e=>setError(String(e)));
  window.yvc.invoke('obs-sync-status').then(status=>setObsSyncBusy(status.busy)).catch(e=>setError(String(e)));
  window.yvc.invoke('model-history').then(setModelHistory).catch(e=>setError(String(e)));
  return unsubscribe;
 },[]);
 useEffect(()=>{
  if(!loaded)return;
  let cancelled=false;setComputeLoading(true);setComputeWarning('');
  window.yvc.invoke('compute-devices').then(result=>{
   if(!cancelled){setComputeDevices(result.devices);setComputeWarning(result.warning);}
  }).catch(()=>{if(!cancelled)setComputeWarning('一覧を取得できませんでした。再読み込みしてください。');})
   .finally(()=>{if(!cancelled)setComputeLoading(false);});
  return()=>{cancelled=true;};
 },[loaded,config.python,computeRefresh]);
 const update=(key:keyof Config,value:string|number)=>setConfig(prev=>({
  ...prev,[key]:value,...(key==='beatrice_model'&&value!==prev.beatrice_model?{beatrice_voice:0,beatrice_model_alias:'',beatrice_model_icon:''}:{})
 }));
 const invoke=async(action:string,payload?:unknown)=>{try{return await window.yvc.invoke(action,payload);}catch(e){setError(String(e));}};
 const pick=async(key:keyof Config)=>{
  const value=await invoke('pick',key);if(!value)return;
  if(key==='training_source'&&config.python){
   setInspecting(true);setError('');
   try{
    const info=await window.yvc.invoke('inspect-model',value);
    if(info.train_required){update('training_source',info.path);setTab('training');setMessage('RVCモデルを読み込みました。学習素材とGPUを確認してください。');}
    else setError('RVCの.pthまたは.onnxを選んでください。このモデルは直接使用できます。');
   }catch(e){setError(String(e));}finally{setInspecting(false);}
  }else update(key,value);
 };
 const changeModelIcon=async(clear=false)=>{
  setChangingIcon(true);setError('');
  try{
   const next=await window.yvc.invoke(clear?'clear-model-icon':'pick-model-icon',{path:config.beatrice_model,voice:config.beatrice_voice});
   if(next){setConfig(next);setMessage(clear?'アイコンを外しました。':'アイコンを設定しました。');}
  }catch(e){setError(String(e));}
  finally{setChangingIcon(false);}
 };
 const addLibraryModel=async()=>{
  const result=await window.yvc.invoke('add-library-model');if(!result)return null;
  if(result.training_source){setConfig(prev=>({...prev,training_source:result.training_source}));setTab('training');setLibrary(false);return null;}
  setModelHistory(result.models);return result.id||null;
 };
 const useLibraryModel=async(id:string)=>{
  const next=await window.yvc.invoke('select-model-history',id);setConfig(next);setSelectedModelId('');setTab('voice');setMessage('モデルを切り替えました。');
 };
 const saveLibraryModel=async(id:string,alias:string,icon:string)=>{
  const result=await window.yvc.invoke('edit-library-model',{id,alias,icon});setModelHistory(result.models);setConfig(result.config);setMessage('モデルの設定を保存しました。');
 };
 const removeLibraryModel=async(id:string)=>{
  const result=await window.yvc.invoke('remove-library-model',{id});setModelHistory(result.models);setConfig(result.config);if(selectedModelId===id)setSelectedModelId('');setMessage('一覧から外しました。モデルのファイルは残っています。');
 };
 const setup=async()=>{
  setSettingUp(true);setError('');setSetupMessage('準備を開始しています…');
  try{
   const c=await window.yvc.invoke('setup-runtime');setConfig(c);
   setSetupMessage('準備完了。');setMessage('');
  }catch(e){setError(String(e));setSetupMessage('準備できませんでした。エラー内容を確認して再試行してください。');}
  finally{setSettingUp(false);}
 };
 const installTsukuyomi=async()=>{
  setInstallingOfficial(true);setError('');setOfficialError('');setOfficialMessage('公式モデルの導入を開始しています…');
  try{
   const result=await window.yvc.invoke('install-tsukuyomi',{agreed:true});
   setConfig(result.config);setModelHistory(result.models);setOfficialMessage('つくよみちゃん（コーパス）を一覧に追加しました。');
   return result.id as string;
  }catch(e){
   const detail=String(e);
   if(/abort|cancel|中止/i.test(detail))setOfficialMessage('導入を中止しました。');
   else{setOfficialError(detail);setOfficialMessage('導入できませんでした。ネット接続を確認して再試行してください。');}
   return null;
  }finally{setInstallingOfficial(false);}
 };
 const toggle=async()=>{
  setError('');
  try{
   if(converting){setState('stopping');await window.yvc.invoke('stop');setMessage('停止しています…');}
   else{setState('loading');setMetrics({});await window.yvc.invoke('start',config);}
  }catch(e){setError(String(e));setState('stopped');}
 };
 const model=config.beatrice_model;
 const currentRecentModel=modelHistory.find(item=>samePath(item.path,model)&&item.voice===config.beatrice_voice);
 const selectedRecentModel=modelHistory.find(item=>item.id===selectedModelId)||currentRecentModel;
 const modelLabel=config.beatrice_model_alias||basename(model);
 const iconData=iconImages[config.beatrice_model_icon]||'';
 const options=(channel:'inputs'|'outputs')=>devices.filter(d=>d[channel]>0&&d.host===audioHost);
 const cpuDevice=computeDevices.find(device=>device.id==='cpu');
 const recommendedDevice=computeDevices.find(device=>device.id==='cuda:0'&&device.available)||cpuDevice;
 const selectedComputeDevice=config.compute==='auto'?recommendedDevice:computeDevices.find(device=>device.id===(config.compute==='cuda'?'cuda:0':config.compute));
 const scheduledDeviceName=selectedComputeDevice?`${selectedComputeDevice.kind} · ${selectedComputeDevice.name}${selectedComputeDevice.available?'':'（利用不可）'}`:
  computeLoading?'確認中…':config.compute.startsWith('cuda')?'選択したGPUが見つかりません':'実行先を確認できません';
 const actualDeviceName=actualDevice==='CPU'?(cpuDevice?`CPU · ${cpuDevice.name}`:'CPU'):
  /^(CPU|GPU) · /.test(actualDevice)?actualDevice:actualDevice?`GPU · ${actualDevice}`:scheduledDeviceName;
 const deviceName=(state==='running'||state==='stopping')&&actualDevice?actualDeviceName:scheduledDeviceName;
 return <div className="shell">
  <aside>
   <div className="brand">YUI VOICE CHANGER</div>
   <button title="マイク・出力先・声を調整して、リアルタイム変換を開始します。" className={tab==='voice'?'nav selected':'nav'} onClick={()=>setTab('voice')}><span>◉</span> 声を変える</button>
   <button title="歌配信用の固定遅延とボーカルエフェクトを設定します。" className={tab==='singing'?'nav selected':'nav'} onClick={()=>setTab('singing')}><span>♫</span> 歌枠用設定</button>
   <button title="変換環境のセットアップや、CPU・GPUの選択、アプリの設定を行います。" className={tab==='setup'?'nav selected':'nav'} onClick={()=>setTab('setup')}><span>⚙</span> 環境設定</button>
   <button className={'nav help-nav '+(tab==='help'?'selected':'')} title="使い方をアプリ内で表示します。" onClick={()=>setTab('help')}><span>▤</span> 使い方</button>
  </aside>
  <main>
   {tab!=='voice'&&<header><h1>{tab==='help'?'使い方':tab==='training'?'モデルを追加':tab==='singing'?'歌枠用設定':'環境設定'}</h1></header>}
   {error&&<div className="error" role="alert">{error}<button aria-label="エラーを閉じる" onClick={()=>setError('')}>×</button></div>}
   {!supported&&<div className="error">Windows x64またはApple Silicon Macを使用してください。</div>}
   {tab==='singing'&&<SingingSettings config={config} active={active} effectsDisabled={adjustmentsDisabled} running={state==='running'} metrics={metrics} calibration={calibration} onCalibration={setCalibration} onUpdate={patch=>setConfig(prev=>({...prev,...patch}))}/>}
   {tab==='help'?<Help/>:tab==='training'?<ModelTraining config={config} active={active} job={job} onPick={pick} onUpdate={update} onJob={setJob} onConfig={c=>{setConfig(c);setTab('voice');setMessage('学習モデルを選択しました。開始して試聴してください。');}} onError={setError}/>:tab==='voice'?<>
    <div className="voice-grid">
    <div className="voice-column">
     <section className="model-card">
      <div className="model-summary">
       <div className="model-avatar-wrap"><button className="model-avatar" aria-label={config.beatrice_model_icon?'モデルのアイコンを変更':'モデルのアイコンを設定'} title="ICO・PNG・JPG画像を選んで、このモデルのアイコンにします。" disabled={active||!model} onClick={()=>changeModelIcon()}>{iconData?<img src={iconData} alt=""/>:<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m4 18 5-5 4 3 4-5 4 6"/></svg>}</button>
       {config.beatrice_model_icon&&<button className="model-icon-clear" aria-label="モデルのアイコンを外す" title="このモデルのアイコンを外します。元の画像は削除しません。" disabled={active} onClick={()=>changeModelIcon(true)}>×</button>}</div>
       <div className="current-model"><span>現在使用中のモデル：</span><h2 title={model}>{modelLabel}</h2></div>
       <button title="モデルの追加・切り替え・編集・一覧からの削除を行います。" className="model-select-button" onClick={()=>setLibrary(true)}><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>モデル一覧</button>
      </div>
     </section>
    <section className="card route-card">
     <div className="section-title"><h3>音声のルート</h3><RefreshButton title="マイクなどを接続し直したときに、入出力デバイスを再検出します。" disabled={active} onClick={()=>invoke('devices')}>音声デバイス一覧を更新</RefreshButton></div>
     <div className="route">
      <label title="変換する声を取り込むマイクを選びます。"><span>マイク</span><select disabled={active} value={config.input} onChange={e=>{const id=Number(e.target.value);setConfig(p=>({...p,input:id,input_name:devices.find(d=>d.id===id)?.name||''}));}}><option value={-1}>入力を選択</option>{options('inputs').map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label title="変換した声を送る先です。VB-CABLEで配信・通話へ送る場合はCABLE Inputを選び、送信先アプリのマイクをCABLE Outputにします。"><span>変換音声の出力先</span><select disabled={active} value={config.output} onChange={e=>{const id=Number(e.target.value);setConfig(p=>({...p,output:id,output_name:devices.find(d=>d.id===id)?.name||''}));}}><option value={-1}>出力を選択</option>{options('outputs').map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
     </div>
    </section>
    <PresetCard config={config} disabled={settingUp||job.busy||inspecting||installingOfficial||changingIcon||calibration.busy||presetSwitching||obsSyncBusy||!['stopped','running'].includes(state)} saveDisabled={settingUp||job.busy||inspecting||installingOfficial||calibration.busy||presetSwitching||obsSyncBusy} onApply={next=>{setConfig(next);setMetrics({});setError('');}}/>
    </div>
    <div className="voice-column">
     <section className="signal-card" aria-label="音声モニター">
      <div className="signal-top"><span>入力レベル</span><span>{state==='running'?`${Math.round(20*Math.log10(Math.max(metrics.rms||0,1e-6)))} dB`:'— dB'}</span></div>
      <div className="wave">{Array.from({length:48},(_,i)=><i key={i} style={{height:state==='running'?`${Math.max(4,Math.min(100,(metrics.rms||0)*650)*(0.3+Math.abs(Math.sin(i*1.7))))}%`:`${8+Math.abs(Math.sin(i*.4))*18}%`}}/>)}</div>
      <div className="performance">
       <div title="マイク入力から選択した出力先までの遅延の概算です。実測値ではなく、配信・通話アプリ側の遅延は含みません。"><span>入力→出力の遅延（目安）</span><strong>{state==='running'&&Number.isFinite(metrics.latency_estimate_ms)?`約${Math.round(metrics.latency_estimate_ms)}`:'—'}<small> ms</small></strong></div>
       <div className="gpu-name" title={state==='running'||state==='stopping'?'変換に実際に使っているCPUまたはGPUです。':'現在の設定で使用する予定のCPUまたはGPUです。実際の使用先は変換開始後に確定します。'}><span>変換の実行先</span><strong>{deviceName}</strong></div>
      </div>
      {state==='running'&&metrics.clip>0&&<p className="monitor-warning" role="status">出力が上限を超えています。出力ゲインを下げてください。</p>}
      {state==='running'&&(metrics.late_blocks>0||metrics.dropped>0||metrics.device_errors>0)&&<p className="monitor-warning" role="status">音声の処理・入出力が追いつかなかった区間があります。他のGPU処理や音声デバイスの設定を確認してください。</p>}
     </section>
    <section className="card"><div className="section-title"><h3>声の調整</h3></div>
     <div className="voice-sliders">
      <Slider label="音の高さ（ピッチ）" help="声の音程を半音単位で変えます。プラスで高く、マイナスで低くなります。変換中も調整できます。" value={config.beatrice_pitch} min={-24} max={24} unit="半音" disabled={adjustmentsDisabled} onChange={v=>update('beatrice_pitch',v)}/>
      <Slider label="声の響き（フォルマント）" help="音程とは別に、声の響きや太さを調整します。まず0から少しずつ試してください。変換中も調整できます。" value={config.beatrice_formant} min={-2} max={2} step={.5} unit="半音" disabled={adjustmentsDisabled} onChange={v=>update('beatrice_formant',v)}/>
      <Slider label="入力ゲイン" help="変換する前のマイク音量を調整します。小さすぎる声は上げ、音割れする場合は下げます。変換中も調整できます。" value={config.input_gain} min={-12} max={18} unit="dB" disabled={adjustmentsDisabled} onChange={v=>update('input_gain',v)}/>
      <Slider label="出力ゲイン" help="変換した声の音量を調整します。出力の音割れが出る場合は下げてください。変換中も調整できます。" value={config.gain} min={-24} max={18} unit="dB" disabled={adjustmentsDisabled} onChange={v=>update('gain',v)}/>
     </div>
    </section>
    </div>
    </div>
   </>:tab==='singing'?null:<div className="settings-grid"><section className="card settings">
    <section className="runtime-setup" aria-label="変換環境">
     <div className="section-title"><h3>変換環境</h3><span className="pill">{config.python?'設定済み':'未設定'}</span></div>
     <div className="guide-actions"><button title="変換に必要な環境を自動で用意します。初回は数GBのダウンロードが必要な場合があります。このPCのPythonやPATHは変更しません。" disabled={active||!supported} onClick={setup}>{settingUp?'セットアップ中…':'必要な環境を自動セットアップ'}</button></div>
     {config.python&&<p className="runtime-path" title="使用している専用環境のPythonです。"><span>Python：</span><code>{config.python}</code></p>}
     {setupMessage&&<p className="hint" role="status">{setupMessage}</p>}
    </section>
    <fieldset className="compute-field" disabled={active}>
     <legend className="compute-heading"><span>変換の実行先</span><RefreshButton title="CPU・GPUを再検出して、現在の環境で利用できるか確認します。" disabled={active||computeLoading} onClick={()=>setComputeRefresh(value=>value+1)}>{computeLoading?'確認中…':'一覧を再読み込み'}</RefreshButton></legend>
     <div className="compute-list">
      <label title="GPUが使えればGPU、使えなければCPUを使用します。変更は次の変換開始時に反映されます。" className={'compute-option '+(config.compute==='auto'?'chosen':'')}><input type="radio" name="compute" value="auto" checked={config.compute==='auto'} onChange={()=>update('compute','auto')}/><span><strong>推奨（{computeLoading?'確認中…':recommendedDevice?`${recommendedDevice.kind} · ${recommendedDevice.name}`:'実行先を確認できません'}）</strong></span></label>
      {computeDevices.map(device=><label key={device.id} title={device.available?'このデバイスを指定して変換します。変更は次の変換開始時に反映されます。':device.reason} className={'compute-option '+(!device.available?'unavailable ': '')+((config.compute===device.id||(config.compute==='cuda'&&device.id==='cuda:0'))?'chosen':'')}>
       <input type="radio" name="compute" value={device.id} disabled={!device.available||computeLoading} checked={config.compute===device.id||(config.compute==='cuda'&&device.id==='cuda:0')} onChange={()=>update('compute',device.id)}/>
       <span><strong>{device.kind} · {device.name}</strong>{!device.available&&<small>{device.reason}</small>}</span>
      </label>)}
      {!computeLoading&&!computeDevices.some(device=>device.kind==='GPU')&&<p className="hint">GPUは検出されませんでした。CPUで変換できます。</p>}
      {!computeLoading&&config.compute.startsWith('cuda')&&!computeDevices.some(device=>device.id===config.compute||(config.compute==='cuda'&&device.id==='cuda:0'))&&<p className="hint danger">選択していたGPUが見つかりません。実行先を選び直してください。</p>}
     </div>
     {computeWarning&&<p role="status" className="hint danger">{computeWarning}</p>}
    </fieldset>
   </section>
   <section className="card settings-transfer" aria-label="設定の保存・読み込み">
    <h3>設定の保存・読み込み</h3>
    <div className="guide-actions settings-actions">
     <button title="保存した設定JSONを読み込みます。別のPCではモデルなどの保存先を選び直してください。" disabled={active} onClick={async()=>{try{const c=await window.yvc.invoke('import-settings');if(c){setConfig(c);setDevices(d=>[...d]);setMessage('設定を読み込みました。');setError('');}}catch(e){setError(String(e));}}}>設定をインポート</button>
     <button title="現在の設定をJSONファイルに保存します。モデル本体は含みません。" disabled={active} onClick={async()=>{try{await window.yvc.invoke('save',config);const file=await window.yvc.invoke('export-settings');if(file)setMessage('設定を書き出しました。');}catch(e){setError(String(e));}}}>設定をエクスポート</button>
    </div>
   </section></div>}
   <footer><div className="footer-message">{inspecting?'モデルの形式を確認しています…':message}</div><div className="footer-actions"><div className={'status '+(state==='running'?'live':'')}><i/>{state==='running'?'変換中':state==='stopped'?'待機中':state==='stopping'?'停止中':'準備中'}</div><button title={converting?'マイクからの変換を停止します。':!config.python?'環境設定で変換環境をセットアップしてください。':!model?'モデル一覧から声のモデルを選択してください。':config.input<0||config.output<0?'マイクと出力先を選択してください。':'選択したマイクの声を変換し、指定した出力先へ送ります。'} className={'primary '+(converting?'stop':'')} onClick={toggle} disabled={!supported||settingUp||installingOfficial||changingIcon||job.busy||calibration.busy||inspecting||(!converting&&obsSyncBusy)||(state==='stopping'&&!presetSwitching)||(!converting&&(!config.python||!model||config.input<0||config.output<0))}>{state==='stopping'&&!presetSwitching?'停止中…':converting?'■ 停止する':'▶  声変換をはじめる'}</button></div></footer>
  </main>
  {library&&<ModelLibrary items={modelHistory} icons={iconImages} currentId={currentRecentModel?.id} selectedId={selectedRecentModel?.id} onSelect={setSelectedModelId} disabled={active} onClose={()=>setLibrary(false)} onTrain={()=>{setTab('training');setLibrary(false);}} onAdd={addLibraryModel} onUse={useLibraryModel} onSave={saveLibraryModel} onRemove={removeLibraryModel} onPickIcon={id=>window.yvc.invoke('pick-library-icon',{id})} official={{installing:installingOfficial,message:officialMessage,error:officialError,supported,onInstall:installTsukuyomi,onCancel:async()=>{setOfficialMessage('導入を中止しています…');await window.yvc.invoke('cancel-official-model');},onTerms:()=>window.yvc.invoke('open-resource','tsukuyomi_terms')}}/>}
 </div>;
}
function RefreshButton({children,title,disabled,onClick}:{children:React.ReactNode;title:string;disabled:boolean;onClick:()=>void}){
 return <button type="button" title={title} className="device-refresh-button" disabled={disabled} onClick={onClick}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6.1A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.9 5.9"/></svg>{children}</button>;
}
createRoot(document.getElementById('root')!).render(<App/>);
