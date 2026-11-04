const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ObsLink}=require('../electron/obs-link.cjs');
const {normalize,liveControls}=require('../electron/config.cjs');
const {ObsServer}=require('./helpers/obs-server.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate){for(let count=0;count<150;count++){if(predicate())return;await delay(20);}throw Error('Expected OBS state did not arrive.');}
(async()=>{
 const server=await new ObsServer().ready;
 let secret='';const events=[];
 const link=new ObsLink({notify:event=>events.push(event),credentials:{load:()=>secret,save:(value,remember)=>secret=remember?value:'',available:()=>true},timeout:250,reconnectDelay:60});
 let config=normalize({obs_port:server.port,singing_enabled:true,singing_latency_ms:500,obs_correction_ms:20,obs_input_uuid:'desktop',obs_input_name:'デスクトップ音声'});
 try{
  link.configure(config,false);await link.connect({port:server.port,password:server.password,remember:true});
  assert.equal(link.status().state,'connected');assert.equal(secret,server.password);
  assert.equal(link.status().inputs.length,3);assert.equal(server.writes().length,0);
  config={...config,obs_enabled:true};link.configure(config,true);await link.flush();
  assert.equal(server.get('desktop').offset,520);assert.equal(server.get('voice').offset,0);
  const firstWrites=server.writes().length;await link.flush();assert.equal(server.writes().length,firstWrites);
  config={...config,obs_correction_ms:30};link.configure(config,true);await link.flush();assert.equal(server.get('desktop').offset,530);
  server.get('desktop').inputName='名前を変更した伴奏';await link.refresh();assert.equal(server.get('desktop').offset,530);
  link.configure(config,false);await link.flush();assert.equal(server.get('desktop').offset,23);
  config={...config,obs_input_uuid:'music',obs_input_name:'伴奏ブラウザー'};link.configure(config,true);await link.flush();assert.equal(server.get('music').offset,530);
  server.get('music').offset=777;link.configure({...config,obs_enabled:false},true);await link.flush();assert.equal(server.get('music').offset,777);
  assert(events.some(event=>event.message==='OBS側で変更された値を保持しました。'));
  server.get('music').offset=35;link.configure(config,true);await link.flush();
  server.drop();await until(()=>link.status().state==='disconnected');await until(()=>link.status().appliedOffset===530&&link.status().state==='connected');
  link.configure(config,false);await link.flush();assert.equal(server.get('music').offset,35);
  const before=server.writes().length;server.delayGet=80;link.configure(config,true);const pending=link.flush();await delay(20);link.configure({...config,obs_enabled:false},false);await pending;await link.flush();assert.equal(server.writes().length,before);
  config={...config,obs_input_uuid:'missing',obs_input_name:'削除された伴奏'};link.configure(config,true);await assert.rejects(link.flush(),/見つかりません/);assert.equal(server.writes().length,before);
  config={...config,obs_input_uuid:'music',obs_input_name:'伴奏ブラウザー'};server.ignore='SetInputAudioSyncOffset';link.configure(config,true);await assert.rejects(link.flush(),/時間切れ/);assert.equal(server.get('music').offset,530);
  server.ignore='';await link.flush();link.configure(config,false);await link.flush();assert.equal(server.get('music').offset,35);
  server.kick();await until(()=>link.status().state==='disconnected');const connections=server.connections;await delay(180);assert.equal(server.connections,connections);
  await link.connect({port:server.port,remember:true});assert.equal(link.status().state,'connected');
  link.configure(config,true);await link.flush();await link.shutdown();assert.equal(server.get('music').offset,35);
  assert(events.every(event=>event.type==='obs-status'));
  const wrong=new ObsLink({timeout:250,reconnectDelay:30});wrong.configure({...config,obs_enabled:true},false);
  await assert.rejects(wrong.connect({port:server.port,password:'wrong'}),/パスワード/);const failed=server.connections;await delay(100);assert.equal(server.connections,failed);await wrong.shutdown();
  const base=normalize({});assert.equal(liveControls(base,normalize({...base,obs_enabled:true,obs_correction_ms:20}),'running'),null);
  for(const bad of [{obs_port:0},{obs_port:1.5},{obs_port:65536},{obs_correction_ms:1001},{obs_enabled:1},{obs_input_name:'bad\nname'}])assert.throws(()=>normalize(bad));
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-obs-password-'));
  try{
   const {passwordStore}=require('../electron/obs-password.cjs');
   const store=passwordStore(home,{isEncryptionAvailable:()=>true,encryptString:value=>{assert.equal(value,'test-secret');return Buffer.from('encrypted fixture');},decryptString:value=>{assert.equal(value.toString(),'encrypted fixture');return 'test-secret';}});
   store.save('test-secret',true);assert.equal(store.load(),'test-secret');assert(!fs.readFileSync(path.join(home,'obs-password.bin')).includes('test-secret'));store.save('',false);assert.equal(store.load(),'');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
  const openServer=await new ObsServer({auth:false}).ready,openLink=new ObsLink({timeout:250});
  try{openLink.configure(normalize({obs_port:openServer.port}),false);await openLink.connect({port:openServer.port,password:'',remember:false});assert.equal(openLink.status().state,'connected');assert.equal(openServer.writes().length,0);}
  finally{await openLink.shutdown();await openServer.close();}
  const startup=new ObsLink({credentials:{load:()=>'late-password',available:()=>true},timeout:250,reconnectDelay:50});
  let lateServer;
  try{
   startup.configure(normalize({obs_port:openServer.port}),false);
   await assert.rejects(startup.flush());
   lateServer=await new ObsServer({port:openServer.port,password:'late-password'}).ready;
   await until(()=>startup.status().state==='connected');
   assert.equal(lateServer.writes().length,0);
   await startup.disconnect();
   const connections=lateServer.connections;
   await startup.flush();await delay(160);
   assert.equal(lateServer.connections,connections);
  }finally{await startup.shutdown();if(lateServer)await lateServer.close();}
  console.log('PASS actual WebSocket auth/RPC, audio source filtering, fixed+correction, no repeated writes, UUID rename, restore, external edits, reconnect/kick, stale updates, timeouts, validation and password storage');
 }finally{await link.shutdown();await server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
