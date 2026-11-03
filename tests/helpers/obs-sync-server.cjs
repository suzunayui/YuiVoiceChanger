const {ObsServer}=require('./obs-server.cjs');
const fs=require('node:fs'),path=require('node:path');
class ObsSyncServer extends ObsServer{
 constructor(){
  super({auth:false});this.streaming=false;this.recording=false;this.replay=false;this.replayAvailable=false;this.cameraAvailable=true;this.profile='Original';this.profiles=['Original'];this.failNext='';
  this.parameters={'Output/Mode':'Simple','Output/FilenameFormatting':'original-%ss','SimpleOutput/RecTracks':'1','SimpleOutput/FilePath':'original-folder','SimpleOutput/RecFormat2':'mkv','SimpleOutput/RecQuality':'Small'};
  for(const input of this.inputs)input.tracks={'1':true,'2':false,'3':false,'4':false,'5':false,'6':false};
  this.extraRequests=['GetProfileParameter','SetProfileParameter','GetProfileList','CreateProfile','SetCurrentProfile','RemoveProfile','GetInputAudioTracks','SetInputAudioTracks','StartRecord','StopRecord','GetStreamStatus','GetRecordStatus','GetReplayBufferStatus','GetInputMute','GetInputSettings','GetInputPropertiesListPropertyItems','CreateInput','RemoveInput','GetCurrentProgramScene','SetInputAudioMonitorType','SetSceneItemEnabled'];
  this.handleRequest=async(type,data)=>{
   if(this.failNext===type){this.failNext='';return {code:500};}
   let response={};const input=this.inputs.find(item=>data.inputUuid?item.inputUuid===data.inputUuid:item.inputName===data.inputName);
   if(type==='GetStreamStatus')response={outputActive:this.streaming};
   else if(type==='GetRecordStatus')response={outputActive:this.recording};
   else if(type==='GetReplayBufferStatus'){if(!this.replayAvailable&&!this.replay)return {code:604};response={outputActive:this.replay};}
   else if(type==='GetVirtualCamStatus'){if(!this.cameraAvailable)return {code:604};response={outputActive:!!this.camera};}
   else if(type==='GetProfileList')response={currentProfileName:this.profile,profiles:[...this.profiles]};
   else if(type==='GetProfileParameter')response={parameterValue:this.parameters[data.parameterCategory+'/'+data.parameterName]??null};
   else if(type==='SetProfileParameter'){const key=data.parameterCategory+'/'+data.parameterName;if(data.parameterValue===null)delete this.parameters[key];else this.parameters[key]=data.parameterValue;}
   else if(type==='GetInputAudioTracks'){if(!input)return {code:600};response={inputAudioTracks:structuredClone(input.tracks)};}
   else if(type==='SetInputAudioTracks'){if(!input)return {code:600};input.tracks=structuredClone(data.inputAudioTracks);}
   else if(type==='GetInputMute')response={inputMuted:false};
   else if(type==='GetInputSettings')response={inputKind:input?.inputUuid==='desktop'?'wasapi_output_capture':'wasapi_input_capture',inputSettings:{device_id:input?.inputUuid==='desktop'?'default':input?.inputUuid==='voice'?'cable':'mic'}};
   else if(type==='GetInputPropertiesListPropertyItems')response={propertyItems:[{itemName:'Fixture mic',itemValue:'mic',itemEnabled:true},{itemName:'CABLE Output',itemValue:'cable',itemEnabled:true}]};
   else if(type==='GetCurrentProgramScene')response={currentProgramSceneName:'Scene'};
   else if(type==='CreateInput'){this.inputs.push({inputName:data.inputName,inputUuid:'raw-'+this.inputs.length,offset:0,tracks:{'1':false,'2':true,'3':false,'4':false,'5':false,'6':false}});response={inputUuid:this.inputs.at(-1).inputUuid,sceneItemId:42};}
   else if(type==='RemoveInput'){if(!input)return {code:600};this.inputs=this.inputs.filter(item=>item!==input);}
   else if(type==='SetInputAudioMonitorType'||type==='SetSceneItemEnabled'){}
   else if(type==='StartRecord'){if(this.recording)return {code:500};this.recording=true;const folder=this.parameters['SimpleOutput/FilePath'];fs.mkdirSync(folder,{recursive:true});this.recordFile=path.join(folder,'test.mkv');fs.writeFileSync(this.recordFile,'fixture');}
   else if(type==='StopRecord'){this.recording=false;response={outputPath:this.recordFile};}
   else if(type==='CreateProfile'){
    if(this.profiles.includes(data.profileName))return {code:601};
    const create=()=>{this.profiles.push(data.profileName);this.profile=data.profileName;};
    if(this.profileDelay)setTimeout(create,this.profileDelay);else create();
   }
   else if(type==='SetCurrentProfile'){if(!this.profiles.includes(data.profileName))return {code:600};this.profile=data.profileName;}
   else if(type==='RemoveProfile'){
    if(this.profile===data.profileName)return {code:500};
    const remove=()=>{this.profiles=this.profiles.filter(name=>name!==data.profileName);};
    if(this.profileDelay)setTimeout(remove,this.profileDelay);else remove();
   }
   else return null;
   return {response};
  };
 }
}
module.exports={ObsSyncServer};
