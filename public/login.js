document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({user:u.value,pass:p.value})});
if(r.ok)location.href='/';else document.getElementById('e').textContent=(await r.json()).error;};
