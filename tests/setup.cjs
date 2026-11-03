const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {download,run,PYTHON}=require('../electron/setup.cjs');
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
  console.log('PASS streamed download digest, failed digest cleanup, startup error handling');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
