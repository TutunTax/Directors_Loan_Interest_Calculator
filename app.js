/* Director & related-party loan interest — multi-client front end (Supabase + GitHub Pages) */
(() => {
'use strict';
const E = Engine;
const CFG = window.APP_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, blank) => { if (blank && Math.abs(n) < 0.005) return ''; const neg = n < 0; const [i, d] = Math.abs(n).toFixed(2).split('.'); return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + d; };

// ======================= data access (all Supabase calls live here) =======================
const configured = CFG.SUPABASE_URL && !/YOUR-PROJECT/.test(CFG.SUPABASE_URL) && CFG.SUPABASE_ANON_KEY && !/YOUR-ANON/.test(CFG.SUPABASE_ANON_KEY);
const sb = (configured && window.supabase) ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const ok = async q => { const { data, error } = await q; if (error) throw new Error(error.message || String(error)); return data; };
const api = {
  session: async () => (await sb.auth.getSession()).data.session,
  onAuth: cb => sb.auth.onAuthStateChange((_e, s) => cb(s)),
  signIn: async (email, password) => { const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw new Error(error.message); },
  signOut: () => sb.auth.signOut(),
  isPlatformAdmin: async () => (await ok(sb.from('platform_admins').select('user_id'))).length > 0,
  myRoles: async uid => { const rows = await ok(sb.from('client_members').select('client_id,role').eq('user_id', uid)); const m = {}; rows.forEach(r => m[r.client_id] = r.role); return m; },
  clients: () => ok(sb.from('clients').select('*').order('name')),
  prime: () => ok(sb.from('prime_rates').select('effective_from,rate').order('effective_from')),
  accounts: id => ok(sb.from('loan_accounts').select('*, loan_rate_rules(effective_from,basis,value)').eq('client_id', id).order('label')),
  runs: id => ok(sb.from('interest_runs').select('reference,journal_date,total,created_at').eq('client_id', id).order('created_at', { ascending: false }).limit(10)),
  logRun: row => ok(sb.from('interest_runs').insert(row)),
  saveSettings: (id, payload) => ok(sb.rpc('save_client_settings', { p_client: id, p: payload })),
  savePrime: rows => ok(sb.rpc('save_prime', { p: rows })),
  createClient: (name, short) => ok(sb.rpc('create_client', { p_name: name, p_short: short || null })),
  listMembers: id => ok(sb.rpc('list_members', { p_client: id })),
  addMember: (id, email, role) => ok(sb.rpc('add_member', { p_client: id, p_email: email, p_role: role })),
  removeMember: (id, uid) => ok(sb.rpc('remove_member', { p_client: id, p_user: uid }))
};
if (window.__API_OVERRIDE) Object.assign(api, window.__API_OVERRIDE);   // used by automated tests only

// ======================= state =======================
const clone = o => JSON.parse(JSON.stringify(o));
let session = null, isPlatformAdmin = false, roles = {}, clients = [], clientId = null, client = null;
let settings = blankSettings(), members = [], runs = [];
let loaded = [], jdates = {}, jrefs = {}, stmtPeriod = {}, notes = [], loginMsg = '', busy = '', newClientOpen = false;
let tab = 'run', saveState = '', primeDirty = false;
function blankSettings() { return { prime: [], accounts: {}, expenseAccount: '', refPrefix: 'INTJNL', fyeMonth: 2 }; }
const today = new Date(); const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const monthEnds = (() => { const out = []; let [y, m] = [today.getFullYear(), today.getMonth() + 1]; for (let i = 0; i < 16; i++) { const e = E.eom(`${y}-${String(m).padStart(2, '0')}-01`); if (e <= todayIso) out.push(e); m--; if (m === 0) { m = 12; y--; } } return out; })();
let asAt = monthEnds[0];
const myRole = () => isPlatformAdmin ? 'admin' : (roles[clientId] || 'viewer');
const canEdit = () => myRole() === 'admin' || myRole() === 'staff';
const isClientAdmin = () => myRole() === 'admin';

// ======================= boot / auth =======================
async function boot() {
  if (!sb && !window.__API_OVERRIDE) { render(); return; }
  if (sb) api.onAuth(async s => { const had = !!session; session = s; if (s && !had) await afterLogin(); if (!s) { resetAll(); render(); } });
  session = await api.session(); if (session) await afterLogin(); else render();
}
function resetAll() { clients = []; clientId = null; client = null; settings = blankSettings(); loaded = []; members = []; runs = []; isPlatformAdmin = false; roles = {}; }
async function afterLogin() {
  try {
    busy = 'Loading…'; render();
    isPlatformAdmin = await api.isPlatformAdmin(); roles = await api.myRoles(session.user.id); clients = await api.clients();
    let pick = null; try { pick = localStorage.getItem('dli.client'); } catch (e) { }
    await selectClient((clients.find(c => c.id === pick) || clients[0] || {}).id);
  } catch (e) { notes = ['Could not load: ' + e.message]; }
  busy = ''; render();
}
async function selectClient(id) {
  clientId = id || null; client = clients.find(c => c.id === id) || null; loaded = []; jdates = {}; jrefs = {}; stmtPeriod = {}; notes = []; members = []; runs = []; saveState = '';
  if (!client) { settings = blankSettings(); return; }
  try { localStorage.setItem('dli.client', id); } catch (e) { }
  const [prime, accts, rn] = await Promise.all([api.prime(), api.accounts(id), api.runs(id)]);
  settings = { prime: prime.map(p => ({ from: p.effective_from, rate: +p.rate })), accounts: {}, expenseAccount: client.expense_account || '', refPrefix: client.ref_prefix || 'INTJNL', fyeMonth: client.fye_month || 2 };
  accts.forEach(a => { settings.accounts[a.sage_key] = { sageName: a.sage_account_name, label: a.label, descPrefix: a.desc_prefix, loanAccount: a.sage_ledger_account, rates: (a.loan_rate_rules || []).map(r => ({ from: r.effective_from, basis: r.basis, value: +r.value })).sort((x, y) => x.from < y.from ? -1 : 1) }; });
  runs = rn; primeDirty = false;
  if (isClientAdmin()) { try { members = await api.listMembers(id); } catch (e) { members = []; } }
}

// ======================= saving (debounced, serial) =======================
let saveTimer = null, saving = false, dirty = false;
function queueSave() { if (!canEdit()) return; dirty = true; saveState = 'Saving…'; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 700); paintSave(); }
async function flush() {
  if (saving || !dirty) return; saving = true; dirty = false;
  const id = clientId;
  try {
    await api.saveSettings(id, { client: { expense_account: settings.expenseAccount, ref_prefix: settings.refPrefix, fye_month: settings.fyeMonth },
      accounts: Object.keys(settings.accounts).map(k => { const c = settings.accounts[k]; return { sage_key: k, sage_account_name: c.sageName || k, label: c.label || '', desc_prefix: c.descPrefix || '', sage_ledger_account: c.loanAccount || '', rates: (c.rates || []).filter(r => r.from).map(r => ({ from: r.from, basis: r.basis, value: r.value })) }; }) });
    if (primeDirty && isPlatformAdmin) { await api.savePrime(settings.prime.filter(p => p.from).map(p => ({ from: p.from, rate: p.rate }))); primeDirty = false; }
    saveState = 'Saved';
  } catch (e) { saveState = 'Could not save: ' + e.message; }
  saving = false; if (dirty) flush(); paintSave();
}
function paintSave() { const el = $('#savestate'); if (el) el.textContent = saveState; }

