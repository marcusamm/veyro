// The emailed link can open another tab. Resume in the original tab, where the
// explicitly requested, temporary draft lives. No draft is sent by this script.
let checking=false;
async function checkLogin(){
  if(checking||document.visibilityState==='hidden')return;
  checking=true;
  try{
    const response=await fetch('/logistik/api/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(response.ok&&(await response.json()).authenticated)location.replace('/logistik/mine/');
  }catch{/* The sent-link page remains useful while offline. */}
  finally{checking=false;}
}
window.addEventListener('focus',checkLogin);
document.addEventListener('visibilitychange',checkLogin);
window.addEventListener('pageshow',checkLogin);
setInterval(checkLogin,10000);
