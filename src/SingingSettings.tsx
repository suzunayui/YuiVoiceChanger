import React from 'react';
import type {Config} from './main';
import Slider from './Slider';
import ObsIntegration from './ObsIntegration';
import LatencyCalibration,{type CalibrationStatus} from './LatencyCalibration';
import StreamMix from './StreamMix';

export const effectDefaults={fx_enabled:false,fx_lowcut:80,fx_brightness:0,fx_compressor:0,fx_deesser:0,fx_reverb:0,fx_echo:0,fx_echo_ms:250,fx_limiter:true};
export type EffectConfig=typeof effectDefaults;
const presets=[
 {name:'ナチュラル',values:{fx_lowcut:80,fx_brightness:1,fx_compressor:25,fx_deesser:20,fx_reverb:6,fx_echo:0,fx_echo_ms:250}},
 {name:'ポップ',values:{fx_lowcut:100,fx_brightness:2,fx_compressor:50,fx_deesser:35,fx_reverb:10,fx_echo:8,fx_echo_ms:250}},
 {name:'バラード',values:{fx_lowcut:70,fx_brightness:0,fx_compressor:35,fx_deesser:25,fx_reverb:20,fx_echo:14,fx_echo_ms:375}}
];

export default function SingingSettings({config,active,effectsDisabled,running,metrics,calibration,onCalibration,onUpdate}:{config:Config;active:boolean;effectsDisabled:boolean;running:boolean;metrics:any;calibration:CalibrationStatus;onCalibration:(next:CalibrationStatus)=>void;onUpdate:(patch:Partial<Config>)=>void}){
 const effect=(key:keyof EffectConfig,label:string,help:string,min:number,max:number,unit='%')=><Slider key={key} label={label} help={help} value={Number(config[key])} min={min} max={max} unit={unit} signed={unit==='dB'} disabled={effectsDisabled||!config.fx_enabled} onChange={value=>onUpdate({[key]:value})}/>;
 return <div className="singing-grid">
  <div className="singing-sidebar">
  <StreamMix config={config} active={active} disabled={effectsDisabled} running={running} onUpdate={onUpdate}>
   <Slider label="固定遅延" help={config.mix_enabled?'声と伴奏をそろえて出力するまでの待ち時間です。OBSまでの機器の遅延は別に加わります。変更は停止中に行います。':'マイク入力からOBSに届くまでの目標遅延です。自動測定後は経路の遅れを差し引いて声の出力時刻を調整します。変更は停止中に行います。'} value={config.mix_enabled?config.mix_latency_ms:config.singing_latency_ms+config.obs_correction_ms} min={200} max={3000} step={1} unit="ms" signed={false} disabled={active} onChange={value=>{if(config.mix_enabled){onUpdate({mix_latency_ms:value});return;}const base=Math.min(value,Math.max(200,Math.min(2000,Math.max(config.singing_latency_ms,value-1000))));onUpdate({singing_latency_ms:base,obs_correction_ms:value-base,obs_delay_manual:true});}}/>
   {!config.mix_enabled&&<LatencyCalibration config={config} status={calibration} disabled={active} onStatus={onCalibration} buttonLabel="処理時間から設定"/>}
  </StreamMix>
  <ObsIntegration config={config} active={active} disabled={effectsDisabled} running={running} onUpdate={onUpdate}/>
  </div>
  <section className="card vocal-effects" aria-label="ボーカルエフェクト">
   <div className="section-title"><h3>ボーカルエフェクト</h3><label className="singing-toggle" title="変換後の声にエフェクトをかけます。変換中も変更できます。"><input type="checkbox" checked={config.fx_enabled} disabled={effectsDisabled} onChange={e=>onUpdate({fx_enabled:e.target.checked})}/>有効</label></div>
   <div className="effect-presets" aria-label="エフェクトのプリセット">{presets.map(preset=><button key={preset.name} disabled={effectsDisabled} title="このプリセットのエフェクトをまとめて適用します。固定遅延の設定は変えません。" onClick={()=>onUpdate({...preset.values,fx_enabled:true,fx_limiter:true})}>{preset.name}</button>)}<button disabled={effectsDisabled} title="エフェクトだけを初期値へ戻します。" onClick={()=>onUpdate(effectDefaults)}>リセット</button></div>
   <div className="effects-grid">
    <div>
     {effect('fx_lowcut','ローカット','息や振動の低音を減らします。0Hzで無効です。',0,200,'Hz')}
     {effect('fx_brightness','明るさ','高音域を上げ下げします。こもる場合は少し上げ、刺さる場合は下げます。',-6,6,'dB')}
     {effect('fx_compressor','コンプレッサー','声の大小をそろえます。上げるほど強くかかります。0%で無効です。',0,100)}
     {effect('fx_deesser','歯擦音の抑制','サ行などの鋭い高音を抑えます。強くすると声の明瞭さも変わります。0%で無効です。',0,100)}
    </div>
    <div>
     {effect('fx_reverb','リバーブ','空間の響きを加えます。0%で無効です。',0,50)}
     {effect('fx_echo','エコー','声を遅れて繰り返します。主音のタイミングは変えません。0%で無効です。',0,50)}
     {effect('fx_echo_ms','エコーの間隔','繰り返す間隔です。四分音符なら60000÷BPM、八分音符なら30000÷BPMが目安です。',80,1000,'ms')}
     <label className="singing-toggle limiter-toggle" title="エフェクトによるピークを抑えます。先読みを使わないため遅延は増えません。元から割れている音は復元しません。"><input type="checkbox" checked={config.fx_limiter} disabled={effectsDisabled||!config.fx_enabled} onChange={e=>onUpdate({fx_limiter:e.target.checked})}/>リミッター</label>
    </div>
   </div>
  </section>
 </div>;
}
