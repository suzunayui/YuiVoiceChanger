const {randomUUID}=require('node:crypto');
function playEngineProbe({events,request,isRunning,stopEngine,signal,onProgress=()=>{},device_name='',referenceStart,verification=false,timeout=45000,cancelTimeout=5000}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted||!isRunning()){reject(Error(signal?.aborted?'測定を中止しました。':'声変換を開始してから測定してください。'));return;}
  const id=randomUUID();let finished=false,cancelling=null,engineError='',cancelTimer,aligning=false,clockWait=null;
  const now=()=>Number(process.hrtime.bigint())/1e9;
  const finish=(error,event)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(cancelTimer);clockWait?.cancel();clockWait=null;events.off('event',listener);signal?.removeEventListener('abort',abort);error?reject(error):resolve(event);};
  const forceStop=()=>{Promise.resolve().then(stopEngine).then(()=>finish(cancelling),error=>finish(Error('テスト音声を停止できませんでした。'+error.message)));};
  const cancel=error=>{
   if(finished||cancelling)return;cancelling=error;
   cancelTimer=setTimeout(forceStop,cancelTimeout);
   try{request('sync-test-cancel');}catch{forceStop();}
  };
  const abort=()=>cancel(Error('測定を中止しました。'));
  const align=async()=>{
   const samples=[];
   for(let token=0;token<5;token++){
    if(finished||cancelling)return;
    const before=now();
    const value=await new Promise((resolve,reject)=>{
     const timeout=setTimeout(()=>{clockWait=null;reject(Error('測定用の時刻を取得できませんでした。'));},1000);
     clockWait={token,resolve:event=>{clearTimeout(timeout);clockWait=null;resolve(event);},cancel:()=>{clearTimeout(timeout);reject(Error('測定を中止しました。'));}};
     try{request('sync-test-clock',{id,token});}catch(error){clearTimeout(timeout);clockWait=null;reject(error);}
    });
    const after=now();if(!Number.isFinite(value.clock))throw Error('測定用の時刻が正しくありません。');
    samples.push({rtt:after-before,offset:value.clock-(before+after)/2});
   }
   samples.sort((a,b)=>a.rtt-b.rtt);
   if(samples[0].rtt>.02)throw Error('測定用の時刻の応答が遅いため測定できません。');
   if(finished||cancelling)return;
   const epoch=await referenceStart();
   if(!finished&&!cancelling)request('sync-test-align',{id,epoch:epoch+samples[0].offset});
  };
  const listener=event=>{
   if(event.type==='error')engineError=event.message;
   if(event.type==='state'&&event.state==='stopped'){cancel(cancelling||Error(engineError||'声変換が停止したため測定を中止しました。'));return;}
   if(event.type!=='sync-test'||event.id!==id)return;
   if(event.phase==='clock'){if(clockWait?.token===event.token)clockWait.resolve(event);return;}
   if(event.phase==='ready'&&referenceStart){if(!aligning){aligning=true;align().catch(cancel);}return;}
   if(['completed','failed','cancelled'].includes(event.phase))finish(cancelling||(event.phase==='completed'?null:Error(event.message||'テスト音声の再生を中止しました。')),event);
   else if(!cancelling){try{onProgress(event);}catch(error){cancel(error);}}
  };
  const timer=setTimeout(()=>cancel(Error('テスト音声の再生が時間切れになりました。')),timeout);
  events.on('event',listener);signal?.addEventListener('abort',abort,{once:true});
  try{request('sync-test-start',{id,device_name,...(referenceStart?{silent:true}:{}),...(verification?{verification:true}:{})});}catch(error){finish(error);}
 });
}
module.exports={playEngineProbe};
