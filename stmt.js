/* ===== Statement logic: line status, per-line interest, reconciliation, Sage import differences, journal CSV =====
   Pure functions (no DOM, no database) so they can be tested in Node. Needs engine.js loaded first. */
const Stmt = (() => {
  const E = Engine;
  const r2 = E.round2;
  const fmt = n => { const neg = n < 0; const [i, d] = Math.abs(n).toFixed(2).split('.'); return (neg ? '-' : '') + i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + d; };
  const adjMonthOf = r => { const m = /interest adjustment\s+([a-z]{3})[a-z]*\s+(\d{4})/i.exec(r.desc || ''); if (!m) return null; const i = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase()); return i < 0 ? null : m[2] + '-' + String(i + 1).padStart(2, '0'); };
  const effMonth = r => r.adjMonth || r.date.slice(0, 7);

  // ---------- rows ----------
  function fromDb(e) {
    return { id: e.id, seq: e.seq, inSage: e.in_sage !== false, approved: e.approved !== false, removed: !!e.removed,
      orig: e.sage_original || null, origin: e.origin || 'sage', exportedAt: e.exported_at || null,
      date: e.entry_date, entity: e.entity || '', ref: e.ref || '', type: e.entry_type || '', desc: e.description || '',
      debit: +e.debit, credit: +e.credit, bal: e.balance == null ? 0 : +e.balance, hasBal: e.balance != null };
  }
  const counted = r => r.approved && !r.removed;
  // posted = in Sage and counted; pending = counted but not in Sage yet; draft = made in the app, not counted;
  // imported = came from a Sage import, not counted until approved; changed = a Sage line edited in the app; removed = a Sage line deleted in the app
  function statusOf(r) {
    if (r.removed) return 'removed';
    if (r.inSage && r.orig) return 'changed';
    if (!r.approved) return r.inSage ? 'imported' : 'draft';
    return r.inSage ? 'posted' : 'pending';
  }
  const STATUS = { posted: 'In Sage', pending: 'Not in Sage yet', draft: 'Draft', imported: 'Imported draft', changed: 'Differs from Sage', removed: 'Deleted - still in Sage' };
  const byDate = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : ((a.seq || 0) - (b.seq || 0)) || ((a.id || 0) - (b.id || 0));

  // rows (all states) -> { all, acct (counted lines, ready for the engine), sageCheck }
  function build(rows, opening, name, company) {
    const all = rows.slice().sort(byDate);
    E.prepareAccount({ opening: opening || 0, rows: all });            // net / interest flags on every line, drafts included
    const acct = { name: name || '', company: company || '', opening: opening || 0, rows: all.filter(counted) };
    E.prepareAccount(acct);
    // The balance column on the export belongs to Sage's own lines, as Sage holds them.
    const sageRows = all.filter(r => r.inSage).map(r => {
      const o = r.orig; return Object.assign({}, r, o ? { date: o.date, debit: +o.debit, credit: +o.credit } : {});
    }).sort(byDate);
    const chk = { opening: opening || 0, rows: sageRows }; E.prepareAccount(chk);
    acct.balanceMismatches = chk.balanceMismatches; acct.firstMismatch = chk.firstMismatch;
    return { all, acct };
  }

  // ---------- interest for one month, split by the line that carries each day ----------
  // Same rule as the engine: interest for day d is on the balance at the close of day d-1.
  // A line owns the days from the day after its date until the next line's date; days carried in from an earlier month belong to "b/f".
  function monthInterest(acct, cfg, prime, month) {
    const ev = acct.rows.map(r => ({ d: E.dnum(r.date), net: r.net, r, ex: r.isInterest && effMonth(r) === month.month }));
    const items = new Map(); const warns = [];
    let bal = acct.opening, p = 0, owner = null, sum = 0; const startN = E.dnum(month.from);
    for (let d = startN; d <= E.dnum(month.to); d++) {
      while (p < ev.length && ev[p].d <= d - 1) { if (!ev[p].ex) bal = r2(bal + ev[p].net); owner = ev[p].r; p++; }
      const key = owner && E.dnum(owner.date) >= startN ? owner.id : 'bf';
      let it = items.get(key); if (!it) { it = { key, days: 0, raw: 0, rates: [] }; items.set(key, it); }
      it.days++;
      const rate = E.rateOn(E.iso(d), cfg, prime);
      if (rate == null) { warns.push({ t: 'norate', day: E.iso(d) }); continue; }
      const amt = (bal > 0 ? bal : 0) * rate / 100 / 365;
      it.raw += amt; sum += amt; if (!it.rates.includes(rate)) it.rates.push(rate);
    }
    items.forEach(it => { it.interest = r2(it.raw); });
    return { month: month.month, from: month.from, to: month.to, items, total: r2(sum), warns };
  }

  // The statement: months from `from` to `to`; every month starts with a b/f line and ends with its interest, posted and drafted figures.
  function statement(all, acct, cfg, prime, from, to) {
    let bal = acct.opening;
    all.forEach(r => { if (counted(r) && r.date < from) bal = r2(bal + r.net); });
    const opening = bal; const hasRates = !!(cfg && cfg.rates && cfg.rates.length);
    const months = E.monthsBetween(from, to).map(m => {
      const mi = hasRates ? monthInterest(acct, cfg, prime, m) : null;
      const lines = []; const it = k => (mi && mi.items.get(k)) || null;
      lines.push({ kind: 'bf', date: m.from, bal, item: it('bf') });
      all.forEach(r => {
        if (r.date < m.from || r.date > m.to) return;
        if (counted(r)) bal = r2(bal + r.net);
        lines.push({ kind: 'row', row: r, status: statusOf(r), bal: counted(r) ? bal : null, item: counted(r) ? it(r.id) : null });
      });
      const ints = all.filter(r => r.isInterest && !r.removed && effMonth(r) === m.month);
      const posted = r2(ints.filter(counted).reduce((s, r) => s + r.net, 0));
      const drafted = r2(ints.filter(r => !counted(r)).reduce((s, r) => s + r.net, 0));
      const calc = mi ? mi.total : null;
      return { month: m.month, from: m.from, to: m.to, lines, calc, posted, drafted, diff: calc == null ? null : r2(calc - posted - drafted), warns: mi ? mi.warns : [] };
    });
    return { opening, months, closing: bal };
  }

  // ---------- interest reconciliation ----------
  // posted = counted lines, drafted = lines waiting for approval; outstanding = what is still to be journalled.
  function reconcile(all, acct, cfg, prime, through, nMonths) {
    return E.checkPosted(acct, cfg, prime, through, nMonths).map(c => {
      const drafted = r2(all.filter(r => !counted(r) && !r.removed && r.isInterest && effMonth(r) === c.month).reduce((s, r) => s + r.net, 0));
      return Object.assign({}, c, { drafted, outstanding: r2(c.diff - drafted) });
    });
  }
  // Months that still have no interest at all (counted or drafted), worked out on the counted lines.
  function planNew(all, acct, cfg, prime, asAt, journalDates) {
    const withDrafts = { rows: all.filter(r => !r.removed) };
    const det = E.detectAccrued(withDrafts);
    const plan = E.planRun(acct, cfg, prime, asAt, { accruedThrough: det ? det.date : null, journalDates });
    return { plan, through: plan.accruedThrough };
  }

  // Draft lines for the interest routine: one line per account per month to accrue, plus an adjustment line for each month you tick.
  // items: [{ key, label, cfg, all, plan, recon, adj:Set(months) }]
  function interestDrafts(items, opts) {
    const out = []; const used = new Set(opts.usedRefs || []);
    const adjMonth = E.ym(opts.asAt);
    const base = (opts.jrefs && opts.jrefs[adjMonth]) || E.journalRef(opts.refPrefix, adjMonth);
    const adjRef = used.has(base) ? base + 'ADJ' : base;
    const adjDate = (opts.jdates && opts.jdates[adjMonth]) || E.eom(adjMonth + '-01');
    items.forEach(it => {
      it.plan.months.forEach(m => {
        if (Math.abs(m.amount) < 0.005) return;
        out.push({ sage_key: it.key, date: m.date, ref: (opts.jrefs && opts.jrefs[m.month]) || E.journalRef(opts.refPrefix, m.month), desc: m.desc,
          debit: m.amount < 0 ? -m.amount : 0, credit: m.amount > 0 ? m.amount : 0, origin: 'interest' });
      });
      (it.recon || []).forEach(c => {
        if (!it.adj.has(c.month) || Math.abs(c.outstanding) < 0.005) return;
        const [y, mo] = c.month.split('-');
        out.push({ sage_key: it.key, date: adjDate, ref: adjRef,
          desc: `Interest adjustment ${E.MONLONG[+mo - 1].slice(0, 3)} ${y} (posted ${fmt(r2(c.posted + c.drafted))}, calculated ${fmt(c.calc)}) - ${it.label}`,
          debit: c.outstanding < 0 ? -c.outstanding : 0, credit: c.outstanding > 0 ? c.outstanding : 0, origin: 'interest' });
      });
    });
    return out;
  }

  // ---------- Sage journal CSV, made from the approved interest lines that Sage does not hold yet ----------
  function journalCsv(accounts, settings) { // accounts: [{ cfg, all }]
    const groups = new Map(); const ids = [];
    accounts.forEach(a => a.all.forEach(r => {
      if (!(counted(r) && !r.inSage && r.origin === 'interest')) return;
      const k = r.ref + '|' + r.date; if (!groups.has(k)) groups.set(k, { ref: r.ref, date: r.date, desc: 'Interest on loans', items: [] });
      groups.get(k).items.push({ amount: r.net, desc: r.desc, loanAcct: a.cfg.loanAccount }); ids.push(r.id);
    }));
    const months = Array.from(groups.values()).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.ref < b.ref ? -1 : 1);
    const rows = E.journalRows(months, settings);
    return { csv: rows.length ? E.journalCsv(rows) : '', rows, groups: months, ids };
  }

  // ---------- Sage import: what is different? ----------
  // Lines are matched on date and net amount. A line you edited is still matched on what Sage held when you edited it.
  function diffImport(all, sageRows, from, to) {
    const net = (d, c) => r2(c - d);
    const key = (date, n) => date + '|' + n.toFixed(2);
    const pool = {};
    all.filter(r => r.inSage).forEach(r => {
      const k = r.orig ? key(r.orig.date, net(+r.orig.debit, +r.orig.credit)) : key(r.date, net(r.debit, r.credit));
      (pool[k] = pool[k] || []).push(r);
    });
    Object.values(pool).forEach(a => a.sort((x, y) => (x.orig ? 1 : 0) - (y.orig ? 1 : 0)));        // plain lines first
    const matched = new Set(); const unmatched = [];
    sageRows.forEach((s, n) => { const k = key(s.date, net(s.debit, s.credit)); const m = (pool[k] || []).shift(); if (m) matched.add(m.id); else unmatched.push({ s, n }); });
    const left = [].concat(...Object.values(pool));                                                  // Sage lines the app holds that this export does not
    const changedLeft = left.filter(r => r.orig && !r.removed);
    const others = all.filter(r => !r.inSage);
    const toAdd = [], toMark = [], resolved = [];
    unmatched.forEach(({ s, n }) => {
      const k = key(s.date, net(s.debit, s.credit));
      let i = changedLeft.findIndex(r => key(r.date, net(r.debit, r.credit)) === k);
      if (i >= 0) { resolved.push(changedLeft.splice(i, 1)[0]); return; }
      i = others.findIndex(r => !r.removed && key(r.date, net(r.debit, r.credit)) === k);
      if (i >= 0) { toMark.push(others.splice(i, 1)[0]); return; }
      toAdd.push(Object.assign({}, s, { seq: n }));
    });
    const inRange = r => r.date >= from && r.date <= to;
    return {
      toAdd,                                                                                          // Sage has it, the app does not
      toMark,                                                                                         // made in the app, now in Sage
      resolved,                                                                                       // edited in the app, Sage now holds the new values
      purge: left.filter(r => r.removed),                                                             // deleted in the app, Sage no longer holds it
      stillChanged: all.filter(r => r.inSage && r.orig && !r.removed && matched.has(r.id)),          // Sage still holds the old values
      stillRemoved: all.filter(r => r.removed && matched.has(r.id)),                                  // Sage still holds the line
      otherChanged: changedLeft,                                                                      // Sage holds neither the old nor the new values
      missing: left.filter(r => !r.removed && !r.orig && inRange(r)),                                 // app says it is in Sage, the export does not have it
      pending: others.filter(r => !r.removed)                                                         // still not in Sage
    };
  }

  return { fmt, fromDb, counted, statusOf, STATUS, build, monthInterest, statement, reconcile, planNew, interestDrafts, journalCsv, diffImport, effMonth, byDate };
})();
