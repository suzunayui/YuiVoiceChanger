async function openModelLibrary(page){
 await page.getByRole('button',{name:'モデル一覧',exact:true}).click();
 const library=page.getByRole('dialog',{name:'モデル一覧',exact:true});await library.waitFor();return library;
}
async function addAndUseModel(page,label){
 const library=await openModelLibrary(page);
 await library.getByRole('button',{name:'＋ モデルを追加',exact:true}).click();
 await library.getByRole('textbox',{name:'モデルの別名',exact:true}).waitFor();
 await library.getByRole('button',{name:'保存',exact:true}).click();
 await library.getByRole('button',{name:`モデルを選択：${label}`,exact:true}).click();
 await library.getByRole('button',{name:'このモデルに切り替える',exact:true}).click();
 await library.waitFor({state:'hidden'});
}
async function editModel(page,label){
 const library=await openModelLibrary(page);
 await library.getByRole('group',{name:label,exact:true}).getByRole('button',{name:'編集',exact:true}).click();
 return library;
}
module.exports={openModelLibrary,addAndUseModel,editModel};
