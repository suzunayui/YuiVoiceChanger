import React,{useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {Config} from './main';
type Input={inputName:string;inputUuid:string};
type Status={phase:string;busy:boolean;message:string;beat?:number;progress?:number;result?:{correction_ms:number;spread_ms:number;matched:number}};
const idle:Status={phase:'idle',busy:false,message:''};
const errorMessage=(error:unknown)=>String(error instanceof Error?error.message:error).replace(/^Error:\s*/,'').replace(/^Error invoking remote method 'yvc':\s*/,'').replace(/^Error:\s*/,'');
export default function ObsSyncCalibration({config,inputs,connected,connectionPending,disabled,connect,connectionForm,connectionError,launcherTarget}:{config:Config;inputs:Input[];connected:boolean;connectionPending:boolean;disabled:boolean;connect:()=>Promise<{ok:boolean;error?:string}>;connectionForm:React.ReactNode;connectionError:string;launcherTarget:HTMLElement|null}){
 const [open,setOpen]=useState(false),[status,setStatus]=useState<Status>(idle),[pending,setPending]=useState(false),[voice,setVoice]=useState(''),[error,setError]=useState('');
 const [info,setInfo]=useState({ffmpeg:false,recovery:false});const dialog=useRef<HTMLDialogElement>(null);
 const [connecting,setConnecting]=useState(false),[connectError,setConnectError]=useState('');
 const key=(input:Input)=>input.inputUuid||input.inputName;
 const sources=inputs.filter(input=>config.obs_input_uuid?input.inputUuid!==config.obs_input_uuid:input.inputName!==config.obs_input_name);
 const refresh=()=>window.yvc.invoke('obs-sync-info').then(setInfo).catch(e=>setError(errorMessage(e)));
 useEffect(()=>{
  window.yvc.invoke('obs-sync-status').then(next=>{setStatus(next);if(!next.busy)refresh();}).catch(e=>setError(errorMessage(e)));
  return window.yvc.subscribe(event=>{if(event.type==='obs-sync'){setStatus(event);if(!event.busy)refresh();}});
 },[]);
 useEffect(()=>{if(open){if(!dialog.current?.open)dialog.current?.showModal();refresh();}},[open]);
 useEffect(()=>{if(status.busy)setOpen(true);},[status.busy]);
 const working=pending||status.busy;
 const available=connected;
 const show=async()=>{
  setOpen(true);setError('');setConnectError('');
  if(!connected&&!connecting&&!connectionPending){setConnecting(true);try{const result=await connect();if(!result.ok)setConnectError(errorMessage(result.error||'OBSに接続できませんでした。'));}catch(e){setConnectError(errorMessage(e));}finally{setConnecting(false);}}
 };
 const start=async()=>{setPending(true);setError('');try{setStatus(await window.yvc.invoke('obs-sync-start',{config,voice}));}catch(e){setError(errorMessage(e));}finally{setPending(false);}};
 const close=()=>{if(working)window.yvc.invoke('obs-sync-cancel').then(setStatus).catch(e=>setError(errorMessage(e)));else setOpen(false);};
 return <>
  {launcherTarget&&createPortal(<button className="obs-button" aria-label="ビープでOBSのずれを自動調整" title="ビープに合わせて発声し、OBSとのずれを自動設定します。接続と声変換は自動で準備します。" onClick={show}>自動設定</button>,launcherTarget)}
  {open&&<dialog ref={dialog} className="model-library obs-sync-dialog" aria-labelledby="obs-sync-title" onCancel={event=>{event.preventDefault();close();}}>
   <div className="library-header"><h2 id="obs-sync-title">ビープでOBSのずれを自動調整</h2><button aria-label="OBSの同期測定を閉じる" onClick={close}>×</button></div>
   {!working&&<>
    <p>3拍のカウントの後、続く8拍に合わせて短く「た」と発声してください。</p>
    <p className="hint">他の音楽とOBSの配信・録画・リプレイバッファ・仮想カメラを止め、ヘッドホンで行ってください。録音先と音声トラックは測定後に戻します。</p>
    {!connected&&<div aria-label="測定用のOBS接続"><p role="status">{connecting||connectionPending?'OBSに接続しています…':'OBSの接続設定を確認してください。'}</p>{connectionForm}</div>}
    <label className="obs-sync-source"><span>OBSで変換後の声を取り込むソース</span><select value={voice} onChange={e=>setVoice(e.target.value)}><option value="">CABLE Outputなどを取り込むソースを選択</option>{sources.map(input=><option key={key(input)} value={key(input)}>{input.inputName}</option>)}</select></label>
    <p className="hint">生声はアプリで選択中のマイクから直接取得します。</p>
    {!info.ffmpeg&&<div><p className="hint">解析用のffmpegを指定してください。</p><button className="obs-button" onClick={()=>window.yvc.invoke('obs-sync-pick-ffmpeg').then(setInfo).catch(e=>setError(errorMessage(e)))}>ffmpegを選ぶ</button></div>}
   </>}
   {status.message&&<p role={status.phase==='failed'?'alert':'status'}>{status.message}</p>}
   {working&&<><progress aria-label="OBSの同期測定の進捗" max={1} value={status.progress||0}/>{status.phase==='speaking'&&<div className="obs-sync-beat">{(status.beat??0)<=0?`準備 ${Math.min(3,Math.max(1,1-(status.beat??0)))}`:(status.beat??0)<=8?`${status.beat} / 8`:'解析準備'}</div>}</>}
   {status.phase==='completed'&&status.result&&<div className="obs-sync-result"><span>補正値</span><strong>{status.result.correction_ms>0?'+':''}{status.result.correction_ms}<small> ms</small></strong><p className="hint">{status.result.matched}回の発声で測定 · ばらつき {status.result.spread_ms}ms</p></div>}
   {error&&error!==status.message&&<p className="error" role="alert">{error}</p>}
   {!connected&&(connectionError||connectError)&&<p className="error" role="alert">{errorMessage(connectionError||connectError)}</p>}
   {!working&&disabled&&<p className="hint">ほかの処理が完了すると測定を開始できます。</p>}
   {!working&&info.recovery&&<button className="obs-button" onClick={()=>{setPending(true);setError('');window.yvc.invoke('obs-sync-recover').then(setInfo).catch(e=>setError(errorMessage(e))).finally(()=>setPending(false));}}>前回の測定設定を復元</button>}
   <p className="hint">拍に合わせた発声を基準に測定します。発声の癖も結果に影響するため、補正後に録音で確認してください。</p>
   <div className="calibration-actions">{working?<button className="obs-button" onClick={close}>中止する</button>:<><button className="obs-button" onClick={()=>setOpen(false)}>閉じる</button><button className="primary" title="必要な声変換・固定遅延・OBSの自動設定を開始して測定します。" disabled={disabled||!available||!voice||!info.ffmpeg||info.recovery} onClick={start}>{status.phase==='completed'?'もう一度測定':'測定を開始'}</button></>}</div>
  </dialog>}
 </>;
}
