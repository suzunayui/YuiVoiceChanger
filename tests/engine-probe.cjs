const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {playEngineProbe}=require('../electron/engine-probe.cjs');
async function scenario(kind){
 const events=new EventEmitter(),controller=new AbortController(),commands=[],progress=[];let stopped=0,id;
 const send=event=>events.emit('event',event);
 const request=(command,data={})=>{
  commands.push(command);
  if(command==='sync-test-start'){
   id=data.id;assert.match(id,/^[a-f0-9-]{36}$/);assert.equal(data.device_name,'Fixture output');
   send({type:'sync-test',id:'unrelated',phase:'completed'});
   send({type:'sync-test',id,phase:'testing',progress:.4});
   if(kind==='success')setImmediate(()=>send({type:'sync-test',id,phase:'completed'}));
   if(kind==='failed')setImmediate(()=>send({type:'sync-test',id,phase:'failed',message:'fixture playback failure'}));
   if(kind==='stopped')setImmediate(()=>send({type:'state',state:'stopped'}));
   if(kind==='cancel')setImmediate(()=>controller.abort());
  }else if(command==='sync-test-cancel'&&kind==='cancel')setImmediate(()=>send({type:'sync-test',id,phase:'cancelled'}));
 };
 if(kind==='pre-cancel')controller.abort();
 const promise=playEngineProbe({events,request,isRunning:()=>kind!=='not-running',stopEngine:async()=>{stopped++;},signal:controller.signal,onProgress:event=>progress.push(event),device_name:'Fixture output',timeout:kind==='timeout'?10:1000,cancelTimeout:10});
 if(kind==='success')assert.equal((await promise).phase,'completed');
 else await assert.rejects(promise,kind==='failed'?/fixture playback/:kind==='timeout'?/時間切れ/:/停止|中止|開始/);
 assert.equal(events.listenerCount('event'),0);
 assert.equal(stopped,['timeout','stopped'].includes(kind)?1:0);
 assert.equal(commands.includes('sync-test-start'),!['pre-cancel','not-running'].includes(kind));
 assert.equal(commands.includes('sync-test-cancel'),['cancel','timeout','stopped'].includes(kind));
 assert.equal(progress.length,['pre-cancel','not-running'].includes(kind)?0:1);
}
(async()=>{for(const kind of ['success','failed','stopped','cancel','timeout','pre-cancel','not-running'])await scenario(kind);console.log('PASS test-voice IPC: real session IDs, progress, acknowledgement before cancellation cleanup, timeout fallback, stopped engine and listener cleanup');})().catch(error=>{console.error(error);process.exitCode=1;});
