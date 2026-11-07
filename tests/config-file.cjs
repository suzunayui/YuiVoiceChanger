const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {loadConfig}=require('../electron/config-file.cjs');
const {normalize,defaults}=require('../electron/config.cjs');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-config-file-'));
try{
 const file=path.join(home,'desktop.json');
 let result=loadConfig(file,home,normalize);
 assert.deepEqual(result.saved,{});assert.equal(result.error,undefined);assert.deepEqual(result.config,normalize({}));
 fs.writeFileSync(file,'﻿'+JSON.stringify({engine_version:2,beatrice_pitch:3}));
 result=loadConfig(file,home,normalize);
 assert.equal(result.config.beatrice_pitch,3);assert.equal(result.error,undefined);
 const backups=()=>fs.readdirSync(home).filter(name=>name.startsWith('desktop.unreadable-'));
 assert.equal(backups().length,0);
 for(const broken of ['not json','[1,2]','{"engine_version":2,"beatrice_pitch":999}']){
  fs.writeFileSync(file,broken);
  const before=backups();
  result=loadConfig(file,home,normalize);
  assert.equal(result.config.beatrice_pitch,defaults().beatrice_pitch);
  assert.match(result.error,/読み込めなかった/);
  const added=backups().filter(name=>!before.includes(name));
  assert.equal(added.length,1);
  assert.equal(fs.readFileSync(path.join(home,added[0]),'utf8'),broken);
  assert(result.error.includes(added[0]));
 }
 assert.deepEqual(loadConfig(file,home,normalize).saved,{},'broken contents never reach the migration code');
 console.log('PASS settings file: missing, BOM and valid files load; broken files are copied aside and reported');
}finally{fs.rmSync(home,{recursive:true,force:true});}
