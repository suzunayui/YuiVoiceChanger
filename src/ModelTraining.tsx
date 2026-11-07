import React,{useEffect,useState} from 'react';
import type {Config} from './main';
import errorText from './errorText';

export default function ModelTraining({config,active,job,onPick,onUpdate,onJob,onConfig,onError}:{
 config:Config;active:boolean;job:any;onPick:(key:keyof Config)=>Promise<void>;
 onUpdate:(key:keyof Config,value:string|number)=>void;onJob:(value:any)=>void;onConfig:(value:Config)=>void;onError:(value:string)=>void;
}){
 const [gpu,setGpu]=useState<any>(null),[checking,setChecking]=useState(false);
 const check=async()=>{
  setChecking(true);
  try{setGpu(await window.yvc.invoke('gpu-info'));}catch(e){onError(errorText(e));}
  finally{setChecking(false);}
 };
 useEffect(()=>{if(config.python)check();},[config.python]);
 const start=async(resume=false)=>{
  onError('');onJob({...job,busy:true,phase:'preparing',message:'学習を準備しています…'});
  try{onJob(await window.yvc.invoke(resume?'training-resume':'training-start',resume?undefined:config));}
  catch(e){onError(errorText(e));onJob({...job,busy:false});}
 };
 const percent=job.total?Math.min(100,Math.round(100*(job.current||0)/job.total)):0;
 const phases:Record<string,string>={idle:'準備',preparing:'準備中',generating:'教材音声を生成中',codebooks:'声の特徴を準備中',training:'学習中',saving:'保存中',completed:'作成完了',cancelled:'中断',failed:'エラー'};
 return <section className="card training-panel">
  <div className="section-title"><h3>RVCから学習モデルを作る</h3></div>
  <p className="hint">音質は元のモデルや学習素材によって変わります。完成後に試聴してください。</p>
  <label className="path-field"><span>RVCモデル（.pth / .onnx）</span><div><input readOnly value={config.training_source}/><button title="声の元になるRVCの.pthまたは.onnxモデルを選びます。" disabled={active} onClick={()=>onPick('training_source')}>モデルを選ぶ</button></div></label>
  <label className="path-field"><span>学習素材の音声フォルダ</span><div><input readOnly value={config.training_audio}/><button title="WAV・FLAC・OGG・MP3など、複数の文章を読んだ音声が入ったフォルダを選びます。" disabled={active} onClick={()=>onPick('training_audio')}>フォルダを選ぶ</button></div></label>
  <p className="hint">複数の文章を含む、数分以上の読み上げ音声を用意してください。</p>
  <div className="training-options">
   <label title="RVCで学習用の音声を生成するときの音程です。普段そのRVCで使っている値に合わせます。"><span>教材生成の音高（半音）</span><input type="number" min={-24} max={24} value={config.teacher_pitch} disabled={active} onChange={e=>onUpdate('teacher_pitch',Number(e.target.value))}/></label>
   <label title="学習を繰り返す回数です。多いほど時間がかかります。まずお試しで動作を確認できます。"><span>学習回数</span><select value={config.training_steps} disabled={active} onChange={e=>onUpdate('training_steps',Number(e.target.value))}><option value={2000}>2,000（お試し）</option><option value={10000}>10,000（標準）</option><option value={20000}>20,000（長め）</option></select></label>
  </div>
  <div className="gpu-check"><button title="学習に使えるNVIDIA GPUと空きメモリーを確認します。" disabled={active||checking||!config.python} onClick={check}>{checking?'GPUを確認中…':'GPUを確認'}</button><span>{gpu?(gpu.eligible?`${gpu.name} · 学習できます。`:gpu.reason):'学習には対応するNVIDIA GPUが必要です。'}</span></div>
  <p className="hint">初回に約550MBをダウンロードします。</p>
  {(job.busy||['completed','cancelled','failed'].includes(job.phase))&&<div className="training-progress" role="status">
   <strong>{phases[job.phase]||'準備'}</strong><p>{job.message||'モデルと学習素材を選んでください。'}</p>
   {['generating','training','saving'].includes(job.phase)&&<><progress value={job.current||0} max={job.total||1}/><span>{job.current||0} / {job.total||0}（{percent}%）</span></>}
   {job.busy&&Number.isFinite(job.eta_seconds)&&job.eta_seconds>0&&<p>残り時間の目安：約{Math.ceil(job.eta_seconds/60)}分</p>}
  </div>}
  <div className="guide-actions">
   <button title="RVCから学習用の音声を生成し、このアプリで使えるモデルを作ります。元のモデルや素材は変更しません。" className="primary" disabled={active||checking||!gpu?.eligible||!config.training_source||!config.training_audio} onClick={()=>start()}>学習モデルを作成</button>
   {job.busy&&<button title="処理の区切りで状態を保存して中断します。保存した状態から再開できます。" onClick={async()=>onJob(await window.yvc.invoke('training-cancel'))}>保存して中断</button>}
   {!job.busy&&['cancelled','failed'].includes(job.phase)&&job.id&&<button title="前回保存した学習状態の続きから再開します。" disabled={active||!gpu?.eligible} onClick={()=>start(true)}>前回の学習を再開</button>}
   {!job.busy&&job.model&&<button title="完成したモデルを選択して、声の変換画面に戻ります。" disabled={active} onClick={async()=>{try{onConfig(await window.yvc.invoke('use-trained-model'));}catch(e){onError(errorText(e));}}}>作成したモデルを使う</button>}
  </div>
 </section>;
}
