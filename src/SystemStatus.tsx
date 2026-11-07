type Verdict={kind:string;message:string};
type Status={behind:boolean;verdicts:Verdict[];summary:(Verdict&{count:number})[];sample:{cpu:{total:number;busiest:number};ramFreeGb:number;ramTotalGb:number;gpu:null|{name:string;util:number;encoder:number|null;vramUsedMb:number|null;vramTotalMb:number|null;temperature:number|null}}};
const GIB_PER_MIB=1024;
export default function SystemStatus({status,running}:{status:Status|null;running:boolean}){
 const sample=status?.sample,gpu=sample?.gpu;
 const problems=status?.summary.filter(item=>item.kind!=='ok')||[];
 return <section className="runtime-setup diagnostic-log system-status" aria-label="PCの状態">
  <div className="section-title"><h3>PCの状態</h3></div>
  <p className="hint">声変換中のPC全体のCPU・メモリ・GPUと、変換の遅れを見て、足りないものを判定します。買い替えが必要かどうかまでは判定しません。</p>
  {!status&&<p className="hint" role="status">{running?'測定中です。10秒ほどで表示します。':'声変換を開始すると確認します。'}</p>}
  {sample&&<dl className="system-values">
   <div><dt>CPU</dt><dd>{Math.round(sample.cpu.total)}%（最大のコア {Math.round(sample.cpu.busiest)}%）</dd></div>
   <div><dt>メモリの空き</dt><dd>{sample.ramFreeGb.toFixed(1)} / {sample.ramTotalGb.toFixed(1)} GB</dd></div>
   <div><dt>GPU</dt><dd>{gpu?`${gpu.util}%`:'取得できません'}</dd></div>
   {gpu&&gpu.vramUsedMb!==null&&gpu.vramTotalMb!==null&&<div><dt>GPUメモリ</dt><dd>{(gpu.vramUsedMb/GIB_PER_MIB).toFixed(1)} / {(gpu.vramTotalMb/GIB_PER_MIB).toFixed(1)} GB</dd></div>}
  </dl>}
  {status&&!problems.length&&<p className="hint" role="status">問題は見つかりませんでした。</p>}
  {problems.length>0&&<ul className="system-verdicts" role="status">{problems.map(item=><li key={item.kind}>{item.message}<small>（この変換中に{item.count}回）</small></li>)}</ul>}
 </section>;
}
