/* Director & related-party loan interest — the statement is the working page (Supabase + GitHub Pages) */
(() => {
'use strict';
const E = Engine, S = Stmt;
const CFG = window.APP_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, blank) => { if (blank && Math.abs(n) < 0.005) return ''; return S.fmt(n); };

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
  entries: async accId => { const out = []; for (let from = 0; ; from += 1000) { const r = await ok(sb.from('ledger_entries').select('id,seq,entry_date,entity,ref,entry_type,description,debit,credit,balance,in_sage,origin,approved,removed,sage_original,exported_at').eq('loan_account_id', accId).order('entry_date').order('seq').range(from, from + 999)); out.push(...r); if (r.length < 1000) break; } return out; },
  lastImports: id => ok(sb.from('ledger_imports').select('loan_account_id,file_name,imported_at,row_count').eq('client_id', id).order('imported_at', { ascending: false }).limit(200)),
  saveEntry: p => ok(sb.rpc('save_entry', p)),
  deleteEntry: (client, id) => ok(sb.rpc('delete_entry', { p_client: client, p_id: id })),
  revertEntry: (client, id) => ok(sb.rpc('revert_entry', { p_client: client, p_id: id })),
  setApproved: (client, ids, approved) => ok(sb.rpc('set_approved', { p_client: client, p_ids: ids, p_approved: approved })),
  addEntries: (id, rows) => ok(sb.rpc('add_entries', { p_client: id, p_rows: rows })),
  applyImport: p => ok(sb.rpc('apply_import', p)),
  markExported: (client, ids) => ok(sb.rpc('mark_exported', { p_client: client, p_ids: ids })),
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
let session = null, isPlatformAdmin = false, roles = {}, clients = [], clientId = null, client = null;
let settings = blankSettings(), members = [], runs = [];
let loaded = [], notes = [], loginMsg = '', busy = '', newClientOpen = false;
let tab = 'stmt', saveState = '', primeDirty = false;
let acctKey = null, stmtFrom = null, editId = null, addOpen = false, reviews = {}, adjSel = {};
const openDet = new Set();
const dAttr = k => ` data-det="${esc(k)}"${openDet.has(k) ? ' open' : ''}`;
function blankSettings() { return { prime: [], accounts: {}, expenseAccount: '', refPrefix: 'INTJNL', fyeMonth: 2 }; }
const today = new Date(); const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const monthEnds = (() => { const out = []; let [y, m] = [today.getFullYear(), today.getMonth() + 1]; for (let i = 0; i < 16; i++) { const e = E.eom(`${y}-${String(m).padStart(2, '0')}-01`); if (e <= todayIso) out.push(e); m--; if (m === 0) { m = 12; y--; } } return out; })();
let asAt = monthEnds[0];
const myRole = () => isPlatformAdmin ? 'admin' : (roles[clientId] || 'viewer');
const canEdit = () => myRole() === 'admin' || myRole() === 'staff';
const isClientAdmin = () => myRole() === 'admin';
const fyStart = iso => { const [y, m] = iso.split('-').map(Number); const start = settings.fyeMonth % 12 + 1; const sy = start === 1 ? y : (m >= start ? y : y - 1); return `${sy}-${String(start).padStart(2, '0')}-01`; };
const flash = m => { notes = [m]; };

// ======================= boot / auth =======================
async function boot() {
  if (!sb && !window.__API_OVERRIDE) { render(); return; }
  if (sb) api.onAuth(async s => { const had = !!session; session = s; if (s && !had) await afterLogin(); if (!s) { resetAll(); render(); } });
  session = await api.session(); if (session) await afterLogin(); else render();
}
function resetAll() { clients = []; clientId = null; client = null; settings = blankSettings(); loaded = []; members = []; runs = []; isPlatformAdmin = false; roles = {}; }
let loginP = null;
function afterLogin() { if (!loginP) loginP = doLogin().finally(() => { loginP = null; }); return loginP; }
async function doLogin() {
  try {
    busy = 'Loading…'; render();
    isPlatformAdmin = await api.isPlatformAdmin(); roles = await api.myRoles(session.user.id); clients = await api.clients();
    let pick = null; try { pick = localStorage.getItem('dli.client'); } catch (e) { }
    await selectClient((clients.find(c => c.id === pick) || clients[0] || {}).id);
  } catch (e) { notes = ['Could not load: ' + e.message]; }
  busy = ''; render();
}
async function selectClient(id) {
  clientId = id || null; client = clients.find(c => c.id === id) || null; loaded = []; reviews = {}; editId = null; addOpen = false; acctKey = null; stmtFrom = null; adjSel = {}; notes = []; members = []; runs = []; saveState = '';
  if (!client) { settings = blankSettings(); return; }
  try { localStorage.setItem('dli.client', id); } catch (e) { }
  const [prime, accts, rn] = await Promise.all([api.prime(), api.accounts(id), api.runs(id)]);
  settings = { prime: prime.map(p => ({ from: p.effective_from, rate: +p.rate })), accounts: {}, expenseAccount: client.expense_account || '', refPrefix: client.ref_prefix || 'INTJNL', fyeMonth: client.fye_month || 2 };
  accts.forEach(a => { settings.accounts[a.sage_key] = { dbId: a.id, opening: +a.opening_balance || 0, openingDate: a.opening_date, sageName: a.sage_account_name, label: a.label, descPrefix: a.desc_prefix, loanAccount: a.sage_ledger_account, rates: (a.loan_rate_rules || []).map(r => ({ from: r.effective_from, basis: r.basis, value: +r.value })).sort((x, y) => x.from < y.from ? -1 : 1) }; });
  runs = rn; primeDirty = false;
  const imps = await api.lastImports(id); const lastImp = {}; imps.forEach(i => { if (!lastImp[i.loan_account_id]) lastImp[i.loan_account_id] = i; });
  const nl = [];
  for (const a of accts) { const k = a.sage_key; const ent = await api.entries(a.id); if (ent.length) nl.push(makeLoaded(k, ent, lastImp[a.id])); }
  nl.sort((x, y) => x.acct.name.localeCompare(y.acct.name)); loaded = nl;
  acctKey = loaded.length ? loaded[0].cfgKey : null;
  if (isClientAdmin()) { try { members = await api.listMembers(id); } catch (e) { members = []; } }
}

function makeLoaded(key, ent, imp) {
  const c = settings.accounts[key];
  const { all, acct } = S.build(ent.map(S.fromDb), c.opening || 0, c.sageName || key, client ? client.name : '');
  return { id: key, cfgKey: key, file: imp ? imp.file_name : '', imported: imp ? imp.imported_at : '', all, acct };
}
async function reloadAccount(key, file) {
  const old = loaded.find(l => l.cfgKey === key);
  const accs = await api.accounts(clientId); const row = accs.find(x => x.sage_key === key);
  Object.assign(settings.accounts[key], { dbId: row.id, opening: +row.opening_balance || 0, openingDate: row.opening_date });
  const ent = await api.entries(row.id);
  const imp = file ? { file_name: file, imported_at: new Date().toISOString() } : (old ? { file_name: old.file, imported_at: old.imported } : null);
  const nl = makeLoaded(key, ent, imp);
  loaded = loaded.filter(l => l.cfgKey !== key).concat([nl]).sort((a, b) => a.acct.name.localeCompare(b.acct.name));
  if (!acctKey) acctKey = key;
}
const curLoaded = () => loaded.find(l => l.cfgKey === acctKey) || loaded[0] || null;

// ======================= saving settings (debounced, serial) =======================
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
async function settle() { clearTimeout(saveTimer); for (let i = 0; i < 200 && (dirty || saving); i++) { if (dirty && !saving) await flush(); else await new Promise(r => setTimeout(r, 50)); } if (/^Could not/.test(saveState)) throw new Error(saveState); }
function paintSave() { const el = $('#savestate'); if (el) el.textContent = saveState; }

// ======================= rendering =======================
const TABS = [['stmt', 'Statement'], ['int', 'Interest'], ['set', 'Rates & settings']];
function render() {
  const sc = window.scrollY; try { const ae = document.activeElement; if (ae && ae !== document.body && ae.blur) ae.blur(); } catch (e) { }
  paintHeader();
  if (!configured && !window.__API_OVERRIDE) { $('#nav').innerHTML = ''; $('#app').innerHTML = vSetup(); return; }
  if (!session) { $('#nav').innerHTML = ''; $('#app').innerHTML = vLogin(); return; }
  if (busy) { $('#nav').innerHTML = ''; $('#app').innerHTML = `<div class="note info">${esc(busy)}</div>`; return; }
  if (newClientOpen) { $('#nav').innerHTML = ''; $('#app').innerHTML = vNewClient(); return; }
  if (!client) { $('#nav').innerHTML = ''; $('#app').innerHTML = `<div class="card"><h2>No clients yet</h2><div class="muted">${isPlatformAdmin ? 'Use “+ New client” at the top to add your first client.' : 'You have not been given access to any client. Ask the practice to add you.'}</div></div>`; return; }
  $('#nav').innerHTML = TABS.map(([k, t]) => `<button data-a="tab" data-k="${k}" class="${tab === k ? 'on' : ''}">${esc(t)}</button>`).join('');
  $('#app').innerHTML = tab === 'stmt' ? vStmt() : tab === 'int' ? vInt() : vSet();
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
const noteHtml = () => notes.map(n => `<div class="note ${/^(Saved|Done)/.test(n) ? 'info' : 'bad'}">${esc(n)}</div>`).join('');
const accLabel = l => settings.accounts[l.cfgKey].label || l.acct.name;
const BADGE = { posted: 'ok', pending: 'todo', draft: 'todo', imported: 'todo', changed: 'todo', removed: 'todo' };

// ---------- the statement ----------
function vStmt() {
  let h = `<div class="card"><div class="row"><div class="grow"><h2>${esc(client.name)} — statement</h2><div class="muted">Add, edit or delete lines here. Lines that are not approved do not count in the balance or the interest.</div></div></div>
  ${canEdit() ? `<div class="drop" id="drop" data-a="pick" style="margin-top:12px"><b>Import Sage ledger files</b> or drop them here — differences are added as drafts for your approval<input id="fin" type="file" multiple accept=".xls,.xlsx,.html,.htm,.csv" class="hidden"></div>` : ''}${noteHtml()}</div>`;
  Object.keys(reviews).forEach(k => { h += vReview(k); });
  if (!loaded.length) return h + `<div class="note info">No ledgers saved for this client yet. Import the Sage exports above.</div>`;
  const l = curLoaded(); const cfg = settings.accounts[l.cfgKey];
  const from = stmtFrom || fyStart(asAt);
  const prime = settings.prime;
  const st = Stmt.statement(l.all, l.acct, cfg, prime, from, asAt);
  const drafts = l.all.filter(r => !r.removed && !r.approved);
  h += `<div class="card"><div class="row"><select data-a="acct">${loaded.map(x => `<option value="${esc(x.cfgKey)}"${x.cfgKey === l.cfgKey ? ' selected' : ''}>${esc(accLabel(x))}</option>`).join('')}</select>
  <span class="muted">From</span><input type="date" value="${from}" data-a="sfrom"><span class="muted">To</span><select data-a="asat">${monthEnds.map(d => `<option value="${d}"${d === asAt ? ' selected' : ''}>${E.dmy(d)}</option>`).join('')}</select>
  <span class="grow"></span>${canEdit() ? `<button class="btn sec" data-a="add-open">+ Add line</button>${drafts.length ? `<button class="btn" data-a="approve-all">Approve all drafts (${drafts.length})</button>` : ''}` : ''}<button class="btn sec" data-a="dl-pdf">Download PDF</button></div>
  <div class="muted" style="margin-top:6px">Last import: ${l.imported ? esc(String(l.imported).slice(0, 10)) + (l.file ? ' · ' + esc(l.file) : '') : 'none'} · Opening balance ${fmt(st.opening)}</div>`;
  if (l.acct.balanceMismatches) h += `<div class="note warn">The Balance column in Sage's export doesn't tie to its own debits and credits (${l.acct.balanceMismatches} row${l.acct.balanceMismatches > 1 ? 's' : ''}, first on ${E.dmy(l.acct.firstMismatch.date)}).</div>`;
  if (addOpen && canEdit()) h += vLineForm(null);
  h += `<div style="overflow:auto;margin-top:8px"><table class="sm"><tr><th>Date</th><th>Reference</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th><th class="n">Balance</th><th class="n">Interest</th><th>Status</th><th></th></tr>`;
  st.months.forEach(m => {
    m.lines.forEach(x => {
      if (x.kind === 'bf') { h += `<tr class="bf"><td>${E.dmy(x.date)}</td><td></td><td><i>Balance brought forward</i></td><td></td><td></td><td class="n">${fmt(x.bal)}</td><td class="n">${x.item ? intCell(x.item) : ''}</td><td></td><td></td></tr>`; return; }
      const r = x.row;
      if (editId === r.id && canEdit()) { h += `<tr><td colspan="9">${vLineForm(r)}</td></tr>`; return; }
      const dim = x.status === 'removed' ? 'text-decoration:line-through;opacity:.6;' : (!Stmt.counted(r) ? 'opacity:.8;' : '');
      const bg = x.status === 'posted' ? '' : 'background:#fbf3f3;';
      h += `<tr style="${bg}${dim}"><td>${E.dmy(r.date)}</td><td>${esc(r.ref)}</td><td>${esc(r.desc)}</td><td class="n">${fmt(r.debit, true)}</td><td class="n">${fmt(r.credit, true)}</td><td class="n">${x.bal == null ? '' : fmt(x.bal)}</td><td class="n">${x.item ? intCell(x.item) : ''}</td>
      <td><span class="pill ${BADGE[x.status]}">${esc(Stmt.STATUS[x.status])}</span>${r.orig ? `<div class="muted">Sage: ${E.dmy(r.orig.date)} ${fmt(+r.orig.credit - +r.orig.debit)}</div>` : ''}</td>
      <td style="white-space:nowrap">${canEdit() ? rowButtons(r, x.status) : ''}</td></tr>`;
    });
    h += `<tr class="tot"><td colspan="6">${E.MONLONG[+m.month.slice(5) - 1]} ${m.month.slice(0, 4)} interest — calculated ${m.calc == null ? 'n/a (no rate)' : fmt(m.calc)} · posted ${fmt(m.posted)} · drafted ${fmt(m.drafted)}</td><td class="n">${m.calc == null ? '' : fmt(m.calc)}</td><td colspan="2" ${m.diff != null && Math.abs(m.diff) >= 0.005 ? 'style="color:var(--maroon);font-weight:600"' : ''}>${m.diff == null ? '' : Math.abs(m.diff) < 0.005 ? 'Reconciled' : 'Difference ' + fmt(m.diff)}</td></tr>`;
  });
  h += `<tr class="tot"><td colspan="5">Closing balance (counted lines)</td><td class="n">${fmt(st.closing)}</td><td colspan="3"></td></tr></table></div></div>`;
  return h;
}
const intCell = it => `${it.interest ? fmt(it.interest) : ''}<div class="muted">${it.days} day${it.days === 1 ? '' : 's'}${it.rates.length ? ' @ ' + it.rates.map(E.pct).join('/') : ''}</div>`;
function rowButtons(r, status) {
  let b = '';
  if (!r.removed && !r.approved) b += `<button class="lnk" data-a="approve" data-id="${r.id}">Approve</button> `;
  else if (!r.removed && r.approved && !r.inSage) b += `<button class="lnk" data-a="unapprove" data-id="${r.id}">Unapprove</button> `;
  if (!r.removed) b += `<button class="lnk" data-a="edit" data-id="${r.id}">Edit</button> <button class="lnk" data-a="del" data-id="${r.id}">Delete</button> `;
  if (r.orig || r.removed) b += `<button class="lnk" data-a="revert" data-id="${r.id}">Revert to Sage</button>`;
  return b;
}
function vLineForm(r) {
  const cr = r ? r.credit > 0 : true; const amt = r ? (r.credit > 0 ? r.credit : r.debit) : '';
  return `<div class="note info"><div class="row"><span>Date</span><input type="date" class="en-date" value="${r ? r.date : todayIso}"><select class="en-type"><option value="credit"${cr ? ' selected' : ''}>Advance received (credit)</option><option value="debit"${cr ? '' : ' selected'}>Payment made (debit)</option></select><input type="number" step="0.01" min="0" class="en-amt" placeholder="Amount" value="${amt}"><input class="en-ref w-m" placeholder="Reference" value="${esc(r ? r.ref : '')}"><input class="en-desc w-l" placeholder="Description" value="${esc(r ? r.desc : '')}"><button class="btn" data-a="line-save" data-id="${r ? r.id : ''}">Save</button><button class="btn sec" data-a="line-cancel">Cancel</button></div>${r ? '' : '<div class="muted">New lines are saved as drafts until you approve them.</div>'}</div>`;
}

// ---------- Sage import differences ----------
function vReview(k) {
  const rv = reviews[k], d = rv.diff, nm = settings.accounts[k].label || rv.a.name;
  const li = r => esc(E.dmy(r.date) + ' ' + (r.desc || r.ref) + ' ' + fmt(r.credit - r.debit));
  const none = !d.toAdd.length && !d.toMark.length && !d.resolved.length && !d.purge.length;
  let h = `<div class="card" style="border-color:var(--maroon)"><h3>Sage import — ${esc(nm)} <span class="muted">· ${esc(rv.file)}</span></h3><div style="margin:6px 0">`;
  h += `<div><b>${d.toAdd.length}</b> line${d.toAdd.length === 1 ? '' : 's'} in Sage not in the app${d.toAdd.length ? ' — tick the ones to add as drafts' : ''}.</div>`;
  if (d.toMark.length) h += `<div><b>${d.toMark.length}</b> app line${d.toMark.length === 1 ? ' is' : 's are'} now in Sage (will be marked as in Sage).</div>`;
  if (d.resolved.length) h += `<div><b>${d.resolved.length}</b> edited line${d.resolved.length === 1 ? '' : 's'} now agree${d.resolved.length === 1 ? 's' : ''} with Sage: ${d.resolved.map(li).join('; ')}.</div>`;
  if (d.purge.length) h += `<div><b>${d.purge.length}</b> deleted line${d.purge.length === 1 ? ' is' : 's are'} no longer in Sage (will be cleared): ${d.purge.map(li).join('; ')}.</div>`;
  if (d.stillChanged.length) h += `<div style="color:var(--maroon)"><b>${d.stillChanged.length}</b> edited line${d.stillChanged.length === 1 ? '' : 's'} still differ${d.stillChanged.length === 1 ? 's' : ''} from Sage: ${d.stillChanged.map(li).join('; ')}.</div>`;
  if (d.stillRemoved.length) h += `<div style="color:var(--maroon)"><b>${d.stillRemoved.length}</b> deleted line${d.stillRemoved.length === 1 ? ' is' : 's are'} still in Sage: ${d.stillRemoved.map(li).join('; ')}.</div>`;
  if (d.otherChanged.length) h += `<div style="color:var(--maroon)"><b>${d.otherChanged.length}</b> edited line${d.otherChanged.length === 1 ? '' : 's'} match neither the old nor the new Sage values: ${d.otherChanged.map(li).join('; ')}.</div>`;
  if (d.pending.length) h += `<div style="color:var(--maroon)"><b>${d.pending.length}</b> app line${d.pending.length === 1 ? ' is' : 's are'} not in Sage: ${d.pending.map(li).join('; ')}.</div>`;
  if (d.missing.length) h += `<div style="color:var(--maroon)"><b>${d.missing.length}</b> line${d.missing.length === 1 ? '' : 's'} the app holds as from Sage ${d.missing.length === 1 ? 'is' : 'are'} not in this export: ${d.missing.slice(0, 6).map(li).join('; ')}${d.missing.length > 6 ? '…' : ''}.</div>`;
  h += `</div>`;
  if (d.toAdd.length) h += `<div class="row"><button class="lnk" data-a="imp-all" data-k="${esc(k)}" data-v="1">Select all</button><button class="lnk" data-a="imp-all" data-k="${esc(k)}" data-v="0">Select none</button></div>
    <div style="max-height:320px;overflow:auto"><table class="sm"><tr><th></th><th>Date</th><th>Reference</th><th>Description</th><th class="n">Debit</th><th class="n">Credit</th></tr>${d.toAdd.map((r, i) => `<tr><td><input type="checkbox" data-a="imp-row" data-k="${esc(k)}" data-i="${i}" ${rv.accept.has(i) ? 'checked' : ''}></td><td>${E.dmy(r.date)}</td><td>${esc(r.ref)}</td><td>${esc(r.desc)}</td><td class="n">${fmt(r.debit, true)}</td><td class="n">${fmt(r.credit, true)}</td></tr>`).join('')}</table></div>`;
  return h + `<div class="row" style="margin-top:10px"><button class="btn" data-a="imp-apply" data-k="${esc(k)}">${none && !d.toAdd.length ? 'Record import' : 'Save differences as drafts'}</button><button class="btn sec" data-a="imp-cancel" data-k="${esc(k)}">Discard</button></div></div>`;
}

// ---------- interest recalculation ----------
function intData() {
  return loaded.map(l => {
    const cfg = settings.accounts[l.cfgKey];
    const { plan, through } = Stmt.planNew(l.all, l.acct, cfg, settings.prime, asAt, {});
    const thru = through && through < asAt ? through : (through ? asAt : null);
    const recon = plan.blocked ? [] : Stmt.reconcile(l.all, l.acct, cfg, settings.prime, thru, 12);
    return { l, cfg, plan, recon };
  });
}
function vInt() {
  let h = `<div class="card"><div class="row"><div class="grow"><h2>${esc(client.name)} — interest</h2><div class="muted">Compares the interest posted with the interest calculated from the lines you have approved, and adds what is missing as drafts on the statement.</div></div>
  <div><span class="muted">Interest up to </span><select data-a="asat">${monthEnds.map(d => `<option value="${d}"${d === asAt ? ' selected' : ''}>${E.dmy(d)}</option>`).join('')}</select></div></div>${noteHtml()}</div>`;
  if (!loaded.length) return h + `<div class="note info">Import the ledgers first.</div>`;
  const data = intData(); let any = false;
  data.forEach(d => {
    const diffs = d.recon.filter(c => Math.abs(c.outstanding) >= 0.005);
    const set = adjSel[d.l.cfgKey] || (adjSel[d.l.cfgKey] = new Set());
    h += `<div class="card"><h3>${esc(accLabel(d.l))}</h3>`;
    if (d.plan.blocked) { h += `<div class="note warn">No interest rate set for this loan — set it under Rates &amp; settings.</div></div>`; return; }
    if (d.plan.months.length) {
      any = true;
      h += `<div class="muted">New months to accrue (after ${d.plan.accruedThrough ? E.dmy(d.plan.accruedThrough) : 'the start'})</div><table class="sm"><tr><th>Month</th><th>Period</th><th class="n">Days</th><th class="n">Interest</th></tr>${d.plan.months.map(m => `<tr><td>${E.MONLONG[+m.month.slice(5) - 1]} ${m.month.slice(0, 4)}</td><td>${E.dm(m.from)} – ${E.dmy(m.to)}</td><td class="n">${m.days}</td><td class="n">${fmt(m.amount)}</td></tr>`).join('')}</table>`;
    } else h += `<div class="muted">No new months to accrue.</div>`;
    h += `<div class="muted" style="margin-top:8px">Posted vs calculated — last ${d.recon.length} months</div><table class="sm"><tr><th>Month</th><th class="n">Posted</th><th class="n">Drafted</th><th class="n">Calculated</th><th class="n">Still to add</th><th>Adjust</th></tr>${d.recon.map(c => `<tr><td>${E.MONLONG[+c.month.slice(5) - 1].slice(0, 3)} ${c.month.slice(0, 4)}</td><td class="n">${fmt(c.posted)}</td><td class="n">${fmt(c.drafted, true)}</td><td class="n">${fmt(c.calc)}</td><td class="n" style="${Math.abs(c.outstanding) >= 0.005 ? 'color:var(--maroon);font-weight:600' : ''}">${fmt(c.outstanding)}</td><td>${Math.abs(c.outstanding) >= 0.005 ? `<input type="checkbox" data-a="adj" data-k="${esc(d.l.cfgKey)}" data-m="${c.month}" ${set.has(c.month) ? 'checked' : ''}>` : ''}</td></tr>`).join('')}</table></div>`;
    if (diffs.length) any = true;
  });
  if (canEdit()) h += `<div class="card"><button class="btn" data-a="make-drafts"${any ? '' : ' disabled'}>Create interest entries as drafts</button><span class="muted"> — new months plus the ticked adjustments are added to the statement as drafts; nothing counts until you approve it there.</span></div>`;
  h += vExport();
  return h + vRuns();
}
function exportData() { return Stmt.journalCsv(loaded.map(l => ({ cfg: settings.accounts[l.cfgKey], all: l.all })), settings); }
function vExport() {
  const ex = exportData(); const d = canEdit() ? '' : ' disabled';
  let h = `<div class="card"><h3>Sage journal</h3><div class="muted">Made from approved interest lines that are not in Sage yet.</div>
  <div class="row" style="margin-top:8px"><div>Interest expense account in Sage (debit) <input class="w-m" data-a="expacct" value="${esc(settings.expenseAccount)}"${d}></div>`;
  loaded.filter(l => !settings.accounts[l.cfgKey].loanAccount && ex.ids.some(id => l.all.some(r => r.id === id))).forEach(l => { h += `<div>${esc(accLabel(l))} — Sage loan account (credit) <input class="w-m" data-a="loanacct" data-k="${esc(l.cfgKey)}"${d}></div>`; });
  h += `</div>`;
  if (!ex.groups.length) return h + `<div class="note info" style="margin-top:10px">No approved interest lines are waiting to go to Sage.</div></div>`;
  ex.groups.forEach(g => { h += `<div style="margin-top:10px"><b>${esc(g.ref)}</b> · ${E.dmy(g.date)} · ${g.items.length} line${g.items.length === 1 ? '' : 's'} · ${fmt(E.round2(g.items.reduce((s, x) => s + Math.abs(x.amount), 0)))}</div>`; });
  return h + `<div class="row" style="margin-top:12px"><button class="btn" data-a="dl-journal"${d}>Download Sage journal CSV</button><span class="muted">The lines are then marked as exported; import the ledger after posting them in Sage.</span></div></div>`;
}
function vRuns() {
  if (!runs.length) return '';
  return `<div class="card"><h3>Journals produced for ${esc(client.name)}</h3><table class="sm" style="margin-top:6px"><tr><th>Produced</th><th>Reference</th><th>Journal date</th><th class="n">Total</th></tr>${runs.map(r => `<tr><td>${esc(String(r.created_at).slice(0, 16).replace('T', ' '))}</td><td>${esc(r.reference)}</td><td>${E.dmy(r.journal_date)}</td><td class="n">${fmt(+r.total)}</td></tr>`).join('')}</table></div>`;
}

// ---------- settings ----------
function rateEditor(cfgKey) {
  const c = settings.accounts[cfgKey]; const d = canEdit() ? '' : ' disabled';
  return `<table class="sm"><tr><th>From</th><th>Rate basis</th><th>Value</th><th></th></tr>${(c.rates || []).map((r, i) => `<tr>
    <td><input type="date" value="${esc(r.from)}" data-a="rate" data-k="${esc(cfgKey)}" data-i="${i}" data-f="from"${d}></td>
    <td><select data-a="rate" data-k="${esc(cfgKey)}" data-i="${i}" data-f="basis"${d}><option value="prime"${r.basis === 'prime' ? ' selected' : ''}>Prime +</option><option value="fixed"${r.basis === 'fixed' ? ' selected' : ''}>Fixed rate</option></select></td>
    <td><input type="number" step="0.01" value="${esc(r.value)}" data-a="rate" data-k="${esc(cfgKey)}" data-i="${i}" data-f="value"${d}> %</td>
    <td>${canEdit() ? `<button class="x" title="Remove" data-a="rate-del" data-k="${esc(cfgKey)}" data-i="${i}">&times;</button>` : ''}</td></tr>`).join('')}</table>
    ${canEdit() ? `<button class="lnk" data-a="rate-add" data-k="${esc(cfgKey)}">+ add rate line</button>` : ''}`;
}
function vSet() {
  const d = canEdit() ? '' : ' disabled'; const dp = isPlatformAdmin ? '' : ' disabled';
  let h = `<div class="card"><div class="row"><h2 class="grow">${esc(client.name)} — settings</h2><span class="muted" id="savestate">${esc(saveState)}</span></div>
  ${canEdit() ? '' : '<div class="note info">You have view-only access to this client.</div>'}
  <div class="row"><div>Interest expense account in Sage (debit) <input class="w-m" data-a="expacct" value="${esc(settings.expenseAccount)}"${d}></div>
  <div>Journal reference prefix <input class="w-s" data-a="refprefix" value="${esc(settings.refPrefix)}"${d}></div>
  <div>Financial year ends in <select data-a="fye"${d}>${E.MONLONG.map((m, i) => `<option value="${i + 1}"${settings.fyeMonth === i + 1 ? ' selected' : ''}>${m}</option>`).join('')}</select></div></div></div>`;
  Object.keys(settings.accounts).sort().forEach(k => { const c = settings.accounts[k];
    h += `<div class="card"><h3>${esc(c.label || k)} <span class="muted">· ${esc(c.sageName || k)}</span></h3><div class="row" style="margin:8px 0"><div>Short name <input class="w-m" data-a="cfg" data-k="${esc(k)}" data-f="label" value="${esc(c.label)}"${d}></div><div class="grow">Journal description <input class="w-l" data-a="cfg" data-k="${esc(k)}" data-f="descPrefix" value="${esc(c.descPrefix)}"${d}></div><div>Sage account name of the loan (credit) <input class="w-m" data-a="cfg" data-k="${esc(k)}" data-f="loanAccount" value="${esc(c.loanAccount)}"${d}></div></div>
    <div class="muted">Interest rate for this loan</div>${rateEditor(k)}</div>`; });
  if (!Object.keys(settings.accounts).length) h += `<div class="note info">Loan accounts appear here automatically the first time you load a ledger for them.</div>`;
  h += `<div class="card"><h2>Prime lending rate <span class="muted">(shared by all clients${isPlatformAdmin ? '' : ' — read only'})</span></h2><div class="muted" style="margin-bottom:8px">Enter the first day the new prime rate applies. Each loan's rate is prime plus its own margin.</div>
  <table class="sm"><tr><th>Applies from</th><th>Prime</th><th></th></tr>${settings.prime.slice().sort((a, b) => a.from < b.from ? 1 : -1).map(p => { const i = settings.prime.indexOf(p); return `<tr><td><input type="date" value="${p.from}" data-a="prime" data-i="${i}" data-f="from"${dp}></td><td><input type="number" step="0.01" value="${p.rate}" data-a="prime" data-i="${i}" data-f="rate"${dp}> %</td><td>${isPlatformAdmin ? `<button class="x" data-a="prime-del" data-i="${i}">&times;</button>` : ''}</td></tr>`; }).join('')}</table>
  ${isPlatformAdmin ? `<div style="margin-top:8px"><button class="btn sec" data-a="prime-add">+ New prime rate</button></div>` : ''}</div>`;
  if (isClientAdmin()) h += `<div class="card"><h2>People with access to ${esc(client.name)}</h2><table class="sm"><tr><th>Email</th><th>Role</th><th></th></tr>${members.map(m => `<tr><td>${esc(m.email)}</td><td>${esc(m.role)}</td><td><button class="x" title="Remove" data-a="member-del" data-u="${esc(m.user_id)}">&times;</button></td></tr>`).join('')}</table>
  <div class="row" style="margin-top:10px"><input id="memail" placeholder="email of an existing user" class="w-m"><select id="mrole"><option value="staff">staff — can run &amp; edit</option><option value="viewer">viewer — read only</option><option value="admin">admin — also manages people</option></select><button class="btn sec" data-a="member-add">Give access</button></div>
  <div class="muted" style="margin-top:6px">The person must first exist as a user (Supabase → Authentication → Users → Invite user).</div>${noteHtml()}</div>`;
  return h;
}

// ======================= Sage import =======================
async function loadFiles(files) {
  notes = [];
  if (!canEdit()) { notes.push('You have view-only access, so you cannot import ledgers.'); render(); return; }
  busy = 'Reading…'; render();
  for (const f of files) {
    let text; try { text = await f.text(); } catch (e) { notes.push(`Could not read ${f.name}`); continue; }
    let accts = [];
    try { accts = /^\s*</.test(text) || /<table/i.test(text) ? E.parseSageHtml(text) : E.parseCsv(text, f.name.replace(/\.[^.]+$/, '')); } catch (e) { }
    accts = accts.filter(a => a.rows.length);
    if (!accts.length) { notes.push(`${f.name}: no ledger transactions found — expected the Sage "Account Transactions Report" export.`); continue; }
    for (const a of accts) {
      const key = E.keyOf(a.name);
      try {
        if (!settings.accounts[key]) { settings.accounts[key] = { sageName: a.name, label: a.name, descPrefix: 'Interest Loan - ' + a.name, loanAccount: '', rates: [] }; queueSave(); }
        await settle();
        const first = a.rows[0].date, last = a.rows[a.rows.length - 1].date;
        const from = a.openingDate && a.openingDate < first ? a.openingDate : first, to = a.rangeTo && a.rangeTo > last ? a.rangeTo : last;
        const l = loaded.find(x => x.cfgKey === key);
        const diff = Stmt.diffImport(l ? l.all : [], a.rows, from, to);
        reviews[key] = { file: f.name, a, diff, accept: new Set(diff.toAdd.map((_, i) => i)) };
        acctKey = key;
      } catch (e) { notes.push(`${a.name}: ${e.message}`); }
    }
    const co = accts[0].company; if (co && client && co.toLowerCase().replace(/[^a-z0-9]/g, '') !== client.name.toLowerCase().replace(/[^a-z0-9]/g, '')) notes.push(`Note: ${f.name} is for "${co}" but the selected client is "${client.name}".`);
  }
  busy = ''; render();
}
async function applyReview(key) {
  const rv = reviews[key]; const d = rv.diff; const add = d.toAdd.filter((_, i) => rv.accept.has(i));
  const res = await api.applyImport({ p_client: clientId, p_sage_key: key, p_file: rv.file, p_opening: rv.a.opening || 0, p_opening_date: rv.a.openingDate || rv.a.rows[0].date,
    p_add: add.map(r => ({ seq: r.seq, date: r.date, entity: r.entity, ref: r.ref, type: r.type, desc: r.desc, debit: r.debit, credit: r.credit, bal: r.hasBal ? r.bal : null })),
    p_match: d.toMark.map(r => r.id), p_resolve: d.resolved.map(r => r.id), p_purge: d.purge.map(r => r.id) });
  delete reviews[key]; await reloadAccount(key, rv.file);
  notes = [`Saved ${rv.a.name}: ${res.added} line${res.added === 1 ? '' : 's'} added as drafts for your approval.`];
}

// ======================= events =======================
const lineById = id => { const l = curLoaded(); return l ? l.all.find(r => r.id === +id) : null; };
async function afterChange() { await reloadAccount(acctKey); render(); }
function setRate(k, i, f, v) { const r = settings.accounts[k].rates[i]; r[f] = f === 'value' ? parseFloat(v) || 0 : v; settings.accounts[k].rates.sort((a, b) => a.from < b.from ? -1 : 1); }
document.addEventListener('submit', async e => { if (e.target.id !== 'loginform') return; e.preventDefault(); loginMsg = ''; try { await api.signIn($('#lemail').value.trim(), $('#lpass').value); } catch (er) { loginMsg = er.message; render(); } });
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-a]'); if (!t || t.tagName === 'INPUT' || t.tagName === 'SELECT') return; const a = t.dataset.a;
  try {
    if (a === 'tab') { tab = t.dataset.k; notes = []; render(); }
    else if (a === 'pick') { $('#fin').click(); }
    else if (a === 'signout') { await api.signOut(); session = null; resetAll(); render(); }
    else if (a === 'newclient-open') { newClientOpen = true; notes = []; render(); }
    else if (a === 'newclient-cancel') { newClientOpen = false; notes = []; render(); }
    else if (a === 'newclient-save') { const n = $('#ncname').value.trim(); if (!n) return; try { const id = await api.createClient(n, $('#ncshort').value.trim()); clients = await api.clients(); roles = await api.myRoles(session.user.id); newClientOpen = false; await selectClient(id); tab = 'stmt'; } catch (er) { notes = [er.message]; } render(); }
    else if (a === 'rate-add') { const rs = settings.accounts[t.dataset.k].rates; rs.push({ from: todayIso, basis: 'prime', value: rs.length ? rs[rs.length - 1].value : 2 }); queueSave(); render(); }
    else if (a === 'rate-del') { settings.accounts[t.dataset.k].rates.splice(+t.dataset.i, 1); queueSave(); render(); }
    else if (a === 'prime-add') { const top = settings.prime.slice().sort((x, y) => x.from < y.from ? 1 : -1)[0]; settings.prime.push({ from: todayIso, rate: top ? top.rate : 10 }); primeDirty = true; queueSave(); render(); }
    else if (a === 'prime-del') { settings.prime.splice(+t.dataset.i, 1); primeDirty = true; queueSave(); render(); }
    else if (a === 'imp-all') { const rv = reviews[t.dataset.k]; rv.accept = t.dataset.v === '1' ? new Set(rv.diff.toAdd.map((_, i) => i)) : new Set(); render(); }
    else if (a === 'imp-cancel') { delete reviews[t.dataset.k]; render(); }
    else if (a === 'imp-apply') { busy = 'Saving…'; render(); try { await applyReview(t.dataset.k); } catch (er) { notes = [er.message]; } busy = ''; render(); }
    else if (a === 'add-open') { addOpen = true; editId = null; render(); }
    else if (a === 'line-cancel') { addOpen = false; editId = null; render(); }
    else if (a === 'edit') { editId = +t.dataset.id; addOpen = false; render(); }
    else if (a === 'line-save') {
      const n = t.closest('.note'); const amt = parseFloat(n.querySelector('.en-amt').value), dt = n.querySelector('.en-date').value;
      if (!(amt > 0) || !dt) { notes = ['Enter a date and an amount above zero.']; render(); return; }
      const cr = n.querySelector('.en-type').value === 'credit'; const id = t.dataset.id ? +t.dataset.id : null;
      await api.saveEntry({ p_client: clientId, p_id: id, p_sage_key: acctKey, p_date: dt, p_ref: n.querySelector('.en-ref').value.trim(), p_desc: n.querySelector('.en-desc').value.trim() || (cr ? 'Advance received' : 'Payment made'), p_debit: cr ? 0 : amt, p_credit: cr ? amt : 0, p_origin: 'manual' });
      addOpen = false; editId = null; notes = []; await afterChange();
    }
    else if (a === 'del') { const r = lineById(t.dataset.id); if (!r) return; if (!window.confirm(r.inSage ? 'Delete this line? It is in Sage, so it stays flagged until Sage no longer holds it.' : 'Delete this line?')) return; await api.deleteEntry(clientId, r.id); notes = []; await afterChange(); }
    else if (a === 'revert') { await api.revertEntry(clientId, +t.dataset.id); notes = []; await afterChange(); }
    else if (a === 'approve') { await api.setApproved(clientId, [+t.dataset.id], true); notes = []; await afterChange(); }
    else if (a === 'unapprove') { await api.setApproved(clientId, [+t.dataset.id], false); notes = []; await afterChange(); }
    else if (a === 'approve-all') { const ids = curLoaded().all.filter(r => !r.removed && !r.approved).map(r => r.id); if (!ids.length) return; await api.setApproved(clientId, ids, true); notes = []; await afterChange(); }
    else if (a === 'make-drafts') await makeDrafts();
    else if (a === 'dl-journal') await dlJournal();
    else if (a === 'dl-pdf') dlPdf();
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
  else if (a === 'acct') { acctKey = t.value; editId = null; addOpen = false; }
  else if (a === 'sfrom') stmtFrom = t.value || null;
  else if (a === 'imp-row') { const rv = reviews[t.dataset.k]; const i = +t.dataset.i; if (t.checked) rv.accept.add(i); else rv.accept.delete(i); return; }
  else if (a === 'adj') { const s = adjSel[t.dataset.k] || (adjSel[t.dataset.k] = new Set()); if (t.checked) s.add(t.dataset.m); else s.delete(t.dataset.m); return; }
  else if (a === 'rate') { setRate(t.dataset.k, +t.dataset.i, t.dataset.f, t.value); queueSave(); }
  else if (a === 'prime') { const p = settings.prime[+t.dataset.i]; p[t.dataset.f] = t.dataset.f === 'rate' ? parseFloat(t.value) || 0 : t.value; settings.prime.sort((x, y) => x.from < y.from ? -1 : 1); primeDirty = true; queueSave(); }
  else if (a === 'cfg') { settings.accounts[t.dataset.k][t.dataset.f] = t.value; queueSave(); }
  else if (a === 'expacct') { settings.expenseAccount = t.value.trim(); queueSave(); }
  else if (a === 'loanacct') { settings.accounts[t.dataset.k].loanAccount = t.value.trim(); queueSave(); }
  else if (a === 'refprefix') { settings.refPrefix = t.value.trim() || 'INTJNL'; queueSave(); }
  else if (a === 'fye') { settings.fyeMonth = +t.value; queueSave(); }
  else return;
  render();
});
document.addEventListener('toggle', e => { const d = e.target; if (d && d.dataset && d.dataset.det) { if (d.open) openDet.add(d.dataset.det); else openDet.delete(d.dataset.det); } }, true);
['dragover', 'dragenter'].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.add('over'); } }));
['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { const d = e.target.closest && e.target.closest('#drop'); if (d) { e.preventDefault(); d.classList.remove('over'); if (ev === 'drop') loadFiles(Array.from(e.dataTransfer.files)); } }));

// ======================= interest routine and outputs =======================
async function makeDrafts() {
  await settle();
  const data = intData(); const usedRefs = []; loaded.forEach(l => l.all.forEach(r => { if (r.ref) usedRefs.push(r.ref); }));
  const items = data.map(d => ({ key: d.l.cfgKey, label: accLabel(d.l), cfg: d.cfg, all: d.l.all, plan: d.plan, recon: d.recon, adj: adjSel[d.l.cfgKey] || new Set() }));
  const rows = Stmt.interestDrafts(items, { asAt, refPrefix: settings.refPrefix, usedRefs, jrefs: {}, jdates: {} });
  if (!rows.length) { notes = ['Nothing to add — the interest is already posted or drafted.']; render(); return; }
  await api.addEntries(clientId, rows);
  for (const k of new Set(rows.map(r => r.sage_key))) await reloadAccount(k);
  adjSel = {}; notes = [`Done: ${rows.length} interest line${rows.length === 1 ? '' : 's'} added as drafts. Review and approve them on the Statement page.`];
  render();
}
function save(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: type || 'text/plain' });
  if (window.__SAVE_OVERRIDE) { window.__SAVE_OVERRIDE(filename, blob); return true; }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); return true;
}
async function dlJournal() {
  await settle();
  const ex = exportData(); if (!ex.csv) return;
  save(`${(client.short_name || client.name).replace(/[^\w-]+/g, '_')} Sage interest journal ${E.dmy(asAt).replace(/\//g, '-')}.csv`, ex.csv, 'text/csv');
  if (canEdit()) {
    try {
      for (const g of ex.groups) await api.logRun({ client_id: clientId, as_at: asAt, reference: g.ref, journal_date: g.date, total: E.round2(g.items.reduce((s, x) => s + Math.abs(x.amount), 0)), lines: g.items.map(x => ({ amount: x.amount, description: x.desc })) });
      await api.markExported(clientId, ex.ids); runs = await api.runs(clientId);
      for (const l of loaded.slice()) await reloadAccount(l.cfgKey);
      notes = ['Done: journal downloaded and recorded.'];
    } catch (er) { notes = ['The CSV downloaded, but recording it failed: ' + er.message]; }
    render();
  }
}
function dlPdf() {
  const l = curLoaded(); if (!l) return; const from = stmtFrom || fyStart(asAt), to = asAt;
  const st = E.buildStatement(l.acct, [], from, to); const title = accLabel(l);
  if (!window.jspdf) { notes = ['The PDF library did not load. Check your internet connection and reload.']; render(); return; }
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const M = 14, W = 210; const X = { date: M, ref: M + 21, desc: M + 52 }; const col = { deb: M + 130, cre: M + 154, bal: M + 182 };
  const maroon = [139, 26, 26], char = [52, 53, 50]; let y;
  const header = first => {
    doc.setFillColor(...maroon); doc.rect(0, 0, W, first ? 30 : 16, 'F'); doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(first ? 15 : 10);
    doc.text(first ? 'Loan account statement' : `Loan account statement - ${title}`, M, first ? 13 : 10);
    if (first) { doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.text(l.acct.company || client.name, M, 21); doc.text(`${E.dmy(from)} to ${E.dmy(to)}`, W - M, 21, { align: 'right' }); }
    doc.setTextColor(...char); y = first ? 40 : 24;
    if (first) { doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(l.acct.name, M, y); y += 8; }
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
