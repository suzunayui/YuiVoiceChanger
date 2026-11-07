// Whole-PC load, read in this process so measuring never competes with the audio process.
const {execFile}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');

const INTERVAL_MS=10000;
const GPU_FULL=90,VRAM_FULL=.9,CPU_FULL=90,CORE_FULL=95,RAM_LOW=.1;
const THERMAL_MASK=0x20n|0x40n;
const GPU_QUERY='--query-gpu=name,utilization.gpu,utilization.encoder,memory.used,memory.total,temperature.gpu,clocks_throttle_reasons.active';
const MESSAGES={
 ok:'問題は見つかりませんでした。',
 other:'変換は遅れていますが、CPU・メモリ・GPUには余裕があります。PCの負荷以外の原因かもしれません。',
 gpu:'GPUの処理が足りていません。OBSやカラオケなど、GPUを使うアプリを軽くすると改善するかもしれません。',
 vram:'GPUメモリが足りていません。GPUを使うアプリを閉じると改善するかもしれません。',
 thermal:'GPUの温度が高く、速度が制限されています。PCの冷却を確認してください。',
 cpu:'CPUが足りていません。同時に動かしているアプリを減らすと改善するかもしれません。',
 memory:'メモリの空きが少なくなっています。使っていないアプリを閉じてください。',
};

const number=text=>{const value=Number.parseFloat(text);return Number.isFinite(value)?value:null;};
function parseLine(line){
 const parts=line.split(',').map(part=>part.trim());
 if(parts.length<7)return null;
 const [name,util,encoder,used,total,temperature,reasons]=parts;
 const utilization=number(util);
 if(!name||utilization===null)return null;
 let thermalLimit=false;
 try{thermalLimit=(BigInt(reasons)&THERMAL_MASK)!==0n;}catch{}
 return {name,util:utilization,encoder:number(encoder),vramUsedMb:number(used),vramTotalMb:number(total),temperature:number(temperature),thermalLimit};
}
function parseNvidiaSmi(text){
 const gpus=text.split(/\r?\n/).map(parseLine).filter(Boolean);
 return gpus.length?gpus.reduce((busiest,gpu)=>gpu.util>busiest.util?gpu:busiest):null;
}
function readNvidiaGpu(){
 return new Promise(resolve=>execFile('nvidia-smi',[GPU_QUERY,'--format=csv,noheader'],{timeout:3000,windowsHide:true},(error,stdout)=>resolve(error?null:parseNvidiaSmi(stdout))));
}
function cpuUsage(previous,current){
 const usage=current.map((cpu,index)=>{
  const before=previous[index]?.times||cpu.times;
  const total=key=>cpu.times[key]-before[key];
  const all=total('user')+total('nice')+total('sys')+total('irq')+total('idle');
  return {busy:all-total('idle'),all};
 });
 const busy=usage.reduce((sum,cpu)=>sum+cpu.busy,0),all=usage.reduce((sum,cpu)=>sum+cpu.all,0);
 return {total:all?busy/all*100:0,busiest:Math.max(0,...usage.map(cpu=>cpu.all?cpu.busy/cpu.all*100:0))};
}
// CPU and GPU only count as short when audio actually fell behind: busy but keeping up is fine.
function judge({cpu,ramFreeRatio,gpu},behind){
 const kinds=[];
 if(behind){
  if(gpu?.util>=GPU_FULL)kinds.push('gpu');
  if(gpu?.vramTotalMb&&gpu.vramUsedMb/gpu.vramTotalMb>=VRAM_FULL)kinds.push('vram');
  if(gpu?.thermalLimit)kinds.push('thermal');
  if(cpu.total>=CPU_FULL||cpu.busiest>=CORE_FULL)kinds.push('cpu');
 }
 if(ramFreeRatio<RAM_LOW)kinds.push('memory');
 if(!kinds.length)kinds.push(behind?'other':'ok');
 return kinds.map(kind=>({kind,message:MESSAGES[kind]}));
}
function formatLogLine(stamp,{cpu,ramFreeGb,ramTotalGb,gpu},behind,verdicts){
 const parts=[`cpu=${Math.round(cpu.total)}%`,`busiest_core=${Math.round(cpu.busiest)}%`,`ram_free_gb=${ramFreeGb.toFixed(1)}/${ramTotalGb.toFixed(1)}`];
 if(gpu)parts.push(`gpu=${gpu.util}%`,`encoder=${gpu.encoder}%`,`vram_mb=${gpu.vramUsedMb}/${gpu.vramTotalMb}`,`gpu_temp=${gpu.temperature}`,`thermal_limit=${gpu.thermalLimit}`);
 else parts.push('gpu=unavailable');
 return `${stamp} System: ${parts.join(' ')} behind=${behind} verdict=${verdicts.map(item=>item.kind).join('+')}`;
}
const pad=value=>String(value).padStart(2,'0');
const defaultStamp=()=>{const now=new Date();return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;};

class SystemMonitor{
 constructor({publish,writeLog,stamp=defaultStamp,readGpu=readNvidiaGpu,readCpus=os.cpus,readMemory=()=>({free:os.freemem(),total:os.totalmem()}),setTimer=callback=>setInterval(callback,INTERVAL_MS),clearTimer=clearInterval}){
  Object.assign(this,{publish,writeLog,stamp,readGpu,readCpus,readMemory,setTimer,clearTimer});
  this.run=0;this.timer=null;
 }
 start(){
  this.stop();
  this.run+=1;this.active=true;this.seen=0;this.latest=0;this.found={};this.cpus=this.readCpus();
  this.timer=this.setTimer(()=>{this.sample().catch(()=>{});});
 }
 stop(){
  this.active=false;
  if(this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
 }
 observe({late_blocks=0,dropped=0,skipped_blocks=0}){this.latest=late_blocks+dropped+skipped_blocks;}
 async sample(){
  if(!this.active)return;
  const run=this.run;
  let gpu=null;
  try{gpu=await this.readGpu();}catch{}
  if(!this.active||run!==this.run)return;
  const cpus=this.readCpus(),cpu=cpuUsage(this.cpus,cpus),{free,total}=this.readMemory();
  this.cpus=cpus;
  const behind=this.latest>this.seen;this.seen=this.latest;
  const sample={cpu,ramFreeRatio:total?free/total:1,ramFreeGb:free/2**30,ramTotalGb:total/2**30,gpu};
  const verdicts=judge(sample,behind);
  for(const {kind} of verdicts)if(kind!=='ok')this.found[kind]=(this.found[kind]||0)+1;
  try{this.writeLog(formatLogLine(this.stamp(),sample,behind,verdicts));}catch{}
  this.publish({sample,behind,verdicts,found:{...this.found},summary:Object.entries(this.found).map(([kind,count])=>({kind,count,message:MESSAGES[kind]}))});
 }
}
function appendLogLine(file,line){fs.appendFile(file,line+'\n',()=>{});}

module.exports={SystemMonitor,parseNvidiaSmi,cpuUsage,judge,formatLogLine,appendLogLine};
