// ============================================================
// YAPSON-BOT7 — Auto-login + Automatisation des retraits
// ============================================================

const express  = require('express');
const fetch    = require('node-fetch');
const FormData = require('form-data');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const NET_UUIDS = {
  'MOOV CI'  : '24462fd9-c8e2-42f2-a95f-119844bc2ada',
  'MTN CI'   : '77e8e729-a0f1-4e1b-8614-168c77f4b101',
  'ORANGE CI': '938988bf-d571-4eac-befb-40644c20976a',
  'Orangeint': '6fbc14c6-2b0b-431a-afce-2c371b33b2a3',
  'Wave'     : '97847ae3-6c50-4116-a6da-a69695afbaaa',
};

let cfg = {
  mgmtLogin    : process.env.MGMT_LOGIN    || '',
  mgmtPassword : process.env.MGMT_PASSWORD || '',
  mgmtCookies  : process.env.MGMT_COOKIES  || '',  // fallback manuel
  yapsonToken  : process.env.YAPSON_TOKEN  || '',
  network      : process.env.YAPSON_NETWORK|| 'Orangeint',
  pollInterval : parseInt(process.env.POLL_INTERVAL || '900'),
  maxSolde     : parseInt(process.env.MAX_SOLDE || '0'),
};

// Session dynamique (renouvellée automatiquement)
let sessionCookies = '';
let lastLoginTime  = 0;
const SESSION_TTL  = 10 * 60 * 60 * 1000; // 10h en ms

const stats = { confirmed: 0, missing: 0, fixed: 0, polls: 0, rejected: 0 };
const logs  = [];
let pollTimer = null, isRunning = false, botActive = false;

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

// Retourne les cookies actifs (session ou fallback)
function getActiveCookies() {
  return sessionCookies || parseCookies(cfg.mgmtCookies);
}

function mgmtH(extraContentType) {
  return {
    'Accept'           : 'application/json, text/plain, */*',
    'Content-Type'     : extraContentType || 'application/json',
    'X-Requested-With' : 'XMLHttpRequest',
    'X-Time-Zone'      : 'GMT+00',
    'Cookie'           : getActiveCookies(),
    'User-Agent'       : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer'          : 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
  };
}
function yapH() {
  return { 'Content-Type':'application/json', 'Authorization': `Bearer ${cfg.yapsonToken}` };
}

// ── AUTO-LOGIN ─────────────────────────────────────────────────
async function autoLogin() {
  if (!cfg.mgmtLogin || !cfg.mgmtPassword) {
    addLog('warn', 'Pas de login/password — utilisation cookies manuels');
    return false;
  }
  addLog('info', `Connexion automatique: ${cfg.mgmtLogin}...`);
  try {
    // Step 1: GET la page login pour récupérer les cookies initiaux
    const r1 = await fetch('https://my-managment.com/signin/', {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
      redirect: 'manual',
    });
    const initCookies = (r1.headers.raw()['set-cookie'] || [])
      .map(c => c.split(';')[0]).join('; ');

    // Step 2: POST login
    const fd = new FormData();
    fd.append('login', cfg.mgmtLogin);
    fd.append('password', cfg.mgmtPassword);
    fd.append('remember', '1');

    const r2 = await fetch('https://my-managment.com/admin/auth/login', {
      method: 'POST',
      headers: {
        'Cookie'     : initCookies,
        'Referer'    : 'https://my-managment.com/signin/',
        'User-Agent' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        ...fd.getHeaders(),
      },
      body: fd,
      redirect: 'manual',
    });

    // Collecter tous les cookies de la réponse
    const newCookies = (r2.headers.raw()['set-cookie'] || [])
      .map(c => c.split(';')[0]);

    if (newCookies.length === 0 && r2.status !== 302) {
      // Essayer format JSON
      const r3 = await fetch('https://my-managment.com/admin/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type'  : 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie'        : initCookies,
          'Referer'       : 'https://my-managment.com/signin/',
          'User-Agent'    : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ login: cfg.mgmtLogin, password: cfg.mgmtPassword }),
        redirect: 'manual',
      });
      const c3 = (r3.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]);
      if (c3.length > 0) {
        // Fusionner avec cookies initiaux
        const merged = [...initCookies.split('; ').filter(Boolean), ...c3];
        sessionCookies = merged.join('; ');
        lastLoginTime = Date.now();
        addLog('ok', `✔ Session JSON — ${c3.length} cookie(s) nouveaux`);
        return true;
      }
      addLog('err', `Login échoué: status=${r3.status}`);
      return false;
    }

    // Fusionner cookies initiaux + nouveaux
    const allCookies = [
      ...initCookies.split('; ').filter(Boolean),
      ...newCookies,
    ];
    // Dédupliquer par nom
    const cookieMap = {};
    allCookies.forEach(c => {
      const [k,v] = c.split('=');
      if(k && v !== undefined) cookieMap[k.trim()] = v;
    });
    sessionCookies = Object.entries(cookieMap).map(([k,v]) => `${k}=${v}`).join('; ');
    lastLoginTime = Date.now();
    addLog('ok', `✔ Session auto — ${Object.keys(cookieMap).length} cookies — status=${r2.status}`);
    return true;
  } catch(e) {
    addLog('err', `Login erreur: ${e.message}`);
    return false;
  }
}

