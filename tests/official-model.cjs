const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {installOfficial}=require('../electron/official-model.cjs');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-official-check-'));
 const original=global.fetch;let calls=0;
 try{
  global.fetch=async()=>{calls++;return new Response('not the official archive',{status:200});};
  await assert.rejects(installOfficial(home,{agreed:false}),/同意/);
  assert.equal(calls,0);assert(!fs.existsSync(path.join(home,'models')));
  await assert.rejects(installOfficial(home,{agreed:true}),/検証/);
  assert.equal(calls,1);
  assert.deepEqual(fs.readdirSync(path.join(home,'models')),[]);
  console.log('PASS explicit consent required before network access; invalid download leaves no installed model');
 }finally{
  global.fetch=original;
  assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(home,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
