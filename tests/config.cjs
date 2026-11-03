const assert=require('node:assert/strict');
const {normalize}=require('../electron/config.cjs');
const old={beatrice_vst:'vst',beatrice_model:'voice.toml',beatrice_libs:'old-libs',python:'old-python',beatrice_block:.02,beatrice_pitch:14,beatrice_formant:.5,input:27,output:23,input_name:'USB',output_name:'CABLE',gain:18,beatrice_clarity:true};
const migrated=normalize(old);
assert.equal(migrated.engine_version,2);
assert.equal(migrated.beatrice_pitch,14);assert.equal(migrated.beatrice_formant,.5);
assert.equal(migrated.input_name,'USB');assert.equal(migrated.output_name,'CABLE');
assert.equal(migrated.python,'');assert.equal(migrated.beatrice_model,'');
assert.equal(migrated.gain,0);assert.equal(migrated.input_gain,12);assert.equal(migrated.beatrice_block,.08);
assert.equal('beatrice_vst' in migrated,false);assert.equal('beatrice_libs' in migrated,false);
const current={...migrated,beatrice_model:'声.pt.gz',python:'new-python',gain:3};
assert.deepEqual(normalize(current),current);
for(const bad of [{gain:100},{beatrice_formant:.3},{beatrice_voice:-1},{beatrice_voice:.5},{input:2.5},{schedule_ms:100},{beatrice_block:.02},{engine_version:3},{python:42},{compute:'unknown'},{teacher_pitch:100},{training_steps:1.5}])assert.throws(()=>normalize(bad));
assert.throws(()=>normalize({arbitrary:'x'},{importing:true}));
assert.equal(normalize({beatrice_model_label:'以前の自動名'}).beatrice_model_alias,'');
assert.equal(normalize({beatrice_model_alias:'自分の名前'}).beatrice_model_alias,'自分の名前');
assert.throws(()=>normalize({beatrice_model_alias:'x'.repeat(81)}));
assert.throws(()=>normalize({beatrice_model_alias:'改行\n入り'}));
assert.throws(()=>normalize({beatrice_model_icon:'../outside.png'}));
assert.equal(normalize({beatrice_model_icon:'a'.repeat(64)}).beatrice_model_icon,'a'.repeat(64));
console.log('PASS legacy migration, gain calibration, current settings roundtrip, invalid settings rejection');

const {liveControls}=require('../electron/config.cjs');
const liveBase=normalize({});
const liveNext=normalize({...liveBase,beatrice_pitch:3,beatrice_formant:.5,input_gain:6,gain:-4});
assert.deepEqual(liveControls(liveBase,liveNext,'running'),{beatrice_pitch:3,beatrice_formant:.5,input_gain:6,gain:-4});
assert.equal(liveControls(liveBase,liveBase,'running'),null);
assert.equal(liveControls(liveBase,liveNext,'stopped'),null);
for(const state of ['loading','stopping'])assert.throws(()=>liveControls(liveBase,liveNext,state));
for(const change of [{beatrice_model:'D:\\other.pt.gz'},{input:1},{output:2},{compute:'cpu'},{beatrice_voice:1},{python:'other-python'}]){
 assert.throws(()=>liveControls(liveBase,normalize({...liveNext,...change}),'running'));
}
console.log('PASS live adjustment snapshot; model/device/runtime changes remain blocked while converting');

assert.equal(normalize({}).singing_enabled,false);
assert.equal(normalize({}).fx_enabled,false);
for(const change of [{singing_latency_ms:199},{singing_latency_ms:2001},{singing_enabled:1},{fx_enabled:1},{fx_echo_ms:0},{fx_reverb:51},{fx_compressor:.5}])assert.throws(()=>normalize(change));
assert.throws(()=>liveControls(liveBase,normalize({...liveBase,singing_enabled:true}),'running'));
assert.throws(()=>liveControls(liveBase,normalize({...liveBase,singing_latency_ms:500}),'running'));
assert.deepEqual(liveControls(liveBase,normalize({...liveBase,fx_enabled:true,fx_reverb:15}),'running'),{beatrice_pitch:14,beatrice_formant:0,input_gain:12,gain:0});
console.log('PASS singing/effect validation, safe defaults, fixed timing locked and effects adjustable during conversion');

for(const compute of ['cpu','auto','cuda','cuda:0','cuda:1'])assert.equal(normalize({compute}).compute,compute);
for(const compute of ['cuda:-1','cuda:01','cuda:1.5','cuda:999999'])assert.throws(()=>normalize({compute}));
