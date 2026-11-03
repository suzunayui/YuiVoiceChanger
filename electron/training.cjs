const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const {spawn}=require('node:child_process');
const {prepareAssets,prepareOnnx}=require('./model-assets.cjs');
const {run}=require('./setup.cjs');
class TrainingManager{
 constructor(home,engineRoot,notify){
  this.home=home;this.engineRoot=engineRoot;this.notify=notify;this.busy=false;this.child=null;this.cancelled=false;
  this.state={phase:'idle',message:'RVCモデルから、このアプリ用の声を学習できます。'};
  this.record=path.join(home,'last-training.json');
  try{
   this.state=JSON.parse(fs.readFileSync(this.record,'utf8'));
   if(!['completed','cancelled','failed','idle'].includes(this.state.phase))this.state={...this.state,phase:'cancelled',message:'前回の学習を再開できます。'};
  }catch{}
 }
 update(value){
  this.state={...this.state,...value};
  fs.mkdirSync(this.home,{recursive:true});
  fs.writeFileSync(this.record,JSON.stringify(this.state,null,2));
  this.notify({type:'training',...this.state,busy:this.busy});
 }
 status(){return {...this.state,busy:this.busy};}
 async tool(python,command,args=[]){
  if(!python)throw Error('実行環境をセットアップしてください。');
  const text=await run(python,['-I',path.join(this.engineRoot,'backend','model_tools.py'),command,...args],{timeout:120000});
  const lines=text.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1));
 }
 async ensureMetadata(python){
  try{await run(python,['-I','-c','import onnx']);return;}catch{}
  const manifest=JSON.parse(fs.readFileSync(path.join(this.home,'runtime','direct-gpu-runtime.json'),'utf8'));
  const uv=path.join(path.dirname(path.dirname(path.dirname(manifest.python))),'uv.exe');
  await run(uv,['pip','install','--python',python,'--only-binary',':all:','onnx==1.23.2'],{timeout:300000});
 }
 async inspect(python,file){
  if(typeof file!=='string')throw Error('モデルを選んでください。');
  if(path.extname(file).toLowerCase()==='.onnx')await this.ensureMetadata(python);
  return this.tool(python,'inspect',[file]);
 }
 async start(config,options={}){
  if(this.busy||this.starting)throw Error('学習は実行中です。');
  this.starting=true;
  try{return await this.startChecked(config,options);}finally{this.starting=false;}
 }
 async startChecked(config,{resume=false}={}){
  if(this.busy)throw Error('学習は実行中です。');
  const gpu=await this.tool(config.python,'gpu');
  if(!gpu.eligible)throw Error(gpu.reason);
  let job,options;
  if(resume){
   if(!/^[0-9a-f-]{36}$/.test(this.state.id||''))throw Error('再開できる学習がありません。');
   job=path.join(this.home,'models',this.state.id);
   options=JSON.parse(fs.readFileSync(path.join(job,'config.json'),'utf8'));
  }else{
   const info=await this.inspect(config.python,config.training_source);
   if(!info.train_required)throw Error('RVCの.pthまたは.onnxを選んでください。');
   if(!fs.statSync(config.training_audio,{throwIfNoEntry:false})?.isDirectory())throw Error('学習素材の音声フォルダを選んでください。');
   const id=crypto.randomUUID();job=path.join(this.home,'models',id);fs.mkdirSync(job,{recursive:true});
   options={source:config.training_source,audio:config.training_audio,pitch:config.teacher_pitch,steps:config.training_steps,job};
   fs.writeFileSync(path.join(job,'config.json'),JSON.stringify(options,null,2));
  }
  this.busy=true;this.cancelled=false;this.abort=new AbortController();
  this.update({id:path.basename(job),phase:'preparing',message:'学習環境を準備しています',model:null,current:0,total:options.steps,eta_seconds:null});
  this.task=this.execute(config.python,options).catch(error=>this.update({phase:this.cancelled?'cancelled':'failed',message:this.cancelled?'準備を中止しました。':error.message})).finally(()=>{this.busy=false;this.update({});});
  return this.status();
 }
 async execute(python,options){
  const progress=message=>this.update({message});
  options.assets=await prepareAssets(this.home,progress,()=>this.cancelled,this.abort.signal);
  if(this.cancelled){this.update({phase:'cancelled',message:'準備を中止しました。再開できます。'});return;}
  if(path.extname(options.source).toLowerCase()==='.onnx')options.helper=await prepareOnnx(this.home,progress);
  if(this.cancelled){this.update({phase:'cancelled',message:'準備を中止しました。再開できます。'});return;}
  const configFile=path.join(options.job,'config.json');fs.writeFileSync(configFile,JSON.stringify(options,null,2));
  const log=fs.createWriteStream(path.join(options.job,'training.log'),{flags:'a'});
  const child=spawn(python,['-I','-u',path.join(this.engineRoot,'backend','training_job.py'),configFile],{
   cwd:this.engineRoot,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});
  this.child=child;child.stderr.pipe(log);
  let terminal=false;
  readline.createInterface({input:child.stdout}).on('line',line=>{
   try{
    const event=JSON.parse(line);if(['completed','cancelled','failed'].includes(event.phase))terminal=true;
    this.update(event);
   }catch{log.write(line+'\n');}
  });
  await new Promise((resolve,reject)=>{
   child.once('error',reject);
   child.once('exit',code=>{
    this.child=null;log.end();
    if(!terminal)this.update({phase:this.cancelled?'cancelled':'failed',message:this.cancelled?'学習を中断しました。保存済みの状態から再開できます。':`学習プロセスが終了しました (${code})。詳細は学習ログを確認してください。`});
    resolve();
   });
  });
 }
 cancel(){
  this.cancelled=true;
  this.abort?.abort();
  if(this.child?.stdin.writable)this.child.stdin.write('{"command":"cancel"}\n');
  if(this.busy)this.update({message:'中断を要求しました。処理の区切りで保存して停止します。'});
  return this.status();
 }
 async shutdown(){
  if(!this.busy)return;
  this.cancel();
  let timer;
  await Promise.race([this.task,new Promise(resolve=>{timer=setTimeout(()=>{this.child?.kill();resolve();},20000);})]);
  clearTimeout(timer);
 }
}
module.exports={TrainingManager};
