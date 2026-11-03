import React,{useEffect,useRef,useState} from 'react';
export type LibraryModel={id:string;path:string;voice:number;label:string;alias:string;icon:string;available:boolean};
type OfficialModel={installing:boolean;message:string;error:string;supported:boolean;onInstall:()=>Promise<string|null>;onCancel:()=>Promise<void>;onTerms:()=>Promise<void>};
type Props={items:LibraryModel[];icons:Record<string,string>;currentId?:string;selectedId?:string;onSelect:(id:string)=>void;disabled:boolean;onClose:()=>void;onTrain:()=>void;onAdd:()=>Promise<string|null>;onUse:(id:string)=>Promise<void>;onSave:(id:string,alias:string,icon:string)=>Promise<void>;onRemove:(id:string)=>Promise<void>;onPickIcon:(id:string)=>Promise<{icon:string;data:string}|null>;official:OfficialModel};
export default function ModelLibrary(props:Props){
 const dialog=useRef<HTMLDialogElement>(null);
 const [editing,setEditing]=useState(''),[alias,setAlias]=useState(''),[icon,setIcon]=useState(''),[preview,setPreview]=useState('');
 const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [removing,setRemoving]=useState<LibraryModel|null>(null);
 const [officialOpen,setOfficialOpen]=useState(!props.items.length);
 const item=props.items.find(model=>model.id===editing),locked=busy||props.disabled;
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 useEffect(()=>{if(item){setAlias(item.alias);setIcon(item.icon);setPreview('');}},[editing,item?.id]);
 const run=async(action:()=>Promise<void>)=>{setBusy(true);setError('');try{await action();}catch(e){setError(String(e));}finally{setBusy(false);}};
 const picture=(id:string,label:string)=>props.icons[id]?<img src={props.icons[id]} alt=""/>:<span aria-hidden="true">{Array.from(label)[0]||'＋'}</span>;
 const filtered=props.items.filter(model=>(model.label+' '+model.path).toLowerCase().includes(query.toLowerCase()));
 const selected=props.items.find(model=>model.id===props.selectedId);
 return <><dialog ref={dialog} className="model-library" aria-label="モデル一覧" onCancel={e=>{e.preventDefault();if(!busy)props.onClose();}}>
  <div className="library-header"><h2>{item?'モデルを編集':'モデル一覧'}</h2><button aria-label="モデル一覧を閉じる" title="閉じる" disabled={busy} onClick={props.onClose}>×</button></div>
  {error&&<p className="error" role="alert">{error}</p>}
  {busy&&!props.official.installing&&<p className="hint" role="status">処理中…</p>}
  {props.disabled&&!props.official.installing&&<p className="hint">変換・学習を停止すると、追加や編集ができます。</p>}
  {item?<form className="library-editor" onSubmit={e=>{e.preventDefault();run(async()=>{await props.onSave(item.id,alias,icon);setEditing('');});}}>
   <div className="library-icon-editor"><button type="button" className="library-icon" aria-label="編集するモデルのアイコンを選ぶ" title="ICO・PNG・JPGを選びます。保存するまで現在の設定は変わりません。" disabled={locked} onClick={()=>run(async()=>{const next=await props.onPickIcon(item.id);if(next){setIcon(next.icon);setPreview(next.data);}})}>{icon&&(preview||props.icons[icon])?<img src={preview||props.icons[icon]} alt=""/>:<span>＋</span>}</button><button type="button" disabled={locked} onClick={()=>run(async()=>{const next=await props.onPickIcon(item.id);if(next){setIcon(next.icon);setPreview(next.data);}})}>アイコンを選ぶ</button>{icon&&<button type="button" disabled={locked} onClick={()=>{setIcon('');setPreview('');}}>アイコンを外す</button>}</div>
   <label className="library-alias"><span>モデルの別名</span><input autoFocus value={alias} maxLength={80} placeholder={item.path.split(/[\\/]/).pop()} disabled={locked} onChange={e=>setAlias(e.target.value)}/></label>
   <div className="library-editor-tools"><button type="button" disabled={locked||!alias} title="別名を空にしてファイル名の表示に戻します。保存すると反映されます。" onClick={()=>setAlias('')}>ファイル名に戻す</button></div>
   <details className="library-file"><summary>ファイルの場所</summary><p>{item.path}</p></details>
   <div className="library-editor-actions"><button className="primary" disabled={locked} type="submit">保存</button><button disabled={busy} type="button" onClick={()=>{setEditing('');setError('');}}>キャンセル</button></div>
  </form>:<>
   <details className="stock-model-install" open={officialOpen} onToggle={e=>setOfficialOpen(e.currentTarget.open)}>
    <summary>つくよみちゃんで試す</summary>
    <p>利用規約に同意して、公式配布元から約19MBのモデルを一覧に追加します。</p>
    <p className="hint">つくよみちゃん © Rei Yumesaki ／ 公式モデル：Project Beatrice</p>
    <div className="guide-actions">
     <button title="つくよみちゃん（コーパス）を追加します。使用中のモデルは、切り替えボタンを押すまで変わりません。" className="primary" disabled={locked||!props.official.supported} onClick={()=>run(async()=>{const id=await props.official.onInstall();if(id){props.onSelect(id);setQuery('');}})}>{props.official.installing?'つくよみちゃんを導入中…':'規約に同意してつくよみちゃんを導入'}</button>
     <button title="ブラウザーで公式モデルの利用規約を開きます。" onClick={()=>props.official.onTerms().catch(e=>setError(String(e)))}>利用規約を読む ↗</button>
     {props.official.installing&&<button title="今回のダウンロード・導入を中止します。" onClick={()=>props.official.onCancel().catch(e=>setError(String(e)))}>導入を中止</button>}
    </div>
    {props.official.message&&<p role="status">{props.official.message}</p>}
    {props.official.error&&<p className="error" role="alert">{props.official.error}</p>}
   </details>
   <div className="library-toolbar"><input aria-label="モデルを検索" placeholder="モデルを検索" value={query} onChange={e=>setQuery(e.target.value)}/><button className="primary" disabled={locked} title="モデルのファイルを一覧に追加します。現在の選択は変えません。" onClick={()=>run(async()=>{const id=await props.onAdd();if(id){props.onSelect(id);setEditing(id);setQuery('');}})}>＋ モデルを追加</button><button disabled={locked} onClick={props.onTrain}>RVCから作成</button></div>
   <div className="library-items">{filtered.map(model=><div key={model.id} className={'library-item '+(model.id===props.selectedId?'selected ':'')+(model.id===props.currentId?'in-use':'')} role="group" aria-label={model.label}>
    <button className="library-select" aria-label={`モデルを選択：${model.label}`} aria-pressed={model.id===props.selectedId} title={model.path} disabled={locked||!model.available} onClick={()=>props.onSelect(model.id)}><span className="library-icon">{picture(model.icon,model.label)}</span><span className="library-model-name"><strong>{model.label}</strong><small>{!model.available?'ファイルなし':model.id===props.currentId?'使用中':model.id===props.selectedId?'選択中':''}</small></span></button>
    <div className="library-row-actions"><button disabled={locked} onClick={()=>{setEditing(model.id);setError('');}}>編集</button><button className="remove-model" title="確認してから一覧から外します。モデルのファイルは削除しません。" disabled={locked} onClick={()=>setRemoving(model)}>一覧から削除</button></div>
   </div>)}</div>
   {!filtered.length&&<p className="hint">{props.items.length?'一致するモデルがありません。':'モデルを追加してください。'}</p>}
   <div className="library-confirm"><span>{selected?`選択：${selected.label}`:'モデルを選択してください。'}</span><button className="primary" disabled={locked||!selected?.available||selected.id===props.currentId} onClick={()=>run(async()=>{if(selected){await props.onUse(selected.id);props.onClose();}})}>このモデルに切り替える</button></div>
  </>}
 </dialog>{removing&&<RemoveModelConfirmation model={removing} current={removing.id===props.currentId} onClose={()=>setRemoving(null)} onRemove={()=>props.onRemove(removing.id)}/>}</>;
}

function RemoveModelConfirmation(props:{model:LibraryModel;current:boolean;onClose:()=>void;onRemove:()=>Promise<void>}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
 const remove=async()=>{setBusy(true);setError('');try{await props.onRemove();props.onClose();}catch(e){setError(String(e));}finally{setBusy(false);}};
 return <dialog ref={dialog} className="model-library library-remove-confirmation" aria-labelledby="remove-model-title" aria-describedby="remove-model-description" onCancel={e=>{e.preventDefault();if(!busy)props.onClose();}}>
  <h2 id="remove-model-title">一覧から削除しますか？</h2>
  <p className="library-remove-name">{props.model.label}</p>
  <div id="remove-model-description"><p>モデルのファイルは削除されません。</p>{props.current&&<p>使用中のモデルが未選択になります。</p>}</div>
  {error&&<p className="error" role="alert">{error}</p>}
  <div className="library-editor-actions"><button autoFocus disabled={busy} onClick={props.onClose}>キャンセル</button><button className="primary" disabled={busy} onClick={remove}>{busy?'削除中…':'一覧から削除'}</button></div>
 </dialog>;
}
