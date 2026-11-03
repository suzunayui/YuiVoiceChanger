const {_electron:electron}=require('@playwright/test');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-guide-'));
 const checkpoint=path.join(profile,'声.pt.gz');fs.writeFileSync(checkpoint,'fixture');
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:profile}});
 try{
  const page=await app.firstWindow();
  await page.getByRole('heading',{name:'環境設定',exact:true}).waitFor();
  assert.equal(await page.locator('aside').getByRole('button').count(),4);
  assert.equal(await page.getByRole('button',{name:'？ 初期設定',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'モデル一覧を開く',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'必要な環境を自動セットアップ',exact:true}).count(),1);
  assert.equal(await page.getByRole('alert').count(),0);
  await app.evaluate(({shell,dialog},file)=>{
   global.opened=[];shell.openExternal=async url=>global.opened.push(url);
   shell.openPath=async file=>{global.opened.push(file);return '';};
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
  },checkpoint);
  await page.getByRole('button',{name:'▤ 使い方',exact:true}).click();
  await page.getByRole('region',{name:'使い方の本文',exact:true}).getByRole('heading',{name:'使い方',exact:true}).waitFor();
  const opened=await app.evaluate(()=>global.opened);
  assert.equal(opened.length,0);
  assert(await page.evaluate(()=>window.yvc.invoke('open-resource','file:///C:/Windows').then(()=>false,()=>true)));
  assert.equal(await page.getByRole('button',{name:'規約に同意してつくよみちゃんを導入',exact:true}).count(),0);
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  const library=page.getByRole('dialog',{name:'モデル一覧',exact:true});await library.waitFor();
  await library.getByRole('button',{name:'＋ モデルを追加',exact:true}).click();
  await library.getByRole('button',{name:'保存',exact:true}).click();
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,'');
  await library.getByRole('button',{name:'モデルを選択：声.pt.gz',exact:true}).click();
  await library.getByRole('button',{name:'このモデルに切り替える',exact:true}).click();
  await page.waitForFunction(async()=>Boolean((await window.yvc.invoke('config')).beatrice_model));
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,checkpoint);
  await page.getByRole('button',{name:'⚙ 環境設定',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'必要な環境を自動セットアップ',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:/VST/}).count(),0);
  for(const [width,height] of [[1280,720],[1000,570]]){
   await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
   const r=await page.evaluate(()=>{const environment=document.querySelector('.settings').getBoundingClientRect(),transfer=document.querySelector('.settings-transfer').getBoundingClientRect();return {w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,bottom:environment.bottom,transferBottom:transfer.bottom,leftRight:environment.right,rightLeft:transfer.left,aligned:Math.abs(environment.top-transfer.top)<1,footer:document.querySelector('footer').getBoundingClientRect().top};});
   assert(r.sw<=r.w&&r.sh<=r.h&&r.bottom<=r.footer&&r.transferBottom<=r.footer&&r.leftRight<r.rightLeft&&r.aligned,JSON.stringify(r));
   const transfer=page.getByRole('region',{name:'設定の保存・読み込み',exact:true});
   assert.equal(await transfer.getByRole('button',{name:/設定を(?:インポート|エクスポート)/}).count(),2);
  }
  if(process.env.YVC_TEST_SCREENSHOT)await page.screenshot({path:process.env.YVC_TEST_SCREENSHOT});
  console.log('PASS first-run environment settings, single setup action, no duplicate onboarding, main model library, README and compact layout');
 }finally{await app.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
