import React,{useEffect,useRef,useState} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const files={readme:'README.md',beatrice:'docs/beatrice.md',mac:'docs/mac-preview.md',license:'LICENSE',notices:'THIRD_PARTY_NOTICES.md'};
type DocumentId=keyof typeof files;
const origin='https://yui-help.invalid/';
const headingId=(node:any):string=>{
 const text=(entry:any):string=>entry.value||entry.children?.map(text).join('')||'';
 return text(node).trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu,'').replace(/\s+/g,'-');
};

export default function Help(){
 const panel=useRef<HTMLElement>(null);
 const [doc,setDoc]=useState<DocumentId>('readme'),[anchor,setAnchor]=useState('');
 const [content,setContent]=useState(''),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 useEffect(()=>{
  let cancelled=false;setContent('');setLoading(true);setError('');
  window.yvc.invoke('read-help',doc).then(text=>{if(!cancelled)setContent(text);})
   .catch(e=>{if(!cancelled)setError(`説明を読み込めませんでした。${String(e)}`);})
   .finally(()=>{if(!cancelled)setLoading(false);});
  return()=>{cancelled=true;};
 },[doc,retry]);
 useEffect(()=>{
  if(!content)return;
  panel.current?.closest('main')?.scrollTo(0,0);
  if(anchor)document.getElementById(anchor)?.scrollIntoView({block:'start'});
 },[content,anchor]);
 const follow=async(href:string)=>{
  setError('');
  try{
   const url=new URL(href,new URL(files[doc],origin));
   if(url.origin===new URL(origin).origin){
    const next=Object.entries(files).find(([,file])=>'/'+file===url.pathname)?.[0] as DocumentId|undefined;
    if(!next)throw Error('この説明へのリンクは開けません。');
    setAnchor(decodeURIComponent(url.hash.slice(1)));setDoc(next);
   }else await window.yvc.invoke('open-help-link',url.href);
  }catch(e){setError(String(e));}
 };
 return <section ref={panel} className="card help-panel" aria-label="使い方の本文">
  {doc!=='readme'&&<button className="help-back" onClick={()=>{setAnchor('');setDoc('readme');}}>← 使い方に戻る</button>}
  {loading&&<p role="status">読み込み中…</p>}
  {error&&<div className="error" role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>再読み込み</button></div>}
  <article className="help-document"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
   a:({href,children})=>href?<a href={href} onClick={event=>{event.preventDefault();void follow(href);}}>{children}</a>:<span>{children}</span>,
   img:({alt})=><span>{alt}</span>,
   h1:({node,children})=><h2 id={headingId(node)} className="help-doc-title">{children}</h2>,
   h2:({node,children})=><h3 id={headingId(node)}>{children}</h3>,
   h3:({node,children})=><h4 id={headingId(node)}>{children}</h4>,
   table:({children})=><div className="help-table"><table>{children}</table></div>
  }}>{content}</Markdown></article>
 </section>;
}
