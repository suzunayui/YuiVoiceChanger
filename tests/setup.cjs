const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {download,run,setup,removeStaleRuntimes,PYTHON}=require('../electron/setup.cjs');
(async()=>{
 assert.equal(PYTHON,'3.15.2');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-download-'));
 const data=Buffer.from('verified runtime fixture');
 const server=http.createServer((req,res)=>res.end(data));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url=`http://127.0.0.1:${server.address().port}/fixture`;
  const file=path.join(home,'tool.zip');
  await download(url,file,crypto.createHash('sha256').update(data).digest('hex'));
  assert.deepEqual(fs.readFileSync(file),data);
  await assert.rejects(download(url,path.join(home,'bad.zip'),'0'.repeat(64)),/検証/);
  assert(!fs.existsSync(path.join(home,'bad.zip')));assert(!fs.existsSync(path.join(home,'bad.zip.partial')));
  await assert.rejects(run(path.join(home,'missing.exe'),[]),/起動できません/);
  const running=new AbortController();
  const started=Date.now();
  const stopped=run(process.execPath,['-e','setTimeout(()=>{},60000)'],{signal:running.signal});
  setTimeout(()=>running.abort(),100);
  await assert.rejects(stopped,/中止/);assert(Date.now()-started<10000,'cancel does not wait for the command');
  const cancelled=new AbortController();cancelled.abort();
  const cancelHome=path.join(home,'cancel');
  await assert.rejects(setup(cancelHome,()=>{},{signal:cancelled.signal}),/中止/);
  assert.deepEqual(fs.readdirSync(path.join(cancelHome,'runtime')),[],'a cancelled attempt leaves no environment behind');
  const stale=path.join(home,'stale'),keep='direct-gpu-11111111-1111-4111-8111-111111111111',old='direct-gpu-22222222-2222-4222-8222-222222222222';
  for(const name of [keep,old,'onnx-helper-3.14','python','uv-cache'])fs.mkdirSync(path.join(stale,name),{recursive:true});
  fs.writeFileSync(path.join(stale,'direct-gpu-runtime.json'),'{}');
  await removeStaleRuntimes(stale,keep);
  assert.deepEqual(fs.readdirSync(stale).sort(),[keep,'direct-gpu-runtime.json','onnx-helper-3.14','python','uv-cache'].sort());
  console.log('PASS streamed download digest, failed digest cleanup, startup error handling, cancel, cleanup of old environments only');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
