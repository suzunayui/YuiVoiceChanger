const assert=require('node:assert/strict');
const {Hotkeys,MUTE_ACCELERATOR,presetAccelerator}=require('../electron/hotkeys.cjs');
function fakeShortcuts(taken=[]){
 const handlers=new Map();
 return {handlers,register(key,handler){if(taken.includes(key))return false;handlers.set(key,handler);return true;},unregister(key){handlers.delete(key);},isRegistered:key=>handlers.has(key)};
}
let now=1000;const clock=()=>now;
{
 const shortcuts=fakeShortcuts(),calls=[];
 const hotkeys=new Hotkeys({shortcuts,onMute:()=>calls.push('mute'),onPreset:index=>calls.push(index),clock});
 assert.deepEqual(hotkeys.sync(false),{enabled:false,failed:[]});assert.equal(shortcuts.handlers.size,0);
 assert.deepEqual(hotkeys.sync(true),{enabled:true,failed:[]});assert.equal(shortcuts.handlers.size,10);
 shortcuts.handlers.get(MUTE_ACCELERATOR)();
 now+=50;shortcuts.handlers.get(MUTE_ACCELERATOR)();
 now+=200;shortcuts.handlers.get(MUTE_ACCELERATOR)();
 assert.deepEqual(calls,['mute'],'holding the key is one press');
 now+=1000;shortcuts.handlers.get(MUTE_ACCELERATOR)();
 assert.deepEqual(calls,['mute','mute']);
 now+=1000;shortcuts.handlers.get(presetAccelerator(2))();
 assert.deepEqual(calls,['mute','mute',2]);
 hotkeys.sync(false);assert.equal(shortcuts.handlers.size,0);
}
{
 const shortcuts=fakeShortcuts([MUTE_ACCELERATOR,presetAccelerator(0)]);
 const hotkeys=new Hotkeys({shortcuts,onMute(){},onPreset(){},clock});
 const status=hotkeys.sync(true);
 assert.deepEqual(status.failed,[MUTE_ACCELERATOR,presetAccelerator(0)]);
 assert.equal(shortcuts.handlers.size,8,'keys that are free still work');
 assert.deepEqual(hotkeys.status(),status);
}
console.log('PASS hotkeys: opt-in registration, key repeat is one press, shortcuts taken by other apps are reported');
