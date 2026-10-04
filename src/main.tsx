import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './style.css';

type Config={beatrice_model:string;beatrice_vst:string;beatrice_pitch:number;beatrice_block:number;beatrice_noise_filter:boolean;beatrice_gate:number;beatrice_clarity:boolean;python:string;input:number;output:number;input_name:string;output_name:string;gain:number};
type Device={id:number;name:string;host:string;inputs:number;outputs:number};
declare global{interface Window{yvc:{invoke:(action:string,payload?:unknown)=>Promise<any>;subscribe:(callback:(event:any)=>void)=>()=>void}}}
const empty:Config={beatrice_model:'',beatrice_vst:'',beatrice_pitch:12,beatrice_block:.04,beatrice_noise_filter:true,beatrice_gate:-50,beatrice_clarity:false,python:'',input:-1,output:-1,input_name:'',output_name:'',gain:0};
const basename=(value:string)=>value.split(/[\\/]/).pop()||'モデル未選択';
function App(){
 const [config,setConfig]=useState<Config>(empty),[tab,setTab]=useState('voice'),[state,setState]=useState('stopped');
 const [devices,setDevices]=useState<Device[]>([]),[metrics,setMetrics]=useState<any>({});
 const [message,setMessage]=useState('モデルと入出力先を選んで、はじめましょう。'),[error,setError]=useState('');
 const [loaded,setLoaded]=useState(false);
 useEffect(()=>{if(loaded)window.yvc.invoke('save',config).catch(e=>setError(String(e)));},[config,loaded]);
 useEffect(()=>{if(!loaded||!devices.length)return;setConfig(prev=>{
  const next={...prev};for(const [key,name,channel] of [['input','input_name','inputs'],['output','output_name','outputs']] as const){
   const d=devices.find(x=>x[channel]>0&&x.host==='Windows WASAPI'&&(prev[name]?x.name===prev[name]:x.id===prev[key]));next[key]=d?d.id:-1;if(d)next[name]=d.name;
  }return next;
 });},[loaded,devices]);
 const active=state==='running'||state==='loading';
 const update=(key:keyof Config,value:string|number|boolean)=>setConfig(prev=>({...prev,[key]:value}));
 const invoke=async(action:string,payload?:unknown)=>{try{return await window.yvc.invoke(action,payload)}catch(e){setError(String(e));}};
 useEffect(()=>{
  window.yvc.invoke('config').then(c=>{setConfig(c);setLoaded(true);}).catch(e=>setError(String(e)));
  const unsubscribe=window.yvc.subscribe(event=>{
   if(event.type==='devices')setDevices(event.devices);
   if(event.type==='state'){setState(event.state);setMessage(event.state==='running'?'音声をリアルタイムで変換しています。':event.state==='loading'?'変換エンジンを準備しています…':'変換を停止しました。');}
   if(event.type==='loading')setMessage(event.message);
   if(event.type==='metrics')setMetrics(event);
   if(event.type==='error')setError(event.message);
  });
  window.yvc.invoke('devices').catch(e=>setError(String(e)));
  return unsubscribe;
 },[]);
 const model=config.beatrice_model;
 const budget=Math.round(config.beatrice_block*1000);
 const pick=async(key:keyof Config)=>{const value=await invoke('pick',key);if(value)update(key,value);};
 const toggle=async()=>{setError('');try{if(active){await window.yvc.invoke('stop');setMessage('停止しています…');}else{setState('loading');await window.yvc.invoke('start',config);}}catch(e){setError(String(e));setState('stopped');}};
 return <div className="shell">
  <aside><div className="brand"><img className="app-icon" src="./icon.png" alt=""/><div>YUI<span>VOICE CHANGER</span></div></div>
   <div className="nav-label">WORKSPACE</div>
   <button className={tab==='voice'?'nav selected':'nav'} onClick={()=>setTab('voice')}><span>◉</span> 声を変える</button>
   <button className={tab==='setup'?'nav selected':'nav'} onClick={()=>setTab('setup')}><span>⚙</span> 環境設定</button>
   <div className="sidebar-bottom"><div className="local-dot"/> LOCAL FIRST<p>あなたの声は、このPCの中で。</p><small>独立エンジン · v0.2</small></div>
  </aside>
  <main><header><div><div className="eyebrow">YOUR VOICE, YOUR WAY</div><h1>{tab==='voice'?'声に、もうひとつの表情を。':'変換の準備を、ここから。'}</h1></div><div className={'status '+(state==='running'?'live':'')}><i/>{state==='running'?'変換中':state==='loading'?'準備中':'待機中'}</div></header>
  {error&&<div className="error" role="alert">{error}<button onClick={()=>setError('')}>×</button></div>}
  {tab==='voice'?<>

   <div className="top-grid"><section className="model-card"><div className="eyebrow">VOICE MODEL</div><div className="model-body"><div className="model-icon">声</div><div><h2>{basename(model).replace(/\.(pth|onnx|toml)$/,'')}</h2><p>Beatrice 2 · CPUで変換</p></div></div><button className="link-button" disabled={active} onClick={()=>pick('beatrice_model')}>モデルを選び直す <span>↗</span></button></section>
   <section className="signal-card"><div className="signal-top"><span className="eyebrow">LIVE SIGNAL</span><span>{metrics.silent?'無音待機':state==='running'?'INPUT':'READY'}</span></div><div className="wave">{Array.from({length:48},(_,i)=><i key={i} style={{height:state==='running'?`${Math.max(4,Math.min(100,(metrics.rms||0)*650)*(0.3+Math.abs(Math.sin(i*1.7))))}%`:`${8+Math.abs(Math.sin(i*.4))*18}%`}}/>)}</div><div className="signal-bottom"><span>入力レベル</span><span>{state==='running'?`${Math.round(20*Math.log10(Math.max(metrics.rms||0,1e-6)))} dB`:'— dB'}</span></div></section></div>
   <section className="card"><div className="section-title"><h3>音声のルート</h3><button className="text-button" disabled={active} onClick={()=>invoke('devices')}>デバイスを更新 ↻</button></div><div className="route"><label><span>INPUT / マイク</span><select disabled={active} value={config.input} onChange={e=>{const id=Number(e.target.value);setConfig(p=>({...p,input:id,input_name:devices.find(d=>d.id===id)?.name||''}));}}><option value={-1}>入力を選択</option>{devices.filter(d=>d.inputs>0&&d.host==='Windows WASAPI').map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label><div className="route-arrow">→</div><label><span>OUTPUT / 変換音声の出力先</span><select disabled={active} value={config.output} onChange={e=>{const id=Number(e.target.value);setConfig(p=>({...p,output:id,output_name:devices.find(d=>d.id===id)?.name||''}));}}><option value={-1}>出力を選択</option>{devices.filter(d=>d.outputs>0&&d.host==='Windows WASAPI').map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label></div><p className="hint">通話アプリへ送る場合は仮想ケーブルを選択。スピーカーへの出力はハウリングに注意してください。</p></section>
   <div className="controls-grid"><section className="card"><div className="section-title"><h3>声の調整</h3><span className="pill">停止中に変更</span></div><Slider label="音の高さ" value={config.beatrice_pitch} min={-24} max={24} unit="半音" disabled={active} onChange={v=>update('beatrice_pitch',v)}/><Slider label="出力ゲイン" value={config.gain} min={-24} max={30} unit="dB" disabled={active} onChange={v=>update('gain',v)}/>{state==='running'&&metrics.clip>0&&<p className="hint danger">出力が上限を超えています。音が割れる場合はゲインを下げてください。</p>} </section>
   <section className="card"><div className="section-title"><h3>変換のペース</h3><span className="pill">遅延と負荷</span></div><div className="presets">{[[.01,'最短 10ms'],[.02,'低遅延 20ms'],[.04,'安定 40ms']].map(([block,name])=><button disabled={active} key={String(name)} className={config.beatrice_block===block?'chosen':''} onClick={()=>update('beatrice_block',Number(block))}>{name}</button>)}</div><div className="timing"><div><strong>{budget}<small>ms</small></strong><span>処理ブロック</span></div></div><p className="hint">短いブロックほど待ち時間が減ります。音切れが出る場合は20msまたは40msに戻してください。デバイスとモデル内部の遅延は別途加わります。</p></section></div>
   <section className="card"><label className="stability"><input type="checkbox" disabled={active} checked={config.beatrice_noise_filter} onChange={e=>update('beatrice_noise_filter',e.target.checked)}/><span>無音中のノイズを抑える</span></label><label className="stability" style={{marginTop:6}}><input type="checkbox" disabled={active} checked={config.beatrice_clarity} onChange={e=>update('beatrice_clarity',e.target.checked)}/><span>声をクリアにする（軽いEQ）</span></label><Slider label="ノイズ抑制のしきい値" value={config.beatrice_gate} min={-70} max={-30} unit="dB" disabled={active||!config.beatrice_noise_filter} onChange={v=>update('beatrice_gate',v)}/><p className="hint">静かな間だけ出力を下げます。小声が消える場合はしきい値を下げるかOFFにしてください。</p></section>
   <section className="performance"><div><span>推論時間 / ブロック</span><strong className={metrics.over_budget?'danger':''}>{state==='running'?Math.round(metrics.ms||0):'—'} <small>/ {budget} ms</small></strong></div><div><span>変換の実行先</span><strong>CPU</strong></div><div><span>待ち音声</span><strong>{state==='running'?Math.round(metrics.queue_ms||0):'—'}<small> ms</small></strong></div><div><span>遅延による破棄</span><strong>{metrics.dropped||0}<small> 回</small></strong></div></section>
  </>:<section className="card settings"><h3>モデルと実行環境</h3><p className="hint">既存アプリは起動しません。Pythonは音声処理専用で、画面とは別プロセスで動きます。</p>{[['beatrice_model','Beatriceモデル（.toml）'],['beatrice_vst','公式Beatrice 2 VST3（.vst3）'],['python','Python実行ファイル']].map(([key,label])=><label className="path-field" key={key}><span>{label}</span><div><input disabled={active} value={String(config[key as keyof Config])} onChange={e=>update(key as keyof Config,e.target.value)}/><button disabled={active} onClick={()=>pick(key as keyof Config)}>参照</button></div></label>)}<button className="primary small" disabled={active} onClick={async()=>{await invoke('save',config);setMessage('設定を保存しました。Pythonを変更した場合はアプリを再起動してください。');}}>設定を保存</button><div style={{display:'flex',gap:12,marginTop:12}}><button disabled={active} onClick={async()=>{try{const c=await window.yvc.invoke('import-settings');if(c){setConfig(c);setDevices(d=>[...d]);setMessage('設定を読み込みました。実行環境の変更を反映するにはアプリを再起動してください。');setError('');}}catch(e){setError(String(e));}}}>設定をインポート</button><button disabled={active} onClick={async()=>{try{await window.yvc.invoke('save',config);const file=await window.yvc.invoke('export-settings');if(file)setMessage('設定を書き出しました。');}catch(e){setError(String(e));}}}>設定をエクスポート</button></div><p className="hint">設定はJSONで保存します。モデル本体は含まれません。別のPCではファイルの場所を選び直してください。</p><p className="hint">モデル・画像は配布物に含まれません。保存先はこのPCの個人設定だけに記録されます。</p></section>}
  <footer><div><span className="footer-dot"/>{message}<small>Beatrice · CPU処理</small></div><button className={'primary '+(active?'stop':'')} onClick={toggle} disabled={!active&&(!model||!config.beatrice_vst||config.input<0||config.output<0)}>{active?'■ 停止する':'▶  声変換をはじめる'}</button></footer>
  </main>
 </div>;
}
function Slider({label,value,min,max,unit,disabled,onChange}:{label:string;value:number;min:number;max:number;unit:string;disabled:boolean;onChange:(n:number)=>void}){return <label className="slider"><div><span>{label}</span><strong>{value>0?'+':''}{value}<small> {unit}</small></strong></div><input type="range" min={min} max={max} value={value} disabled={disabled} onChange={e=>onChange(Number(e.target.value))}/></label>}
createRoot(document.getElementById('root')!).render(<App/>);
