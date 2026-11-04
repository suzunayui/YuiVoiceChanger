const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitForAudioStability({getMetrics,check,quietMs=2000,timeoutMs=30000,now=()=>Date.now(),sleep=pause}){
 const started=now();let stableSince=null,previous=null;
 while(now()-started<timeoutMs){
  check();const current=getMetrics(),time=now();
  const fresh=Number.isFinite(current.received_at)&&time-current.received_at>=0&&time-current.received_at<=Math.max(1500,3*(current.budget_ms||0));
  const healthy=fresh&&current.output_started===true&&current.output_samples>=48000*3.5&&current.budget_ms>0&&Number.isFinite(current.ms)&&current.ms<=current.budget_ms*.9&&Number.isFinite(current.queue_ms)&&current.queue_ms<=current.budget_ms;
  if(!healthy){stableSince=null;previous=null;}
  else if(!previous||current.output_samples!==previous.output_samples){
   const uninterrupted=previous&&current.output_samples>previous.output_samples&&['late_blocks','dropped','device_errors','missing_ms'].every(key=>Number.isFinite(current[key])&&current[key]===previous[key]);
   if(!uninterrupted)stableSince=time;
   previous={...current};
   if(stableSince!==null&&time-stableSince>=quietMs)return;
  }
  await sleep(100);
 }
 throw Error('音声出力が安定しなかったため測定しません。PCの負荷と音声デバイスを確認してください。補正値は変更していません。');
}
async function waitForRecordingProgress({readStatus,check,timeoutMs=15000,now=()=>Date.now(),sleep=pause}){
 const started=now();let previous=-1,previousBytes=-1;
 while(now()-started<timeoutMs){
  check();const record=await readStatus();
  if(!record.outputActive||record.outputPaused)throw Error('テスト録画が停止・一時停止されました。');
  if(Number.isFinite(record.outputDuration)){
   if(previous>=0&&record.outputDuration<previous)throw Error('OBSの録画時刻が変わったため測定しません。補正値は変更していません。');
   if(record.outputDuration>=1000&&record.outputDuration>previous&&previous>=0&&Number.isFinite(record.outputBytes)&&record.outputBytes>0&&record.outputBytes>previousBytes&&previousBytes>=0)return;
   previous=record.outputDuration;
  }
  previousBytes=Number.isFinite(record.outputBytes)?record.outputBytes:-1;
  await sleep(100);
 }
 throw Error('OBSの録音開始を確認できなかったため測定しません。補正値は変更していません。');
}
module.exports={waitForAudioStability,waitForRecordingProgress};
