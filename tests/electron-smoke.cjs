const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-electron-'));
 const app=await electron.launch({args:[path.resolve(__dirname,'..')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'◉ 声を変える'}).click();await page.getByRole('heading',{name:'音声のルート'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'▶ 声変換をはじめる'}).isDisabled(),true);
  assert.equal(await page.getByLabel('変換エンジン').count(),0);
  await page.getByRole('slider',{name:/^音の高さ/}).press('ArrowLeft');
  await page.waitForFunction(async()=> (await window.yvc.invoke('config')).beatrice_pitch===13);
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  await page.getByRole('dialog',{name:'モデル一覧',exact:true}).waitFor();
  await page.getByRole('button',{name:'モデル一覧を閉じる',exact:true}).click();
  await page.getByRole('button',{name:'⚙ 環境設定'}).click();
  await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
  assert.equal(await page.locator('.settings .path-field').count(),0);
  assert.equal(await page.getByRole('heading',{name:'詳細設定',exact:true}).count(),0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'desktop.json'))).beatrice_pitch,13);
  const saved=JSON.parse(fs.readFileSync(path.join(home,'desktop.json')));
  assert.equal('gpu' in saved,false);assert.equal('model' in saved,false);
  const prefs=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(prefs.nodeIntegration,false);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  console.log('PASS: Electron UI, settings persistence, disabled start, isolated renderer');
 } finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exit(1)});
