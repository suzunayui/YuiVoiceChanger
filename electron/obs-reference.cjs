const fs=require('node:fs');
const now=()=>Number(process.hrtime.bigint())/1e9;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Small WAV packets keep OBS's next-packet media cursor within 1 ms of playback.
const RATE=48000,PACKET_MS=1,LEAD_SECONDS=4,ONSETS=[1.8,2.73,3.96,4.78,6.12,7.17,8.60,9.57];
function writeReference(file){
 const pcm=Buffer.alloc(RATE*(15+LEAD_SECONDS)*2),length=Math.round(.08*RATE);
 for(const onset of ONSETS)for(let i=0;i<length;i++)pcm.writeInt16LE(Math.round(32767*.12*Math.sin(2*Math.PI*1000*i/RATE)*Math.sin(Math.PI*i/(length-1))**2),(Math.round((onset+LEAD_SECONDS)*RATE)+i)*2);
 const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(RATE,24);header.writeUInt32LE(RATE*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
 fs.writeFileSync(file,Buffer.concat([header,pcm]));
}
async function startReference({rpc,input,delayMs=0,check=()=>{},clock=now,wait=sleep}){
 if(!Number.isInteger(delayMs)||delayMs<0||delayMs>3000)throw Error('測定用の待ち時間が正しくありません。');
 check();await rpc('TriggerMediaInputAction',{...input,mediaAction:'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'});
 const samples=[];
 for(let i=0;i<24;i++){
  check();const before=clock(),state=await rpc('GetMediaInputStatus',input),after=clock();
  if(state.mediaState==='OBS_MEDIA_STATE_PLAYING'&&Number.isFinite(state.mediaCursor)&&state.mediaCursor>10&&state.mediaCursor<1000&&after-before<.02)
   samples.push({epoch:(before+after)/2-(state.mediaCursor-PACKET_MS)/1000,rtt:after-before,cursor:state.mediaCursor});
  await wait(10);
 }
 if(samples.length<8||samples.at(-1).cursor-samples[0].cursor<80)throw Error('OBSの測定用音声の再生時刻を確認できませんでした。');
 const epochs=samples.map(item=>item.epoch).sort((a,b)=>a-b),median=epochs[Math.floor(epochs.length/2)];
 if(epochs.at(-1)-epochs[0]>.015)throw Error('OBSの測定用音声の時刻が安定していないため測定しません。');
 // Bake the target delay into the relative injection epoch, rather than relying
 // on sync offsets being applied to a newly restarted media source by OBS.
 return median+LEAD_SECONDS-delayMs/1000;
}
module.exports={writeReference,startReference,now};
