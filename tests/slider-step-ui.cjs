const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-step-controls-'));
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,beatrice_pitch:23,beatrice_formant:1.5,input_gain:17,gain:17}));
 const options={...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}};
 let app;
 try{
  app=await electron.launch(options);let page=await app.firstWindow();
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  const controls=[['音の高さ（ピッチ）','beatrice_pitch','半音',23],['声の響き（フォルマント）','beatrice_formant','半音',1.5],['入力ゲイン','input_gain','dB',17],['出力ゲイン','gain','dB',17]];
  const saved=async(key,value)=>page.waitForFunction(async({key,value})=>(await window.yvc.invoke('config'))[key]===value,{key,value});
  for(const [label,key,unit,initial] of controls){
   const slider=page.getByRole('slider',{name:label,exact:true});await slider.waitFor();
   const down=page.getByRole('button',{name:`${label}を1${unit}減らす`,exact:true}),up=page.getByRole('button',{name:`${label}を1${unit}増やす`,exact:true});
   assert.equal(Number(await slider.inputValue()),initial);
   await down.click();await saved(key,initial-1);assert.equal(Number(await slider.inputValue()),initial-1);
   await up.click();await saved(key,initial);assert.equal(Number(await slider.inputValue()),initial);
   const max=Number(await slider.getAttribute('max')),min=Number(await slider.getAttribute('min'));
   await up.click();await saved(key,max);assert(await up.isDisabled());assert.equal(Number(await slider.inputValue()),max);
   await slider.press('Home');await saved(key,min);assert(await down.isDisabled());
   await up.click();await saved(key,min+1);assert.equal(Number(await slider.inputValue()),min+1);
   await slider.press('End');await saved(key,max);assert(await up.isDisabled());
  }
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state:'running',device:'CPU'}));
  const expected={};
  assert.equal(await page.getByRole('slider').count(),4);
  for(const [label,key,unit] of controls){
   const slider=page.getByRole('slider',{name:label,exact:true}),max=Number(await slider.getAttribute('max'));
   assert(await slider.isEnabled());
   await page.getByRole('button',{name:`${label}を1${unit}減らす`,exact:true}).click();await saved(key,max-1);
   await slider.press('ArrowLeft');expected[label]=max-1-Number(await slider.getAttribute('step'));await saved(key,expected[label]);
  }
  for(const select of await page.locator('.route select').all())assert(await select.isDisabled());
  for(const state of ['loading','stopping']){
   await app.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state}),state);
   await page.waitForFunction(()=>[...document.querySelectorAll('.step-button')].every(button=>button.disabled));
  }
  await app.close();app=await electron.launch(options);page=await app.firstWindow();await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  for(const [label] of controls){const slider=page.getByRole('slider',{name:label,exact:true});await slider.waitFor();assert.equal(Number(await slider.inputValue()),expected[label]);}
  console.log('PASS all four +/- controls, boundaries, live slider/keyboard adjustment, loading/stopping locks, device locks and restart persistence');
 }finally{if(app)await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
