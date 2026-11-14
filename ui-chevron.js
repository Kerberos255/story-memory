/** Shared disclosure icon used by every collapsible section. */
export function chevronIcon(extraClass=''){
  const ns='http://www.w3.org/2000/svg';
  const icon=document.createElementNS(ns,'svg');
  icon.setAttribute('class','sm-disclosure-chevron'+(extraClass?' '+extraClass:''));
  icon.setAttribute('viewBox','0 0 24 24');
  icon.setAttribute('aria-hidden','true');
  icon.setAttribute('fill','none');
  icon.setAttribute('stroke','currentColor');
  icon.setAttribute('stroke-width','1.75');
  icon.setAttribute('stroke-linecap','round');
  icon.setAttribute('stroke-linejoin','round');
  const path=document.createElementNS(ns,'path');
  path.setAttribute('d','m6 9 6 6 6-6');
  icon.append(path);
  return icon;
}
