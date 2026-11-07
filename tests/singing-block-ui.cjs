const {_electron:electron,expect}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-block-'));
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,singing_enabled:true}));
 const app=await electron.launch({args:[path.resolve('.')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 const saved=async(page,value)=>page.waitForFunction(async value=>(await window.yvc.invoke('config')).singing_block_ms===value,value);
 try{
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  const mode=page.getByRole('region',{name:'歌枠モード',exact:true});
  const slider=mode.getByRole('slider',{name:'変換の間隔',exact:true});
  await expect(slider).toHaveValue('80');
  await expect(slider).toHaveAttribute('step','80');
  await expect(slider).toHaveAttribute('max','400');
  const up=mode.getByRole('button',{name:'変換の間隔を80ms増やす',exact:true}),down=mode.getByRole('button',{name:'変換の間隔を80ms減らす',exact:true});
  await expect(down).toBeDisabled();
  await up.click();await saved(page,160);
  await slider.focus();await slider.press('ArrowRight');await saved(page,240);
  await up.click();await up.click();await saved(page,400);
  await expect(up).toBeDisabled();
  await down.click();await saved(page,320);
  await expect(slider).toHaveValue('320');
  // It changes the reserved processing time, so it is set while stopped.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state:'running',budget_ms:320,schedule_ms:640}));
  await expect(slider).toBeDisabled();
  console.log('PASS singing interval slider moves in 80 ms steps up to 400 ms and locks while running');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
