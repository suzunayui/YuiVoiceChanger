// Opt-in: downloads the official 19MB archive into an isolated test profile.
// No microphone opens, and the user's real model selection is never changed.
const {_electron:electron}=require('@playwright/test');
const {addAndUseModel}=require('./helpers/model-library.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {TERMS_URL,DOWNLOAD_URL}=require('../electron/official-model.cjs');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-official-ui-'));
 const app=await electron.launch({...(process.env.YVC_TEST_EXECUTABLE?{executablePath:process.env.YVC_TEST_EXECUTABLE,args:[]}:{args:[path.resolve('.')]}),env:{...process.env,YVC_DESKTOP_HOME:home}});
 try{
  const page=await app.firstWindow();
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
  const library=page.getByRole('dialog',{name:'モデル一覧',exact:true});await library.waitFor();
  const button=page.getByRole('button',{name:'規約に同意してつくよみちゃんを導入',exact:true});
  await button.waitFor();
  assert(await page.evaluate(()=>window.yvc.invoke('install-tsukuyomi',{agreed:false}).then(()=>false,()=>true)));
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,'');
  await app.evaluate(({shell})=>{global.opened=[];shell.openExternal=async url=>global.opened.push(url);});
  await page.getByRole('button',{name:'利用規約を読む ↗',exact:true}).click();
  assert.deepEqual(await app.evaluate(()=>global.opened),[TERMS_URL]);
  await page.evaluate(()=>{window.installEvents=[];window.yvc.subscribe(event=>window.installEvents.push(event));});
  await button.click();
  await library.getByRole('status').filter({hasText:'つくよみちゃん（コーパス）を一覧に追加しました'}).waitFor({timeout:180000});
  assert.equal((await page.evaluate(()=>window.yvc.invoke('config'))).beatrice_model,'');
  await library.getByRole('button',{name:'このモデルに切り替える',exact:true}).click();
  const config=await page.evaluate(()=>window.yvc.invoke('config'));
  assert.equal(config.beatrice_voice,1);assert.equal(config.beatrice_model_alias,'つくよみちゃん');
  assert.match(config.beatrice_model_icon,/^[a-f0-9]{64}$/);
  assert(fs.existsSync(path.join(home,'model-icons',config.beatrice_model_icon+'.png')));
  assert(path.resolve(config.beatrice_model).startsWith(path.resolve(home)+path.sep));
  assert(fs.existsSync(config.beatrice_model));
  const receipt=JSON.parse(fs.readFileSync(path.join(path.dirname(config.beatrice_model),'installation.json'),'utf8'));
  assert.equal(receipt.source,DOWNLOAD_URL);assert.equal(receipt.terms_url,TERMS_URL);assert(receipt.agreed_at);
  assert(!(await page.evaluate(()=>window.installEvents)).some(e=>e.state==='running'));
  await page.getByRole('button',{name:'◉ 声を変える',exact:true}).click();
  await page.getByRole('heading',{name:'つくよみちゃん',exact:true}).waitFor();
  const next=path.join(home,'other.pt.gz');fs.writeFileSync(next,'fixture');
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},next);
  await addAndUseModel(page,'other.pt.gz');
  await page.waitForFunction(async()=>{const c=await window.yvc.invoke('config');return c.beatrice_voice===0&&c.beatrice_model_alias==='';});
  console.log('PASS consent button, official terms link, real download/extraction, corpus voice selection, consent receipt and model-switch reset');
 }finally{
  await app.close();assert(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(home,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
