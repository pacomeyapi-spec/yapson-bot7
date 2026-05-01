// ============================================================
// YAPSON-BOT7 — Automatisation des retraits (Withdrawals)
// ============================================================
// Cycle automatique :
//   1. Lire les retraits en attente sur my-managment.com
//   2. Créer les décaissements sur connect.yapson.net
//   3. Confirmer les retraits sur my-managment.com
// ============================================================

const express = require('express');
const fetch   = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Config depuis variables d'environnement Railway ──────────
let MGMT_COOKIES    = process.env.MGMT_COOKIES    || '';
let YAPSON_TOKEN    = process.env.YAPSON_TOKEN     || '';

// ── Mapping réseau → UUID ─────────────────────────────────────
const NET_UUIDS = {
  'MOOV CI'  : '24462fd9-c8e2-42f2-a95f-119844bc2ada',
  'MTN CI'   : '77e8e729-a0f1-4e1b-8614-168c77f4b101',
  'ORANGE CI': '938988bf-d571-4eac-befb-40644c20976a',
  'Orangeint': '6fbc14c6-2b0b-431a-afce-2c371b33b2a3',
  'Wave'     : '97847ae3-6c50-4116-a6da-a69695afbaaa',
};

// YAPSON_NETWORK : "Orangeint" ou "ORANGE CI" (défaut: Orangeint)
const YAPSON_NETWORK_NAME = process.env.YAPSON_NETWORK || 'Orangeint';
const YAPSON_NETWORK = NET_UUIDS[YAPSON_NETWORK_NAME] || NET_UUIDS['Orangeint'];
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL || '900') * 1000;
const MAX_SOLDE       = parseInt(process.env.MAX_SOLDE || '0');

const state = {
  running: false, lastCycle: null, cycles: 0,
  totalOk: 0, totalErr: 0, totalFCFA: 0,
  log: [], status: 'idle', solde: 0,
};

function addLog(type, msg) {
  const ts = new Date().toISOString().replace('T',' ').substring(0,19);
  state.log.unshift({ ts, type, msg });
  if (state.log.length > 200) state.log.pop();
  console.log(`[${type.toUpperCase()}] ${ts} — ${msg}`);
}

function mgmtHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': MGMT_COOKIES,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    'Referer': 'https://my-managment.com/fr/admin/report/pendingrequestwithdrawal',
  };
}

function yapsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${YAPSON_TOKEN}`,
  };
}

async function getSolde() {
  try {
    await fetch('https://connect.yapson.net/api/aggregator/dashboard/', { headers: yapsonHeaders() });
    return MAX_SOLDE > 0 ? MAX_SOLDE : 99999999;
  } catch (e) {
    return MAX_SOLDE > 0 ? MAX_SOLDE : 99999999;
  }
}

async function getWithdrawals(solde) {
  const res = await fetch('https://my-managment.com/admin/report/pendingrequestwithdrawal', {
    method: 'POST',
    headers: mgmtHeaders(),
    body: JSON.stringify({ page: 1, limit: 500 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} — vérifier les cookies`);
  const data = await res.json();
  const rows = data.data || [];
  const selected = [];
  let cumul = 0;
  for (const row of rows) {
    const montant = row.summa_sort || parseInt((row.summa || '').replace(/[^0-9]/g, '')) || 0;
    let phone = row.dopparam && row.dopparam[0] ? row.dopparam[0].description || '' : '';
    const pm = String(phone).match(/0[0-9]{9}/);
    if (!pm || montant <= 0 || cumul + montant > solde) continue;
    selected.push({ phone: pm[0], montant, confirmData: row.confirm && row.confirm[0] ? row.confirm[0].data : null });
    cumul += montant;
  }
  addLog('info', `${rows.length} retraits lus, ${selected.length} sélectionnés (${cumul.toLocaleString()} FCFA)`);
  return selected;
}

async function createPayout(item) {
  const res = await fetch('https://connect.yapson.net/api/aggregator/payout/', {
    method: 'POST',
    headers: yapsonHeaders(),
    body: JSON.stringify({ amount: item.montant, recipient_phone: item.phone, network: YAPSON_NETWORK }),
  });
  const body = await res.json();
  if (res.status === 200 || res.status === 201) return { ok: true };
  return { ok: false, err: JSON.stringify(body).substring(0, 100) };
}

