const assert=require('node:assert/strict');
const {ObsMix}=require('../electron/obs-mix.cjs');
const tracks=(...enabled)=>Object.fromEntries([1,2,3,4,5,6].map(n=>[n,enabled.includes(n)]));
(async()=>{
 const music={inputUuid:'music'},voice={inputUuid:'voice'};
 const inputs={music:{inputAudioTracks:tracks(1)},voice:{inputAudioTracks:tracks(2),inputAudioSyncOffset:140,monitorType:'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT',inputMuted:true}};
 const before=structuredClone(inputs);let fail=false;
 const fields={AudioTracks:'inputAudioTracks',AudioSyncOffset:'inputAudioSyncOffset',AudioMonitorType:'monitorType',Mute:'inputMuted'};
 const connection={identified:true,port:4455,request:async(type,request)=>{
  const field=fields[type.slice(8)],input=inputs[request.inputUuid];assert(field,type);
  if(type.startsWith('Get'))return {[field]:structuredClone(input[field])};
  if(fail&&type==='SetInputAudioMonitorType'){fail=false;throw Error('test failure');}
  input[field]=structuredClone(request[field]);
 }};
 const mix=new ObsMix();await mix.apply(connection,music,voice);
 assert.deepEqual(inputs.music.inputAudioTracks,tracks());assert.deepEqual(inputs.voice.inputAudioTracks,tracks(1,2));
 assert.equal(inputs.voice.inputAudioSyncOffset,0);assert.equal(inputs.voice.inputMuted,false);assert.equal(inputs.voice.monitorType,'OBS_MONITORING_TYPE_NONE');
 await mix.restore(connection);assert.deepEqual(inputs,before);
 fail=true;await assert.rejects(()=>mix.apply(connection,music,voice),/test failure/);assert.deepEqual(inputs,before);
 console.log('PASS mix route replaces duplicate accompaniment, preserves both output tracks and restores on stop or failure');
})().catch(error=>{console.error(error);process.exitCode=1;});