// Vérifie et renouvelle la session si nécessaire
async function ensureSession() {
  const age = Date.now() - lastLoginTime;
  if (!sessionCookies || age > SESSION_TTL) {
    return await autoLogin();
  }
  return true;
}

// ── RETRAITS ───────────────────────────────────────────────────
async function getWithdrawals() {
  const res = await fetch('https://my-managment.com/admin/report/pendingrequestwithdrawal', {
    method:'POST', headers:mgmtH(), body:JSON.stringify({page:1,limit:500}),
  });
  if (res.status === 401 || res.status === 403) {
    addLog('warn', 'Session expirée — reconnexion...');
    await autoLogin();
    return getWithdrawals();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.is_guest) {
    addLog('warn', 'is_guest=true — reconnexion...');
    await autoLogin();
    return getWithdrawals();
  }
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

  // Pre-call obligatoire
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
    'Cookie'          : getActiveCookies(),
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
      if (json.success===true) return {ok:true};
      // Session expirée dans confirmW
      if (json.is_guest===true) {
        addLog('warn','Session expirée en confirmation — reconnexion...');
        await autoLogin();
        return confirmW(item); // retry
      }
      return {ok:false, err:json.message||JSON.stringify(json).substring(0,60)};
    } catch(e) { return {ok:true}; }
  }
  const errText = await res.text().catch(()=>'');
  // Si 404 avec is_guest — session expirée
  if (errText.includes('"is_guest":true')) {
    addLog('warn','Session expirée (is_guest) — reconnexion...');
    await autoLogin();
    return confirmW(item);
  }
  return {ok:false, err:`HTTP ${res.status} — ${errText.substring(0,60)}`};
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function runCycle() {
  if (isRunning) return;
  isRunning=true; stats.polls++;
  addLog('info',`━━ Poll #${stats.polls} ━━`);
  try {
    await ensureSession();
    if (!cfg.yapsonToken) throw new Error('YAPSON_TOKEN manquant');
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

app.get('/',(req,res)=>{
  const logHtml=logs.slice(0,100).map(e=>{
    const cls=e.type==='ok'?'ok':e.type==='err'?'er':e.type==='warn'?'wa':e.type==='dot'?'dt':'in';
    const ic=e.type==='ok'?'✔':e.type==='err'?'✘':e.type==='warn'?'⚠':e.type==='dot'?'◉':'▸';
    return `<div class="le ${cls}"><span class="lt">${e.ts}</span><span>${ic} ${e.msg}</span></div>`;
  }).join('');
  const netOpts=Object.keys(NET_UUIDS).map(n=>`<option value="${n}" ${n===cfg.network?'selected':''}>${n}</option>`).join('');
  const hasLogin = !!(cfg.mgmtLogin && cfg.mgmtPassword);
  const sessionAge = lastLoginTime ? Math.round((Date.now()-lastLoginTime)/60000)+'min' : 'jamais';
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
.btn-blue{background:rgba(88,166,255,.2);color:var(--b);border:1px solid rgba(88,166,255,.4)}
.btn:hover{filter:brightness(1.15)}.btns{display:flex;gap:8px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:4px 12px;font-size:10px;font-weight:700}
.badge .dot{width:7px;height:7px;border-radius:50%}
.b-on{background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3)}
.b-on .dot{background:var(--g);animation:pulse 1.8s infinite}
.b-off{background:rgba(139,148,158,.1);color:var(--m);border:1px solid rgba(139,148,158,.2)}
.b-off .dot{background:var(--m)}
.b-info{background:rgba(88,166,255,.1);color:var(--b);border:1px solid rgba(88,166,255,.2)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.log{background:#0d1117;border-radius:7px;max-height:400px;overflow-y:auto;padding:8px;font-size:10px;line-height:2;word-break:break-word}
.le{display:flex;gap:10px}.lt{color:var(--m);min-width:135px;flex-shrink:0}
.ok span:last-child{color:var(--g)}.er span:last-child{color:var(--r)}.wa span:last-child{color:var(--o)}.dt span:last-child{color:var(--m)}.in span:last-child{color:var(--b)}
.hint{border-radius:7px;padding:8px 12px;font-size:10px;line-height:1.8;margin-top:8px}
.hint-g{background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.2);color:var(--g)}
.hint-w{background:rgba(240,136,62,.08);border:1px solid rgba(240,136,62,.2);color:var(--o)}
.hint b{color:var(--t)}
.seclbl{font-size:11px;font-weight:700;margin-bottom:10px}
.tag-ok{display:inline-block;background:rgba(63,185,80,.15);color:var(--g);border:1px solid rgba(63,185,80,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
.tag-err{display:inline-block;background:rgba(248,81,73,.15);color:var(--r);border:1px solid rgba(248,81,73,.3);border-radius:4px;padding:1px 7px;font-size:9px;margin-left:6px}
</style></head><body><div class="wrap">
<div class="statbar">
<div class="sc vc"><div class="sv">${stats.confirmed}</div><div class="sl">Confirmés</div></div>
<div class="sc vm"><div class="sv">${stats.missing}</div><div class="sl">Manquants</div></div>
<div class="sc vf"><div class="sv">${stats.fixed}</div><div class="sl">Corrigés</div></div>
<div class="sc vp"><div class="sv">${stats.polls}</div><div class="sl">Polls</div></div>
<div class="sc vs"><div class="sv">0</div><div class="sl">SMS</div></div>
<div class="sc vr"><div class="sv">${stats.rejected}</div><div class="sl">Rejetés</div></div>
</div>

<div class="card"><div class="ch"><span>🔑</span> COMPTES</div><div class="cb">
<form method="POST" action="/save-accounts"><div class="g2">
<div>
<div class="seclbl" style="color:var(--b)">agg.yapson.net</div>
<div class="frow"><label>Token yapson</label>
<input type="password" name="yapsonToken" value="${cfg.yapsonToken?'●'.repeat(20):''}" placeholder="eyJhbGci...">
${cfg.yapsonToken?'<span class="tag-ok">✓ OK</span>':'<span class="tag-err">✗ manquant</span>'}
</div></div>
<div>
<div class="seclbl" style="color:var(--g)">my-managment.com ${hasLogin?'<span class="tag-ok">✓ Auto-login actif</span>':'<span class="tag-err">✗ Manuel</span>'}</div>
<div class="frow"><label>Identifiant (login)</label>
<input type="text" name="mgmtLogin" value="${cfg.mgmtLogin||''}" placeholder="27581639855"></div>
<div class="frow"><label>Mot de passe</label>
<input type="password" name="mgmtPassword" value="${cfg.mgmtPassword?'●'.repeat(12):''}" placeholder="••••••••"></div>
${hasLogin?'<div class="hint hint-g">✔ Session auto — renouvelée il y a <b>'+sessionAge+'</b></div>':'<div class="hint hint-w">Sans login/password, les cookies expirent toutes les ~12h</div>'}
</div>
</div>
<div style="margin-top:14px;display:flex;gap:8px">
<button class="btn btn-save" type="submit">💾 Sauvegarder</button>
</div>
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
<a class="btn btn-blue" href="/login">🔄 Re-login</a>
<a class="btn btn-gray" href="/reset">◌ Reset stats</a>
<a class="btn btn-gray" href="/">⟳ Actualiser</a>
</div></div></div>

<div class="card"><div class="ch"><span>📋</span> JOURNAL — ${logs.length} entrées</div>
<div class="cb" style="padding:8px"><div class="log">${logHtml||'<div class="le in"><span class="lt">—</span><span>▸ En attente</span></div>'}</div>
</div></div></div></body></html>`);
});

app.post('/save-accounts',(req,res)=>{
  const{yapsonToken,mgmtLogin,mgmtPassword}=req.body;
  if(yapsonToken&&!yapsonToken.startsWith('●'))cfg.yapsonToken=yapsonToken.trim();
  if(mgmtLogin)cfg.mgmtLogin=mgmtLogin.trim();
  if(mgmtPassword&&!mgmtPassword.startsWith('●'))cfg.mgmtPassword=mgmtPassword.trim();
  addLog('ok','Comptes mis à jour');
  sessionCookies=''; lastLoginTime=0; // forcer re-login
  if(botActive){stopPolling();setTimeout(startPolling,1000);}
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
app.get('/start', (req,res)=>{startPolling();res.redirect('/');});
app.get('/stop',  (req,res)=>{stopPolling(); res.redirect('/');});
app.get('/run',   async(req,res)=>{runCycle().catch(e=>addLog('err',e.message));res.redirect('/');});
app.get('/login', async(req,res)=>{await autoLogin();res.redirect('/');});
app.get('/reset', (req,res)=>{Object.keys(stats).forEach(k=>stats[k]=0);logs.length=0;addLog('info','Reset');res.redirect('/');});
app.get('/health',(req,res)=>res.json({...stats,botActive,network:cfg.network,interval:cfg.pollInterval,sessionAge:lastLoginTime?Math.round((Date.now()-lastLoginTime)/60000):null}));
app.get('/cookies',(req,res)=>res.redirect('/'));

app.listen(PORT,async()=>{
  addLog('info',`YapsonBot7 démarré — port ${PORT}`);
  addLog('info',`Réseau: ${cfg.network} | Intervalle: ${cfg.pollInterval}s`);
  if(cfg.mgmtLogin&&cfg.mgmtPassword) {
    addLog('info',`Auto-login activé: ${cfg.mgmtLogin}`);
    await autoLogin();
    if(cfg.yapsonToken)startPolling();
  } else if(cfg.mgmtCookies&&cfg.yapsonToken){
    addLog('warn','Mode cookies manuels (pas de login/password configuré)');
    startPolling();
  } else {
    addLog('warn','Configurer login+password dans le dashboard');
  }
});
