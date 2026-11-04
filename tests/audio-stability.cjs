const assert=require('node:assert/strict');
const {waitForAudioStability,waitForRecordingProgress}=require('../electron/audio-stability.cjs');
const healthy=time=>({received_at:time,output_started:true,output_samples:48000*4+time*48,budget_ms:80,ms:20,queue_ms:0,late_blocks:0,dropped:0,device_errors:0,missing_ms:0});
async function scenario(metrics,{cancelAt=Infinity,timeoutMs=8000}={}){
 let time=0;const checks=[];
 await waitForAudioStability({getMetrics:()=>metrics(time),check:()=>{checks.push(time);if(time>=cancelAt)throw Error('cancelled');},now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs});
 return {time,checks};
}
(async()=>{
 assert.equal((await scenario(healthy)).time,2000);
 assert.equal((await scenario(time=>time<2000?{...healthy(time),output_started:false}:healthy(time))).time,4000);
 assert.equal((await scenario(time=>({...healthy(time),late_blocks:time<1500?0:1}))).time,3500);
 assert.equal((await scenario(time=>({...healthy(time),ms:time<1200?79:20}))).time,3200);
 assert.equal((await scenario(time=>({...healthy(time),queue_ms:time<1200?160:0}))).time,3200);
 assert.equal((await scenario(time=>({...healthy(time),output_samples:time*48}))).time,5500);
 for(const sample of [()=>({}),()=>healthy(0),time=>({...healthy(time),output_started:false}),time=>({...healthy(time),output_samples:48000*4}),time=>({...healthy(time),dropped:time/100}),time=>({...healthy(time),device_errors:time/100}),time=>({...healthy(time),missing_ms:time})]){
  await assert.rejects(scenario(sample),/安定しなかった/);
 }
 await assert.rejects(scenario(time=>({...healthy(time),output_started:false}),{cancelAt:300}),/cancelled/);
 async function recording(status,check=()=>{}){
  let time=0;
  await waitForRecordingProgress({readStatus:async()=>status(time),check:()=>check(time),now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:2000});
  return time;
 }
 const progress=time=>({outputActive:true,outputDuration:time,outputBytes:time*100});
 assert.equal(await recording(progress),1000);
 for(const status of [time=>({...progress(time),outputBytes:0}),time=>({...progress(time),outputBytes:100}),()=>({...progress(5000)}),()=>({outputActive:true})])await assert.rejects(recording(status),/録音開始を確認できなかった/);
 await assert.rejects(recording(time=>({...progress(time),outputPaused:true})),/一時停止/);
 await assert.rejects(recording(time=>({...progress(time),outputDuration:time<100?500:0})),/録画時刻が変わった/);
 await assert.rejects(recording(progress,time=>{if(time>=300)throw Error('cancelled');}),/cancelled/);
 console.log('PASS output stability waits for fresh advancing audio, filled startup buffer, headroom and uninterrupted counters; stale/frozen/missing output times out and cancellation is immediate');
})().catch(error=>{console.error(error);process.exitCode=1;});
