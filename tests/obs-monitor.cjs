const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsMonitor}=require('../electron/obs-monitor.cjs');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-monitor-')),file=path.join(home,'normal.mkv');fs.writeFileSync(file,'fixture');
 const events=new EventEmitter(),calls=[],notices=[],workerCommands=[];let running=true,recording=true,child;
 const config={python:'fixture-python',singing_enabled:true,obs_input_uuid:'music'};
 const obs={connection:{identified:true,request:async(type,data)=>{
  calls.push(type);assert(type.startsWith('Get'),'Passive monitor must never mutate OBS');
  if(type==='GetInputList')return {inputs:[{inputName:'伴奏',inputUuid:'music'},{inputName:'マイク',inputUuid:'voice'}]};
  if(type==='GetInputSettings')return {inputKind:'wasapi_output_capture',inputSettings:{device_id:'default'}};
  if(type==='GetProfileList')return {currentProfileName:'normal'};
  if(type==='GetProfileParameter')return {parameterValue:({Mode:'Simple',RecFormat2:'mkv',RecTracks:'1'})[data.parameterName]};
  if(type==='GetInputAudioTracks')return {inputAudioTracks:{1:true}};
  if(type==='GetInputMute')return {inputMuted:false};
  if(type==='GetRecordStatus')return {outputActive:recording,outputPaused:false};
  if(type==='GetOutputList')return {outputs:[{outputName:'simple_file_output'}]};
  if(type==='GetOutputSettings')return {outputSettings:{path:file}};
  throw Error(type);
 }}};
 const monitor=new ObsMonitor({obs,engineRoot:home,events,isRunning:()=>running,ffmpeg:()=>file,notify:e=>notices.push(e),interval:10,
  request:(command,{id})=>{workerCommands.push(command);events.emit('event',{type:'passive-reference',id,voice:command==='passive-snapshot'?{time:100,samples:'',valid:''}:null});},
  spawnProcess:()=>{child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let stopped=false;
   child.kill=()=>{if(!stopped){stopped=true;child.emit('exit',0);}return true;};
   child.stdin=new Writable({write(data,encoding,done){const q=JSON.parse(data.toString());if(q.command==='measure')child.stdout.write(JSON.stringify({phase:'measured',delta_ms:-85,age_s:8,spread_ms:2})+'\n');else if(q.command==='stop')setImmediate(()=>child.kill());else setImmediate(()=>child.stdout.write('{"phase":"ready"}\n'));done();}});return child;}
 });
 try{
  await monitor.start(config,{voice:'voice'});
  for(let i=0;i<100&&monitor.status().phase!=='measured';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(monitor.status().delta_ms,-85);assert.equal(monitor.status().active,true);assert(recording);
  assert(workerCommands.includes('passive-snapshot'));assert(!workerCommands.includes('sync-test-start'));
  recording=false;await new Promise(r=>setTimeout(r,50));assert.equal(monitor.status().phase,'waiting');assert(!('delta_ms' in monitor.status()));
  assert(monitor.status().active,'Waiting for recording must not stop voice or monitoring');
  await monitor.stop();assert(!monitor.active);assert(workerCommands.includes('passive-stop'));assert(calls.every(x=>x.startsWith('Get')));
  await monitor.start(config,{voice:'voice'});running=false;events.emit('event',{type:'state',state:'stopped'});await monitor.stop();assert(!monitor.active);
  await assert.rejects(()=>monitor.start({...config,singing_enabled:false},{voice:'voice'}),/固定遅延/);
  console.log('PASS passive monitor: signed result, no OBS/recording writes, recording wait, engine stop and cleanup');
 }finally{await monitor.shutdown();fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