// ======================= ledger loading =======================
async function loadFiles(files) {
  notes = [];
  for (const f of files) {
    let text; try { text = await f.text(); } catch (e) { notes.push(`Could not read ${f.name}`); continue; }
    let accts = [];
    try { accts = /^\s*</.test(text) || /<table/i.test(text) ? E.parseSageHtml(text) : E.parseCsv(text, f.name.replace(/\.[^.]+$/, '')); } catch (e) { }
    accts = accts.filter(a => a.rows.length);
    if (!accts.length) { notes.push(`${f.name}: no ledger transactions found — expected the Sage "Account Transactions Report" export.`); continue; }
    accts.forEach(a => {
      E.prepareAccount(a);
      const key = E.keyOf(a.name);
      if (!settings.accounts[key]) { settings.accounts[key] = { sageName: a.name, label: a.name, descPrefix: 'Interest Loan - ' + a.name, loanAccount: '', rates: [] }; queueSave(); }
      const id = (a.company || '') + '|' + key;
      loaded = loaded.filter(l => l.id !== id);
      loaded.push({ id, file: f.name, acct: a, cfgKey: key, accrued: null, adj: {} });
    });
    const co = accts[0].company; if (co && client && co.toLowerCase().replace(/[^a-z0-9]/g, '') !== client.name.toLowerCase().replace(/[^a-z0-9]/g, '')) notes.push(`Note: ${f.name} is for "${co}" but the selected client is "${client.name}".`);
  }
  loaded.sort((a, b) => a.acct.name.localeCompare(b.acct.name));
  render();
}

// ======================= computation =======================
function compute() {
  const plans = loaded.map(l => {
    const cfg = settings.accounts[l.cfgKey];
    const plan = E.planRun(l.acct, cfg, settings.prime, asAt, { accruedThrough: l.accrued, journalDates: jdates });
    const thru = plan.accruedThrough && plan.accruedThrough < asAt ? plan.accruedThrough : (plan.accruedThrough ? asAt : null);
    const check = plan.blocked ? [] : E.checkPosted(l.acct, cfg, settings.prime, thru, 6);
    const lastTx = l.acct.rows.length ? l.acct.rows[l.acct.rows.length - 1].date : null;
    return { l, cfg, plan, check, lastTx };
  });
  const months = {};
  plans.forEach(p => p.plan.months.forEach(m => { if (Math.abs(m.amount) < 0.005 && !m.segs.length) return; (months[m.month] = months[m.month] || { month: m.month, items: [] }).items.push({ p, m }); }));
  const adjMonth = E.ym(asAt);
  plans.forEach(p => p.check.forEach(c => { if (p.l.adj[c.month] && Math.abs(c.diff) >= 0.005) { (months[adjMonth] = months[adjMonth] || { month: adjMonth, items: [] }); months[adjMonth].adjs = months[adjMonth].adjs || []; months[adjMonth].adjs.push({ p, c }); } }));
  const journals = Object.keys(months).sort().map(k => {
    const j = months[k]; const [y, mo] = k.split('-');
    j.date = jdates[k] || E.eom(k + '-01'); j.ref = jrefs[k] || E.journalRef(settings.refPrefix, k);
    j.desc = `Interest on loans ${E.MONLONG[+mo - 1].slice(0, 3)} ${y}`;
    j.lines = [];
    j.items.forEach(({ p, m }) => j.lines.push({ p, amount: m.amount, desc: m.desc, loanAcct: p.cfg.loanAccount, label: p.cfg.label || p.l.acct.name }));
    (j.adjs || []).forEach(({ p, c }) => { const [cy, cm] = c.month.split('-'); j.lines.push({ p, amount: c.diff, desc: `Interest adjustment ${E.MONLONG[+cm - 1].slice(0, 3)} ${cy} (posted ${fmt(c.posted)}, calculated ${fmt(c.calc)}) - ${p.cfg.label || p.l.acct.name}`, loanAcct: p.cfg.loanAccount, label: p.cfg.label || p.l.acct.name, adj: true }); });
    j.total = E.round2(j.lines.reduce((s, x) => s + x.amount, 0));
    return j;
  });
  return { plans, journals };
}
const fyStart = iso => { const [y, m] = iso.split('-').map(Number); const start = settings.fyeMonth % 12 + 1; const sy = start === 1 ? y : (m >= start ? y : y - 1); return `${sy}-${String(start).padStart(2, '0')}-01`; };
function generatedFor(p, journals) { const g = []; journals.forEach(j => j.lines.forEach(x => { if (x.p === p) g.push({ date: j.date, ref: j.ref, desc: x.desc, amount: x.amount }); })); return g; }

