// A broken pipe to the audio process must surface as an error, never as a main-process crash.
const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-worker-crash-'));
 const fixture=path.join(home,'fixture');fs.mkdirSync(fixture);
 const python=path.join(home,'fixture-python.exe'),model=path.join(home,'voice.pt.gz');fs.writeFileSync(python,'fixture');fs.writeFileSync(model,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,python,beatrice_model:model,input:0,output:1,input_name:'Fixture mic',output_name:'Fixture out'}));
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'yui-crash-test',version:require('../package.json').version,main:'entry.cjs'}));
 fs.writeFileSync(path.join(fixture,'entry.cjs'),`
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
const original=cp.spawn;global.uncaught=[];global.breakPipe=false;
process.on('uncaughtException',error=>global.uncaught.push(String(error)));
cp.spawn=(file,args,options)=>{
 if(file!==${JSON.stringify(python)})return original(file,args,options);
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 let ended=false;child.kill=()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',0);}return true;};
 const emit=event=>child.stdout.write(JSON.stringify(event)+'\\n');
 const worker=args.some(arg=>arg.endsWith('worker.py'));
 child.stdin=new Writable({write(chunk,encoding,done){
  if(global.breakPipe){
   done(Object.assign(Error('write EPIPE'),{code:'EPIPE'}));
   setImmediate(()=>{if(!ended){ended=true;child.stdout.end();child.stderr.end();child.emit('exit',3);}});
   return;
  }
  for(const line of chunk.toString().trim().split('\\n')){
   const request=JSON.parse(line);
   if(request.command==='devices')emit({type:'devices',devices:[{id:0,name:'Fixture mic',host:'Windows WASAPI',inputs:1,outputs:0},{id:1,name:'Fixture out',host:'Windows WASAPI',inputs:0,outputs:2}]});
   if(request.command==='start')emit({type:'state',state:'running',device:'CPU',budget_ms:80,schedule_ms:160});
   if(request.command==='stop')emit({type:'state',state:'stopped'});
   if(request.command==='quit')setImmediate(()=>child.kill());
  }done();
 }});
 setImmediate(()=>{if(worker)emit({type:'ready'});else{child.stdout.write(JSON.stringify({devices:[]})+'\\n');child.kill();}});
 return child;
};
require(${JSON.stringify(path.resolve('electron/main.cjs'))});
`);
 const app=await electron.launch({args:[fixture],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  await page.getByRole('button',{name:/声変換をはじめる/}).click();
  await page.getByRole('button',{name:/停止する/}).waitFor();
  await app.evaluate(()=>{global.breakPipe=true;});
  await page.getByRole('button',{name:'音の高さ（ピッチ）を1半音減らす',exact:true}).click();
  await page.getByText(/音声処理が終了しました \(3\)/).waitFor();
  await page.getByRole('button',{name:/声変換をはじめる/}).waitFor();
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(await app.evaluate(()=>global.uncaught),[]);
  console.log('PASS broken audio pipe: no main-process exception, conversion stops and the exit is reported');
 }finally{await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
