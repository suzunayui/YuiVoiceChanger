const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const {LatencyCalibration}=require('../electron/latency-calibration.cjs');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-calibration-manager-'));
 const python=path.join(home,'python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 const config={python,beatrice_model:model,input:0,output:1};let spawns=0,kills=0,applied=0;
 const factory=mode=>()=>{
  spawns++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let ended=false;
  const exit=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}};
  const emit=event=>child.stdout.write(JSON.stringify(event)+'\n');
  child.kill=()=>{kills++;setImmediate(exit);};
  child.stdin=new Writable({write(data,encoding,done){
   const message=JSON.parse(data.toString());
   if(mode==='invalid'&&!message.command){emit({phase:'completed',recommended_ms:5000});setImmediate(exit);}
   if(mode==='late'&&message.command==='cancel'){emit({phase:'completed',recommended_ms:320});setImmediate(exit);}
   done();
  }});return child;
 };
 const options={engineRoot:path.resolve('.'),onComplete:()=>{applied++;},timeout:500,cancelTimeout:10};
 try{
  for(const mode of ['hang','late']){
   const manager=new LatencyCalibration({...options,spawnProcess:factory(mode)});
   for(let index=0;index<2;index++){manager.start(config);await new Promise(resolve=>setImmediate(resolve));manager.cancel();await manager.task;assert.equal(manager.status().phase,'cancelled');assert.equal(manager.busy,false);}
  }
  assert.equal(kills,2);assert.equal(applied,0);
  const invalid=new LatencyCalibration({...options,spawnProcess:factory('invalid')});invalid.start(config);await invalid.task;assert.equal(invalid.status().phase,'failed');assert.equal(applied,0);
  const timed=new LatencyCalibration({...options,timeout:10,spawnProcess:factory('hang')});timed.start(config);await timed.task;assert.match(timed.status().message,/時間切れ/);
  let release;const before=new Promise(resolve=>release=resolve),count=spawns;
  const preparing=new LatencyCalibration({...options,beforeStart:()=>before,spawnProcess:factory('hang')});preparing.start(config);preparing.cancel();release();await preparing.task;assert.equal(spawns,count);assert.equal(preparing.status().phase,'cancelled');
  const shutdown=new LatencyCalibration({...options,spawnProcess:factory('hang')});shutdown.start(config);await new Promise(resolve=>setImmediate(resolve));await shutdown.shutdown();assert.equal(shutdown.status().phase,'cancelled');
  assert.throws(()=>shutdown.start({...config,python:''}));assert.throws(()=>shutdown.start({...config,input:-1}));
  console.log('PASS calibration lifecycle: repeated cancellation, late results ignored, invalid result rejected, timeout/quit cleanup and cancellation before any microphone process starts');
 }finally{fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
