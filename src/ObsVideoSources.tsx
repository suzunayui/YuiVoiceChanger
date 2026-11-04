import React from 'react';
export type VideoSource={id:string;inputUuid:string;inputName:string};
type Choice={inputUuid:string;inputName:string};
const keyOf=(input:Choice)=>input.inputUuid?'uuid:'+input.inputUuid:input.inputName?'name:'+input.inputName:'';

function SourceRow({item,index,items,choices,disabled,onChange,onRemove}:{item:VideoSource;index:number;items:VideoSource[];choices:Choice[];disabled:boolean;onChange:(patch:Partial<VideoSource>)=>void;onRemove:()=>void}){
 const selected=keyOf(item),known=choices.some(choice=>keyOf(choice)===selected);
 return <div className="obs-video-row">
  <div className="obs-video-select"><select aria-label={`映像ソース ${index+1}`} value={selected} disabled={disabled} title="ウィンドウキャプチャや3Dモデルの映像キャプチャデバイスを選びます。" onChange={event=>{const source=choices.find(choice=>keyOf(choice)===event.target.value);onChange({inputUuid:source?.inputUuid||'',inputName:source?.inputName||''});}}>
   <option value="">映像ソースを選択</option>{selected&&!known&&<option value={selected}>{item.inputName||'選択済みの映像'}（未確認）</option>}{choices.map(choice=><option key={keyOf(choice)} value={keyOf(choice)} disabled={items.some(other=>other.id!==item.id&&keyOf(other)===keyOf(choice))}>{choice.inputName}</option>)}
  </select><button className="obs-button obs-source-step" aria-label={`映像ソース ${index+1} を削除`} title="同期対象から外し、この映像の遅延を元に戻します。OBSのソースは削除しません。" disabled={disabled} onClick={onRemove}>−</button></div>
 </div>;
}

export default function ObsVideoSources({items,choices,enabled,disabled,onChange,onEnabled}:{items:VideoSource[];choices:Choice[];enabled:boolean;disabled:boolean;onChange:(items:VideoSource[],enabled?:boolean)=>void;onEnabled:(value:boolean)=>void}){
 const hasSelection=items.some(item=>Boolean(keyOf(item)));
 return <div className="obs-video-sources">
  <div className="obs-source-heading obs-video-heading"><span>遅延させる映像</span><div className="obs-video-actions"><label className="singing-toggle" title="選んだ映像を声の遅延に合わせます。500msを超える分は自動分割し、停止時に元へ戻します。"><input type="checkbox" aria-label="映像も声に同期" checked={enabled} disabled={disabled||(!enabled&&!hasSelection)} onChange={event=>onEnabled(event.target.checked)}/>同期</label></div></div>
  {items.map((item,index)=><SourceRow key={item.id} item={item} index={index} items={items} choices={choices} disabled={disabled} onChange={patch=>{const next=items.map(source=>source.id===item.id?{...source,...patch}:source);onChange(next,'inputUuid' in patch||'inputName' in patch?next.some(source=>Boolean(keyOf(source))):undefined);}} onRemove={()=>{const next=items.filter(source=>source.id!==item.id);onChange(next,enabled&&next.some(source=>Boolean(keyOf(source))));}}/>)}
  <button className="obs-button obs-video-add" aria-label="映像ソースを追加" title="一覧の末尾に映像を追加（最大8個）" disabled={disabled||items.length>=8} onClick={()=>onChange([...items,{id:crypto.randomUUID(),inputUuid:'',inputName:''}])}>＋ 映像を追加</button>
 </div>;
}
