const assert=require('node:assert/strict');
const {ObsSyncServer}=require('./helpers/obs-sync-server.cjs');
const {ObsLink}=require('../electron/obs-link.cjs');
const {normalize}=require('../electron/config.cjs');

(async()=>{
 const server=await new ObsSyncServer().ready;
 const joysound={inputUuid:'joy',inputName:'カラオケJOYSOUND for STREAMER',inputKind:'spout_capture',noAudio:true};
 server.inputs.push(joysound);
 const original={filterName:'既存の遅延',filterKind:'gpu_delay',filterEnabled:true,filterSettings:{delay_ms:120}};
 server.filters.set('joy',[structuredClone(original)]);
 const obs=new ObsLink();
 const config=normalize({obs_port:server.port,obs_enabled:true,mix_enabled:true,mix_voice_uuid:'voice',obs_input_uuid:'desktop'});
 const delays=()=>server.filters.get('joy').filter(x=>x.filterName.startsWith('YUI映像同期 ')).map(x=>x.filterSettings.delay_ms);
 try{
  obs.configure({...config,obs_enabled:false},true);await obs.flush();
  assert.deepEqual(delays(),[500]);
  assert(!server.records.some(x=>x.type==='SetInputAudioTracks'));
  obs.configure(config,true);await obs.flush();
  assert.deepEqual(delays(),[500]);assert.equal(obs.status().appliedVideoOffset,500);
  assert.deepEqual(obs.status().autoVideoSources,[joysound.inputName]);
  assert.equal(server.filters.get('joy')[0].filterEnabled,false);
  assert.deepEqual(server.filters.get('video'),[]);
  obs.configure({...config,mix_latency_ms:950,obs_video_enabled:true,obs_video_sources:[{id:'manual',inputName:joysound.inputName,inputUuid:'joy'}]},true);
  await obs.flush();assert.deepEqual(delays(),[500,450]);
  for(const [correction,expected,target] of [[140,[500,140],640],[-180,[320],320],[-800,[],0]]){
   obs.configure({...config,obs_enabled:false,obs_video_correction_ms:correction},true);
   await obs.flush();
   assert.deepEqual(delays(),expected);
   assert.equal(obs.status().appliedVideoOffset,target);
  }
  obs.configure(config,false);await obs.flush();assert.deepEqual(server.filters.get('joy'),[original]);
  assert.deepEqual(obs.status().autoVideoSources,[]);
  console.log('PASS JOYSOUND Spout auto-detection, 500 ms, split delays, deduplication and restoration');
 }finally{await obs.shutdown();await server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
