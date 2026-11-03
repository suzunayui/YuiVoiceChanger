const {_electron:electron}=require('@playwright/test');
const {addAndUseModel,openModelLibrary}=require('./helpers/model-library.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-icons-'));
 const first=path.join(home,'first.pt.gz'),second=path.join(home,'second.pt.gz');
 fs.writeFileSync(first,'fixture');fs.writeFileSync(second,'fixture');
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,beatrice_model:first}));
 const options={...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}};
 let app;
 try{
  app=await electron.launch(options);let page=await app.firstWindow();
  const images=await app.evaluate(({nativeImage},{home,png,ico})=>{
   const fs=process.mainModule.require('node:fs');const image=nativeImage.createFromPath(png);
   const files=[home+'/画像.png',home+'/画像.jpg',home+'/画像.jpeg',home+'/画像.ico'];
   fs.writeFileSync(files[0],image.toPNG());fs.writeFileSync(files[1],image.toJPEG(85));fs.writeFileSync(files[2],image.toJPEG(90));fs.copyFileSync(ico,files[3]);return files;
  },{home,png:path.resolve('assets/icon.png'),ico:path.resolve('assets/icon.ico')});
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  const mockPick=async file=>app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async(_window,options)=>{global.iconDialogOptions=options;return {canceled:!file,filePaths:file?[file]:[]};};},file);
  const ready=async()=>page.waitForFunction(()=>!document.querySelector('.model-avatar').disabled&&Boolean(document.querySelector('.model-avatar img')?.naturalWidth));
  for(const file of images){
   await mockPick(file);
   await page.getByRole('button',{name:/^モデルのアイコンを(設定|変更)$/}).click();
   await ready();
   assert.deepEqual((await app.evaluate(()=>global.iconDialogOptions)).filters[0].extensions,['ico','png','jpg','jpeg']);
  }
  const icon=(await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon;
  let library=await openModelLibrary(page);
  await page.waitForFunction(()=>Boolean(document.querySelector('.library-item img')?.naturalWidth));
  await library.getByRole('button',{name:'モデル一覧を閉じる',exact:true}).click();
  assert(/^[a-f0-9]{64}$/.test(icon));assert(fs.existsSync(path.join(home,'model-icons',icon+'.png')));
  const bad=path.join(home,'broken.png');fs.writeFileSync(bad,'invalid image');
  await mockPick(bad);await page.getByRole('button',{name:'モデルのアイコンを変更',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'画像を読み込めませんでした'}).waitFor();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon,icon);
  await page.getByRole('button',{name:'エラーを閉じる',exact:true}).click();
  await mockPick(null);await page.getByRole('button',{name:'モデルのアイコンを変更',exact:true}).click();await ready();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon,icon);
  await mockPick(second);await addAndUseModel(page,'second.pt.gz');
  await page.getByRole('heading',{name:'second.pt.gz',exact:true}).waitFor();
  assert.equal(await page.locator('.model-avatar img').count(),0);
  const history=await page.evaluate(()=>window.yvc.invoke('model-history'));
  library=await openModelLibrary(page);
  await library.getByRole('button',{name:'モデルを選択：first.pt.gz',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,second);
  await library.getByRole('button',{name:'このモデルに切り替える',exact:true}).click();
  await ready();assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon,icon);
  for(const file of images)fs.unlinkSync(file);
  await app.close();app=await electron.launch(options);page=await app.firstWindow();
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();await ready();
  assert(await page.evaluate(()=>window.yvc.invoke('model-icon','../outside').then(()=>false,()=>true)));
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  await page.locator('.model-avatar-wrap').hover();await page.getByRole('button',{name:'モデルのアイコンを外す',exact:true}).click();
  await page.waitForFunction(async()=>(await window.yvc.invoke('config')).beatrice_model_icon==='');
  assert.equal((await page.evaluate(()=>window.yvc.invoke('model-history')))[0].icon,'');
  console.log('PASS ICO/PNG/JPG/JPEG decoding, cached display, cancellation, corrupt image rejection, model isolation, history/restart restore and removal');
 }finally{if(app)await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
