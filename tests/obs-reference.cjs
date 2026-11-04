const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {startReference}=require('../electron/obs-reference.cjs'),{playEngineProbe}=require('../electron/engine-probe.cjs');
async function cursor(kind){
 let t=100,started=0;const rpc=async(type)=>{
  if(type==='TriggerMediaInputAction'){started=t;return {};}
  const elapsed=t-started;t+=.001;
  return {mediaState:'OBS_MEDIA_STATE_PLAYING',mediaCursor:kind==='frozen'?1:Math.round(elapsed*1000)+1+(kind==='jitter'?(elapsed>.1?40:0):0)};
 };
 const job=startReference({rpc,input:{inputName:'test'},clock:()=>t,wait:async()=>{t+=.01;}});
 if(kind==='good')assert(Math.abs(await job-started-4)<.002);else await assert.rejects(job,/時刻/);
}
async function ipc(kind){
 const events=new EventEmitter(),controller=new AbortController();let starts=0,id,epoch,clocks=0,stops=0;
 const emit=event=>events.emit('event',event);
 const request=(command,data)=>{
  if(command==='sync-test-start'){id=data.id;assert.equal(data.silent,true);setImmediate(()=>emit({type:'sync-test',id,phase:'ready'}));}
  if(command==='sync-test-clock'){clocks++;emit({type:'sync-test',id,phase:'clock',token:data.token,clock:Number(process.hrtime.bigint())/1e9+400});}
  if(command==='sync-test-align'){epoch=data.epoch;setImmediate(()=>emit({type:'sync-test',id,phase:'completed'}));}
  if(command==='sync-test-cancel'){stops++;setImmediate(()=>emit({type:'sync-test',id,phase:'cancelled'}));}
 };
 const job=playEngineProbe({events,request,isRunning:()=>true,stopEngine:async()=>{},signal:controller.signal,
  referenceStart:async()=>{starts++;if(kind==='cancel'){controller.abort();return 100;}if(kind==='failure')throw Error('reference failure');return 100;}});
 if(kind==='good'){assert.equal((await job).phase,'completed');assert(Math.abs(epoch-500)<.01);assert.equal(stops,0);}
 else{await assert.rejects(job,kind==='failure'?/reference failure/:/中止/);assert.equal(epoch,undefined);assert.equal(stops,1);}
 assert.equal(starts,1);assert.equal(clocks,5);assert.equal(events.listenerCount('event'),0);
}
(async()=>{for(const kind of ['good','frozen','jitter'])await cursor(kind);for(const kind of ['good','cancel','failure'])await ipc(kind);console.log('PASS silent OBS reference: media timeline validation, private-pipe clock alignment, cancellation and reference failure; no playback devices');})().catch(error=>{console.error(error);process.exitCode=1;});
