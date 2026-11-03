const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-layout-'));
 const history=Array.from({length:10},(_,index)=>{
  const model=path.join(profile,`checkpoint_${index}.pt.gz`);fs.writeFileSync(model,'fixture');
  return {id:`model-${index}`,path:model,voice:0,alias:`声${index+1}`,icon:''};
 });
 fs.writeFileSync(path.join(profile,'model-history.json'),JSON.stringify(history));
 fs.writeFileSync(path.join(profile,'desktop.json'),JSON.stringify({engine_version:2,beatrice_model:history[0].path,beatrice_model_alias:history[0].alias}));
 const app=await electron.launch({args:[path.resolve('.')],env:{...process.env,YVC_DESKTOP_HOME:profile}});
 try{
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'◉ 声を変える'}).click();await page.getByRole('heading',{name:'音声のルート'}).waitFor();
  await page.locator('.signal-card .gpu-name strong').filter({hasText:/^(CPU|GPU) · /}).waitFor();
  assert.equal(await page.locator('.recent-models').count(),0);
  for(const width of [1280,1000]){
   await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,570),width);
   await page.waitForTimeout(100);
   const layout=await page.evaluate(()=>{
    return {scrollW:document.documentElement.scrollWidth,w:innerWidth,scrollH:document.documentElement.scrollHeight,h:innerHeight,
     bottom:document.querySelector('.voice-sliders').closest('.card').getBoundingClientRect().bottom,footer:document.querySelector('footer').getBoundingClientRect().top};
   });
   console.log(width,layout);assert(layout.scrollW<=layout.w&&layout.scrollH<=layout.h&&layout.bottom<=layout.footer);
  }
  const controls=await page.locator('.voice-sliders .slider').evaluateAll(labels=>labels.map(label=>{const r=label.getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom};}));
  assert.equal(controls.length,4);
  for(let index=1;index<controls.length;index++){assert.equal(controls[index].x,controls[0].x);assert(controls[index].y>=controls[index-1].bottom);}
  const cards=await page.locator('.voice-grid>.voice-column').evaluateAll(items=>items.map(item=>{const r=item.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right};}));
  assert.equal(cards.length,2);assert.equal(cards[0].y,cards[1].y);assert(cards[1].x>=cards[0].right);
  assert.equal(await page.locator('.route-arrow').count(),0);
  const compact=await page.evaluate(()=>{
   const model=document.querySelector('.model-card').getBoundingClientRect(),route=document.querySelector('.route-card').getBoundingClientRect(),presets=document.querySelector('.preset-card').getBoundingClientRect();
   return {modelHeight:model.height,routeHeight:route.height,gap:presets.top-route.bottom};
  });
  assert(compact.modelHeight<=80&&compact.routeHeight<=220&&compact.gap>=8&&compact.gap<=12,JSON.stringify(compact));
  const summary=await page.evaluate(()=>{const name=document.querySelector('.current-model').getBoundingClientRect(),button=document.querySelector('.model-select-button').getBoundingClientRect();return {right:name.right,left:button.left,sameRow:button.top<name.bottom&&button.bottom>name.top};});
  assert(summary.left>=summary.right&&summary.sameRow,JSON.stringify(summary));
  assert.equal(await page.locator('.signal-card .performance').count(),1);
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  // Feed display-only events in this isolated profile; no microphone or inference starts.
  await app.evaluate(({BrowserWindow})=>{
   const wc=BrowserWindow.getAllWindows()[0].webContents;
   wc.send('engine-event',{type:'state',state:'running',device:'GPU · NVIDIA GeForce RTX 5070 Ti',budget_ms:80,schedule_ms:160});
   wc.send('engine-event',{type:'metrics',latency_estimate_ms:276,rms:.1,clip:.01,late_blocks:1});
  });
  await page.locator('.signal-card .gpu-name strong').getByText('GPU · NVIDIA GeForce RTX 5070 Ti',{exact:true}).waitFor();
  await page.locator('.signal-card .performance strong').filter({hasText:/^約276\s*ms$/}).waitFor();
  assert(await page.locator('.signal-card').evaluate(element=>element.scrollWidth<=element.clientWidth));
  await page.locator('.signal-card .monitor-warning').last().waitFor();
  assert.equal(await page.locator('.signal-card .monitor-warning').count(),2);
  // Expanded notices may need scrolling in compact windows; the stop action stays fixed.
  await page.evaluate(()=>document.querySelector('main').scrollTo(0,document.querySelector('main').scrollHeight));
  assert(await page.evaluate(()=>document.querySelector('.voice-sliders').closest('.card').getBoundingClientRect().bottom<=document.querySelector('footer').getBoundingClientRect().top));
  if(process.env.YVC_TEST_WARNING_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_WARNING_SCREENSHOT});
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state:'stopped'}));
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  const library=page.getByRole('dialog',{name:'モデル一覧',exact:true});
  await page.waitForFunction(()=>document.querySelectorAll('.library-item').length===10);
  assert.equal(await library.getByRole('button',{pressed:true}).count(),1);
  assert(await library.evaluate(element=>element.scrollWidth<=element.clientWidth));
  console.log('PASS uncluttered main layout at both widths; ten models remain available in the library');
 }finally{await app.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
