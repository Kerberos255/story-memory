// Own the entry element, never the Quick Replies plugin's #qr--bar.
// SillyTavern may create or replace its Quick Reply strip after extensions boot.
export function ensureStoryMemoryEntry(doc,onOpen){
  const form=doc.getElementById('send_form');
  if(!form)return null;
  // Ignore an old bar made by Story Memory itself; its id impersonated Quick Replies.
  const quickBar=[...form.querySelectorAll('[id="qr--bar"]')]
    .find(bar=>!bar.classList.contains('story-memory-made-bar'));
  const quickHolder=quickBar?.querySelector('.qr--buttons')||quickBar;
  let ownBar=form.querySelector('#story-memory-entry-bar');
  if(!quickHolder&&!ownBar){
    ownBar=doc.createElement('div');
    ownBar.id='story-memory-entry-bar';
    ownBar.className='flex-container flexGap5';
    form.prepend(ownBar);
  }
  const holder=quickHolder||ownBar;
  // A replaced/reattached toolbar can briefly contain two copies. Keep just one.
  const existing=[...form.querySelectorAll('[id="story-memory-open"]')];
  let button=existing.shift();
  if(!button){
    button=doc.createElement('div');
    button.id='story-memory-open';
    button.className='qr--button menu_button interactable';
    button.tabIndex=0;
    button.setAttribute('role','button');
    button.title='打开剧情记忆';
    button.textContent='✦ 剧情记忆';
    button.addEventListener('click',onOpen);
    button.addEventListener('keydown',e=>{
      if(e.key==='Enter'||e.key===' '){e.preventDefault();onOpen();}
    });
  }
  if(button.parentElement!==holder)holder.append(button);
  for(const duplicate of existing)duplicate.remove();
  if(ownBar&&ownBar!==holder)ownBar.remove();
  for(const legacy of form.querySelectorAll('.story-memory-made-bar')){
    const empty=legacy.children.length===0||[...legacy.children].every(child=>
      child.classList.contains('qr--buttons')&&child.children.length===0);
    if(empty)legacy.remove();
  }
  // The fallback is used only when Quick Replies has not mounted its toolbar.
  if(!doc.getElementById('story-memory-entry-style')){
    const style=doc.createElement('style');
    style.id='story-memory-entry-style';
    style.textContent='#story-memory-entry-bar{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:5px;width:100%;padding:2px 0}'+
      '#story-memory-open{border:1px solid var(--SmartThemeBorderColor);border-radius:10px;padding:3px 8px;margin:3px 0;cursor:pointer;color:var(--SmartThemeBodyColor)}'+
      '#story-memory-open:hover{background:rgba(128,128,128,.15)}'+
      '#story-memory-open:focus-visible{outline:2px solid var(--SmartThemeQuoteColor);outline-offset:2px}';
    doc.head.append(style);
  }
  return button;
}
