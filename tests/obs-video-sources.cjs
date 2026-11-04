const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsSocket}=require('../electron/obs-link.cjs');
const {ObsVideoDelay}=require('../electron/obs-video-delay.cjs');
const {ObsVideoSources}=require('../electron/obs-video-sources.cjs');
const {normalize}=require('../electron/config.cjs');
const {Presets}=require('../electron/presets.cjs');
const {ObsServer}=require('./helpers/obs-server.cjs');
const selected=[{id:'joysound',inputUuid:'video',inputName:'映像のみ'},{id:'avatar',inputUuid:'camera',inputName:'3Dモデル'}];
const parts=(server,key)=>server.filters.get(key).filter(item=>item.filterName.startsWith('YUI映像同期 ')).map(item=>item.filterSettings.delay_ms);
(async()=>{
 const old=normalize({obs_video_enabled:true,obs_video_uuid:'video',obs_video_name:'映像のみ'});assert.equal(old.obs_video_sources[0].inputUuid,'video');assert(!('offset_ms' in old.obs_video_sources[0]));assert(!('obs_video_uuid' in old));
 assert.deepEqual(normalize({obs_video_sources:selected.map(item=>({...item,offset_ms:-30}))}).obs_video_sources,selected);
 const config=normalize({obs_video_enabled:true,obs_video_sources:selected});assert.deepEqual(config.obs_video_sources,selected);assert.notEqual(config.obs_video_sources,selected);
 for(const list of [null,{},Array(9).fill(selected[0]),[selected[0],selected[0]],[selected[0],{...selected[1],inputUuid:'video'}],[{...selected[0],offset_ms:-1001}],[{...selected[0],inputName:'bad\nname'}],[{...selected[0],offset_ms:.5}]])assert.throws(()=>normalize({obs_video_sources:list}));
 assert.deepEqual(normalize({obs_video_sources:[],obs_video_uuid:'old',obs_video_name:'old'}).obs_video_sources,[]);
 const server=await new ObsServer({auth:false}).ready,home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-many-video-'));
 server.inputs.push({inputUuid:'camera',inputName:'3Dモデル',noAudio:true,inputKind:'dshow_input',offset:0});server.filters.set('camera',[]);
 const original={filterName:'元の映像遅延',filterKind:'gpu_delay',filterEnabled:true,filterSettings:{delay_ms:300}};server.filters.set('video',[structuredClone(original)]);
 const connection=new ObsSocket(server.port,'',{timeout:100});await connection.ready;
 try{
  // A previously installed single-source version can leave recovery information.
  const legacy=new ObsVideoDelay(home);await legacy.apply(connection,selected[0],519);
  const manager=new ObsVideoSources(home);await manager.apply(connection,selected,519,()=>true);
  assert.deepEqual(parts(server,'video'),[500,19]);assert.deepEqual(parts(server,'camera'),[500,19]);assert(!fs.existsSync(path.join(home,'obs-video-delay.json')));
  assert.equal(fs.readdirSync(path.join(home,'obs-video-delays')).length,2);
  const before=server.records.length;await manager.apply(connection,selected,519,()=>true);
  assert.equal(server.records.length,before,'Unchanged sources must not recreate filters');
  await manager.apply(connection,[selected[1]],519,()=>true);assert.deepEqual(server.filters.get('video'),[original]);assert.deepEqual(parts(server,'camera'),[500,19]);
  assert(!server.records.some(item=>item.type==='RemoveInput'));
  await manager.apply(connection,[selected[1]],1014,()=>true);assert.deepEqual(parts(server,'camera'),[500,500,14]);
  await manager.apply(connection,selected,519,()=>true);
  const recovered=new ObsVideoSources(home);assert(recovered.pending);await recovered.restore(connection);assert.deepEqual(server.filters.get('video'),[original]);assert.deepEqual(server.filters.get('camera'),[]);assert(!recovered.pending);
  await recovered.apply(connection,selected,519,()=>true);server.ignore='RemoveSourceFilter';await assert.rejects(recovered.restore(connection),/時間切れ/);
  server.ignore='';const partial=new ObsVideoSources(home);await partial.restore(connection);assert.deepEqual(server.filters.get('video'),[original]);assert.deepEqual(server.filters.get('camera'),[]);
  await partial.apply(connection,selected,519,()=>true);const writes=server.records.length;
  await assert.rejects(partial.apply(connection,selected,-1,()=>true),/負の補正/);assert.equal(server.records.length,writes);
  await partial.apply(connection,[],519,()=>true);assert.deepEqual(server.filters.get('video'),[original]);assert.deepEqual(server.filters.get('camera'),[]);
  const store=new Presets(home),id=store.save({name:'歌枠用',config});store.markApplied(id);assert.equal(new Presets(home).list(normalize(config))[0].active,true);
  assert.deepEqual(new Presets(home).get(id).settings.obs_video_sources,selected);
  const saved=JSON.parse(fs.readFileSync(store.file));saved.presets[0].settings.obs_video_uuid='video';saved.presets[0].settings.obs_video_name='旧ウィンドウ';delete saved.presets[0].settings.obs_video_sources;fs.writeFileSync(store.file,JSON.stringify(saved));assert.equal(new Presets(home).get(id).settings.obs_video_sources[0].inputName,'旧ウィンドウ');
  console.log('PASS multiple video sources: window and capture-device delays, per-source offsets, removal without deleting OBS inputs, no repeated work, single-source migration, multi-file crash/partial recovery, validation and preset persistence');
 }finally{server.ignore='';connection.close();await server.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
