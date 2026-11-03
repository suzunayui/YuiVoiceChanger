// Packaged native macOS UI and Core Audio routing, with no audio capture.
const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-mac-smoke-'));
 const app=await electron.launch({executablePath:process.argv[2],args:[],env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  assert(await app.evaluate(({app})=>app.isPackaged));
  const resources=await app.evaluate(()=>process.resourcesPath);
  for(const file of ['backend/worker.py','backend/requirements-mac.txt','backend/BEATRICE_LICENSE.txt','docs/mac-preview.md'])assert(fs.statSync(path.join(resources,file)).isFile(),file);
  const page=await app.firstWindow();await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.yvc.platform),'darwin');
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.send('engine-event',{type:'devices',devices:[
   {id:3,name:'Mac microphone',host:'Core Audio',inputs:1,outputs:0},
   {id:4,name:'BlackHole 2ch',host:'Core Audio',inputs:2,outputs:2},
   {id:5,name:'Foreign host',host:'MME',inputs:1,outputs:2}
  ]}));
  const input=page.getByRole('combobox',{name:'マイク',exact:true});await input.selectOption('3');
  await page.getByRole('combobox',{name:'変換音声の出力先',exact:true}).selectOption('4');
  assert.equal(await input.locator('option').filter({hasText:'Foreign host'}).count(),0);
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.input===3&&c.output===4;});
  const start=page.getByRole('button',{name:/声変換をはじめる/});assert(await start.isDisabled());
  await page.getByRole('button',{name:'♫ 歌枠用設定',exact:true}).click();
  assert(await page.getByRole('button',{name:'ビープでOBSのずれを自動調整',exact:true}).isEnabled());
  assert.equal(await page.getByText('この版はWindows x64用です。',{exact:true}).count(),0);
  await page.getByRole('button',{name:'▤ 使い方',exact:true}).click();
  await page.getByRole('link',{name:'Mac版の導入',exact:true}).click();
  await page.getByRole('heading',{name:'Apple Silicon Mac試用版',exact:true}).waitFor();
  console.log('PASS native packaged Apple Silicon desktop, Core Audio input/output selection, persistence and calibration launcher; microphone never opened');
 }finally{await app.close();fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
