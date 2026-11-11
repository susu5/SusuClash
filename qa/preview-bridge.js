/* Loaded only by the isolated preview server, never by the production client. */
(()=>{
  'use strict';
  const slot=new URL(document.currentScript.src).searchParams.get('slot')||'cat';
  const storage=window.localStorage,prefix='susu-preview:'+slot+':';
  const scoped={getItem:key=>storage.getItem(prefix+key),setItem:(key,value)=>storage.setItem(prefix+key,String(value)),removeItem:key=>storage.removeItem(prefix+key),clear:()=>Object.keys(storage).filter(k=>k.startsWith(prefix)).forEach(k=>storage.removeItem(k)),key:index=>Object.keys(storage).filter(k=>k.startsWith(prefix))[index]?.slice(prefix.length)};
  Object.defineProperty(scoped,'length',{get:()=>Object.keys(storage).filter(k=>k.startsWith(prefix)).length});
  Object.defineProperty(window,'localStorage',{value:scoped,configurable:true});
  if(!scoped.getItem('clash-theme'))scoped.setItem('clash-theme',slot);
  const listeners=[];
  window.chrome=window.chrome||{};
  window.chrome.webview={
    postMessage(message){if(String(message).startsWith('window:'))parent.postMessage({type:'preview-window',slot,action:String(message).slice(7)},location.origin);},
    addEventListener(type,listener){if(type==='message')listeners.push(listener);}
  };
  addEventListener('message',async event=>{
    if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='preview-command')return;
    const {page,dialog,windowState}=event.data;
    if(windowState)listeners.forEach(listener=>listener({data:'window:state:'+windowState}));
    if(page||dialog){
      const open=[...document.querySelectorAll('dialog[open]')];open.forEach(d=>d.close());
      if(open.length&&!matchMedia('(prefers-reduced-motion: reduce)').matches)await new Promise(r=>setTimeout(r,270));
    }
    if(page){
      if(page.startsWith('doctor:')){openPage('home',true);window.connectionDoctor?.open(page.slice(7));}
      else if(typeof openPage==='function'){
        if(page==='subscriptionDetail'){ui.profile=ui.profiles[1]?.id||ui.profiles[0]?.id;}
        if(page==='connectionApp'||page==='connectionDetail'){await refreshConnections();ui.app=ui.connections?.connections?.[0]?.app||'';ui.connection=ui.connections?.connections?.[0]?.id||'';}
        openPage(page,true);
      }
    }
    if(dialog){
      const routes={
        '.theme-dialog-v2':['settings','.settings-theme-entry'],
        '.line-group-dialog':['lines','.line-group-button'],
        '.secondary-port-dialog':['settings','#editPort'],
        '.app-update-dialog':['settings','.settings-update-entry'],
        '#modeDialog':['home','.player-action:first-child'],
        '#updateDialog':['lines','#update'],
        '#stopCoreDialog':['runtime','#stopCore']
      };
      if(routes[dialog]){const [name,selector]=routes[dialog];openPage(name,true);document.querySelector(selector)?.click();}
      else if(dialog==='.secondary-connections-dialog'||dialog==='#connectionDialog'){
        await refreshConnections();ui.app=ui.connections?.connections?.[0]?.app||'';ui.connection=ui.connections?.connections?.[0]?.id||'';
        if(dialog==='.secondary-connections-dialog'){openPage('connections',true);document.querySelector('#connectionList [data-app]')?.click();}
        else{openPage('connectionDetail',true);document.querySelector('#disconnectOne')?.click();}
      }else if(dialog==='#subDeleteDialog'){ui.profile=ui.profiles.find(p=>!p.active)?.id;openPage('subscriptionDetail',true);document.querySelector('#deleteSubscription')?.click();}
      else if(dialog==='#discardDialog'){openPage('backups',true);ui.backupDraft=[...(ui.automation?.backups||[]),'预览未保存项'];openPage('settings');}
      else if(dialog==='#subDiscardDialog'){openPage('subscriptionForm',true);document.querySelector('#subName').value='预览未保存订阅';openPage('settings');}
      else document.querySelector(dialog)?.showModal();
    }
  });
  addEventListener('DOMContentLoaded',()=>{
    const report=()=>parent.postMessage({type:'preview-ready',slot,theme:document.documentElement.dataset.theme||slot,pages:[...document.querySelectorAll('[data-page]')].map(p=>p.dataset.page),dialogs:[...document.querySelectorAll('dialog')].map((d,i)=>({selector:d.id?'#'+d.id:'.'+[...d.classList].filter(c=>c!=='glass'&&c!=='detail-dialog').join('.'),title:d.querySelector('h2')?.textContent||'弹窗 '+(i+1)}))},location.origin);
    window.addEventListener('clash-theme-change',report);setTimeout(report,600);
  });
})();