// ======================= rendering =======================
const TABS = [['run', '1  Ledgers & interest'], ['journal', '2  Journal'], ['stmt', '3  Statements'], ['set', 'Rates & settings']];
function render() {
  const sc = window.scrollY; try { const ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur(); } catch (e) { }
  paintHeader();
  if (!configured && !window.__API_OVERRIDE) { $('#nav').innerHTML = ''; $('#app').innerHTML = vSetup(); return; }
  if (!session) { $('#nav').innerHTML = ''; $('#app').innerHTML = vLogin(); return; }
  if (busy) { $('#nav').innerHTML = ''; $('#app').innerHTML = `<div class="note info">${esc(busy)}</div>`; return; }
  if (newClientOpen) { $('#nav').innerHTML = ''; $('#app').innerHTML = vNewClient(); return; }
  if (!client) { $('#nav').innerHTML = ''; $('#app').innerHTML = `<div class="card"><h2>No clients yet</h2><div class="muted">${isPlatformAdmin ? 'Use “+ New client” at the top to add your first client.' : 'You have not been given access to any client. Ask the practice to add you.'}</div></div>`; return; }
  $('#nav').innerHTML = TABS.map(([k, t]) => `<button data-a="tab" data-k="${k}" class="${tab === k ? 'on' : ''}">${esc(t)}</button>`).join('');
  const ctx = compute();
  $('#app').innerHTML = tab === 'run' ? vRun(ctx) : tab === 'journal' ? vJournal(ctx) : tab === 'stmt' ? vStmt(ctx) : vSet();
  window.scrollTo(0, sc);
}
function paintHeader() {
  let h = `<h1>Director &amp; related-party loan interest</h1>`;
  if (session && clients.length) h += `<select data-a="client" title="Client">${clients.map(c => `<option value="${c.id}"${c.id === clientId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  if (session && isPlatformAdmin) h += `<button data-a="newclient-open">+ New client</button>`;
  h += `<span class="sp"></span>`;
  if (session) h += `<span>${esc(session.user.email || '')}</span><button data-a="signout">Sign out</button>`;
  $('#hdr').innerHTML = h;
}
function vSetup() { return `<div class="card"><h2>Connect to Supabase</h2><div class="muted">Open <span class="mono">js/config.js</span> and paste your Supabase project URL and anon key (Project Settings → API), then reload.</div></div>`; }
function vLogin() { return `<div class="card login"><h2>Sign in</h2><form id="loginform"><label class="muted">Email</label><input type="email" id="lemail" autocomplete="username" required><label class="muted">Password</label><input type="password" id="lpass" autocomplete="current-password" required><button class="btn" type="submit">Sign in</button></form>${loginMsg ? `<div class="note bad">${esc(loginMsg)}</div>` : ''}</div>`; }
function vNewClient() { return `<div class="card login"><h2>New client</h2><label class="muted">Client name (as on the Sage export)</label><input id="ncname"><label class="muted">Short name</label><input id="ncshort"><div class="row"><button class="btn" data-a="newclient-save">Create client</button><button class="btn sec" data-a="newclient-cancel">Cancel</button></div>${notes.map(n => `<div class="note bad">${esc(n)}</div>`).join('')}</div>`; }

function rateEditor(cfgKey) {
  const c = settings.accounts[cfgKey]; const d = canEdit() ? '' : ' disabled';
  return `<table class="sm"><tr><th>From</th><th>Rate basis</th><th>Value</th><th></th></tr>${(c.rates || []).map((r, i) => `<tr>
    <td><input type="date" value="${esc(r.from)}" data-a="rate" data-k="${esc(cfgKey)}" data-i="${i}" data-f="from"${d}></td>
    <td><select data-a="rate" data-k="${esc(cfgKey)}" data-i="${i}" data-f="basis"${d}><option value="prime"${r.basis === 'prime' ? ' selected' : ''}>Prime +</option><option value="fixed"${r.basis === 'fixed' ? ' selected' : ''}>Fixed rate</option></select></td>
    <td><input type="number" step="0.01" value="${esc(r.value)}" data-a="rate" data-k="${esc(cfgKey)}" data-i="${i}" data-f="value"${d}> %</td>
    <td>${canEdit() ? `<button class="x" title="Remove" data-a="rate-del" data-k="${esc(cfgKey)}" data-i="${i}">&times;</button>` : ''}</td></tr>`).join('')}</table>
    ${canEdit() ? `<button class="lnk" data-a="rate-add" data-k="${esc(cfgKey)}">+ add rate line</button>` : ''}`;
}
const rateAt = (cfg, day) => E.rateOn(day, cfg, settings.prime);

function vRun(ctx) {
  let h = `<div class="card"><div class="row"><div class="grow"><h2>${esc(client.name)} — load the latest Sage ledger</h2><div class="muted">Sage → Reports → Account Transactions Report for each director / related-party loan account (the .xls export). Select several files at once.</div></div>
  <div><span class="muted">Interest up to </span><select data-a="asat">${monthEnds.map(d => `<option value="${d}"${d === asAt ? ' selected' : ''}>${E.dmy(d)}</option>`).join('')}</select></div></div>
  <div class="drop" id="drop" data-a="pick" style="margin-top:12px"><b>Choose ledger files</b> or drop them here<input id="fin" type="file" multiple accept=".xls,.xlsx,.html,.htm,.csv" class="hidden"></div>
  ${notes.map(n => `<div class="note bad">${esc(n)}</div>`).join('')}</div>`;
  if (!loaded.length) return h + `<div class="note info">No ledgers loaded yet. Ledgers are read in your browser and are not stored.</div>`;
  ctx.plans.forEach(p => { h += vAccountCard(p); });
  return h;
}
function vAccountCard(p) {
  const { l, cfg, plan, check, lastTx } = p; const a = l.acct; const det = plan.detected;
  const lastInt = det ? det.row : null; const bal = E.buildStatement(a, [], '0000-01-01', asAt).closing;
  let h = `<div class="card"><div class="row"><div class="grow"><h3>${esc(cfg.label || a.name)} <span class="muted">· ${esc(a.name)}${a.company ? ' · ' + esc(a.company) : ''}</span></h3></div>
  <span class="pill ${plan.months.length || plan.blocked ? 'todo' : 'ok'}">${plan.blocked ? 'Rate needed' : plan.months.length ? plan.months.length + ' month' + (plan.months.length > 1 ? 's' : '') + ' to post' : 'Up to date'}</span></div>`;
  h += `<div class="kv"><div><span>Last ledger entry</span><b>${lastTx ? E.dmy(lastTx) : '-'}</b></div>
  <div><span>Last interest posted</span><b>${lastInt ? `${E.dmy(lastInt.date)} · ${fmt(lastInt.net)}` : 'none found'}</b></div>
  <div><span>Interest accrued up to</span><b><input type="date" value="${esc(plan.accruedThrough || '')}" data-a="accrued" data-id="${esc(l.id)}"> ${l.accrued ? `<button class="lnk" data-a="accrued-reset" data-id="${esc(l.id)}">reset</button>` : ''}</b></div>
  <div><span>Ledger balance at ${E.dmy(asAt)}</span><b>${fmt(bal)}</b></div>
  <div><span>Rate at ${E.dmy(asAt)}</span><b>${rateAt(cfg, asAt) != null ? E.pct(rateAt(cfg, asAt)) : '-'}</b></div></div>`;
  if (plan.blocked) h += canEdit() ? `<div class="note warn"><b>No interest rate set for this loan.</b> How is its rate worked out?<div class="row" style="margin-top:6px"><select class="nr-basis"><option value="prime">Prime +</option><option value="fixed">Fixed rate</option></select><input type="number" step="0.01" class="nr-val" placeholder="e.g. 2"> % <span>from</span><input type="date" class="nr-from" value="${esc(a.rows[0] ? a.rows[0].date : todayIso)}"><button class="btn" data-a="rate-new" data-k="${esc(l.cfgKey)}">Save rate</button></div></div>` : `<div class="note warn">No interest rate has been set for this loan. Ask the practice to set it.</div>`;
  if (a.balanceMismatches) h += `<div class="note warn">The Balance column in this export doesn't tie to its own debits and credits (${a.balanceMismatches} row${a.balanceMismatches > 1 ? 's' : ''}, first on ${E.dmy(a.firstMismatch.date)}). Check the export covers the full date range.</div>`;
  const wset = {}; plan.months.forEach(m => m.warns.forEach(w => { wset[w.t] = wset[w.t] || w; }));
  if (wset.norate) h += `<div class="note warn">No rate is on file for ${E.dmy(wset.norate.day)} — check the prime table and this loan's rate lines in Rates &amp; settings.</div>`;
  if (wset.debit) h += `<div class="note warn">The balance goes into debit (the director owes the company) from ${E.dmy(wset.debit.day)}. No interest is calculated on debit balances here — deal with those days separately.</div>`;
  if (plan.months.length) {
    h += `<table style="margin-top:6px"><tr><th>Month</th><th>Period</th><th class="n">Days</th><th>Rate</th><th class="n">Interest</th></tr>`;
    plan.months.forEach(m => {
      h += `<tr><td>${E.MONLONG[+m.month.slice(5) - 1]} ${m.month.slice(0, 4)}</td><td>${E.dm(m.from)} – ${E.dmy(m.to)}</td><td class="n">${m.days}</td><td>${esc(E.rateText(m.segs).replace('@ ', ''))}</td><td class="n"><b>${fmt(m.amount)}</b></td></tr>
      <tr><td colspan="5" style="padding-top:0;border:0"><details><summary>Working</summary><table class="sm"><tr><th>From</th><th>To</th><th class="n">Days</th><th class="n">Balance</th><th class="n">Rate</th><th class="n">Interest</th></tr>
      ${m.segs.map(s => `<tr><td>${E.dmy(s.from)}</td><td>${E.dmy(s.to)}</td><td class="n">${s.days}</td><td class="n">${fmt(s.bal)}</td><td class="n">${E.pct(s.rate)}</td><td class="n">${s.interest.toFixed(2)}</td></tr>`).join('')}</table></details></td></tr>`;
    });
    h += `<tr class="tot"><td colspan="4">Total to journal</td><td class="n">${fmt(E.round2(plan.months.reduce((s, m) => s + m.amount, 0)))}</td></tr></table>`;
  }
  if (check.length) {
    const flagged = check.filter(c => Math.abs(c.diff) >= 1);
    h += `<details><summary>Posted in Sage vs calculated — last ${check.length} months${flagged.length ? ` (${flagged.length} differ by R1 or more)` : ' (all within R1)'}</summary>
    <div class="muted" style="margin:6px 0">Differences usually come from entries added to the ledger after the interest was posted, or from day-count / rate-date slips in a spreadsheet. Tick a month to include its difference as an adjustment line in the journal.</div>
    <table class="sm"><tr><th>Month</th><th class="n">Posted</th><th class="n">Calculated</th><th class="n">Difference</th><th>Adjust</th></tr>${check.map(c => `<tr><td>${E.MONLONG[+c.month.slice(5) - 1].slice(0, 3)} ${c.month.slice(0, 4)}</td><td class="n">${fmt(c.posted)}</td><td class="n">${fmt(c.calc)}</td><td class="n" style="${Math.abs(c.diff) >= 1 ? 'color:var(--maroon);font-weight:600' : ''}">${fmt(c.diff)}</td>
      <td>${Math.abs(c.diff) >= 0.005 ? `<input type="checkbox" data-a="adj" data-id="${esc(l.id)}" data-m="${c.month}" ${l.adj[c.month] ? 'checked' : ''}>` : ''}</td></tr>`).join('')}</table></details>`;
  }
  return h + `</div>`;
}
function vJournal(ctx) {
  const js = ctx.journals;
  let h = `<div class="card"><h2>Interest journal — ${esc(client.name)}</h2>`;
  if (!loaded.length) return h + `<div class="note info">Load the ledgers first.</div></div>` + vRuns();
  const d = canEdit() ? '' : ' disabled';
  h += `<div class="row"><div>Sage ledger account for interest expense (debit) <input class="w-m" data-a="expacct" value="${esc(settings.expenseAccount)}" placeholder="account number / name"${d}></div></div>`;
  const missing = ctx.plans.filter(p => !p.cfg.loanAccount && js.some(j => j.lines.some(x => x.p === p)));
  if (missing.length) h += `<div class="row" style="margin-top:8px">${missing.map(p => `<div>${esc(p.cfg.label || p.l.acct.name)} — Sage ledger account (credit) <input class="w-m" data-a="loanacct" data-k="${esc(p.l.cfgKey)}" placeholder="account number / name"${d}></div>`).join('')}</div>`;
  if (!js.length) return h + `<div class="note info" style="margin-top:12px">Nothing to journal — every loaded account is up to date to ${E.dmy(asAt)}.</div></div>` + vRuns();
  js.forEach(j => {
    h += `<div style="margin-top:16px"><div class="row"><h3>${esc(j.desc)}</h3><span class="muted">Reference</span><input class="w-m" data-a="jref" data-m="${j.month}" value="${esc(j.ref)}"><span class="muted">Date</span><input type="date" data-a="jdate" data-m="${j.month}" value="${j.date}"></div>
    <table style="margin-top:6px"><tr><th>Ledger account</th><th>Details</th><th class="n">Debit</th><th class="n">Credit</th></tr>`;
    j.lines.forEach(x => { const pos = x.amount >= 0, a = fmt(Math.abs(x.amount));
      h += `<tr><td>${esc(settings.expenseAccount || '(interest expense account)')}</td><td>${esc(x.desc)}</td><td class="n">${pos ? a : ''}</td><td class="n">${pos ? '' : a}</td></tr>
      <tr><td>${esc(x.loanAcct || '(' + x.label + ' account)')}</td><td>${esc(x.desc)}</td><td class="n">${pos ? '' : a}</td><td class="n">${pos ? a : ''}</td></tr>`; });
    const t = fmt(j.lines.reduce((s, x) => s + Math.abs(x.amount), 0));
    h += `<tr class="tot"><td colspan="2">Total</td><td class="n">${t}</td><td class="n">${t}</td></tr></table></div>`;
  });
  h += `<div class="row" style="margin-top:16px"><button class="btn" data-a="dl-journal">Download Sage journal CSV</button><button class="btn sec" data-a="copy-journal">Copy journal lines</button><span class="muted" id="jmsg"></span></div>
  <div class="muted" style="margin-top:8px">The CSV follows Sage Accounting's journal import layout (Adjustments → Journals → New Journal → Import Journals). Compare the headings to Sage's own template the first time; the ledger accounts must already exist. After posting, export the ledger again next month. Downloading records the journal in the history below.</div>
  <textarea id="jcopy" class="hidden" readonly></textarea></div>`;
  return h + vRuns();
}
function vRuns() {
  if (!runs.length) return '';
  return `<div class="card"><h3>Journals produced for ${esc(client.name)}</h3><table class="sm" style="margin-top:6px"><tr><th>Produced</th><th>Reference</th><th>Journal date</th><th class="n">Total</th></tr>${runs.map(r => `<tr><td>${esc(String(r.created_at).slice(0, 16).replace('T', ' '))}</td><td>${esc(r.reference)}</td><td>${E.dmy(r.journal_date)}</td><td class="n">${fmt(+r.total)}</td></tr>`).join('')}</table></div>`;
}
function stmtFor(ctx, p) {
  const sp = stmtPeriod[p.l.id] || {}; const from = sp.from || fyStart(asAt); const to = sp.to || asAt;
  const gen = generatedFor(p, ctx.journals);
  return { from, to, st: E.buildStatement(p.l.acct, gen, from, to), gen };
}
function vStmt(ctx) {
  let h = `<div class="card"><h2>Client statements — ${esc(client.name)}</h2><div class="muted">Built from the Sage ledger plus any interest not yet posted. Default period is the current financial year to ${E.dmy(asAt)}.</div></div>`;
  if (!loaded.length) return h + `<div class="note info">Load the ledgers first.</div>`;
  ctx.plans.forEach(p => {
    const { from, to, st } = stmtFor(ctx, p);
    h += `<div class="card"><div class="row"><div class="grow"><h3>${esc(p.cfg.label || p.l.acct.name)} <span class="muted">· ${esc(p.l.acct.name)}</span></h3></div>
    <span class="muted">From</span><input type="date" value="${from}" data-a="sfrom" data-id="${esc(p.l.id)}"><span class="muted">To</span><input type="date" value="${to}" data-a="sto" data-id="${esc(p.l.id)}">
    <button class="btn" data-a="dl-pdf" data-id="${esc(p.l.id)}">Download PDF</button></div>
    <div class="stmt-prev" style="margin-top:10px"><table class="sm"><tr><th>Date</th><th>Reference</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th></tr>
    <tr><td></td><td></td><td><b>Opening balance</b></td><td></td><td></td><td class="n"><b>${fmt(st.opening)}</b></td></tr>
    ${st.lines.map(x => `<tr style="${x.gen ? 'background:#fbf3f3' : ''}"><td>${E.dmy(x.date)}</td><td>${esc(x.ref)}</td><td>${esc(x.desc)}</td><td class="n">${fmt(x.debit, true)}</td><td class="n">${fmt(x.credit, true)}</td><td class="n">${fmt(x.bal)}</td></tr>`).join('')}
    <tr class="tot"><td></td><td></td><td>Closing balance</td><td class="n">${fmt(st.totD)}</td><td class="n">${fmt(st.totC)}</td><td class="n">${fmt(st.closing)}</td></tr></table></div>
    ${ctx.journals.some(j => j.lines.some(x => x.p === p)) ? `<div class="muted" style="margin-top:6px">Shaded lines are interest not yet posted in Sage.</div>` : ''}</div>`;
  });
  return h;
}
function vSet() {
  const d = canEdit() ? '' : ' disabled'; const dp = isPlatformAdmin ? '' : ' disabled';
  let h = `<div class="card"><div class="row"><h2 class="grow">${esc(client.name)} — settings</h2><span class="muted" id="savestate">${esc(saveState)}</span></div>
  ${canEdit() ? '' : '<div class="note info">You have view-only access to this client.</div>'}
  <div class="row"><div>Interest expense account in Sage (debit) <input class="w-m" data-a="expacct" value="${esc(settings.expenseAccount)}"${d}></div>
  <div>Journal reference prefix <input class="w-s" data-a="refprefix" value="${esc(settings.refPrefix)}"${d}></div>
  <div>Financial year ends in <select data-a="fye"${d}>${E.MONLONG.map((m, i) => `<option value="${i + 1}"${settings.fyeMonth === i + 1 ? ' selected' : ''}>${m}</option>`).join('')}</select></div></div></div>`;
  Object.keys(settings.accounts).sort().forEach(k => { const c = settings.accounts[k];
    h += `<div class="card"><h3>${esc(c.label || k)} <span class="muted">· ${esc(c.sageName || k)}</span></h3><div class="row" style="margin:8px 0"><div>Short name <input class="w-m" data-a="cfg" data-k="${esc(k)}" data-f="label" value="${esc(c.label)}"${d}></div><div class="grow">Journal description <input class="w-l" data-a="cfg" data-k="${esc(k)}" data-f="descPrefix" value="${esc(c.descPrefix)}"${d}></div><div>Sage ledger account (credit) <input class="w-m" data-a="cfg" data-k="${esc(k)}" data-f="loanAccount" value="${esc(c.loanAccount)}"${d}></div></div>
    <div class="muted">Interest rate for this loan</div>${rateEditor(k)}</div>`; });
  if (!Object.keys(settings.accounts).length) h += `<div class="note info">Loan accounts appear here automatically the first time you load a ledger for them.</div>`;
  h += `<div class="card"><h2>Prime lending rate <span class="muted">(shared by all clients${isPlatformAdmin ? '' : ' — read only'})</span></h2><div class="muted" style="margin-bottom:8px">Enter the first day the new prime rate applies (banks apply a change the day after the SARB announcement). Each loan's rate is prime plus its own margin, so a prime change is entered once and flows to every loan of every client.</div>
  <table class="sm"><tr><th>Applies from</th><th>Prime</th><th></th></tr>${settings.prime.slice().sort((a, b) => a.from < b.from ? 1 : -1).map(p => { const i = settings.prime.indexOf(p); return `<tr><td><input type="date" value="${p.from}" data-a="prime" data-i="${i}" data-f="from"${dp}></td><td><input type="number" step="0.01" value="${p.rate}" data-a="prime" data-i="${i}" data-f="rate"${dp}> %</td><td>${isPlatformAdmin ? `<button class="x" data-a="prime-del" data-i="${i}">&times;</button>` : ''}</td></tr>`; }).join('')}</table>
  ${isPlatformAdmin ? `<div style="margin-top:8px"><button class="btn sec" data-a="prime-add">+ New prime rate</button></div>` : ''}</div>`;
  if (isClientAdmin()) h += `<div class="card"><h2>People with access to ${esc(client.name)}</h2><table class="sm"><tr><th>Email</th><th>Role</th><th></th></tr>${members.map(m => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td><button class="x" title="Remove" data-a="member-del" data-u="${esc(m.user_id)}">&times;</button></td></tr>`).join('')}</table>
  <div class="row" style="margin-top:10px"><input id="memail" placeholder="email of an existing user" class="w-m"><select id="mrole"><option value="staff">staff — can run &amp; edit</option><option value="viewer">viewer — read only</option><option value="admin">admin — also manages people</option></select><button class="btn sec" data-a="member-add">Give access</button></div>
  <div class="muted" style="margin-top:6px">The person must first exist as a user (Supabase → Authentication → Users → Invite user).</div>${notes.map(n => `<div class="note bad">${esc(n)}</div>`).join('')}</div>`;
  return h;
}

// ======================= events =======================
function setRate(k, i, f, v) { const r = settings.accounts[k].rates[i]; r[f] = f === 'value' ? parseFloat(v) || 0 : v; settings.accounts[k].rates.sort((a, b) => a.from < b.from ? -1 : 1); }
document.addEventListener('submit', async e => { if (e.target.id !== 'loginform') return; e.preventDefault(); loginMsg = ''; try { await api.signIn($('#lemail').value.trim(), $('#lpass').value); } catch (er) { loginMsg = er.message; render(); } });
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-a]'); if (!t || t.tagName === 'INPUT' || t.tagName === 'SELECT') return; const a = t.dataset.a;
  try {
    if (a === 'tab') { tab = t.dataset.k; render(); }
    else if (a === 'pick') { $('#fin').click(); }
    else if (a === 'signout') { await api.signOut(); session = null; resetAll(); render(); }
    else if (a === 'newclient-open') { newClientOpen = true; notes = []; render(); }
    else if (a === 'newclient-cancel') { newClientOpen = false; notes = []; render(); }
    else if (a === 'newclient-save') { const n = $('#ncname').value.trim(); if (!n) return; try { const id = await api.createClient(n, $('#ncshort').value.trim()); clients = await api.clients(); roles = await api.myRoles(session.user.id); newClientOpen = false; await selectClient(id); tab = 'run'; } catch (er) { notes = [er.message]; } render(); }
    else if (a === 'rate-new') { const n = t.closest('.note'); const v = n.querySelector('.nr-val').value; if (v === '') return; settings.accounts[t.dataset.k].rates.push({ from: n.querySelector('.nr-from').value, basis: n.querySelector('.nr-basis').value, value: parseFloat(v) || 0 }); queueSave(); render(); }
    else if (a === 'rate-add') { const rs = settings.accounts[t.dataset.k].rates; rs.push({ from: todayIso, basis: 'prime', value: rs.length ? rs[rs.length - 1].value : 2 }); queueSave(); render(); }
    else if (a === 'rate-del') { settings.accounts[t.dataset.k].rates.splice(+t.dataset.i, 1); queueSave(); render(); }
    else if (a === 'prime-add') { const top = settings.prime.slice().sort((x, y) => x.from < y.from ? 1 : -1)[0]; settings.prime.push({ from: todayIso, rate: top ? top.rate : 10 }); primeDirty = true; queueSave(); render(); }
    else if (a === 'prime-del') { settings.prime.splice(+t.dataset.i, 1); primeDirty = true; queueSave(); render(); }
    else if (a === 'accrued-reset') { loaded.find(l => l.id === t.dataset.id).accrued = null; render(); }
    else if (a === 'dl-journal') await dlJournal();
    else if (a === 'copy-journal') copyJournal();
    else if (a === 'dl-pdf') dlPdf(t.dataset.id);
    else if (a === 'member-add') { const em = $('#memail').value.trim(); if (!em) return; try { await api.addMember(clientId, em, $('#mrole').value); members = await api.listMembers(clientId); notes = []; } catch (er) { notes = [er.message]; } render(); }
    else if (a === 'member-del') { try { await api.removeMember(clientId, t.dataset.u); members = await api.listMembers(clientId); notes = []; } catch (er) { notes = [er.message]; } render(); }
  } catch (er) { notes = [er.message]; render(); }
});
document.addEventListener('change', async e => {
  const t = e.target; const a = t.dataset && t.dataset.a;
  if (t.id === 'fin') { loadFiles(Array.from(t.files)); return; }
  if (!a) return;
  if (a === 'client') { busy = 'Loading…'; render(); try { await selectClient(t.value); } catch (er) { notes = [er.message]; } busy = ''; render(); return; }
  if (a === 'asat') asAt = t.value;
  else if (a === 'accrued') loaded.find(l => l.id === t.dataset.id).accrued = t.value || null;
  else if (a === 'adj') loaded.find(l => l.id === t.dataset.id).adj[t.dataset.m] = t.checked;
  else if (a === 'rate') { setRate(t.dataset.k, +t.dataset.i, t.dataset.f, t.value); queueSave(); }
  else if (a === 'prime') { const p = settings.prime[+t.dataset.i]; p[t.dataset.f] = t.dataset.f === 'rate' ? parseFloat(t.value) || 0 : t.value; settings.prime.sort((x, y) => x.from < y.from ? -1 : 1); primeDirty = true; queueSave(); }
  else if (a === 'cfg') { settings.accounts[t.dataset.k][t.dataset.f] = t.value; queueSave(); }
  else if (a === 'expacct') { settings.expenseAccount = t.value.trim(); queueSave(); }
  else if (a === 'loanacct') { settings.accounts[t.dataset.k].loanAccount = t.value.trim(); queueSave(); }
  else if (a === 'refprefix') { settings.refPrefix = t.value.trim() || 'INTJNL'; queueSave(); }
  else if (a === 'fye') { settings.fyeMonth = +t.value; queueSave(); }
  else if (a === 'jref') jrefs[t.dataset.m] = t.value.trim();
  else if (a === 'jdate') jdates[t.dataset.m] = t.value;
  else if (a === 'sfrom') (stmtPeriod[t.dataset.id] = stmtPeriod[t.dataset.id] || {}).from = t.value;
  else if (a === 'sto') (stmtPeriod[t.dataset.id] = stmtPeriod[t.dataset.id] || {}).to = t.value;
  else return;
  render();
});
['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.remove('over'); if (ev === 'drop') loadFiles(Array.from(e.dataTransfer.files)); } }));

// ======================= outputs =======================
function save(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain' });
  if (window.__SAVE_OVERRIDE) { window.__SAVE_OVERRIDE(filename, blob); return true; }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); return true;
}
function journalData() { const ctx = compute(); return E.journalRows(ctx.journals.map(j => ({ ref: j.ref, date: j.date, desc: j.desc, items: j.lines.map(x => ({ amount: x.amount, desc: x.desc, loanAcct: x.loanAcct })) })), settings); }
async function dlJournal() {
  const rows = journalData(); if (!rows.length) return; const ctx = compute();
  save(`${(client.short_name || client.name).replace(/[^\w-]+/g, '_')} Sage interest journal ${E.dmy(asAt).replace(/\//g, '-')}.csv`, E.journalCsv(rows), 'text/csv');
  if (canEdit()) {
    try { for (const j of ctx.journals) await api.logRun({ client_id: clientId, as_at: asAt, reference: j.ref, journal_date: j.date, total: E.round2(j.lines.reduce((s, x) => s + Math.abs(x.amount), 0)), lines: j.lines.map(x => ({ account: x.label, amount: x.amount, description: x.desc })) }); runs = await api.runs(clientId); }
    catch (er) { notes = ['The CSV downloaded, but the history entry could not be saved: ' + er.message]; }
    render();
  }
}
function copyJournal() {
  const rows = journalData(); const txt = ['Reference\tDate\tDescription\tLedger Account\tDetails\tDebit\tCredit'].concat(rows.map(r => [r.ref, r.first ? E.dmy(r.date) : '', r.first ? r.desc : '', r.acct, r.details, r.dr, r.cr].join('\t'))).join('\n');
  const ta = $('#jcopy'), msg = $('#jmsg');
  (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => { msg.textContent = 'Copied.'; }).catch(() => { ta.classList.remove('hidden'); ta.value = txt; ta.select(); msg.textContent = 'Copy blocked here — select the text below and copy it.'; });
}
function dlPdf(id) {
  const ctx = compute(); const p = ctx.plans.find(x => x.l.id === id); const { from, to, st } = stmtFor(ctx, p);
  if (!window.jspdf) { notes = ['The PDF library did not load. Check your internet connection and reload.']; render(); return; }
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const M = 14, W = 210; const X = { date: M, ref: M + 21, desc: M + 52 }; const col = { deb: M + 130, cre: M + 154, bal: M + 182 };
  const maroon = [139, 26, 26], char = [52, 53, 50]; const title = p.cfg.label || p.l.acct.name; let y;
  const header = first => {
    doc.setFillColor(...maroon); doc.rect(0, 0, W, first ? 30 : 16, 'F'); doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(first ? 15 : 10);
    doc.text(first ? 'Loan account statement' : `Loan account statement - ${title}`, M, first ? 13 : 10);
    if (first) { doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.text(p.l.acct.company || client.name, M, 21); doc.text(`${E.dmy(from)} to ${E.dmy(to)}`, W - M, 21, { align: 'right' }); }
    doc.setTextColor(...char); y = first ? 40 : 24;
    if (first) { doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(p.l.acct.name, M, y); y += 8; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setFillColor(240, 236, 231); doc.rect(M, y - 4.5, W - 2 * M, 6.5, 'F');
    doc.text('Date', X.date + 1, y); doc.text('Reference', X.ref, y); doc.text('Description', X.desc, y);
    doc.text('Debit', col.deb, y, { align: 'right' }); doc.text('Credit', col.cre, y, { align: 'right' }); doc.text('Balance', col.bal, y, { align: 'right' }); y += 6;
  };
  header(true);
  const row = (d, ref, desc, de, cr, bal, bold) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8);
    const dl = doc.splitTextToSize(desc || '', 56), rl = doc.splitTextToSize(ref || '', 29); const n = Math.max(dl.length, rl.length, 1); const h = n * 3.6 + 1.6;
    if (y + h > 280) { doc.addPage(); header(false); doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(8); }
    doc.text(d, X.date + 1, y); doc.text(rl, X.ref, y); doc.text(dl, X.desc, y);
    if (de) doc.text(de, col.deb, y, { align: 'right' }); if (cr) doc.text(cr, col.cre, y, { align: 'right' }); if (bal !== '') doc.text(bal, col.bal, y, { align: 'right' });
    y += h; doc.setDrawColor(230, 226, 220); doc.line(M, y - 3, W - M, y - 3);
  };
  row('', '', 'Opening balance', '', '', fmt(st.opening), true);
  st.lines.forEach(x => row(E.dmy(x.date), x.ref, x.desc, fmt(x.debit, true), fmt(x.credit, true), fmt(x.bal), false));
  row('', '', 'Closing balance', fmt(st.totD), fmt(st.totC), fmt(st.closing), true);
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(120); doc.text('Prepared by Tutin Tax', M, 290); doc.text(`Page ${i} of ${n}`, W - M, 290, { align: 'right' }); }
  save(`Loan statement - ${title} - ${to}.pdf`, doc.output('blob'), 'application/pdf');
}

render();
boot();
})();
