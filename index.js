// ============================================================
// YAPSON-BOT7 — Automatisation des retraits
// ============================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS pour autoriser le bookmarklet my-managment a envoyer les cookies
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', 'https://my-managment.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const NET_UUIDS = {
  'MOOV CI'  : '24462fd9-c8e2-42f2-a95f-119844bc2ada',
  'MTN CI'   : '77e8e729-a0f1-4e1b-8614-168c77f4b101',
  'ORANGE CI': '938988bf-d571-4eac-befb-40644c20976a',
  'Orangeint': '6fbc14c6-2b0b-431a-afce-2c371b33b2a3',
  'Wave'     : '97847ae3-6c50-4116-a6da-a69695afbaaa',
};

let cfg = {
  mgmtCookies  : process.env.MGMT_COOKIES   || '',
  yapsonToken  : process.env.YAPSON_TOKEN   || '',
  network      : process.env.YAPSON_NETWORK || 'Orangeint',
  pollInterval : parseInt(process.env.POLL_INTERVAL || '900'),
  maxSolde     : parseInt(process.env.MAX_SOLDE || '0'),
};

const stats = { confirmed: 0, missing: 0, fixed: 0, polls: 0, rejected: 0 };
const logs  = [];
let pollTimer = null, isRunning = false, botActive = false;
let lastCookieUpdate = null;

function addLog(type, msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  logs.unshift({ ts, type, msg });
  if (logs.length > 300) logs.pop();
  console.log(`[${type.toUpperCase()}] ${ts} — ${msg}`);
}

function parseCookies(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(c => c.name+'='+c.value).join('; ');
    } catch(e) {}
  }
  return s;
}

function mgmtH() {
  return {
    'Accept'           : 'application/json, text/plain, */*',
    'Content-Type'     : 'application/json',
    'X-Requested-With' : 'XMLHttpRequest',
    'X-Time-Zone'      : 'GMT+00',
    'Cookie'           : parseCookies(cfg.mgmtCookies),
    'User-Agent'       : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'          : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
  };
}
function yapH() {
  return { 'Content-Type':'application/json', 'Authorization': `Bearer ${cfg.yapsonToken}` };
}

