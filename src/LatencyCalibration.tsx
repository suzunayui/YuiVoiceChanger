import React,{useEffect,useRef,useState} from 'react';
import type {Config} from './main';
import errorText from './errorText';

export type CalibrationStatus={phase:string;busy:boolean;message:string;progress?:number;rms?:number;seconds_left?:number;recommended_ms?:number;total_delay_ms?:number};
export const idleCalibration:CalibrationStatus={phase:'idle',busy:false,message:''};
export default function LatencyCalibration({config,status,disabled,onStatus,buttonLabel='自動設定'}:{config:Config;status:CalibrationStatus;disabled:boolean;onStatus:(next:CalibrationStatus)=>void;buttonLabel?:string}){
 const [open,setOpen]=useState(false),[pending,setPending]=useState(false),[cancelling,setCancelling]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(status.busy)setOpen(true);else setCancelling(false);},[status.busy]);
 useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();},[open]);
 const ready=Boolean(config.python&&config.beatrice_model&&config.input>=0&&config.output>=0);
 const start=async()=>{
  setOpen(true);setPending(true);
  try{onStatus(await window.yvc.invoke('latency-calibration-start',config));}
  catch(error){onStatus({phase:'failed',busy:false,message:errorText(error)});}
  finally{setPending(false);}
 };
 const cancel=async()=>{
  setCancelling(true);
  try{onStatus(await window.yvc.invoke('latency-calibration-cancel'));}
  catch(error){onStatus({phase:'failed',busy:false,message:errorText(error)});setCancelling(false);}
 };
 const working=status.busy||pending;
 const current=pending?{phase:'preparing',message:'自動設定を準備しています…',progress:0}:status;
 const close=()=>{if(working)void cancel();else setOpen(false);};
 return <>
  <button className="obs-button calibration-button" title={!ready?'声のモデル・変換環境・マイク・出力先を先に設定してください。':'マイクに6秒ほどしゃべり、現在のモデル・実行先・エフェクトで処理時間を測り、計算結果にさらに100msの余裕を足して固定遅延を自動設定します。音声はメモリ内で処理し、配信先へ出力しません。'} disabled={disabled||!ready||pending} onClick={start}>{buttonLabel}</button>
  {open&&<dialog ref={dialog} className="latency-calibration" aria-labelledby="calibration-title" onCancel={event=>{event.preventDefault();event.stopPropagation();close();}}>
   <div className="calibration-header"><h2 id="calibration-title">固定遅延を自動設定</h2><button type="button" aria-label="自動設定を閉じる" disabled={cancelling} onClick={close}>×</button></div>
   <p className={current.phase==='failed'?'danger':''} role={current.phase==='failed'?'alert':'status'}>{current.message}</p>
   {working&&<progress aria-label="測定の進捗" value={current.progress||0} max={1}/>}
   {current.phase==='speaking'&&<div className="calibration-mic"><span>入力レベル</span><meter aria-label="測定中の入力レベル" min={0} max={1} value={Math.min(1,(status.rms||0)*10)}/><span>あと{status.seconds_left??6}秒</span></div>}
   {current.phase==='completed'&&<strong className="calibration-result">{status.total_delay_ms??status.recommended_ms}<small> ms</small></strong>}
   <p className="hint">変換の処理時間から推定します。OBSまでの実測値ではありません。</p>
   <div className="calibration-actions">{working?<button className="obs-button" disabled={cancelling} onClick={cancel}>{cancelling?'中止しています…':'中止する'}</button>:<>{current.phase!=='completed'&&<button className="obs-button" disabled={disabled||!ready} onClick={start}>もう一度測定</button>}<button className="obs-button" onClick={()=>setOpen(false)}>閉じる</button></>}</div>
  </dialog>}
 </>;
}
