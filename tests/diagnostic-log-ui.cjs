const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-diag-ui-'));
 const output=path.join(home,'saved.txt');
 const app=await electron.launch({args:[path.resolve('.')],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  await app.evaluate(({dialog,shell},output)=>{
   globalThis.saveCalls=0;globalThis.shown=[];
   dialog.showSaveDialog=async(window,options)=>{globalThis.saveCalls++;globalThis.defaultPath=options.defaultPath;return globalThis.cancelSave?{canceled:true}:{canceled:false,filePath:output};};
   shell.showItemInFolder=file=>globalThis.shown.push(file);
  },output);
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'⚙ 環境設定'}).click();
  const section=page.getByRole('region',{name:'診断ログ',exact:true});
  const save=section.getByRole('button',{name:'診断ログを保存',exact:true});
  // The log exists only once audio has run; say so instead of opening a save dialog.
  const logs=path.join(home,'logs'),log=path.join(logs,'independent-engine.log');
  fs.rmSync(log,{force:true});
  await save.click();
  await section.getByRole('alert').filter({hasText:'診断ログはまだありません'}).waitFor();
  assert.equal(await app.evaluate(()=>globalThis.saveCalls),0);
  fs.mkdirSync(logs,{recursive:true});
  fs.appendFileSync(log,`\n2026-11-07 20:00:00 Audio report: callback_late=2\n${os.homedir()}\\secret.py\n`);
  await save.click();
  await section.getByRole('status').filter({hasText:'診断ログを保存しました'}).waitFor();
  assert.equal(await section.getByRole('alert').count(),0);
  const text=fs.readFileSync(output,'utf8');
  assert.match(text,/Audio report: callback_late=2/);
  assert.equal(text.includes(os.homedir()),false);
  assert.deepEqual(await app.evaluate(()=>globalThis.shown),[output]);
  assert.match(await app.evaluate(()=>globalThis.defaultPath),/^YuiVoiceChanger-log-\d{8}-\d{4}\.txt$/);
  // Cancelling keeps the screen quiet and writes nothing.
  fs.rmSync(output);
  await app.evaluate(()=>{globalThis.cancelSave=true;});
  await save.click();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="診断ログ"] [role="status"]'));
  assert.equal(fs.existsSync(output),false);
  // It has to stay usable while converting, right after a dropout happens.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'state',state:'running',budget_ms:80,schedule_ms:160}));
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent.includes('停止')));
  assert.equal(await save.isEnabled(),true);
  console.log('PASS diagnostic log button saves a redacted copy, reports a missing log and works during conversion');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
