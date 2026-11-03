// Exercise the real IPC/registry flow with a local installer fixture; no downloads or microphone.
const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-official-library-'));
 const original=path.join(home,'original.pt.gz'),official=path.join(home,'official.toml');
 fs.writeFileSync(original,'fixture');fs.writeFileSync(official,'fixture');
 const portrait=path.join(home,'tsukuyomichan.png');
 fs.copyFileSync(process.env.YVC_TEST_OFFICIAL_IMAGE||path.resolve('assets/icon.png'),portrait);
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,beatrice_model:original}));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  await app.evaluate(({app,shell},file)=>{
   global.officialTestMode='hold';global.officialTerms=[];
   shell.openExternal=async url=>global.officialTerms.push(url);
   const localRequire=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
   localRequire(localRequire('node:path').join(app.getAppPath(),'electron','official-model.cjs')).installOfficial=async(_home,{signal,progress})=>{
    progress('公式モデルをダウンロード中… 50%');
    if(global.officialTestMode==='error')throw Error('テスト用の通信エラー');
    if(global.officialTestMode==='hold')await new Promise((resolve,reject)=>{
     global.finishOfficialTest=resolve;
     signal.addEventListener('abort',()=>reject(Error('導入を中止しました。')),{once:true});
    });
    return {beatrice_model:file,beatrice_voice:1,beatrice_model_alias:'',beatrice_model_icon:''};
   };
  },official);
  const page=await app.firstWindow();
  await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
  assert.equal(await page.locator('main .stock-model-install').count(),0);
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  const library=page.getByRole('dialog',{name:'モデル一覧',exact:true});await library.waitFor();
  const panel=library.locator('.stock-model-install');await panel.locator('summary').click();
  const install=library.getByRole('button',{name:'規約に同意してつくよみちゃんを導入',exact:true});await install.waitFor();
  await library.getByRole('button',{name:'利用規約を読む ↗',exact:true}).click();
  assert.deepEqual(await app.evaluate(()=>global.officialTerms),[require('../electron/official-model.cjs').TERMS_URL]);
  assert(await page.evaluate(()=>window.yvc.invoke('install-tsukuyomi',{agreed:false}).then(()=>false,()=>true)));
  await install.click();await panel.getByRole('status').filter({hasText:'50%'}).waitFor();
  assert(await library.getByRole('button',{name:'モデル一覧を閉じる',exact:true}).isDisabled());
  assert(await library.getByRole('button',{name:'このモデルに切り替える',exact:true}).isDisabled());
  await page.keyboard.press('Escape');assert(await library.isVisible());
  await library.getByRole('button',{name:'導入を中止',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'導入を中止しました。'}).waitFor();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('model-history'))).length,1);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,original);
  await app.evaluate(()=>{global.officialTestMode='error';});await install.click();
  await panel.getByRole('alert').filter({hasText:'テスト用の通信エラー'}).waitFor();
  assert.equal(await page.locator('main').getByRole('alert').count(),0);
  await app.evaluate(()=>{global.officialTestMode='hold';});await install.click();
  await panel.getByRole('status').filter({hasText:'50%'}).waitFor();
  await app.evaluate(()=>global.finishOfficialTest());
  await panel.getByRole('status').filter({hasText:'一覧に追加しました。'}).waitFor();
  assert.equal(await panel.getByRole('alert').count(),0);
  const registry=await page.evaluate(()=>window.yvc.invoke('model-history'));
  assert.equal(registry.length,2);assert.equal(registry.find(item=>item.path===official).voice,1);
  assert.equal(registry.find(item=>item.path===official).alias,'つくよみちゃん');
  const automaticIcon=registry.find(item=>item.path===official).icon;
  assert.match(automaticIcon,/^[a-f0-9]{64}$/);assert(fs.existsSync(path.join(home,'model-icons',automaticIcon+'.png')));
  await library.getByRole('group',{name:'つくよみちゃん',exact:true}).locator('img').evaluate(img=>img.decode());
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,original);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon,'');
  const confirm=library.getByRole('button',{name:'このモデルに切り替える',exact:true});assert(await confirm.isEnabled());
  for(const width of [1280,1000]){
   await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,720),width);
   assert(await library.evaluate(el=>el.scrollWidth<=el.clientWidth));
  }
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  await confirm.click();await library.waitFor({state:'hidden'});
  const config=await page.evaluate(()=>window.yvc.invoke('config'));assert.equal(config.beatrice_model,official);assert.equal(config.beatrice_voice,1);
  assert.equal(config.beatrice_model_alias,'つくよみちゃん');await page.getByRole('heading',{name:'つくよみちゃん',exact:true}).waitFor();
  assert.equal(config.beatrice_model_icon,automaticIcon);await page.locator('.model-avatar img').evaluate(img=>img.decode());
  // Reinstalling the currently selected model also fills an empty alias and icon in config.
  await page.getByRole('button',{name:'モデルのアイコンを外す',exact:true}).click();
  await page.waitForFunction(async()=>(await window.yvc.invoke('config')).beatrice_model_icon==='');
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  await library.getByRole('group',{name:'つくよみちゃん',exact:true}).getByRole('button',{name:'編集',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.library-alias input')?.value==='つくよみちゃん');
  await library.getByRole('textbox',{name:'モデルの別名',exact:true}).fill('');await library.getByRole('button',{name:'保存',exact:true}).click();
  await library.getByRole('group',{name:'official.toml',exact:true}).waitFor();await panel.locator('summary').click();
  await app.evaluate(()=>{global.officialTestMode='done';});await install.click();
  await panel.getByRole('status').filter({hasText:'一覧に追加しました。'}).waitFor();
  await page.waitForFunction(async()=>(await window.yvc.invoke('config')).beatrice_model_icon!=='');
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon,automaticIcon);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_alias,'つくよみちゃん');
  assert.equal((await page.evaluate(()=>window.yvc.invoke('model-history'))).find(item=>item.path===official).icon,automaticIcon);
  await library.getByRole('button',{name:'モデル一覧を閉じる',exact:true}).click();
  // Use a distinct custom image and ensure reinstall preserves it and the alias.
  const customFile=path.join(home,'custom.png');
  await app.evaluate(({nativeImage},file)=>{
   process.getBuiltinModule('fs').writeFileSync(file,nativeImage.createFromBitmap(Buffer.from([32,64,192,255]),{width:1,height:1}).toPNG());
  },customFile);
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},customFile);
  await page.getByRole('button',{name:'モデルのアイコンを変更',exact:true}).click();
  await page.waitForFunction(async icon=>(await window.yvc.invoke('config')).beatrice_model_icon!==icon,automaticIcon);
  const customIcon=(await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon;
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  await library.getByRole('group',{name:'つくよみちゃん',exact:true}).getByRole('button',{name:'編集',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.library-alias input')?.value==='つくよみちゃん');
  await library.getByRole('textbox',{name:'モデルの別名',exact:true}).fill('保存した別名');await library.getByRole('button',{name:'保存',exact:true}).click();
  await panel.locator('summary').click();await app.evaluate(()=>{global.officialTestMode='done';});await install.click();
  await panel.getByRole('status').filter({hasText:'一覧に追加しました。'}).waitFor();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('model-history'))).length,2);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_alias,'保存した別名');
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model_icon,customIcon);
  assert.equal((await page.evaluate(()=>window.yvc.invoke('model-history'))).find(item=>item.path===official).icon,customIcon);
  assert.equal(await library.getByRole('group',{name:'保存した別名',exact:true}).count(),1);
  console.log('PASS official library: consent/cancel/retry, automatic name/icon, confirmed switching, current name/icon repair, custom icon/alias preservation and compact layout');
 }finally{
  await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
