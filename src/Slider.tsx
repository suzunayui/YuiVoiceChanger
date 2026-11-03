import React,{useId} from 'react';

export default function Slider({label,help,value,min,max,step=1,unit,signed=true,labelControl,disabled,onChange}:{label:string;help:string;value:number;min:number;max:number;step?:number;unit:string;signed?:boolean;labelControl?:React.ReactNode;disabled:boolean;onChange:(n:number)=>void}){
 const id=useId();
 return <div className="slider" title={help}><div>{labelControl??<label htmlFor={id}>{label}</label>}<div className="slider-value-controls">
  <button type="button" className="step-button" aria-label={`${label}を1${unit}減らす`} disabled={disabled||value<=min} onClick={()=>onChange(Math.max(min,value-1))}>−</button>
  <strong>{signed&&value>0?'+':''}{value}<small> {unit}</small></strong>
  <button type="button" className="step-button" aria-label={`${label}を1${unit}増やす`} disabled={disabled||value>=max} onClick={()=>onChange(Math.min(max,value+1))}>＋</button>
 </div></div><input id={id} aria-label={label} aria-description={help} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={e=>onChange(Number(e.target.value))}/></div>;
}
