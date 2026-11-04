const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsLink}=require('../electron/obs-link.cjs'),{ObsSync}=require('../electron/obs-sync.cjs'),{normalize}=require('../electron/config.cjs'),{ObsSyncServer}=require('./helpers/obs-sync-server.cjs');
async function scenario(kind){
 const server=await new ObsSyncServer().ready,home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-broadcast-'));
 const config=normalize({python:'fixture',output_name:kind==='speakers'?'Speakers':'CABLE Input',singing_enabled:true,singing_latency_ms:380,obs_enabled:true,obs_port:server.port,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声'});
 const obs=new ObsLink({home});obs.configure(config,true);let saved=0,played=0,cleared=0;
 const sync=new ObsSync({home,engineRoot:path.resolve('.'),obs,isRunning:()=>true,resetEngine:async()=>{cleared++;assert.equal(server.get('voice').tracks['1'],false,'Voice remains isolated until pending test audio has been discarded');},onComplete:result=>{saved++;return {...config,obs_correction_ms:result.correction_ms};},playTest:async(request)=>{
  played++;const track=sync.journal.privateTrack,reference=server.inputs.find(input=>input.inputName.startsWith('YUI同期測定_目印_'));
  assert.equal(server.streaming,true);assert.equal(server.get('desktop').tracks['1'],true,'Accompaniment remains on the live stream');
  assert.equal(server.get('voice').tracks['1'],false);assert.equal(server.get('voice').tracks[String(track)],true);assert.equal(server.get('voice').balance,1);
  for(const input of [server.get('voice'),reference])for(let n=1;n<=6;n++)assert.equal(input.tracks[String(n)],n===track,'No test source reaches any other track');
  assert.equal(reference.balance,0);assert.equal(server.parameters['SimpleOutput/RecTracks'],String(1<<(track-1)));
  assert.equal(server.records.filter(item=>['CreateProfile','SetCurrentProfile','RemoveProfile'].includes(item.type)).length,0,'A live stream never switches profiles');
  if(kind==='cancel')sync.cancel();
  if(kind==='route-change')server.get('voice').tracks['1']=true;
 }});
 sync.ffmpeg=()=> 'fixture-ffmpeg';sync.waitForStability=async()=>sync.check();
 sync.python=async(_,query)=>{assert.equal(query.mode,'analyze-stereo-probe');assert.equal(server.get('voice').tracks['1'],false);return {correction_ms:120,spread_ms:2,matched:8};};
 try{
  await obs.connect({port:server.port,password:'',remember:false});await obs.flush();
  const settings=structuredClone(server.parameters),tracks=server.inputs.map(input=>structuredClone(input.tracks));
  if(kind!=='unprepared')assert.equal(await sync.broadcast.prepare(),true);
  if(kind!=='unprepared'){
   for(const socket of server.server.clients)socket.send(JSON.stringify({op:5,d:{eventType:'StreamStateChanged',eventData:{outputActive:false,outputState:'OBS_WEBSOCKET_OUTPUT_STARTING'}}}));
   await new Promise(resolve=>setTimeout(resolve,5));assert(sync.broadcast.ready,'Starting is not the stopped event');
  }
  assert.deepEqual(server.parameters,settings);assert.equal(server.recording,false);assert(!fs.existsSync(sync.journalFile));
  if(kind==='used-track')server.parameters['Stream1/EnableMultitrackVideo']='true';
  if(kind==='long-effect')server.filters.set('voice',[{filterName:'Long reverb',filterKind:'vst_filter',filterEnabled:true,filterSettings:{}}]);
  server.records=[];server.streaming=true;
  sync.start(config,{voice:'voice'});await sync.task;await obs.flush();
  const success=kind==='success';assert.equal(sync.status().phase,success?'completed':kind==='cancel'?'cancelled':'failed');assert.equal(saved,success?1:0);
  assert.equal(played,['unprepared','used-track','speakers','long-effect'].includes(kind)?0:kind==='success'?3:1);assert.equal(server.streaming,true,'Never stop the stream');
  assert.equal(server.recording,false);assert.equal(server.get('voice').balance??.5,.5);assert.equal(cleared,['unprepared','used-track','speakers','long-effect'].includes(kind)?0:1);
  if(kind==='used-track')delete server.parameters['Stream1/EnableMultitrackVideo'];
  assert.deepEqual(server.parameters,settings);assert(!server.inputs.some(input=>input.inputName.startsWith('YUI同期測定_')));
  if(kind!=='route-change')assert.deepEqual(server.inputs.map(input=>input.tracks),tracks);
  assert(!server.records.some(item=>['StopStream','CreateProfile','RemoveProfile','SetCurrentProfile'].includes(item.type)));
 }finally{server.streaming=false;await obs.shutdown();await server.close();fs.rmSync(home,{recursive:true,force:true});}
}
(async()=>{for(const kind of ['success','cancel','route-change','unprepared','used-track','speakers','long-effect'])await scenario(kind);console.log('PASS broadcast calibration: preflight recorder binding, stereo private track, voice isolation until drain, uninterrupted accompaniment/stream, two verified passes, cancellation, route change, unprepared/speaker/unsafe track/effect rejection; no plugins or devices');})().catch(error=>{console.error(error);process.exitCode=1;});
