import React,{useEffect,useRef,useState} from 'react';
import type {Config} from './main';
type Preset={id:string;name:string;active?:boolean};
type Props={config:Config;disabled:boolean;saveDisabled:boolean;onApply:(config:Config)=>void};
export default function PresetCard({config,disabled,saveDisabled,onApply}:Props){
 const [items,setItems]=useState<Preset[]>([]);
 const [editing,setEditing]=useState<Preset|'new'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{let cancelled=false;window.yvc.invoke('presets').then(next=>{if(!cancelled)setItems(next);}).catch(e=>{if(!cancelled)setError(String(e));});return()=>{cancelled=true;};},[]);
 useEffect(()=>window.yvc.subscribe(event=>{if(event.type==='presets')setItems(event.items);}),[]);
 const apply=async(item:Preset)=>{setBusy(true);setError('');setMessage('');try{const next=await window.yvc.invoke('apply-preset',item.id);onApply(next);setMessage(`「${item.name}」を適用しました。`);}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <section className="card preset-card" aria-label="プリセット">
  <div className="section-title"><h3>プリセット</h3><button className="obs-button" disabled={busy||saveDisabled} title="現在のモデル・音声ルート・声の調整・実行先・歌枠用設定に名前を付けて保存します。Python環境・学習設定・OBSのパスワードは保存しません。" onClick={()=>{setError('');setEditing('new');}}>現在の設定を保存</button></div>
  <div className="preset-list">{items.map(item=><div className="preset-entry" key={item.id}>
   <button className={'obs-button preset-apply'+(item.active?' chosen':'')} aria-pressed={!!item.active} disabled={busy||disabled} title={`${item.name}：${disabled?'準備・切り替え・学習が終わるまでお待ちください。':'クリックで設定を切り替えます。変換中も使えます。同じモデル・実行先なら重みを保持します。固定遅延や入出力先を変える場合は音声バッファを作り直すため、一時的に音が途切れます。'}`} onClick={()=>apply(item)}>{item.active&&<span aria-hidden="true">✓ </span>}{item.name}</button>
   <button className="obs-button preset-edit" aria-label={`プリセット「${item.name}」を編集`} disabled={busy||saveDisabled} title="名前の変更・現在の設定で上書き・削除を行います。" onClick={()=>{setError('');setEditing(item);}}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg></button>
  </div>)}</div>
  {!items.length&&!error&&<p className="hint">保存したプリセットがありません。</p>}
  {message&&<p className="hint" role="status">{message}</p>}{error&&<p className="error" role="alert">{error}</p>}
  {editing&&<PresetEditor item={editing==='new'?undefined:editing} config={config} disabled={saveDisabled} onClose={()=>setEditing(null)} onSaved={(next,_id,text)=>{setItems(next);setMessage(text);setEditing(null);}}/>}
 </section>;
}
function PresetEditor({item,config,disabled,onClose,onSaved}:{item?:Preset;config:Config;disabled:boolean;onClose:()=>void;onSaved:(items:Preset[],id:string,message:string)=>void}){
 const dialog=useRef<HTMLDialogElement>(null),[name,setName]=useState(item?.name||'');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState<'overwrite'|'remove'|null>(null);
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 const save=async(overwrite=false)=>{setBusy(true);setError('');try{const result=await window.yvc.invoke('save-preset',{id:item?.id,name,...(!item||overwrite?{config}:{})});onSaved(result.items,result.id,`「${name.trim()}」を保存しました。`);}catch(e){setError(String(e));}finally{setBusy(false);}};
 const remove=async()=>{setBusy(true);setError('');try{const items=await window.yvc.invoke('remove-preset',item?.id);onSaved(items,'','プリセットを削除しました。');}catch(e){setError(String(e));}finally{setBusy(false);}};
 const locked=busy||disabled;
 return <dialog ref={dialog} className="model-library preset-dialog" aria-label={confirm==='remove'?'プリセットを削除':confirm==='overwrite'?'プリセットを上書き':item?'プリセットを編集':'プリセットを保存'} onCancel={e=>{e.preventDefault();if(!busy)onClose();}}>
  <div className="library-header"><h2>{confirm==='remove'?'プリセットを削除しますか？':confirm==='overwrite'?'現在の設定で上書きしますか？':item?'プリセットを編集':'プリセットを保存'}</h2><button aria-label="プリセットの編集を閉じる" disabled={busy} onClick={onClose}>×</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  {confirm?<><p className="preset-confirm-name">{confirm==='remove'?item?.name:name.trim()}</p><div className="library-editor-actions"><button className="obs-button" autoFocus disabled={busy} onClick={()=>{setConfirm(null);setError('');}}>戻る</button><button className="primary" disabled={locked} onClick={()=>confirm==='remove'?remove():save(true)}>{confirm==='remove'?'削除する':'上書きする'}</button></div></>:<form onSubmit={e=>{e.preventDefault();save();}}>
   <label className="library-alias"><span>プリセット名</span><input autoFocus maxLength={80} value={name} disabled={locked} onChange={e=>setName(e.target.value)} placeholder="例：通話用・歌枠用"/></label>
   <div className="library-editor-actions"><button className="primary" type="submit" disabled={locked||!name.trim()}>{item?'名前を保存':'保存'}</button><button className="obs-button" type="button" disabled={busy} onClick={onClose}>キャンセル</button></div>
   {item&&<div className="preset-management"><button className="obs-button" type="button" disabled={locked||!name.trim()} onClick={()=>setConfirm('overwrite')}>現在の設定で上書き</button><button className="obs-button" type="button" disabled={locked} onClick={()=>setConfirm('remove')}>削除</button></div>}
  </form>}
 </dialog>;
}
