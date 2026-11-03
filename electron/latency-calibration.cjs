const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const {spawn}=require('node:child_process');
class LatencyCalibration{
 constructor({engineRoot,notify=()=>{},onComplete=()=>{},beforeStart=async()=>{},spawnProcess=spawn,timeout=120000,cancelTimeout=5000}){
  Object.assign(this,{engineRoot,notify,onComplete,beforeStart,spawnProcess,timeout,cancelTimeout});
  this.busy=false;this.child=null;this.state={phase:'idle',message:'',progress:0};
 }
 status(){return {...this.state,busy:this.busy};}
 update(next){this.state={...this.state,...next};this.notify({type:'latency-calibration',...this.status()});}
 start(config){
  if(this.busy)throw Error('自動設定は実行中です。');
  if(!config.python||!fs.statSync(config.python,{throwIfNoEntry:false})?.isFile())throw Error('変換環境をセットアップしてください。');
  if(!config.beatrice_model||!fs.statSync(config.beatrice_model,{throwIfNoEntry:false})?.isFile())throw Error('声のモデルを選んでください。');
  if(config.input<0||config.output<0)throw Error('マイクと出力先を選んでください。');
  const script=path.join(this.engineRoot,'backend','latency_calibration.py');
  if(!fs.existsSync(script))throw Error('自動設定の音声処理ファイルが見つかりません。');
  this.busy=true;this.cancelled=false;this.state={phase:'preparing',message:'自動設定を準備しています…',progress:0};this.update({});
  let terminal=null,finished=false;
  this.task=new Promise(resolve=>{
   const finish=event=>{
    if(finished)return;finished=true;clearTimeout(this.deadline);clearTimeout(this.cancelTimer);this.deadline=this.cancelTimer=null;this.child=null;this.busy=false;
    let nextConfig;
    if(this.cancelled)event={phase:'cancelled',message:'測定を中止しました。'};
    if(event.phase==='completed'){
     try{if(!Number.isInteger(event.recommended_ms)||event.recommended_ms<200||event.recommended_ms>2000)throw Error('測定結果が正しくありません。');nextConfig=this.onComplete(event,config);}
     catch(error){event={phase:'failed',message:error.message};}
    }
    this.state={...event};this.notify({type:'latency-calibration',...this.status(),...(nextConfig?{config:nextConfig}:{})});resolve();
   };
   const launch=()=>{
   let child;
   try{child=this.spawnProcess(config.python,['-I','-u',script],{cwd:this.engineRoot,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});}
   catch(error){finish({phase:'failed',message:'測定プロセスを起動できませんでした。'});return;}
   this.child=child;
   child.stderr.resume();
   child.stdin.on('error',()=>{});
   readline.createInterface({input:child.stdout}).on('line',line=>{
    try{
     const event=JSON.parse(line);
     if(['completed','cancelled','failed'].includes(event.phase)){terminal=event;child.stdin.end();}
     else if(['preparing','speaking','measuring'].includes(event.phase)&&!this.cancelled)this.update(event);
    }catch{}
   });
   child.once('error',()=>finish({phase:'failed',message:'測定プロセスを起動できませんでした。変換環境を確認してください。'}));
   child.once('exit',code=>finish(code===0&&terminal?terminal:{phase:'failed',message:terminal?.phase==='failed'?terminal.message:'測定プロセスが終了しました。変換環境を確認して再試行してください。'}));
   this.deadline=setTimeout(()=>{terminal={phase:'failed',message:'測定が時間切れになりました。再試行してください。'};child.kill();},this.timeout);
   child.stdin.write(JSON.stringify(config)+'\n');
   };
   Promise.resolve().then(()=>this.beforeStart()).then(()=>{if(this.cancelled)finish({phase:'cancelled',message:'測定を中止しました。'});else launch();}).catch(error=>finish({phase:'failed',message:error.message}));
  });
  return this.status();
 }
 cancel(){
  if(!this.busy)return this.status();
  this.cancelled=true;this.update({phase:'cancelling',message:'測定を中止しています…'});
  if(this.child?.stdin.writable)this.child.stdin.write('{"command":"cancel"}\n');
  if(!this.cancelTimer)this.cancelTimer=setTimeout(()=>this.child?.kill(),this.cancelTimeout);
  return this.status();
 }
 async shutdown(){if(this.busy){this.cancel();await this.task;}}
}
module.exports={LatencyCalibration};
