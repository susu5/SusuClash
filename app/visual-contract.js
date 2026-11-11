/* Presentation only: tag existing elements; never replace controls/handlers. */
(()=>{
  'use strict';
  const cards=['.glass.stack','.usage-card-v2','.usage-numbers-v2 > div','.project-poster','.contact-card','.about-versions','.sub-detail','.backup-list','.available-list','.connection-item','.detail-fields','.result-list','.special-entry','.doctor-shell .notice','.doctor-shell .fold','.plan-list','.manual-list','.compact-check-rows','.app-update-versions'].join(',');
  const ignored=new Set(['SCRIPT','STYLE','LINK','META','SVG','PATH','USE','SYMBOL']);
  function apply(root){
    if(!(root instanceof Element))return;
    if(root.matches(cards))root.dataset.scSurface='card';
    root.querySelectorAll(cards).forEach(el=>{el.dataset.scSurface='card';});
    for(const el of [root,...root.querySelectorAll('*')]){
      if(ignored.has(el.tagName)||el.namespaceURI==='http://www.w3.org/2000/svg')continue;
      const size=parseFloat(getComputedStyle(el).fontSize);
      if(size>0&&size<12)el.setAttribute('data-sc-small','');
    }
  }
  apply(document.body);
  let frame=0;const pending=new Set();
  new MutationObserver(records=>{
    for(const record of records)for(const node of record.addedNodes){const el=node instanceof Element?node:node.parentElement;if(el)pending.add(el);}
    if(frame||!pending.size)return;
    frame=requestAnimationFrame(()=>{frame=0;for(const el of pending)if(el.isConnected)apply(el);pending.clear();});
  }).observe(document.body,{childList:true,subtree:true});
})();
