const {_electron:electron,expect}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-mix-level-'));
 fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({engine_version:2,singing_enabled:true,mix_enabled:true}));
 const app=await electron.launch({args:[path.resolve('.')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 // Display-only events in an isolated profile; no microphone or inference starts.
 const send=event=>app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',event),event);
 try{
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  const mode=page.getByRole('region',{name:'歌枠モード',exact:true});
  const meter=mode.getByRole('meter',{name:'取り込んだ伴奏の音量',exact:true});
  const warning=mode.getByText(/取り込んだ伴奏が小さいです/);
  await expect(meter).toHaveCount(0);
  await send({type:'state',state:'running',mix_enabled:true,budget_ms:80,schedule_ms:160});
  await send({type:'metrics',music_db:-12.4,music_low:false});
  await expect(meter).toHaveAttribute('aria-valuenow','-12');
  await expect(mode.getByText('-12 dB',{exact:true})).toBeVisible();
  await expect(warning).toHaveCount(0);
  await send({type:'metrics',music_db:-35,music_low:true});
  await expect(warning).toBeVisible();
  assert.equal(await warning.getAttribute('role'),'status');
  await expect(warning).toContainText(/カラオケアプリの音量/);
  await expect(warning).toContainText(/音量ミキサー/);
  await send({type:'metrics',music_db:-90,music_low:false});
  await expect(mode.getByText('— dB',{exact:true})).toBeVisible();
  await expect(meter).toHaveAttribute('aria-valuenow','-60');
  await expect(warning).toHaveCount(0);
  await send({type:'metrics',music_db:-35,music_low:true});
  await expect(warning).toBeVisible();
  await send({type:'state',state:'stopped'});
  await expect(meter).toHaveCount(0);
  await expect(warning).toHaveCount(0);
  console.log('PASS accompaniment level meter and low-level notice follow metrics and hide when stopped');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