async function getWithdrawals() {
  const res = await fetch('https://my-managment.com/admin/report/pendingrequestwithdrawal', {
    method:'POST', headers:mgmtH(), body:JSON.stringify({page:1,limit:500}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — renouveler les cookies (/update-cookies)`);
  const data = await res.json();
  const rows = data.data || [];
  const out=[]; let cumul=0;
  const solde = cfg.maxSolde>0 ? cfg.maxSolde : 99999999;
  for (const row of rows) {
    const montant = row.summa_sort || parseInt((row.summa||'').replace(/[^0-9]/g,''))||0;
    const phone   = row.dopparam?.[0]?.description||'';
    const pm      = String(phone).match(/0[0-9]{9}/);
    if (!pm||montant<=0||cumul+montant>solde) continue;
    out.push({ phone:pm[0], montant, confirmData:row.confirm?.[0]?.data||null });
    cumul += montant;
  }
  addLog('info',`${rows.length} retraits lus — ${out.length} sélectionnés (${cumul.toLocaleString()} FCFA)`);
  return out;
}

async function payout(item) {
  const uuid = NET_UUIDS[cfg.network]||NET_UUIDS['Orangeint'];
  const res  = await fetch('https://connect.yapson.net/api/aggregator/payout/', {
    method:'POST', headers:yapH(),
    body:JSON.stringify({amount:item.montant, recipient_phone:item.phone, network:uuid}),
  });
  const body = await res.json();
  if (res.status===200||res.status===201) return {ok:true};
  return {ok:false, err:JSON.stringify(body).substring(0,100)};
}

async function confirmW(item) {
  if (!item.confirmData) return {ok:false, err:'Pas de confirmData'};
  const cd = item.confirmData;
  await fetch('https://my-managment.com/admin/banktransfer/getallbanksbysubagentid', {
    method:'POST', headers:mgmtH(),
    body:JSON.stringify({id: cd.subagent_id, ref_id: cd.ref_id||1}),
  }).catch(()=>{});
  await new Promise(r=>setTimeout(r,400));
  const fd = new FormData();
  fd.append('code'        , cd.code||'epay');
  fd.append('id'          , String(cd.id));
  fd.append('comment'     , '');
  fd.append('commentId'   , 'null');
  fd.append('otherComment', '');
  fd.append('is_out'      , 'true');
  fd.append('subagent_id' , String(cd.subagent_id));
  fd.append('ref_id'      , String(cd.ref_id||1));
  fd.append('bank_id'     , cd.bank_id ? String(cd.bank_id) : 'null');
  fd.append('report_id'   , '');
  const h = {
    'Accept'          : 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Time-Zone'     : 'GMT+00',
    'Cookie'          : parseCookies(cfg.mgmtCookies),
    'User-Agent'      : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'         : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
    ...fd.getHeaders(),
  };
  const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney', {
    method:'POST', headers:h, body:fd,
  });
  if (res.status===200||res.status===302) {
    const text = await res.text();
    if (text.startsWith('<')||text.includes('<!DOCTYPE')) return {ok:true};
    try {
      const json = JSON.parse(text);
      return {ok:json.success===true, err:json.message||''};
    } catch(e) { return {ok:true}; }
  }
  const errText = await res.text().catch(()=>'');
  return {ok:false, err:`HTTP ${res.status} — ${errText.substring(0,60)}`};
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function runCycle() {
  if (isRunning) return;
  isRunning=true; stats.polls++;
  addLog('info',`━━ Poll #${stats.polls} ━━`);
  try {
    if (!cfg.mgmtCookies) throw new Error('Cookies manquants — cliquer le bookmarklet sur my-managment');
    if (!cfg.yapsonToken)  throw new Error('Token manquant');
    const items = await getWithdrawals();
    if (!items.length) {
      addLog('info',`Poll F2: 0 confirmé(s), 0 rejeté(s)`);
      isRunning=false; return;
    }
    let ok=0,ko=0; const paid=[];
    for (const item of items) {
      const r = await payout(item);
      if (r.ok){paid.push(item);ok++;addLog('ok',`✔ ${item.phone} → ${item.montant.toLocaleString()} FCFA`);}
      else{ko++;stats.missing++;addLog('err',`✘ ${item.phone} — ${r.err}`);}
      await sleep(800);
    }
    if (paid.length) {
      await sleep(1500);
      for (const item of paid) {
        const r = await confirmW(item);
        if (r.ok){stats.confirmed++;addLog('ok',`✔ Confirmé: ${item.phone}`);}
        else{stats.missing++;addLog('warn',`⚠ Manuel: ${item.phone} — ${r.err}`);}
        await sleep(700);
      }
    }
    addLog('info',`Poll F2: ${ok} confirmé(s), ${ko} rejeté(s)`);
    items.forEach(i=>addLog('dot',`${i.phone} — ${i.montant.toLocaleString()} FCFA`));
  } catch(e){
    addLog('err',`Erreur: ${e.message}`); stats.rejected++;
  } finally {isRunning=false;}
}

function startPolling(){
  if(pollTimer)return; botActive=true;
  addLog('ok',`Bot démarré — ${cfg.pollInterval}s — ${cfg.network}`);
  runCycle(); pollTimer=setInterval(runCycle,cfg.pollInterval*1000);
}
function stopPolling(){
  if(pollTimer){clearInterval(pollTimer);pollTimer=null;}
  botActive=false; addLog('warn','Bot arrêté');
}

// ── Route principale (dashboard) ──────────────────────────────
app.get('/',(req,res)=>{
  const logHtml=logs.slice(0,100).map(e=>{
    const cls=e.type==='ok'?'ok':e.type==='err'?'er':e.type==='warn'?'wa':e.type==='dot'?'dt':'in';
    const ic=e.type==='ok'?'✔':e.type==='err'?'✘':e.type==='warn'?'⚠':e.type==='dot'?'◉':'▸';
    return `<div class="le ${cls}"><span class="lt">${e.ts}</span><span>${ic} ${e.msg}</span></div>`;
  }).join('');
  const netOpts=Object.keys(NET_UUIDS).map(n=>`<option value="${n}" ${n===cfg.network?'selected':''}>${n}</option>`).join('');
  const cookieOk=parseCookies(cfg.mgmtCookies).length>10;
  const cookieAge = lastCookieUpdate ? Math.round((Date.now()-lastCookieUpdate)/60000)+'min' : 'inconnue';
  const BOT_URL = 'https://yapson-bot7-production.up.railway.app';
  const bookmarklet = `javascript:(function(){
    var c=document.cookie;
    var all=[];
    ['auid','lng','PHPSESSID'].forEach(function(n){
      var m=document.cookie.match(new RegExp('(?:^|;\\s*)'+n+'=([^;]*)'));
    });
    fetch('/admin/report/pendingrequestwithdrawal',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest'},body:'{"page":1,"limit":1}',credentials:'include'})
    .then(function(){
      var xhr=new XMLHttpRequest();
      xhr.open('GET','/api/session-info',true);
      xhr.withCredentials=true;
      xhr.onload=function(){
        var cookies=xhr.getResponseHeader('X-Session-Cookies')||'';
        fetch('${BOT_URL}/update-cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:cookies})})
        .then(function(r){return r.json();})
        .then(function(d){alert(d.ok?'✅ Bot mis à jour!':'❌ '+d.err);})
        .catch(function(e){alert('Erreur: '+e.message);});
      };
      xhr.send();
    });
  })()`.replace(/\s+/g,' ');
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YapsonBot7</title><meta http-equiv="refresh" content="15">
<style>:root{--bg:#0d1117;--s1:#161b22;--s2:#21262d;--s3:#30363d;--t:#e6edf3;--m:#8b949e;--g:#3fb950;--b:#58a6ff;--o:#f0883e;--r:#f85149;--p:#bc8cff;}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);font-family:'Courier New',monospace;color:var(--t);font-size:13px;padding:20px}
.wrap{max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.statbar{display:flex;gap:8px;flex-wrap:wrap}
.sc{background:var(--s1);border:1px solid var(--s3);border-radius:10px;padding:12px 20px;min-width:90px;text-align:center;flex:1}
.sv{font-size:28px;font-weight:700;line-height:1}.sl{font-size:9px;color:var(--m);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.sc.vc .sv{color:var(--g)}.sc.vm .sv{color:var(--o)}.sc.vf .sv{color:var(--b)}.sc.vp .sv{color:var(--p)}.sc.vs .sv{color:var(--t)}.sc.vr .sv{color:var(--r)}
.card{background:var(--s1);border:1px solid var(--s3);border-radius:10px;overflow:hidden}
.ch{padding:12px 16px;border-bottom:1px solid var(--s3);font-size:10px;font-weight:700;letter-spacing:2px;color:var(--m);text-transform:uppercase;display:flex;align-items:center;gap:8px}
.cb{padding:16px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
.frow{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
label{font-size:9px;font-weight:700;letter-spacing:1.5px;color:var(--m);text-transform:uppercase}
input,select,textarea{width:100%;background:var(--s2);border:1px solid var(--s3);color:var(--t);border-radius:6px;padding:8px 10px;font-family:inherit;font-size:12px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--b)}
.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.il{font-size:11px;color:var(--m)}
.btn{padding:9px 18px;border-radius:7px;font-family:inherit;font-size:11px;font-weight:700;cursor:pointer;border:none;text-decoration:none;display:inline-block}
.btn-save{background:rgba(88,166,255,.15);color:var(--b);border:1px solid rgba(88,166,255,.4)}
.btn-go{background:rgba(63,185,80,.2);color:var(--g);border:1px solid rgba(63,185,80,.4)}
.btn-stop{background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.35)}
.btn-gray{background:var(--s2);color:var(--m);border:1px solid var(--s3)}
.btn-orange{background:rgba(240,136,62,.2);color:var(--o);border:1px solid rgba(240,136,62,.4)}
.btn:hover{filter:brightness(1.15)}.btns{display:flex;gap:8px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:4px 12px;font-size:10px;font-weight:700}
.badge .dot{width:7px;height:7px;border-radius:50%}
.b-on{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3)}
.b-on .dot{background:var(--g);animation:pulse 1.8s infinite}
.b-off{background:rgba(139,148,158,.1);color:var(--m);border:1px solid rgba(139,148,158,.2)}
.b-off .dot{background:var(--m)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.log{background:#0d1117;border-radius:7px;max-height:400px;overflow-y:auto;padding:8px;font-size:10px;line-height:2;word-break:break-word}
.le{display:flex;gap:10px}.lt{color:var(--m);min-width:135px;flex-shrink:0}
.ok span:last-child{color:var(--g)}.er span:last-child{color:var(--r)}.wa span:last-child{color:var(--o)}.dt span:last-child{color:var(--m)}.in span:last-child{color:var(--b)}
.hint{border-radius:7px;padding:8px 12px;font-size:10px;line-height:1.8;margin-top:8px}
.hint-w{background:rgba(240,136,62,.08);border:1px solid rgba(240,136,62,.2);color:var(--o)}
.hint-g{background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.2);color:var(--g)}
.hint b{color:var(--t)}.seclbl{font-size:11px;font-weight:700;margin-bottom:10px}
.tag-ok{display:inline-block;background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tag-err{display:inline-block;background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.bm-box{background:var(--s2);border:2px dashed var(--o);border-radius:8px;padding:12px 16px;margin-top:12px;cursor:grab;text-align:center;font-size:11px;color:var(--o);font-weight:700;text-decoration:none;display:block}
.bm-box:hover{background:rgba(240,136,62,.1)}
</style></head><body><div class="wrap">

<div class="statbar">
<div class="sc vc"><div class="sv">${stats.confirmed}</div><div class="sl">Confirmés</div></div>
<div class="sc vm"><div class="sv">${stats.missing}</div><div class="sl">Manquants</div></div>
<div class="sc vf"><div class="sv">${stats.fixed}</div><div class="sl">Corrigés</div></div>
<div class="sc vp"><div class="sv">${stats.polls}</div><div class="sl">Polls</div></div>
<div class="sc vs"><div class="sv">0</div><div class="sl">SMS</div></div>
<div class="sc vr"><div class="sv">${stats.rejected}</div><div class="sl">Rejetés</div></div>
</div>

<div class="card"><div class="ch"><span>🔑</span> RENOUVELER LES COOKIES</div><div class="cb">
<div style="color:var(--t);font-size:11px;margin-bottom:12px">
Glisse ce bouton dans ta barre de favoris, puis clique-le <b>depuis my-managment.com</b> pour envoyer tes cookies frais au bot automatiquement.
</div>
<a class="bm-box" href="javascript:(function(){var BOT='https://yapson-bot7-production.up.railway.app';var app=document.querySelector('#app').__vue_app__;var axios=app.config.globalProperties.$http;axios.post('/admin/report/pendingrequestwithdrawal',{page:1,limit:1}).then(function(){var cfg=app.config.globalProperties.$store?app.config.globalProperties.$store.state:{};axios.get('/admin/auth/userinfo').then(function(r){}).catch(function(){});var cookies=document.cookie;fetch(BOT+'/update-cookies',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cookies:null,useSession:true,phpsessid:null})}).then(function(r){return r.json();}).then(function(d){alert(d.ok?'✅ Cookies envoyés au bot!':'❌ '+d.err);}).catch(function(e){alert('Erreur CORS: '+e.message);});});})();">
🔄 YapsonBot — Sync Cookies
</a>
<div class="hint hint-w" style="margin-top:10px">
⚠ La méthode bookmarklet ne peut pas envoyer les cookies HttpOnly (PHPSESSID/auid) à cause de la sécurité navigateur.<br>
<b>Solution rapide :</b> Colle le JSON ci-dessous dans la section COMPTES :
</div>
</div></div>

<div class="card"><div class="ch"><span>🔑</span> COMPTES</div><div class="cb">
<form method="POST" action="/save-accounts"><div class="g2">
<div><div class="seclbl" style="color:var(--b)">agg.yapson.net</div>
<div class="frow"><label>Token yapson</label>
<input type="password" name="yapsonToken" value="${cfg.yapsonToken?'●'.repeat(20):''}" placeholder="eyJhbGci...">
${cfg.yapsonToken?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
</div></div>
<div><div class="seclbl" style="color:var(--g)">my-managment.com</div>
<div class="frow"><label>Cookies — <span style="color:var(--o)">âge: ${cookieAge}</span></label>
<textarea name="mgmtCookies" rows="4" placeholder='JSON Firefox ou PHPSESSID=...; auid=...'>${cfg.mgmtCookies?'(configuré — coller pour remplacer)':''}</textarea>
${cookieOk?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
</div>
<div class="hint hint-w">Coller le JSON Firefox export ou <b>nom=val; nom2=val2</b></div>
</div>
</div><div style="margin-top:14px"><button class="btn btn-save" type="submit">💾 Sauvegarder</button></div>
</form></div></div>

<div class="card"><div class="ch"><span>⚙️</span> CONFIGURATION</div><div class="cb">
<form method="POST" action="/save-config">
<div class="frow"><label>Réseau</label><select name="network">${netOpts}</select></div>
<div class="frow"><div class="inline">
<span class="il">Intervalle :</span><input type="number" name="pollInterval" value="${cfg.pollInterval}" min="60" max="86400" style="width:90px"><span class="il">s</span>
<span class="il" style="margin-left:16px">Solde max :</span><input type="number" name="maxSolde" value="${cfg.maxSolde}" min="0" style="width:120px"><span class="il">FCFA (0 = illimité)</span>
</div></div>
<div style="margin-top:14px"><button class="btn btn-save" type="submit">💾 Appliquer</button></div>
</form></div></div>

<div class="card"><div class="ch"><span>▶</span> CONTRÔLES</div><div class="cb">
<span class="${botActive?'badge b-on':'badge b-off'}"><span class="dot"></span>${botActive?'Actif — toutes les '+cfg.pollInterval+'s':'Arrêté'}</span>
<div class="btns" style="margin-top:14px">
<a class="btn ${botActive?'btn-gray':'btn-go'}" href="/start">▶ Démarrer</a>
<a class="btn ${botActive?'btn-stop':'btn-gray'}" href="/stop">■ Arrêter</a>
<a class="btn btn-gray" href="/run">↻ Lancer cycle</a>
<a class="btn btn-gray" href="/reset">◌ Reset stats</a>
<a class="btn btn-gray" href="/">⟳ Actualiser</a>
</div></div></div>

<div class="card"><div class="ch"><span>📋</span> JOURNAL — ${logs.length} entrées</div>
<div class="cb" style="padding:8px"><div class="log">${logHtml||'<div class="le in"><span class="lt">—</span><span>▸ En attente</span></div>'}</div>
</div></div>
</div></body></html>`);
});

// ── Route update-cookies (appelée par bookmarklet ou manuellement) ──
app.post('/update-cookies', (req, res) => {
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string' || cookies.length < 10) {
    return res.json({ ok: false, err: 'Cookies invalides ou vides' });
  }
  cfg.mgmtCookies = cookies.trim();
  lastCookieUpdate = Date.now();
  addLog('ok', `Cookies mis à jour via API — ${parseCookies(cookies).split(';').length} cookie(s)`);
  if (botActive) { stopPolling(); setTimeout(startPolling, 300); }
  res.json({ ok: true, msg: 'Cookies mis à jour, bot redémarré' });
});

app.post('/save-accounts',(req,res)=>{
  const{yapsonToken,mgmtCookies}=req.body;
  if(yapsonToken&&!yapsonToken.startsWith('●'))cfg.yapsonToken=yapsonToken.trim();
  if(mgmtCookies&&!mgmtCookies.includes('configuré'))cfg.mgmtCookies=mgmtCookies.trim();
  lastCookieUpdate = Date.now();
  addLog('ok',`Comptes mis à jour — ${parseCookies(cfg.mgmtCookies).split(';').length} cookie(s)`);
  if(botActive){stopPolling();setTimeout(startPolling,500);}
  res.redirect('/');
});
app.post('/save-config',(req,res)=>{
  const{network,pollInterval,maxSolde}=req.body;
  if(network&&NET_UUIDS[network])cfg.network=network;
  if(pollInterval)cfg.pollInterval=Math.max(60,parseInt(pollInterval));
  if(maxSolde!==undefined)cfg.maxSolde=parseInt(maxSolde)||0;
  addLog('ok',`Config: ${cfg.network} ${cfg.pollInterval}s`);
  if(botActive){stopPolling();setTimeout(startPolling,500);}
  res.redirect('/');
});
app.get('/start',(req,res)=>{startPolling();res.redirect('/');});
app.get('/stop', (req,res)=>{stopPolling(); res.redirect('/');});
app.get('/run',  async(req,res)=>{runCycle().catch(e=>addLog('err',e.message));res.redirect('/');});
app.get('/reset',(req,res)=>{Object.keys(stats).forEach(k=>stats[k]=0);logs.length=0;addLog('info','Reset');res.redirect('/');});
app.get('/health',(req,res)=>res.json({...stats,botActive,network:cfg.network,interval:cfg.pollInterval,cookieAge:lastCookieUpdate?Math.round((Date.now()-lastCookieUpdate)/60000):null}));
app.get('/cookies',(req,res)=>res.redirect('/'));

app.listen(PORT,()=>{
  addLog('info',`YapsonBot7 démarré — port ${PORT}`);
  addLog('info',`Réseau: ${cfg.network} | Intervalle: ${cfg.pollInterval}s`);
  const p=parseCookies(cfg.mgmtCookies);
  addLog('info',`Cookies: ${p?p.split(';').length+' ok':'MANQUANT'} | Token: ${cfg.yapsonToken?'OK':'MANQUANT'}`);
  lastCookieUpdate = Date.now();
  if(cfg.mgmtCookies&&cfg.yapsonToken)startPolling();
  else addLog('warn','Remplir les comptes dans le dashboard');
});
