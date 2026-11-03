// Opt-in real inspection and UI routing. Never starts conversion or training.
const {_electron:electron}=require('@playwright/test');
const {openModelLibrary,addAndUseModel}=require('./helpers/model-library.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const [profile,pth,onnx,manifest]=process.argv.slice(2);
 if(!manifest)throw Error('Pass desktop.json, synthetic RVC .pth, .onnx and a Beatrice .toml');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-import-'));
 const config=JSON.parse(fs.readFileSync(profile,'utf8'));config.training_audio='';
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify(config));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();
  await page.getByRole('heading',{name:'音声のルート'}).waitFor();
  for(const file of [pth,onnx]){
   await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
   const library=await openModelLibrary(page);
   await library.getByRole('button',{name:'＋ モデルを追加',exact:true}).click();
   await page.getByRole('heading',{name:'RVCから学習モデルを作る'}).waitFor({timeout:30000});
   assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,config.beatrice_model);
   assert.equal(path.normalize((await page.evaluate(()=>window.yvc.invoke('config'))).training_source),path.normalize(file));
   assert(await page.getByRole('button',{name:'学習モデルを作成',exact:true}).isDisabled());
   await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  }
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},manifest);
  await addAndUseModel(page,path.basename(manifest));
  await page.waitForFunction(expected=>document.querySelector('h2')?.title===expected,path.normalize(manifest),{timeout:30000});
  const sizes=await page.evaluate(()=>({input:parseFloat(getComputedStyle(document.querySelector('.route select')).fontSize),label:parseFloat(getComputedStyle(document.querySelector('.slider>div')).fontSize)}));
  assert(sizes.input>=14&&sizes.label>=14,JSON.stringify(sizes));
  assert.equal(await page.getByRole('alert').count(),0);
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  console.log('PASS genuine PTH/ONNX inspection routes to training, keeps selected voice, native TOML selection, readable text');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
