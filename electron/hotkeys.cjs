const MUTE_ACCELERATOR='CommandOrControl+Alt+M';
const PRESET_COUNT=9;
const REPEAT_MS=400;
const presetAccelerator=index=>`CommandOrControl+Alt+${index+1}`;
class Hotkeys{
 constructor({shortcuts,onMute,onPreset,clock=Date.now}){
  this.shortcuts=shortcuts;this.clock=clock;this.registered=[];this.current={enabled:false,failed:[]};
  this.bindings=[[MUTE_ACCELERATOR,onMute],...Array.from({length:PRESET_COUNT},(_,index)=>[presetAccelerator(index),()=>onPreset(index)])];
 }
 // Holding a key repeats it; a toggle that flips on every repeat would be unusable on air.
 once(handler){
  let last=-Infinity;
  return ()=>{const now=this.clock(),repeat=now-last<REPEAT_MS;last=now;if(!repeat)handler();};
 }
 sync(enabled){
  for(const key of this.registered)this.shortcuts.unregister(key);
  this.registered=[];
  const failed=[];
  if(enabled)for(const [key,handler] of this.bindings){
   if(this.shortcuts.register(key,this.once(handler)))this.registered.push(key);else failed.push(key);
  }
  return this.current={enabled:!!enabled,failed};
 }
 status(){return this.current;}
}
module.exports={Hotkeys,MUTE_ACCELERATOR,PRESET_COUNT,presetAccelerator};
