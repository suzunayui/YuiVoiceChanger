import {useState} from 'react';
import errorText from './errorText';
export default function DiagnosticLog(){
 const [saving,setSaving]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
 const save=async()=>{
  setSaving(true);setMessage('');setError('');
  try{if(await window.yvc.invoke('export-log'))setMessage('診断ログを保存しました。不具合の報告に添付してください。');}
  catch(e){setError(errorText(e));}
  finally{setSaving(false);}
 };
 return <section className="runtime-setup diagnostic-log" aria-label="診断ログ">
  <div className="section-title"><h3>診断ログ</h3></div>
  <p className="hint">音声の途切れなどを報告するときに使います。処理の遅れや音量の記録で、マイクの音声や声の内容は含みません。保存時にファイルパスのユーザー名を隠します。</p>
  <div className="guide-actions"><button title="診断ログをテキストファイルに保存します。変換中でも保存できます。" disabled={saving} onClick={save}>診断ログを保存</button></div>
  {message&&<p className="hint" role="status">{message}</p>}
  {error&&<p className="hint danger" role="alert">{error}</p>}
 </section>;
}
