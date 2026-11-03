const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-singing-'));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();
  const nav=await page.locator('aside .nav').allTextContents();
  assert.deepEqual(nav.map(text=>text.trim()),['◉ 声を変える','♫ 歌枠用設定','⚙ 環境設定','▤ 使い方']);
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  await page.getByRole('heading',{name:'歌枠用設定',exact:true}).waitFor();
  const fixed=page.getByRole('checkbox',{name:'固定遅延',exact:true});
  const latency=page.getByRole('slider',{name:'入力→出力の遅延（目標）',exact:true});
  assert(await latency.isDisabled());
  assert(!(await fixed.isChecked()));
  assert(!(await page.getByRole('checkbox',{name:'有効',exact:true}).isChecked()));
  await fixed.check();await latency.focus();await latency.press('ArrowRight');
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).singing_latency_ms===410);
  await page.getByRole('button',{name:'ポップ',exact:true}).click();
  await page.waitForFunction(async()=>{const config=await window.yvc.invoke('config');return config.fx_enabled&&config.fx_compressor===50&&config.fx_echo===8;});
  await page.getByRole('slider',{name:'リバーブ',exact:true}).focus();await page.getByRole('slider',{name:'リバーブ',exact:true}).press('ArrowRight');
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).fx_reverb===11);
  for(const width of [1000,1280,1600]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,570),width);
   await page.waitForFunction(width=>innerWidth===width,width);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.evaluate(()=>document.querySelector('main').scrollTop=0);
   const layout=await page.evaluate(()=>{const timing=document.querySelector('.singing-timing').getBoundingClientRect(),effects=document.querySelector('.vocal-effects').getBoundingClientRect();return {w:innerWidth,sw:document.querySelector('main').scrollWidth,mw:document.querySelector('main').clientWidth,aligned:Math.abs(timing.top-effects.top)<1,right:effects.right,spacing:effects.left-timing.right};});
   assert(layout.sw<=layout.mw&&layout.right<=layout.w&&layout.aligned&&layout.spacing>0,JSON.stringify(layout));
   assert.equal(await page.getByText('現在の遅延（目安）',{exact:true}).count(),0);
   assert.equal(await page.getByRole('slider',{name:'補正値',exact:true}).count(),0);
   const compact=await page.evaluate(()=>({timing:document.querySelector('.singing-timing').getBoundingClientRect().height,obs:document.querySelector('.obs-integration').getBoundingClientRect().height}));
   assert(compact.timing<=180&&compact.obs<=320,JSON.stringify(compact));
   await page.getByRole('button',{name:'OBS連携の設定',exact:true}).click();
   const settings=page.getByRole('dialog',{name:'OBS連携の設定',exact:true});
   const connection=await settings.evaluate(element=>{const password=element.querySelector('.obs-connection-fields input[type=password]').getBoundingClientRect(),button=element.querySelector('.obs-connection-fields>.obs-button').getBoundingClientRect();return {passwordWidth:password.width,right:password.right,left:button.left,aligned:Math.abs(password.bottom-button.bottom)<1};});
   assert(connection.passwordWidth>=48&&connection.left>connection.right&&connection.aligned,JSON.stringify(connection));
   await settings.getByRole('button',{name:'閉じる',exact:true}).click();
   const timing=await page.evaluate(()=>{const label=document.querySelector('.singing-timing .singing-toggle').getBoundingClientRect(),value=document.querySelector('.beep-setting-slot>.obs-button').getBoundingClientRect();return {left:value.left,right:label.right,aligned:Math.abs((label.top+label.bottom)/2-(value.top+value.bottom)/2)<1};});
   assert(timing.left>timing.right&&timing.aligned,JSON.stringify(timing));
   if(process.env.YVC_TEST_SCREENSHOT&&width===1280)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  }
  await page.getByRole('button',{name:'リセット',exact:true}).click();
  await page.waitForFunction(async()=>{const config=await window.yvc.invoke('config');return !config.fx_enabled&&config.singing_enabled&&config.singing_latency_ms===410;});
  await page.reload();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  assert(await fixed.isChecked());assert.equal(await latency.inputValue(),'410');
  assert.equal(await page.getByRole('alert').count(),0);
  console.log('PASS singing navigation order, optional defaults, presets, effect adjustment, fixed timing preserved by reset, persistence and compact layouts');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
