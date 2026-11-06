/* Explicit marketing opt-in only; never installed on customer accounts or previews. */
(() => {
'use strict';
if(location.hostname!=='veyro.dk'||!/^\/(?:$|en\/?$|(?:en\/)?(?:pages|products)\/[^/]+\/?$)/.test(location.pathname))return;
const key='theme-cookie-consent',id='DBMMVK3C77UDLIGRBECG';let loaded=false,sent=false,timer;
function allowed(){try{const r=JSON.parse(localStorage.getItem(key)),age=Date.now()-r?.t;return !window.__veyroConsentStorageFailed&&!navigator.globalPrivacyControl&&navigator.doNotTrack!=='1'&&window.doNotTrack!=='1'&&r?.v===2&&age>=0&&age<31536000000&&r.consent?.marketing===true&&r.consent?.tiktok===true;}catch{return false;}}
function sync(){clearTimeout(timer);if(!allowed()){if(loaded){ttq.revokeConsent();ttq.disableCookie();}for(const part of document.cookie.split(';')){const n=part.trim().split('=')[0];if(n==='_ttp'||n.startsWith('ttcsid'))for(const d of ['', '; Domain=veyro.dk','; Domain=.veyro.dk'])document.cookie=n+'=; Max-Age=0; Path=/; Secure'+d;}return;}
if(!loaded){window.TiktokAnalyticsObject='ttq';const q=window.ttq=window.ttq||[];q.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie','holdConsent','revokeConsent','grantConsent'];q.setAndDefer=(o,m)=>{o[m]=(...a)=>o.push([m,...a]);};q.methods.forEach(m=>q.setAndDefer(q,m));q.instance=p=>{const o=q._i[p]||[];q.methods.forEach(m=>q.setAndDefer(o,m));return o;};q._i={[id]:[]};q._i[id]._u='https://analytics.tiktok.com/i18n/pixel/events.js';q._t={[id]:Date.now()};q._o={[id]:{autoConfig:false}};q.holdConsent();const s=document.createElement('script');s.async=true;s.src=q._i[id]._u+'?sdkid='+id+'&lib=ttq';document.head.appendChild(s);loaded=true;}
window.ttq.grantConsent();window.ttq.enableCookie();if(!sent){window.ttq.page();sent=true;}timer=setTimeout(sync,Math.min(2147483647,Math.max(1,JSON.parse(localStorage.getItem(key)).t+31536000000-Date.now())));}
document.addEventListener('theme:consent',sync);window.addEventListener('storage',e=>{if(!e.key||e.key===key)sync();});window.addEventListener('pageshow',sync);document.addEventListener('visibilitychange',()=>{if(!document.hidden)sync();});sync();
})();
