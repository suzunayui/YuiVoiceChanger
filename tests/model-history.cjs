const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ModelHistory,modelName}=require('../electron/model-history.cjs');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-history-'));
try{
 const file=path.join(home,'voice.pt.gz');fs.writeFileSync(file,'fixture');
 fs.writeFileSync(path.join(home,'model-history.json'),JSON.stringify([{id:'legacy',path:file,voice:0,label:'以前の自動表示名'}]));
 const config={beatrice_model:file,beatrice_voice:0,beatrice_model_alias:'声A',beatrice_model_icon:'a'.repeat(64)};
 let history=new ModelHistory(home);assert.equal(history.list()[0].label,'voice.pt.gz');
 history.remember(config);history.remember({...config,gain:3});
 assert.equal(history.list().length,1);
 history.remember({...config,beatrice_voice:1,beatrice_model_alias:'声B'});
 history=new ModelHistory(home);assert.equal(history.list().length,2);
 const first=history.list().find(item=>item.voice===0);
 assert.deepEqual(history.select(first.id),{beatrice_model:file,beatrice_voice:0,beatrice_model_alias:'声A',beatrice_model_icon:'a'.repeat(64)});
 fs.unlinkSync(file);assert.equal(history.list()[0].available,false);assert.throws(()=>history.select(first.id),/見つかりません/);
 assert.throws(()=>history.select('unknown'),/履歴/);
 for(let index=0;index<12;index++){
  const model=path.join(home,`${index}.pt.gz`);fs.writeFileSync(model,'fixture');history.remember({...config,beatrice_model:model});
 }
 assert.equal(history.list().length,14);
 const last=history.list().at(-1);history.edit(last.id,{alias:'編集した名前'});
 assert.equal(history.list().at(-1).label,'編集した名前');history.remove(last.id);
 assert.equal(history.list().length,13);
 assert.equal(modelName('C:\\miapla-train\\checkpoint_train_00020000.pt.gz'),'checkpoint_train_00020000.pt.gz');
 assert.equal(modelName(file),'voice.pt.gz');assert.equal(modelName(file,'自分の別名'),'自分の別名');
 console.log('PASS persistent model history, voice identity, deduplication, missing files and recent limit');
}finally{fs.rmSync(home,{recursive:true,force:true});}
