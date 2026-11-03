// Exercise the shipped setup on a native Mac runner; never start a microphone.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {setup,validate}=require('../electron/setup.cjs');
(async()=>{
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 const home=path.resolve(process.argv[2]);
 const result=await setup(home,message=>console.log(message));
 const info=await validate(result.python);
 assert.equal(info.python,'3.15.2');assert.equal(info.device,'cpu');
 const again=await setup(home,message=>console.log(message));assert.equal(again.python,result.python);
 if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,`MAC_RUNTIME_PYTHON=${result.python}\n`);
 console.log('PASS native Apple Silicon automatic setup, CPU imports and cached reuse:',JSON.stringify(info));
})().catch(error=>{console.error(error);process.exitCode=1;});
