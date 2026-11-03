const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-help-'));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
  const before=await page.evaluate(()=>window.yvc.invoke('config'));
  await app.evaluate(({app,shell})=>{
   global.helpOpenedFiles=[];global.helpOpenedUrls=[];
   shell.openPath=async file=>{global.helpOpenedFiles.push(file);return '';};
   shell.openExternal=async url=>global.helpOpenedUrls.push(url);
   const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');
   const file=path.join(app.isPackaged?process.resourcesPath:app.getAppPath(),'README.md');
   const read=fs.readFileSync;global.restoreHelpReader=()=>{fs.readFileSync=read;};
   fs.readFileSync=(target,...args)=>{if(target===file)throw Error('Test: help temporarily unavailable');return read(target,...args);};
  });
  await page.getByRole('button',{name:'▤ 使い方',exact:true}).click();
  const help=page.getByRole('region',{name:'使い方の本文',exact:true});
  await help.getByRole('alert').filter({hasText:'説明を読み込めませんでした。'}).waitFor();
  await app.evaluate(()=>global.restoreHelpReader());await help.getByRole('button',{name:'再読み込み',exact:true}).click();
  await help.getByRole('heading',{name:'使い方',exact:true}).waitFor();
  assert.equal(await page.locator('aside .help-nav.selected').count(),1);
  assert(await help.locator('pre code').count()>0);
  await help.getByRole('link',{name:'VB-CABLE',exact:true}).click();
  assert.deepEqual(await app.evaluate(()=>global.helpOpenedUrls),['https://vb-audio.com/Cable/']);
  await help.getByRole('link',{name:'詳細な設定',exact:true}).click();
  await help.getByRole('heading',{name:'モデルと実行環境の設定',exact:true}).waitFor();
  assert.equal(await help.getByRole('table').count(),1);
  await help.getByRole('cell',{name:'学習チェックポイントをGPU/CPUで直接変換',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('main').scrollTop===0);
  for(const width of [1280,1000]){
   await app.evaluate(({BrowserWindow},w)=>BrowserWindow.getAllWindows()[0].setContentSize(w,720),width);
   assert(await help.evaluate(el=>el.scrollWidth<=el.clientWidth));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  await help.getByRole('button',{name:'← 使い方に戻る',exact:true}).click();
  await help.getByRole('link',{name:'LICENSE',exact:true}).click();await help.getByText('MIT License',{exact:true}).waitFor();
  await help.getByRole('button',{name:'← 使い方に戻る',exact:true}).click();
  await help.getByRole('link',{name:'THIRD_PARTY_NOTICES.md',exact:true}).click();
  await help.getByRole('heading',{name:'Third-party notices',exact:true}).waitFor();
  assert.deepEqual(await app.evaluate(()=>global.helpOpenedFiles),[]);
  for(const id of ['../desktop.json','constructor','file:///C:/Windows/win.ini']){
   assert(await page.evaluate(id=>window.yvc.invoke('read-help',id).then(()=>false,()=>true),id));
  }
  for(const url of ['file:///C:/Windows/win.ini','javascript:alert(1)','https://user:password@example.com','http://example.com']){
   assert(await page.evaluate(url=>window.yvc.invoke('open-help-link',url).then(()=>false,()=>true),url));
  }
  assert.deepEqual(await app.evaluate(()=>global.helpOpenedUrls),['https://vb-audio.com/Cable/']);
  assert.deepEqual(await page.evaluate(()=>window.yvc.invoke('config')),before);
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();await page.getByRole('heading',{name:'音声のルート',exact:true}).waitFor();
  await page.getByRole('button',{name:'▤ 使い方',exact:true}).click();await help.getByRole('heading',{name:'使い方',exact:true}).waitFor();
  console.log('PASS in-app help, load failure/retry, Markdown code/table, internal documents/back, HTTPS browser links, scoped IPC, no editor launch or config changes and responsive layout');
 }finally{await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(home,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
