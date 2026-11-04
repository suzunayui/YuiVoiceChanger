const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {ObsLink}=require('../electron/obs-link.cjs'),{ObsSync}=require('../electron/obs-sync.cjs'),{normalize}=require('../electron/config.cjs');
const {ObsSyncServer}=require('./helpers/obs-sync-server.cjs');
async function scenario(kind){
 const server=await new ObsSyncServer().ready,home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-verify-'));
 const config=normalize({python:'fixture.exe',singing_enabled:true,singing_latency_ms:380,obs_enabled:true,obs_port:server.port,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声'});
 const obs=new ObsLink({home});obs.configure(config,true);
 let saves=0,analyses=0,plays=0;const targets=[],phases=[];
 const sequence={cold:[450,452,35,37,34],unstable:[120,600,-100,700,-100],stable:[120,120,120]}[kind]||[120,120,120];
 const sync=new ObsSync({home,engineRoot:path.resolve('.'),obs,isRunning:()=>true,notify:event=>phases.push(event.phase),
  onComplete:result=>{if(kind==='save-error')throw Error('fixture save error');saves++;return {...config,obs_correction_ms:result.correction_ms};},
  playTest:async(request,progress)=>{
   plays++;targets.push(server.get('desktop').offset);assert.equal(saves,0,'Nothing is saved before post-apply verification');
   progress({phase:'testing',progress:.5});
   if(request.verification&&kind==='cancel')sync.cancel();
  }});
 sync.ffmpeg=()=> 'fixture-ffmpeg.exe';sync.waitForStability=async()=>sync.check();
 sync.python=async()=>({phase:'completed',method:'injected-voice',correction_ms:sequence[analyses++]??120,spread_ms:2,matched:kind==='invalid'&&analyses>1?5:8});
 try{
  await obs.connect({port:server.port,password:'',remember:false});await obs.flush();
  const originalTracks=server.inputs.map(input=>structuredClone(input.tracks)),parameters=structuredClone(server.parameters);
  sync.start(config,{voice:'voice'});await sync.task;await obs.flush();
  const success=['stable','cold'].includes(kind);assert.equal(saves,success?1:0);
  assert.equal(sync.status().phase,success?'completed':kind==='cancel'?'cancelled':'failed');
  if(success){
   assert.equal(sync.status().result.verified,true);
   assert(Math.abs(sync.status().result.verification_residual_ms)<=15);
   assert.equal(server.get('desktop').offset,kind==='cold'?415:500);
   assert.deepEqual(targets,kind==='cold'?[380,380,831,415,415]:[380,500,500]);
  }else assert.equal(server.get('desktop').offset,380,'Failed or cancelled candidates are rolled back');
  assert.equal(server.recording,false);assert.deepEqual(server.profiles,['Original']);assert.deepEqual(server.parameters,parameters);
  assert.deepEqual(server.inputs.map(input=>input.tracks),originalTracks);assert(!fs.existsSync(sync.journalFile));
  assert(phases.includes('verifying'));
 }finally{await obs.shutdown();assert.equal(server.get('desktop').offset,23);await server.close();fs.rmSync(home,{recursive:true,force:true});}
}
(async()=>{for(const kind of ['stable','cold','unstable','cancel','invalid','save-error'])await scenario(kind);console.log('PASS post-apply OBS verification: cold-start offset changes, two consecutive passing recordings, no early save, cancellation/failure rollback and recording/profile restoration');})().catch(error=>{console.error(error);process.exitCode=1;});
