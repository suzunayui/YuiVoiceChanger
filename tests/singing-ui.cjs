const {_electron:electron,expect}=require('@playwright/test');
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
  const mode=page.getByRole('region',{name:'歌枠モード',exact:true});
  const enable=mode.getByRole('button',{name:'歌枠用設定にする',exact:true});
  const disable=mode.getByRole('button',{name:'歌枠モードを解除',exact:true});
  const latency=mode.getByRole('slider',{name:'固定遅延',exact:true});
  await expect(latency).toHaveCount(0);
  await expect(mode.getByRole('checkbox')).toHaveCount(0);
  assert(!(await page.getByRole('checkbox',{name:'有効',exact:true}).isChecked()));
  await enable.click();await latency.focus();await latency.press('ArrowRight');
  const playback=mode.getByRole('combobox',{name:'伴奏の再生先',exact:true});
  await expect(playback).toHaveAccessibleDescription(/自分には伴奏をそのまま再生.*CABLE Input/);
  await expect(mode.getByText(/自分には伴奏をそのまま再生/)).toBeHidden();
  assert.match(await mode.locator('.mix-device-label').getAttribute('title'),/CABLE Input/);
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.mix_enabled&&c.singing_enabled&&c.mix_latency_ms===501;});
  await page.getByRole('button',{name:'ポップ',exact:true}).click();
  await page.waitForFunction(async()=>{const config=await window.yvc.invoke('config');return config.fx_enabled&&config.fx_compressor===50&&config.fx_echo===8;});
  await page.getByRole('slider',{name:'リバーブ',exact:true}).focus();await page.getByRole('slider',{name:'リバーブ',exact:true}).press('ArrowRight');
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).fx_reverb===11);
  for(const width of [1000,1280,1600]){
   await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,570),width);
   await page.waitForFunction(width=>innerWidth===width,width);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.evaluate(()=>document.querySelector('main').scrollTop=0);
   const layout=await page.evaluate(()=>{const timing=document.querySelector('.stream-mix').getBoundingClientRect(),effects=document.querySelector('.vocal-effects').getBoundingClientRect();return {w:innerWidth,sw:document.querySelector('main').scrollWidth,mw:document.querySelector('main').clientWidth,aligned:Math.abs(timing.top-effects.top)<1,right:effects.right,spacing:effects.left-timing.right};});
   assert(layout.sw<=layout.mw&&layout.right<=layout.w&&layout.aligned&&layout.spacing>0,JSON.stringify(layout));
   assert.equal(await page.getByText('現在の遅延（目安）',{exact:true}).count(),0);
   assert.equal(await page.getByRole('slider',{name:'補正値',exact:true}).count(),0);
   const compact=await page.evaluate(()=>({timing:document.querySelector('.stream-mix').getBoundingClientRect().height,obs:document.querySelector('.obs-integration').getBoundingClientRect().height}));
   assert(compact.timing<=400&&compact.obs<=320,JSON.stringify(compact));
   await expect(page.getByRole('region',{name:'OBSプラグイン'}).getByRole('button',{name:'一覧を更新'})).toBeVisible();
   await expect(page.getByRole('button',{name:'テスト音声でOBSのずれを自動調整',exact:true})).toHaveCount(0);
   await expect(page.getByRole('button',{name:'ずれを確認',exact:true})).toHaveCount(0);
   if(process.env.YVC_TEST_SCREENSHOT&&width===1280)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  }
  await page.getByRole('button',{name:'リセット',exact:true}).click();
  await page.waitForFunction(async()=>{const config=await window.yvc.invoke('config');return !config.fx_enabled&&config.singing_enabled&&config.mix_enabled&&config.mix_latency_ms===501;});
  await page.reload();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  await expect(disable).toBeVisible();assert.equal(await latency.inputValue(),'501');
  await disable.click();await expect(latency).toHaveCount(0);
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return !c.mix_enabled&&!c.singing_enabled;});
  assert.equal(await page.getByRole('alert').count(),0);
  // Regression: an old +690ms correction must not impose an 890ms floor.
  await page.evaluate(async()=>{const c=await window.yvc.invoke('config');await window.yvc.invoke('save',{...c,singing_enabled:true,singing_latency_ms:200,obs_correction_ms:690,obs_delay_manual:false});});
  await page.reload();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  assert.equal(await latency.inputValue(),'890');assert.equal(await latency.getAttribute('min'),'200');
  await latency.focus();await latency.press('Home');
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.singing_latency_ms+c.obs_correction_ms===200&&c.obs_delay_manual;});
  await latency.evaluate(el=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(el,'500');el.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.singing_latency_ms+c.obs_correction_ms===500;});
  await page.reload();await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();assert.equal(await latency.inputValue(),'500');
  console.log('PASS singing navigation order, optional defaults, presets, effect adjustment, fixed timing preserved by reset, persistence and compact layouts');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
