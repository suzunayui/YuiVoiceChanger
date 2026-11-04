const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsLink,ObsSocket}=require('../electron/obs-link.cjs');
const {ObsVideoDelay,delayParts}=require('../electron/obs-video-delay.cjs');
const {normalize}=require('../electron/config.cjs');
const {Presets}=require('../electron/presets.cjs');
const {ObsServer}=require('./helpers/obs-server.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let index=0;index<150;index++){if(check())return;await pause(20);}throw Error('Expected video sync state');}
const userFilters=()=>[
 {filterName:'手動の遅延',filterKind:'gpu_delay',filterEnabled:true,filterSettings:{delay_ms:500}},
 {filterName:'無効の遅延',filterKind:'gpu_delay',filterEnabled:false,filterSettings:{delay_ms:80}},
 {filterName:'クロマキー',filterKind:'chroma_key_filter_v2',filterEnabled:true,filterSettings:{color:123}}
];
const owned=server=>server.filters.get('video').filter(item=>item.filterName.startsWith('YUI映像同期 '));
const delays=server=>owned(server).map(item=>item.filterSettings.delay_ms);
const filterWrites=server=>server.records.filter(item=>['CreateSourceFilter','RemoveSourceFilter','SetSourceFilterEnabled'].includes(item.type));
(async()=>{
 for(const [target,expected] of [[0,[]],[1,[1]],[500,[500]],[519,[500,19]],[1000,[500,500]],[1014,[500,500,14]],[3000,Array(6).fill(500)]])assert.deepEqual(delayParts(target),expected);
 for(const bad of [-1,4001,1.5,NaN,'500'])assert.throws(()=>delayParts(bad));
 for(const bad of [{obs_video_enabled:1},{obs_video_uuid:'bad\nname'},{obs_video_name:'x'.repeat(513)}])assert.throws(()=>normalize(bad));
 const server=await new ObsServer({auth:false}).ready,home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-video-'));
 server.filters.set('video',userFilters());
 const link=new ObsLink({home,timeout:250,reconnectDelay:30});
 let config=normalize({obs_port:server.port,obs_enabled:true,singing_enabled:true,singing_latency_ms:500,obs_correction_ms:19,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声',obs_video_enabled:true,obs_video_uuid:'video',obs_video_name:'映像のみ'});
 try{
  link.configure(config,false);await link.connect({port:server.port,remember:false});assert.equal(filterWrites(server).length,0);assert.equal(link.status().videoInputs.length,1);
  link.configure(config,true);await link.flush();assert.deepEqual(delays(server),[500,19]);assert.equal(link.status().appliedVideoOffset,519);
  assert.equal(server.filters.get('video')[0].filterEnabled,false);assert.equal(server.filters.get('video')[1].filterEnabled,false);assert.equal(server.filters.get('video')[2].filterEnabled,true);
  assert.equal(server.get('desktop').offset,519);assert(link.video.pending);assert(fs.readdirSync(path.join(home,'obs-video-delays')).some(file=>file.endsWith('.json')));
  const writes=filterWrites(server).length;await link.flush();assert.equal(filterWrites(server).length,writes);
  config={...config,obs_correction_ms:514};link.configure(config,true);await link.flush();assert.deepEqual(delays(server),[500,500,14]);assert.equal(server.get('desktop').offset,1014);
  config={...config,obs_correction_ms:0};link.configure(config,true);await link.flush();assert.deepEqual(delays(server),[500]);
  config={...config,singing_latency_ms:200,obs_correction_ms:-200};link.configure(config,true);await link.flush();assert.deepEqual(delays(server),[]);assert.equal(server.filters.get('video')[0].filterEnabled,false);
  config={...config,singing_latency_ms:500,obs_correction_ms:19};link.configure(config,true);await link.flush();
  server.drop();await until(()=>link.status().state==='disconnected');await until(()=>link.status().appliedVideoOffset===519);assert.deepEqual(delays(server),[500,19]);
  link.configure({...config,obs_video_enabled:false},true);await link.flush();assert.deepEqual(server.filters.get('video'),userFilters());assert.equal(server.get('desktop').offset,519);
  link.configure(config,true);await link.flush();await link.disconnect();assert.deepEqual(server.filters.get('video'),userFilters());assert.equal(server.get('desktop').offset,23);assert(!fs.existsSync(path.join(home,'obs-video-delay.json')));
  await link.connect({port:server.port,remember:false});
  server.inputs.push({inputUuid:'video2',inputName:'別のウィンドウ',noAudio:true,offset:0});server.filters.set('video2',[]);await link.refresh();
  link.configure({...config,obs_video_sources:[{id:'second',inputUuid:'video2',inputName:'別のウィンドウ',offset_ms:0}]},true);await link.flush();assert.deepEqual(server.filters.get('video'),userFilters());assert.equal(server.filters.get('video2').length,2);
  link.configure(config,true);await link.flush();assert.equal(server.filters.get('video2').length,0);assert.deepEqual(delays(server),[500,19]);
  link.configure(config,false);await link.flush();assert.deepEqual(server.filters.get('video'),userFilters());

  server.ignore='CreateSourceFilter';link.configure(config,true);await assert.rejects(link.flush(),/時間切れ/);assert.deepEqual(server.filters.get('video'),userFilters());assert(!link.video.pending);
  server.ignore='';await link.flush();assert.deepEqual(delays(server),[500,19]);assert.equal(link.status().error,'');
  owned(server)[0].filterSettings.delay_ms=333;link.configure(config,false);await link.flush();assert.equal(owned(server).length,1);assert.equal(owned(server)[0].filterSettings.delay_ms,333);assert.equal(server.filters.get('video')[0].filterEnabled,true);
  server.filters.set('video',userFilters());
  await link.shutdown();

  const socket=new ObsSocket(server.port,'');await socket.ready;
  try{
   const manager=new ObsVideoDelay(home),input={inputUuid:'video',inputName:'映像のみ'};
   await manager.apply(socket,input,519);server.ignore='RemoveSourceFilter';await assert.rejects(manager.restore(socket),/時間切れ/);assert.equal(manager.record.complete,false);
   server.ignore='';await manager.apply(socket,input,519);assert.deepEqual(delays(server),[500,19]);
   const recovered=new ObsVideoDelay(home);assert(recovered.pending);await recovered.restore(socket);assert.deepEqual(server.filters.get('video'),userFilters());assert(!recovered.pending);
   let checks=0;await recovered.apply(socket,input,519,()=>++checks<4);assert.deepEqual(server.filters.get('video'),userFilters());
   socket.availableRequests=['GetSourceFilterDefaultSettings'];
   server.extraFilterKinds=['yui_preview_delay'];
   for(const installed of [true,false]){
    server.handleRequest=type=>type==='GetSourceFilterDefaultSettings'?{code:installed?100:607}:null;
    await new ObsVideoDelay(home).apply(socket,input,519);
    assert.deepEqual(owned(server).map(item=>item.filterKind),Array(2).fill(installed?'yui_preview_delay':'gpu_delay'));
    await new ObsVideoDelay(home).restore(socket);
    assert.deepEqual(server.filters.get('video'),userFilters());
   }
   await recovered.apply(socket,input,519);server.inputs=server.inputs.filter(item=>item.inputUuid!=='video');await recovered.restore(socket);assert(!recovered.pending);
  }finally{server.ignore='';socket.close();}

  const presets=new Presets(home),id=presets.save({name:'旧プリセット',config:normalize({})});
  const saved=JSON.parse(fs.readFileSync(presets.file));for(const item of saved.presets)for(const key of ['obs_video_enabled','obs_video_sources'])delete item.settings[key];fs.writeFileSync(presets.file,JSON.stringify(saved));
  assert.equal(new Presets(home).get(id).settings.obs_video_enabled,false);
  console.log('PASS real WebSocket video sync: 500ms split, existing-delay suspension/restore, live updates, no duplicates, reconnect, source switching, timeouts/partial restore, crash recovery, stale updates, external edits and legacy presets; no OBS or capture hardware used');
 }finally{server.ignore='';await link.shutdown();await server.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
