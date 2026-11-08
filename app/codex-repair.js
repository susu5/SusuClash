'use strict';

// A Codex-specific operation is always previewed and explicitly confirmed.
(() => {
  const settings = document.querySelector('[data-page="settings"]');
  const check = document.querySelector('[data-page="check"]');
  if (!settings || !check) return;
  const entry = document.createElement('button'); entry.type='button'; entry.className='sub-entry codex-entry-v2';
  entry.innerHTML='<span class="row-icon"><svg class="icon" aria-hidden="true"><use href="#scan"/></svg></span><span class="row-copy"><span class="row-label">Codex 专项修复</span><span class="hint">检查代理端口并查看修复方案</span></span><span class="chevron" aria-hidden="true">›</span>';
  const more = settings.querySelector('[data-open="runtime"]');
  if (more) more.before(entry); else settings.append(entry);
  const checkEntry = document.createElement('button'); checkEntry.type='button'; checkEntry.className='secondary codex-check-entry-v2'; checkEntry.textContent='Codex 专项修复';
  const results=check.querySelector('.results'); if(results) results.after(checkEntry); else check.append(checkEntry);

  const dialog=document.createElement('dialog');dialog.className='glass detail-dialog codex-dialog-v2';dialog.setAttribute('aria-labelledby','codexRepairTitle');
  dialog.innerHTML='<div class="codex-head-v2"><h2 id="codexRepairTitle">Codex 专项修复</h2><button type="button" class="codex-close-v2" aria-label="关闭">×</button></div><p class="codex-description-v2">检查 Codex 的本机代理端口，并在需要时预览修复方案。不会自动切换线路。</p><div class="codex-status-v2" role="status" aria-live="polite">尚未检查</div><div class="codex-plan-v2" hidden></div><div class="codex-actions-v2"><button type="button" class="secondary codex-preview-v2">检查修复方案</button><button type="button" class="secondary codex-apply-v2" hidden>备份并修复</button></div><p class="hint codex-foot-v2">站点响应不代表 Codex 应用内请求一定成功。</p>';
  document.body.append(dialog);
  const status=dialog.querySelector('.codex-status-v2'),plan=dialog.querySelector('.codex-plan-v2'),preview=dialog.querySelector('.codex-preview-v2'),apply=dialog.querySelector('.codex-apply-v2');
  let token=null, pending=false, generation=0;
  function reset(){generation++;pending=false;token=null;status.textContent='尚未检查';plan.hidden=true;plan.replaceChildren();apply.hidden=true;preview.hidden=false;preview.disabled=false;apply.disabled=false;}
  function open(){reset();dialog.showModal()}
  entry.addEventListener('click',open);checkEntry.addEventListener('click',open);
  dialog.querySelector('.codex-close-v2').addEventListener('click',()=>dialog.close());
  preview.addEventListener('click',async()=>{
    if(pending)return;const mine=++generation;pending=true;preview.disabled=true;status.textContent='正在检查 Codex 代理设置和本机端口…';token=null;plan.hidden=true;apply.hidden=true;
    try {
      const result=await api('codex-repair/preview',{});
      if(mine!==generation||!dialog.open)return;
      if(!result.eligible){status.textContent=result.reason || '当前没有可自动处理的项目，请在 Codex 中检查连接。';return}
      token=result.token;status.textContent='发现可以处理的本机代理端口不一致。';
      const title=document.createElement('strong');title.textContent='拟执行的操作';
      const detail=document.createElement('p');detail.textContent='将 Codex 固定本机代理端口从 '+result.oldPort+' 调整为 '+result.newPort+'，修改前会备份配置。';
      const caveat=document.createElement('p');caveat.textContent='仅修改代理端口，其他内容保持不变；修复后请完全退出并重新打开 Codex，再验证连接。';
      plan.replaceChildren(title,detail,caveat);plan.hidden=false;apply.hidden=false;
    } catch(error){if(mine===generation&&dialog.open)status.textContent=error.message || '检查未完成，请稍后重试。'}
    finally{if(mine===generation){pending=false;preview.disabled=false;}}
  });
  apply.addEventListener('click',async()=>{
    if(pending||!token)return;const mine=++generation;pending=true;apply.disabled=true;preview.disabled=true;status.textContent='正在备份并修复…';const oneTime=token;token=null;
    try{const result=await api('codex-repair/apply',{token:oneTime});if(mine!==generation||!dialog.open)return;status.textContent=result.message || (result.ok?'操作已完成，请重新打开 Codex 并验证。':'修复未完成，请重新检查。');plan.hidden=true;apply.hidden=true;preview.textContent='重新检查';if(result.ok && typeof result.backupName==='string'){const hint=document.createElement('p');hint.className='hint';hint.textContent='原配置备份在 Codex 配置目录：'+result.backupName+'。需要还原时，请先关闭 Codex。';plan.replaceChildren(hint);plan.hidden=false;}}
    catch(error){if(mine!==generation||!dialog.open)return;status.textContent=error.message || '修复未完成，未确认更改；请重新检查。';apply.hidden=true;preview.textContent='重新检查';}
    finally{if(mine===generation){pending=false;preview.disabled=false;}}
  });
  dialog.addEventListener('close',()=>{generation++;pending=false;token=null;preview.textContent='检查修复方案'});
})();
