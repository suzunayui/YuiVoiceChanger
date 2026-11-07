const assert=require('node:assert/strict');
const {normalize,liveControls}=require('../electron/config.cjs');
const presets=require('../electron/presets.cjs');
assert.equal(normalize({}).singing_block_ms,80,'the default keeps the old timing');
for(const value of [80,160,240,320,400])assert.equal(normalize({singing_block_ms:value}).singing_block_ms,value);
for(const value of [0,40,100,480,160.5])assert.throws(()=>normalize({singing_block_ms:value}),/変換の間隔|範囲外/,String(value));
assert.throws(()=>normalize({singing_block_ms:'160'}),/設定値が正しくありません/);
const base=normalize({});
assert.throws(()=>liveControls(base,{...base,singing_block_ms:160},'running'),/停止/,'changing it restarts the audio');
assert.doesNotThrow(()=>liveControls(base,{...base,singing_block_ms:160},'stopped'));
assert(presets.PRESET_KEYS?presets.PRESET_KEYS.includes('singing_block_ms'):require('node:fs').readFileSync(require.resolve('../electron/presets.cjs'),'utf8').includes("'singing_block_ms'"),'presets keep it');
// Presets saved before the setting existed must still load, as the 80 ms they were made with.
{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'yvc-old-presets-'));
 try{
  const settings=presets.snapshot(normalize({beatrice_pitch:7}));delete settings.singing_block_ms;
  fs.writeFileSync(path.join(home,'presets.json'),JSON.stringify({version:1,presets:[{id:'abc',name:'古い',settings}],active:'abc'}));
  const store=new presets.Presets(home);
  assert.equal(store.error,undefined,store.error);
  const [item]=store.list(normalize({}));
  assert.equal(item.name,'古い');
  const applied=store.apply('abc',normalize({singing_block_ms:240}),[]);
  assert.equal((applied.config||applied).singing_block_ms,80);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
}
console.log('PASS singing interval: 80-400 ms in 80 ms steps, default 80, stop to change, kept in presets');