async function confirmWithdrawal(item) {
  if (!item.confirmData) return { ok: false, err: 'Pas de confirmData' };
  const fd = new URLSearchParams();
  fd.append('code', item.confirmData.code || 'epay');
  fd.append('id', String(item.confirmData.id));
  fd.append('comment', '');
  fd.append('commentId', 'null');
  fd.append('otherComment', '');
  fd.append('is_out', 'true');
  fd.append('subagent_id', String(item.confirmData.subagent_id));
  fd.append('ref_id', String(item.confirmData.ref_id || 1));
  fd.append('bank_id', 'null');
  fd.append('report_id', '');
  const res = await fetch('https://my-managment.com/admin/banktransfer/approvemoney', {
    method: 'POST',
    headers: { ...mgmtHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: fd.toString(),
  });
  const body = await res.json();
  if (body.success) return { ok: true };
  const res2 = await fetch('https://my-managment.com/admin/banktransfer/approvemoney', {
    method: 'POST', headers: mgmtHeaders(), body: JSON.stringify(item.confirmData),
  });
  const body2 = await res2.json();
  return { ok: body2.success === true, err: body2.message || JSON.stringify(body2).substring(0,80) };
}

async function runCycle() {
  if (state.running) return;
  state.running = true; state.status = 'running';
  state.cycles++; state.lastCycle = new Date().toISOString();
  addLog('info', `=== Cycle ${state.cycles} démarré ===`);
  try {
    if (!MGMT_COOKIES) throw new Error('MGMT_COOKIES non configuré');
    if (!YAPSON_TOKEN)  throw new Error('YAPSON_TOKEN non configuré');
    const solde = await getSolde();
    state.solde = solde;
    addLog('info', `Solde: ${solde.toLocaleString()} FCFA`);
    const withdrawals = await getWithdrawals(solde);
    if (withdrawals.length === 0) {
      addLog('info', `Aucun retrait — prochain cycle dans ${POLL_INTERVAL/60000}min`);
      return;
    }
    addLog('info', `Envoi de ${withdrawals.length} décaissement(s)...`);
    const paid = [];
    for (const item of withdrawals) {
      const result = await createPayout(item);
      if (result.ok) {
        addLog('ok', `✔ ${item.phone} → ${item.montant.toLocaleString()} FCFA`);
        paid.push(item); state.totalOk++; state.totalFCFA += item.montant;
      } else {
        addLog('err', `✘ ${item.phone} — ${result.err}`);
        state.totalErr++;
      }
      await new Promise(r => setTimeout(r, 800));
    }
    if (paid.length > 0) {
      addLog('info', `Confirmation de ${paid.length} retrait(s)...`);
      await new Promise(r => setTimeout(r, 1500));
      for (const item of paid) {
        const result = await confirmWithdrawal(item);
        if (result.ok) addLog('ok', `✔ Confirmé: ${item.phone}`);
        else addLog('warn', `⚠ Manuel requis: ${item.phone} — ${result.err || ''}`);
        await new Promise(r => setTimeout(r, 700));
      }
    }
    addLog('ok', `=== Cycle ${state.cycles} terminé: ${paid.length} op(s) ===`);
  } catch (e) {
    addLog('err', `Erreur cycle: ${e.message}`); state.status = 'error';
  } finally {
    state.running = false;
    if (state.status === 'running') state.status = 'idle';
  }
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  addLog('info', `Polling démarré — ${POLL_INTERVAL/60000}min`);
  runCycle(); pollTimer = setInterval(runCycle, POLL_INTERVAL);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  addLog('info', 'Polling arrêté');
}

app.use(express.json());

app.get('/', (req, res) => {
  const intervalMin = (POLL_INTERVAL/60000).toFixed(0);
  const logHtml = state.log.slice(0,50).map(e => {
    const cls = e.type==='ok'?'ok':e.type==='err'?'err':e.type==='warn'?'warn':'info';
    return `<div class="le ${cls}"><span class="lt">${e.ts.substring(11,19)}</span><span>${e.msg}</span></div>`;
  }).join('');
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YapsonBot7</title><meta http-equiv="refresh" content="30">
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#080810;font-family:Courier New,monospace;color:#e2e8f0;padding:20px;font-size:13px}
.app{max-width:720px;margin:0 auto}
.hdr{display:flex;align-items:center;gap:12px;padding:16px 0 20px}
.logo{width:42px;height:42px;border-radius:10px;background:#4ade80;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;color:#000}
h1{font-size:20px;font-weight:700}.sub{font-size:11px;color:#64748b;margin-top:2px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.card{background:#10101a;border-radius:10px;border:1px solid rgba(255,255,255,.08);padding:14px 16px}
.card h3{font-size:8px;letter-spacing:2px;color:#64748b;text-transform:uppercase;margin-bottom:10px}
.stat{font-size:26px;font-weight:700}.lbl{font-size:9px;color:#64748b;margin-top:3px}
.badge{display:inline-block;border-radius:5px;padding:3px 10px;font-size:11px;font-weight:700}
.badge-ok{background:rgba(74,222,128,.2);color:#4ade80}
.badge-err{background:rgba(248,113,113,.2);color:#f87171}
.badge-idle{background:rgba(100,116,139,.2);color:#64748b}
.badge-run{background:rgba(96,165,250,.2);color:#60a5fa}
.cfgrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;font-size:11px}
.dot{width:8px;height:8px;border-radius:50%;background:#f87171;flex-shrink:0}
.dot.ok{background:#4ade80}
.log{background:#0e0e12;border-radius:8px;padding:10px;max-height:320px;overflow-y:auto;font-size:9px;line-height:1.9;border:1px solid rgba(255,255,255,.06)}
.le{display:flex;gap:10px}.lt{color:#64748b;min-width:50px;flex-shrink:0}
.ok .le>span:last-child{color:#4ade80}.err .le>span:last-child{color:#f87171}
.warn .le>span:last-child{color:#fb923c}.info .le>span:last-child{color:#60a5fa}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.btn{padding:9px 20px;border-radius:7px;font-family:Courier New,monospace;font-size:11px;font-weight:700;cursor:pointer;border:none;text-decoration:none}
.btn-g{background:rgba(74,222,128,.2);color:#4ade80;border:1px solid rgba(74,222,128,.4)}
.btn-r{background:rgba(248,113,113,.2);color:#f87171;border:1px solid rgba(248,113,113,.4)}
.btn-b{background:rgba(96,165,250,.15);color:#60a5fa;border:1px solid rgba(96,165,250,.3)}
</style></head><body><div class="app">
<div class="hdr"><div class="logo">7</div><div><h1>YapsonBot7</h1>
<div class="sub">Automatisation des retraits • Réseau: ${YAPSON_NETWORK_NAME}</div></div></div>
<div class="grid">
<div class="card"><h3>Statut</h3>
<span class="badge ${state.status==='idle'?'badge-idle':state.status==='running'?'badge-run':'badge-err'}">
${state.status==='idle'?'⏸ En attente':state.status==='running'?'▶ En cours':'✘ Erreur'}</span>
<div class="lbl" style="margin-top:8px">Cycles: ${state.cycles}</div>
<div class="lbl">Dernier: ${state.lastCycle?state.lastCycle.replace('T',' ').substring(0,19):'—'}</div></div>
<div class="card"><h3>Configuration</h3>
<div class="cfgrow"><div class="dot ${MGMT_COOKIES?'ok':''}"></div>Cookies my-managment ${MGMT_COOKIES?'✓':'✗ manquant'}</div>
<div class="cfgrow"><div class="dot ${YAPSON_TOKEN?'ok':''}"></div>Token yapson ${YAPSON_TOKEN?'✓':'✗ manquant'}</div>
<div class="cfgrow" style="color:#64748b">Réseau: ${YAPSON_NETWORK_NAME}</div>
<div class="cfgrow" style="color:#64748b">Intervalle: ${intervalMin}min</div></div>
<div class="card"><h3>Décaissements OK</h3>
<div class="stat" style="color:#4ade80">${state.totalOk}</div>
<div class="lbl">${state.totalFCFA.toLocaleString('fr-FR')} FCFA envoyés</div></div>
<div class="card"><h3>Échecs</h3>
<div class="stat" style="color:#f87171">${state.totalErr}</div>
<div class="lbl">Solde: ${state.solde.toLocaleString('fr-FR')} FCFA</div></div></div>
<div class="actions">
<a class="btn btn-g" href="/run">▶ Lancer cycle</a>
<a class="btn btn-b" href="/">↻ Actualiser</a>
<a class="btn btn-r" href="/stop">⏹ Arrêter</a>
<a class="btn btn-g" href="/start">▶ Démarrer</a></div>
<div class="card" style="margin-bottom:12px">
<h3>Journal</h3><div class="log" style="margin-top:8px">
${logHtml||'<div class="le info"><span class="lt">—</span><span>Aucun log</span></div>'}</div></div>
<div style="font-size:9px;color:#64748b;text-align:center;padding:8px">
YapsonBot7 • Auto-refresh 30s •
<a href="/health" style="color:#64748b">health</a> •
<a href="/cookies" style="color:#fb923c">🔑 Renouveler cookies</a>
</div></div></body></html>`);
});

app.get('/run', async (req, res) => { if(!state.running) runCycle().catch(e=>addLog('err',e.message)); res.redirect('/'); });
app.get('/start', (req, res) => { startPolling(); res.redirect('/'); });
app.get('/stop',  (req, res) => { stopPolling();  res.redirect('/'); });
app.get('/health', (req, res) => res.json({ status:state.status, cycles:state.cycles, totalOk:state.totalOk, totalErr:state.totalErr, totalFCFA:state.totalFCFA, running:state.running, configured:!!(MGMT_COOKIES&&YAPSON_TOKEN) }));

// ── Page /cookies — Renouvellement session 12h ────────────────
app.get('/cookies', (req, res) => {
  const ok  = req.query.ok  || '';
  const msg = req.query.msg || '';
  res.send(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YapsonBot7 — Cookies</title>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#080810;font-family:Courier New,monospace;color:#e2e8f0;padding:24px;font-size:13px;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#10101a;border-radius:12px;border:1px solid rgba(255,255,255,.1);padding:28px 32px;max-width:560px;width:100%}
h1{font-size:17px;font-weight:700;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.logo{width:32px;height:32px;border-radius:8px;background:#4ade80;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:14px;color:#000}
.sub{font-size:11px;color:#64748b;margin-bottom:20px;line-height:1.6}
label{font-size:9px;font-weight:700;letter-spacing:1.5px;color:#64748b;text-transform:uppercase;display:block;margin-bottom:5px}
textarea{width:100%;background:#18182a;border:1px solid rgba(255,255,255,.1);color:#e2e8f0;border-radius:7px;padding:9px 11px;font-family:Courier New,monospace;font-size:10px;outline:none;margin-bottom:14px;resize:vertical;min-height:70px;line-height:1.6}
textarea:focus{border-color:#60a5fa}
.btn{width:100%;padding:11px;background:rgba(74,222,128,.2);border:1px solid rgba(74,222,128,.4);color:#4ade80;border-radius:8px;font-family:Courier New,monospace;font-size:12px;font-weight:700;cursor:pointer}
.alert{border-radius:7px;padding:10px 13px;font-size:11px;margin-bottom:16px}
.alert-ok{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.3);color:#4ade80}
.alert-err{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:#f87171}
.hint{background:#18182a;border-radius:7px;padding:10px 13px;font-size:10px;color:#64748b;margin-bottom:16px;line-height:1.8}
.hint b{color:#60a5fa}a{color:#60a5fa;text-decoration:none}
</style></head><body><div class="card">
<h1><div class="logo">7</div>Renouveler les cookies</h1>
<p class="sub">Session my-managment.com expire toutes les 12h — colle les nouveaux cookies ici.</p>
${ok?'<div class="alert alert-ok">✔ Cookies mis à jour — bot redémarré</div>':''}
${msg&&!ok?'<div class="alert alert-err">✘ '+msg+'</div>':''}
<div class="hint">
<b>Cookies my-managment :</b><br>
F12 → Application → Cookies → copier format nom=valeur; nom2=valeur2<br><br>
<b>Token yapson (agg.yapson.net) :</b><br>
F12 → Console → <b>copy(localStorage.getItem('accessToken'))</b>
</div>
<form method="POST" action="/cookies">
<label>Cookies my-managment.com</label>
<textarea name="cookies" placeholder="sessionid=abc; csrftoken=xyz..." required></textarea>
<label>Token yapson</label>
<textarea name="token" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." rows="3" required></textarea>
<button class="btn" type="submit">✔ Mettre à jour et redémarrer</button>
</form>
<div style="text-align:center;margin-top:14px;font-size:10px"><a href="/">← Dashboard</a></div>
</div></body></html>`);
});

app.post('/cookies', express.urlencoded({ extended: true }), (req, res) => {
  const { cookies, token } = req.body || {};
  if (!cookies || cookies.trim().length < 10) return res.redirect('/cookies?msg=Cookies+invalides');
  if (!token  || token.trim().length  < 20) return res.redirect('/cookies?msg=Token+invalide');
  MGMT_COOKIES = cookies.trim();
  YAPSON_TOKEN  = token.trim();
  addLog('ok', `Cookies mis à jour (${MGMT_COOKIES.length} chars) — redémarrage`);
  stopPolling();
  setTimeout(() => startPolling(), 500);
  res.redirect('/cookies?ok=1');
});

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, () => {
  addLog('info', `YapsonBot7 démarré — port ${PORT}`);
  addLog('info', `Réseau: ${YAPSON_NETWORK_NAME}`);
  addLog('info', `Intervalle: ${POLL_INTERVAL/60000}min`);
  addLog('info', `Cookies: ${MGMT_COOKIES ? 'OK' : 'MANQUANT → aller sur /cookies'}`);
  addLog('info', `Token:   ${YAPSON_TOKEN  ? 'OK' : 'MANQUANT → aller sur /cookies'}`);
  if (MGMT_COOKIES && YAPSON_TOKEN) startPolling();
  else addLog('warn', 'Aller sur /cookies pour configurer');
});
