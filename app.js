'use strict';

/* ---------- pomôcky ---------- */
const KEY = 'krytia.v1';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const z2 = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => iso(new Date());
const diff = (a, b) => Math.round((parse(a) - parse(b)) / 864e5);
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const fmt = s => { const d = parse(s); return `${d.getDate()}. ${d.getMonth() + 1}.` + (d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''); };
const pl = (n, a, b, c) => (n === 1 ? a : n >= 2 && n <= 4 ? b : c);
const dni = n => `${n} ${pl(n, 'deň', 'dni', 'dní')}`;
const predDnami = n => (n === 0 ? 'dnes' : n === 1 ? 'včera' : `pred ${n} dňami`);
const pacientov = n => `${n} ${pl(n, 'pacient', 'pacienti', 'pacientov')}`;
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const byName = (a, b) => a.name.localeCompare(b.name, 'sk');
/* Dátum končí bodkou; na konci vety nech nie sú dve. */
const tidy = s => String(s).replace(/\.\.(?!\.)/g, '.');

/* ---------- dáta ---------- */
/* Každý lekár, zariadenie a pacient nesie čas poslednej zmeny (u). Vymazané ostávajú v „gone“,
   aby sa pri spájaní s účtom nevrátili. Tak sa zmeny z mobilu, iPadu a počítača dajú spojiť. */
const OWNER = 'krytia.owner';
const COLS = ['doctors', 'places', 'patients'];
const blank = () => ({ v: 2, doctors: [], places: [], patients: [], gone: {}, settings: { gap: 30, early: 20, u: 0 }, lastBackup: null });
const shape = d => Object.assign(blank(), d, { gone: Object.assign({}, d.gone), settings: Object.assign(blank().settings, d.settings) });
let S = load();
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.patients)) return shape(d);
  } catch (e) { /* poškodené dáta: začni načisto, nič neprepisuj, kým používateľ niečo neuloží */ }
  return blank();
}
const sig = o => { const { u, ...r } = o; return JSON.stringify(r); };
function snapshotOf(s) {
  const m = new Map();
  for (const k of COLS) for (const o of s[k]) m.set(`${k}:${o.id}`, sig(o));
  m.set('settings', JSON.stringify([s.settings.gap, s.settings.early]));
  return m;
}
let snap = snapshotOf(S);
function persist() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* plné úložisko: dáta ostanú aspoň v účte */ } }
function save() {
  const now = Date.now(), next = snapshotOf(S);
  for (const k of COLS) for (const o of S[k]) {
    const key = `${k}:${o.id}`;
    if (snap.get(key) !== next.get(key) || (S.gone[o.id] || 0) >= (o.u || 0)) { o.u = now; delete S.gone[o.id]; }
  }
  for (const key of snap.keys()) if (key !== 'settings' && !next.has(key)) S.gone[key.slice(key.indexOf(':') + 1)] = now;
  if (snap.get('settings') !== next.get('settings')) S.settings.u = now;
  snap = next;
  persist();
  if (window.KrytiaCloud) window.KrytiaCloud.changed();
}
/* Spojí dva zoznamy: z každej položky vyhrá novšia zmena, vymazanie platí, kým ju nikto neupraví neskôr. */
function merge(a, b) {
  const out = blank();
  for (const g of [a.gone, b.gone]) for (const [id, t] of Object.entries(g || {})) out.gone[id] = Math.max(out.gone[id] || 0, t);
  for (const k of COLS) {
    const m = new Map();
    for (const o of [...(a[k] || []), ...(b[k] || [])]) { const ex = m.get(o.id); if (!ex || (o.u || 0) > (ex.u || 0)) m.set(o.id, o); }
    out[k] = [...m.values()].filter(o => !((out.gone[o.id] || 0) >= (o.u || 0)));
  }
  out.settings = Object.assign(blank().settings, ((b.settings && b.settings.u) || 0) > ((a.settings && a.settings.u) || 0) ? b.settings : a.settings);
  out.lastBackup = [a.lastBackup, b.lastBackup].filter(Boolean).sort().pop() || null;
  return out;
}
const canon = s => JSON.stringify([...COLS.map(k => [...s[k]].sort((x, y) => (x.id < y.id ? -1 : 1))), Object.entries(s.gone).sort(), s.settings, s.lastBackup]);
const doctor = id => S.doctors.find(d => d.id === id);
const place = id => S.places.find(p => p.id === id);
const patient = id => S.patients.find(p => p.id === id);
const active = () => S.patients.filter(p => !p.ended);

/* Stav pacienta: due = na rade, early = skôr kvôli dovolenke, soon = čoskoro, done = má predpis */
function status(p, t = today()) {
  const { gap, early } = S.settings;
  const last = p.dates.length ? p.dates[p.dates.length - 1] : null;
  const d = doctor(p.doctorId);
  const hasVac = d && d.vacFrom && d.vacTo;
  const onVac = hasVac && t >= d.vacFrom && t <= d.vacTo;
  if (!last) return { kind: 'due', last, days: null, over: 0, frac: 1, onVac };
  const days = diff(t, last), dueDate = addDays(last, gap);
  const base = { last, days, dueDate, onVac, frac: Math.max(0.04, Math.min(1, days / gap)), left: gap - days };
  if (days >= gap) return { ...base, kind: 'due', over: days - gap };
  const vacAhead = hasVac && t < d.vacFrom && dueDate >= d.vacFrom && dueDate <= d.vacTo;
  if (days >= early && vacAhead) return { ...base, kind: 'early' };
  if (days >= early) return { ...base, kind: 'soon' };
  return { ...base, kind: 'done' };
}
function statusLine(p, s) {
  if (p.ended) return `${p.ended.reason === 'umrtie' ? 'Úmrtie' : 'Vyhojené'}, zapísané ${fmt(p.ended.date)}`;
  if (!s.last) return 'Zatiaľ bez predpisu';
  const a = `Naposledy ${fmt(s.last)}`;
  if (s.kind === 'due') return s.over > 0 ? `${a}, mešká ${dni(s.over)}` : `${a}, na rade dnes`;
  if (s.kind === 'early') return `${a}, skôr pre dovolenku`;
  if (s.kind === 'soon') return `${a}, na rade o ${dni(s.left)}`;
  return `${a}, na rade ${fmt(s.dueDate)}`;
}
const urgency = p => { const s = status(p); return s.last ? s.days : 9999; };

/* Prehľad na najbližšie dni bez mien (počty). Číta ho ranné upozornenie v telefóne, aby napísalo,
   koľko pacientov je na rade, a ikona appky ukazuje dnešný počet. */
const isDueOn = (p, t) => ['due', 'early'].includes(status(p, t).kind);
function writeSummary() {
  if (ui.locked) return;
  const days = {};
  const act = active();
  for (let i = 0; i < 21; i++) {
    const t = addDays(today(), i);
    const due = act.filter(p => isDueOn(p, t));
    days[t] = { due: due.length, late: due.filter(p => status(p, t).over > 0).length };
  }
  const n = days[today()].due;
  try { if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); } catch (e) { /* bez odznaku */ }
  if (!('caches' in window)) return;
  caches.open('krytia-prehlad').then(c => c.put('prehlad.json', new Response(JSON.stringify({ at: Date.now(), days }), { headers: { 'Content-Type': 'application/json' } }))).catch(() => {});
}

/* ---------- stav obrazovky ---------- */
const ui = { tab: 'dnes', q: '', doc: 'all', ended: false, locked: !localStorage.getItem(OWNER), mode: 'in', email: '', sync: 'ok', busy: false };
let acct = null;
let draft = { names: '', doc: null, place: null };

/* ---------- stavebné kusy ---------- */
function ring(p, s, big) {
  const r = 18, c = 2 * Math.PI * r;
  if (p.ended) return `<span class="ring ended${big ? ' big' : ''}"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="${r}"/></svg><b>–</b></span>`;
  const label = s.last ? s.days : 'nový';
  return `<span class="ring ${s.kind}${s.last ? '' : ' new'}${big ? ' big' : ''}"><svg viewBox="0 0 44 44"><circle class="bg" cx="22" cy="22" r="${r}"/>` +
    `<circle class="fg" cx="22" cy="22" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - s.frac)).toFixed(1)}"/></svg><b>${label}</b></span>`;
}
function row(p, opt = {}) {
  const s = status(p);
  const late = !p.ended && s.kind === 'due' && (s.over > 0 || !s.last);
  let meta = statusLine(p, s);
  if (opt.where) { const d = doctor(p.doctorId), pc = place(p.placeId); meta += `<br>${esc(d ? d.name : '')}${pc ? ', ' + esc(pc.name) : ''}`; }
  const quiet = s.kind === 'done' || s.kind === 'soon';
  return `<li class="row" data-id="${p.id}">
    <button type="button" class="open" data-act="open" data-id="${p.id}">
      ${ring(p, s)}
      <span class="txt"><span class="name">${esc(p.name)}</span><span class="meta${late ? ' late' : ''}">${meta}</span></span>
    </button>
    ${p.ended ? '' : `<button type="button" class="tick${quiet ? ' quiet' : ''}" data-act="tick" data-id="${p.id}" aria-label="Odfajknúť predpis, ${esc(p.name)}">Odfajknúť</button>`}
  </li>`;
}
const phoneIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.500 3.500h3l1.500 4-2 1.500a11 11 0 0 0 6 6l1.500-2 4 1.500v3a2 2 0 0 1-2.200 2A16.500 16.500 0 0 1 4.500 5.700a2 2 0 0 1 2-2.200z"/></svg>';
function placeBlock(pc, list) {
  const sub = [pc && pc.contact, pacientov(list.length)].filter(Boolean).join(', ');
  const call = pc && pc.phone
    ? `<a class="call" href="tel:${esc(pc.phone.replace(/[^\d+]/g, ''))}" aria-label="Zavolať ${esc(pc.name)}">${phoneIcon}Zavolať</a>`
    : pc ? `<button type="button" class="call" data-act="edit-place" data-id="${pc.id}">Pridať telefón</button>` : '';
  return `<section class="place">
    <div class="place-head"><div class="who"><strong>${esc(pc ? pc.name : 'Bez zariadenia')}</strong><span>${esc(sub)}</span></div>${call}</div>
    <ul>${list.map(p => row(p)).join('')}</ul>
  </section>`;
}
/* Zoznam po lekároch a zariadeniach */
function grouped(list, sorter) {
  let out = '';
  for (const d of [...S.doctors].sort(byName)) {
    const mine = list.filter(p => p.doctorId === d.id);
    if (!mine.length) continue;
    const t = today();
    const vac = d.vacFrom && d.vacTo && t <= d.vacTo
      ? `<p class="note">${tidy(t >= d.vacFrom ? `Lekár má dovolenku do ${fmt(d.vacTo)}.` : `Dovolenka ${fmt(d.vacFrom)} až ${fmt(d.vacTo)}.`)}</p>` : '';
    const groups = new Map();
    for (const p of mine) { if (!groups.has(p.placeId)) groups.set(p.placeId, []); groups.get(p.placeId).push(p); }
    const blocks = [...groups.entries()].map(([pid, l]) => ({ pc: place(pid), l: l.sort(sorter) }))
      .sort((a, b) => sorter(a.l[0], b.l[0]));
    out += `<section class="doc"><h2>${esc(d.name)} <small>${pacientov(mine.length)}</small></h2>${vac}${blocks.map(b => placeBlock(b.pc, b.l)).join('')}</section>`;
  }
  return out;
}
function docFilter(counts) {
  if (S.doctors.length < 2) return '';
  const chip = (id, label, n) => `<button type="button" class="chip" data-act="doc" data-id="${id}" aria-pressed="${ui.doc === id}">${esc(label)}${n ? ` <b>${n}</b>` : ''}</button>`;
  return `<div class="chips filter" role="group" aria-label="Lekár">${chip('all', 'Všetci', 0)}${[...S.doctors].sort(byName).map(d => chip(d.id, d.name, counts(d.id))).join('')}</div>`;
}
const searchBox = ph => `<label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.500"/><path d="M16 16l4.500 4.500"/></svg>
  <input type="search" id="q" value="${esc(ui.q)}" placeholder="${ph}" aria-label="${ph}" autocomplete="off" enterkeyhint="search"></label>`;

/* ---------- Dnes ---------- */
function vDnes() {
  const now = new Date();
  const when = now.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });
  if (!S.patients.length) {
    return `<header class="top"><p class="when">${when}</p><h1>Krytia</h1></header>
      <div class="empty"><h2>Začni prepísaním zošita</h2>
      <p>Pridaj lekára, zariadenie a mená pacientov. Appka potom každý deň ukáže, kto je na rade, a postráži, aby nikto nedostal predpis dvakrát.</p>
      <button type="button" class="btn wide" data-act="add">Pridať pacientov</button></div>`;
  }
  const isDue = p => ['due', 'early'].includes(status(p).kind);
  return `<header class="top"><p class="when">${when}</p><h1 id="headline"></h1></header>
    ${searchBox('Hľadať pacienta')}
    ${docFilter(id => active().filter(p => p.doctorId === id && isDue(p)).length)}
    <div id="list"></div>`;
}
function listDnes() {
  const inDoc = p => ui.doc === 'all' || p.doctorId === ui.doc;
  const q = norm(ui.q);
  if (q) {
    const hits = S.patients.filter(p => norm(p.name).includes(q)).sort((a, b) => !!a.ended - !!b.ended || byName(a, b));
    $('#headline').textContent = hits.length ? `Nájdení: ${hits.length}` : 'Nikto sa nenašiel';
    return hits.length ? `<ul class="plain">${hits.map(p => row(p, { where: true })).join('')}</ul>`
      : `<div class="empty"><h2>„${esc(ui.q)}“ v zozname nie je</h2><p>Skontroluj meno alebo pacienta pridaj.</p><button type="button" class="btn wide" data-act="add">Pridať pacientov</button></div>`;
  }
  const mine = active().filter(inDoc);
  const due = mine.filter(p => ['due', 'early'].includes(status(p).kind));
  const soon = mine.filter(p => status(p).kind === 'soon').sort((a, b) => urgency(b) - urgency(a));
  const n = due.length;
  $('#headline').textContent = n ? `${pacientov(n)} ${pl(n, 'je', 'sú', 'je')} na rade` : 'Dnes nie je nikto na rade';
  const late = due.filter(p => status(p).over > 0).length;
  const doneToday = mine.filter(p => p.dates.includes(today())).length;
  let html = `<div class="stats" aria-label="Prehľad dňa">
    <div class="stat${late ? ' bad' : ''}"><b>${late}</b><span>mešká</span></div>
    <div class="stat"><b>${n - late}</b><span>na rade dnes</span></div>
    <div class="stat${doneToday ? ' good' : ''}"><b>${doneToday}</b><span>hotové dnes</span></div></div>`;
  if (n) html += grouped(due, (a, b) => urgency(b) - urgency(a) || byName(a, b));
  else {
    const next = mine.filter(p => status(p).last).sort((a, b) => urgency(b) - urgency(a))[0];
    html += `<div class="empty"><h2>Všetci majú predpis</h2><p>${next ? tidy(`Najbližšie je na rade ${esc(next.name)}, ${fmt(status(next).dueDate)}.`) : 'Zatiaľ tu nie je žiadny pacient tohto lekára.'}</p></div>`;
  }
  if (soon.length) html += `<details class="more"${ui.soonOpen ? ' open' : ''}><summary>Čoskoro na rade (${soon.length})</summary><ul class="plain">${soon.map(p => row(p, { where: true })).join('')}</ul></details>`;
  return html;
}

/* ---------- Pacienti ---------- */
function vPacienti() {
  const act = active(), end = S.patients.filter(p => p.ended);
  const head = `<div class="bar-top"><header class="top"><h1>Pacienti</h1><p class="sub">${pacientov(act.length)}${end.length ? `, ukončených ${end.length}` : ''}</p></header>
    <button type="button" class="btn small" data-act="add">Pridať</button></div>`;
  if (!S.patients.length) return head + `<div class="empty"><h2>Zatiaľ žiadni pacienti</h2><p>Prepíš mená zo zošita, stačí raz.</p><button type="button" class="btn wide" data-act="add">Pridať pacientov</button></div>`;
  const sw = end.length ? `<div class="chips filter" role="group" aria-label="Zobraziť">
    <button type="button" class="chip" data-act="ended" data-v="0" aria-pressed="${!ui.ended}">Aktívni <b>${act.length}</b></button>
    <button type="button" class="chip" data-act="ended" data-v="1" aria-pressed="${ui.ended}">Ukončení <b>${end.length}</b></button></div>` : '';
  return head + searchBox('Hľadať pacienta') + sw + `<div id="list"></div>`;
}
function listPacienti() {
  const q = norm(ui.q);
  let list = S.patients.filter(p => !!p.ended === (ui.ended && S.patients.some(x => x.ended)));
  if (q) list = S.patients.filter(p => norm(p.name).includes(q));
  if (!list.length) return `<div class="empty"><h2>Nikto sa nenašiel</h2><p>Skontroluj meno alebo pacienta pridaj.</p></div>`;
  return q ? `<ul class="plain">${list.sort(byName).map(p => row(p, { where: true })).join('')}</ul>` : grouped(list, byName);
}

/* ---------- Lekári ---------- */
function vLekari() {
  const t = today();
  const docs = [...S.doctors].sort(byName).map(d => {
    const mine = active().filter(p => p.doctorId === d.id);
    const ok = mine.filter(p => { const s = status(p); return s.last && s.days < S.settings.gap; }).length;
    const vac = d.vacFrom && d.vacTo && t <= d.vacTo ? `Dovolenka ${fmt(d.vacFrom)} až ${fmt(d.vacTo)}` : 'Bez dovolenky';
    return `<button type="button" class="card tap" data-act="edit-doc" data-id="${d.id}">
      <span class="line"><strong class="h">${esc(d.name)}</strong><span class="meta">${ok} z ${mine.length} má predpis</span></span>
      <span class="prog" aria-hidden="true"><i style="width:${mine.length ? Math.round(ok / mine.length * 100) : 0}%"></i></span>
      <span class="meta below">${vac}</span></button>`;
  }).join('');
  const places = [...S.places].sort(byName).map(pc => {
    const n = active().filter(p => p.placeId === pc.id).length;
    return `<button type="button" class="card tap" data-act="edit-place" data-id="${pc.id}">
      <span class="line"><strong class="h">${esc(pc.name)}</strong><span class="meta">${pacientov(n)}</span></span>
      <span class="meta below">${esc([pc.contact, pc.phone].filter(Boolean).join(', ') || 'Bez telefónu')}</span></button>`;
  }).join('');
  return `<header class="top"><h1>Lekári a zariadenia</h1></header>
    ${docs || '<p class="quiet-note">Zatiaľ žiadny lekár.</p>'}
    <button type="button" class="btn ghost wide gap-top" data-act="edit-doc">Pridať lekára</button>
    <section class="sect"><h2>Zariadenia</h2><p>ADOS-ky a domovy dôchodcov. S telefónom sa dá volať jedným ťuknutím.</p>
      ${places || '<p class="quiet-note">Zatiaľ žiadne zariadenie.</p>'}<button type="button" class="btn ghost wide" data-act="edit-place">Pridať zariadenie</button></section>`;
}

/* ---------- Nastavenia ---------- */
const VERSION = '2026.11.20';
const TIMES = ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'];

/* Ranné upozornenia: telefón si od služby Krytia (Cloudflare) vypýta upozornenie v zvolenom čase.
   Služba dostane iba adresu upozornení telefónu a čas, žiadne mená. */
const PUSH_KEY = 'krytia.push';
const PUSH_URL = 'https://krytia-push.r-palocsanyi.workers.dev';
/* Verejný kľúč upozornení vydá odosielač (/health), v zdroji nie je kvôli kontrole tajomstiev. */
let vapidKey = null;
async function vapid() {
  if (!vapidKey) { const r = await fetch(PUSH_URL + '/health'); vapidKey = (await r.json()).key; }
  if (!vapidKey) throw new Error('server');
  return vapidKey;
}
function pushPrefs() {
  const d = { on: false, time: '07:00', days: 'work' };
  try { return Object.assign(d, JSON.parse(localStorage.getItem(PUSH_KEY))); } catch (e) { return d; }
}
const savePush = p => { try { localStorage.setItem(PUSH_KEY, JSON.stringify({ on: p.on, time: p.time, days: p.days })); } catch (e) { /* nič */ } };
function pushState() {
  const p = pushPrefs();
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let support = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'yes' : 'no';
  if (ios && !standalone) support = 'install';
  const perm = support === 'yes' ? Notification.permission : 'default';
  return { ...p, on: p.on && perm === 'granted', support, denied: perm === 'denied' };
}
const u8 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function pushSub(create) {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub && create) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(await vapid()) });
  return sub;
}
async function pushPost(path, sub, extra) {
  const r = await fetch(PUSH_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: sub.toJSON(), ...extra }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error('server');
  return j;
}
async function pushRegister(p) { await pushPost('/sub', await pushSub(true), { time: p.time, days: p.days }); }
async function pushOff() {
  const sub = await pushSub(false).catch(() => null);
  if (sub) { await pushPost('/unsub', sub).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
}
async function pushRun(fn) {
  ui.pushBusy = true; ui.pushErr = ''; render(true);
  try { await fn(); }
  catch (e) { ui.pushErr = e && e.message === 'denied' ? 'Upozornenia sú v telefóne zakázané. Povoľ ich v Nastaveniach telefónu pri Krytii.' : 'Nepodarilo sa. Skontroluj pripojenie a skús to znova.'; }
  ui.pushBusy = false; render(true);
}
function vNastavenia() {
  const t = today(), P = pushState();
  const bk = S.lastBackup ? `Naposledy ${fmt(S.lastBackup)}, ${predDnami(diff(t, S.lastBackup))}.` : 'Záloha ešte nebola urobená.';
  const sync = { ok: 'Uložené v účte, zašifrované', wait: 'Bez pripojenia, uloží sa neskôr', saving: 'Ukladá sa…' }[ui.sync];
  let push;
  if (P.support === 'install') {
    push = `<div class="group"><div class="item col"><strong>Najprv pridaj Krytiu na plochu</strong>
      <span class="meta">Upozornenia na iPhone a iPade fungujú iba v appke na ploche: v Safari ťukni na Zdieľať a potom Pridať na plochu. Potom Krytiu otvor z plochy.</span></div></div>`;
  } else if (P.support === 'no') {
    push = `<div class="group"><div class="item col"><strong>Toto zariadenie upozornenia nepodporuje</strong>
      <span class="meta">Namiesto nich si pridaj pripomienku do kalendára.</span>
      <button type="button" class="btn ghost wide" data-act="ics">Pridať pripomienku do kalendára</button></div></div>`;
  } else {
    const on = P.on;
    push = `<div class="group">
      <div class="item"><span class="lbl"><strong>Ranné upozornenie</strong><span class="meta">${on ? `Každý ${P.days === 'all' ? 'deň' : 'pracovný deň'} o ${P.time.replace(/^0/, '')}: koľko pacientov je na rade.` : P.denied ? 'Upozornenia sú v telefóne zakázané. Povoľ ich v Nastaveniach telefónu pri Krytii.' : 'Telefón ráno pripomenie, koľko pacientov je na rade.'}</span></span>
        <button type="button" class="switch" role="switch" aria-checked="${on}" aria-label="Ranné upozornenie" data-act="push-toggle"${ui.pushBusy ? ' disabled' : ''}><i></i></button></div>
      ${on ? `<div class="item col"><span class="lbl"><strong>Čas</strong></span>
        <div class="chips times" role="group" aria-label="Čas upozornenia">${TIMES.map(x => `<button type="button" class="chip" data-act="push-time" data-v="${x}" aria-pressed="${P.time === x}">${x.replace(/^0/, '')}</button>`).join('')}</div></div>
      <div class="item"><span class="lbl"><strong>Aj cez víkend</strong></span>
        <button type="button" class="switch" role="switch" aria-checked="${P.days === 'all'}" aria-label="Upozornenie aj cez víkend" data-act="push-days"${ui.pushBusy ? ' disabled' : ''}><i></i></button></div>
      <div class="item"><button type="button" class="textbtn" data-act="push-test"${ui.pushBusy ? ' disabled' : ''}>Poslať skúšobné upozornenie</button></div>` : ''}
      <p class="err" role="alert">${esc(ui.pushErr || '')}</p></div>`;
  }
  const step = (name, v, label, hint) => `<div class="item"><span class="lbl"><strong>${label}</strong><span class="meta">${hint}</span></span>
    <span class="stepper"><button type="button" data-act="rule" data-k="${name}" data-d="-1" aria-label="Menej dní">−</button><b>${v}</b><button type="button" data-act="rule" data-k="${name}" data-d="1" aria-label="Viac dní">+</button></span></div>`;
  return `<header class="top"><h1>Nastavenia</h1></header>
    <section class="sect first"><h2>Upozornenia</h2>${push}</section>
    <section class="sect"><h2>Pravidlá</h2><div class="group">
      ${step('gap', S.settings.gap, 'Ďalší predpis po', `dňoch od posledného`)}
      ${step('early', S.settings.early, 'Pred dovolenkou po', `dňoch, keď lekár odchádza`)}
    </div></section>
    <section class="sect"><h2>Účet</h2><div class="group">
      <div class="item col"><strong>${esc(acct ? acct.email : '')}</strong><span class="meta sync ${ui.sync}">${sync}</span>
        <span class="meta">Zoznam je zašifrovaný tvojím kódom. Rovnaký ho uvidíš v mobile, na iPade aj na počítači.</span></div>
      <div class="item"><button type="button" class="textbtn danger" data-act="logout">Odhlásiť sa</button></div>
    </div></section>
    <section class="sect"><h2>Záloha do súboru</h2><div class="group">
      <div class="item col"><span class="meta">Navyše, pre istotu. ${bk}</span>
        <div class="pair"><button type="button" class="btn ghost" data-act="backup">Uložiť zálohu</button><button type="button" class="btn ghost" data-act="restore">Obnoviť</button></div></div>
      <input type="file" id="file" accept="application/json,.json" hidden></div></section>
    <p class="version">Krytia, verzia ${VERSION}</p>`;
}

/* ---------- prihlásenie ---------- */
function vLogin() {
  const make = ui.mode === 'new';
  return `<header class="top login-top"><img src="icons/icon.svg" alt="" width="56" height="56"><h1>Krytia</h1>
      <p class="sub">Prihlás sa a zoznam pacientov uvidíš rovnako v mobile, na iPade aj na počítači.</p></header>
    <button type="button" class="btn wide google" data-act="google"${ui.busy ? ' disabled' : ''}>
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 2.9-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 6.9-10.1 6.9-17.5z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-2.9-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>
      Pokračovať cez Google</button>
    <button type="button" class="btn wide apple" data-act="apple"${ui.busy ? ' disabled' : ''}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9-.1 0-2.7-1-2.7-4.1zM13.9 4.9c.7-.9 1.2-2 1.1-3.2-1 0-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.1 1.1.1 2.3-.6 3-1.5z"/></svg>
      Pokračovať cez Apple</button>
    <p class="err google-err" role="alert">${esc(ui.googleErr || '')}</p>
    <p class="same">Prihlasuj sa vždy rovnako. Google, Apple a e-mail sú tri rôzne účty, každý s vlastným zoznamom.</p>
    ${ui.mailOpen || make ? '' : '<button type="button" class="btn ghost wide mail-open" data-act="mail">Prihlásiť sa e-mailom a heslom</button>'}
    <div${ui.mailOpen || make ? '' : ' hidden'}>
    <p class="or"><span>e-mailom a heslom</span></p>
    <form data-form="login" class="login" novalidate>
      <label class="field"><span>E-mail</span><input type="email" name="email" value="${esc(ui.email)}" autocomplete="username" inputmode="email" autocapitalize="off" spellcheck="false" required></label>
      <label class="field"><span>Heslo${make ? '<span class="hint">Aspoň 6 znakov. Zapíš si ho.</span>' : ''}</span>
        <input type="password" name="password" autocomplete="${make ? 'new-password' : 'current-password'}" required></label>
      <p class="err" role="alert"></p>
      <button type="submit" class="btn wide"${ui.busy ? ' disabled' : ''}>${ui.busy ? 'Chvíľu…' : make ? 'Vytvoriť účet' : 'Prihlásiť sa'}</button>
    </form>
    <div class="login-more">
      <button type="button" class="textbtn" data-act="mode">${make ? 'Už mám účet, prihlásiť sa' : 'Nemám účet, vytvoriť nový'}</button>
      ${make ? '' : '<button type="button" class="textbtn" data-act="reset">Zabudnuté heslo</button>'}
    </div></div>`;
}
const authMsg = c => ({
  'auth/invalid-credential': 'E-mail alebo heslo nesedí.', 'auth/wrong-password': 'E-mail alebo heslo nesedí.', 'auth/user-not-found': 'E-mail alebo heslo nesedí.',
  'auth/email-already-in-use': 'Tento e-mail už účet má. Prihlás sa.', 'auth/weak-password': 'Heslo musí mať aspoň 6 znakov.',
  'auth/invalid-email': 'Skontroluj e-mail.', 'auth/missing-password': 'Napíš heslo.', 'auth/network-request-failed': 'Nie je pripojenie na internet.',
  'auth/too-many-requests': 'Priveľa pokusov. Skús to o chvíľu.',
  'auth/account-exists-with-different-credential': 'Tento e-mail už má účet s heslom. Prihlás sa e-mailom a heslom.',
  'auth/popup-blocked': 'Prehliadač zablokoval okno prihlásenia. Skús to znova.',
  'krytia/apple': 'Prihlásenie cez Apple sa nepodarilo. Skús to znova.',
  'krytia/apple-wait': 'Apple prihlásenie sa ešte načítava. Ťukni o chvíľu znova.',
}[c] || 'Nepodarilo sa. Skús to znova.');
async function submitLogin(f) {
  const email = f.email.value.trim(), pw = f.password.value, err = f.querySelector('.err');
  ui.email = email;
  if (!email || !email.includes('@')) { err.textContent = 'Napíš e-mail.'; return; }
  if (!pw) { err.textContent = 'Napíš heslo.'; return; }
  if (!window.KrytiaCloud) { err.textContent = 'Nie je pripojenie na internet.'; return; }
  ui.busy = true; render();
  try { await (ui.mode === 'new' ? window.KrytiaCloud.register(email, pw) : window.KrytiaCloud.login(email, pw)); }
  catch (e) {
    ui.busy = false; render();
    const f2 = $('form[data-form=login]');
    f2.querySelector('.err').textContent = authMsg(e && e.code);
    if (e && e.code === 'auth/email-already-in-use') { ui.mode = 'in'; render(); $('form[data-form=login] .err').textContent = authMsg(e.code); }
  }
}

/* ---------- šifrovací kód ---------- */
function vCode() {
  const top = (h, p) => `<header class="top login-top"><img src="icons/icon.svg" alt="" width="56" height="56"><h1>${h}</h1><p class="sub">${p}</p></header>`;
  if (ui.code === 'wait') return top('Krytia', 'Načítava sa zoznam z účtu…');
  const fresh = ui.code === 'new' || ui.code === 'reset';
  const head = {
    new: top('Šifrovací kód', 'Mená pacientov sa zašifrujú ešte v tomto zariadení. Bez kódu ich neprečíta nikto, ani Google, ani správca appky.'),
    reset: top('Nový šifrovací kód', `Zoznam z tohto zariadenia (${pacientov(S.patients.length)}) sa zašifruje novým kódom a nahradí zoznam v účte.`),
    enter: top('Zadaj šifrovací kód', 'Zoznam v účte je zašifrovaný. Kód stačí zadať raz na každom zariadení.'),
    changed: top('Kód sa zmenil', 'Na inom zariadení bol nastavený nový šifrovací kód. Zadaj nový kód.'),
  }[ui.code];
  return `${head}
    <form data-form="code" class="login" novalidate>
      <input type="email" name="username" value="${esc(acct ? acct.email : '')}" autocomplete="username" hidden>
      <label class="field"><span>Kód${fresh ? '<span class="hint">Aspoň 6 znakov. Zapíš si ho na papier: keď sa zabudne, zoznam sa nedá obnoviť.</span>' : ''}</span>
        <input type="password" name="code" autocomplete="${fresh ? 'new-password' : 'current-password'}" autocapitalize="off" spellcheck="false" required></label>
      ${fresh ? '<label class="field"><span>Kód znova</span><input type="password" name="code2" autocomplete="new-password" autocapitalize="off" spellcheck="false" required></label>' : ''}
      <p class="err" role="alert"></p>
      <button type="submit" class="btn wide"${ui.busy ? ' disabled' : ''}>${ui.busy ? 'Chvíľu…' : fresh ? 'Nastaviť kód' : 'Odomknúť'}</button>
    </form>
    <div class="login-more">
      ${fresh ? (ui.code === 'reset' ? '<button type="button" class="textbtn" data-act="code-back">Skúsiť znova starý kód</button>' : '')
        : '<button type="button" class="textbtn" data-act="code-forgot">Zabudnutý kód</button>'}
      <button type="button" class="textbtn" data-act="logout">Odhlásiť sa</button>
    </div>`;
}
async function submitCode(f) {
  const code = f.code.value, err = f.querySelector('.err');
  const fresh = ui.code === 'new' || ui.code === 'reset';
  if (code.length < 6) { err.textContent = 'Kód musí mať aspoň 6 znakov.'; return; }
  if (fresh && code !== f.code2.value) { err.textContent = 'Kódy sa nezhodujú. Napíš ich znova.'; f.code2.value = ''; f.code2.focus(); return; }
  if (!window.KrytiaCloud) { err.textContent = 'Nie je pripojenie na internet.'; return; }
  const mode = ui.code;
  ui.busy = true; render();
  try {
    await (mode === 'new' ? window.KrytiaCloud.setCode(code) : mode === 'reset' ? window.KrytiaCloud.resetCode(code) : window.KrytiaCloud.enterCode(code));
    ui.busy = false;
  } catch (e) {
    ui.busy = false; render();
    $('form[data-form=code] .err').textContent = e && e.code === 'krytia/wrong-code' ? 'Kód nesedí. Skús ho znova.' : 'Nepodarilo sa. Skús to znova.';
  }
}

/* ---------- vykreslenie ---------- */
function render(keepScroll) {
  const y = window.scrollY;
  const view = $('#view');
  document.body.classList.toggle('locked', ui.locked || !!ui.code);
  if (ui.locked) { view.innerHTML = vLogin(); window.scrollTo(0, 0); return; }
  if (ui.code) { view.innerHTML = vCode(); window.scrollTo(0, 0); return; }
  view.innerHTML = { dnes: vDnes, pacienti: vPacienti, lekari: vLekari, nastavenia: vNastavenia }[ui.tab]();
  writeSummary();
  renderList();
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === ui.tab ? 'page' : 'false'));
  window.scrollTo(0, keepScroll ? y : 0);
}
function renderList() {
  const el = $('#list');
  if (!el) return;
  el.innerHTML = ui.tab === 'dnes' ? listDnes() : listPacienti();
}

/* ---------- hárky ---------- */
const sheet = $('#sheet'), askBox = $('#ask');
function openSheet(html) {
  sheet.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
function closeSheet() { if (sheet.open) sheet.close(); }
const head = t => `<div class="sheet-head"><h2 id="sheet-title">${t}</h2><button type="button" class="x" data-act="close" aria-label="Zavrieť">×</button></div>`;
for (const d of [sheet, askBox]) d.addEventListener('click', e => { if (e.target === d) d.close('cancel'); });

/* Otázka s bezpečnou hlavnou voľbou. Vráti true iba pri voľbe „go“. */
function ask({ title, text, safe, go, danger }) {
  return new Promise(res => {
    askBox.innerHTML = `<h2 id="ask-title">${esc(tidy(title))}</h2><p>${esc(tidy(text))}</p>
      <div class="stack"><button type="button" class="btn wide" value="safe" autofocus>${esc(safe)}</button>
      <button type="button" class="btn wide ${danger ? 'danger' : 'ghost'}" value="go">${esc(go)}</button></div>`;
    askBox.onclose = () => res(false);
    askBox.querySelectorAll('button').forEach(b => b.onclick = () => { res(b.value === 'go'); askBox.close(); });
    askBox.showModal();
  });
}

let toastT;
function toast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Vrátiť</button>' : ''}`;
  if (undo) el.querySelector('button').onclick = () => { undo(); el.classList.remove('on'); };
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), undo ? 7000 : 3500);
}

/* ---------- odfajknutie predpisu ---------- */
async function tick(id, date = today()) {
  const p = patient(id);
  if (!p || p.ended) return;
  if (p.dates.includes(date)) { toast(`${p.name} už má ${date === today() ? 'dnešok' : fmt(date)} zapísaný`); return; }
  const { gap, early } = S.settings;
  const prev = [...p.dates].filter(d => d < date).pop();
  if (prev) {
    const days = diff(date, prev), s = status(p);
    if (days < early) {
      const go = await ask({
        title: `Ešte nie. Predpis bol ${predDnami(days)}.`,
        text: `${p.name}: naposledy ${fmt(prev)}. Ďalší predpis najskôr ${fmt(addDays(prev, gap))}, pred dovolenkou lekára ${fmt(addDays(prev, early))}.`,
        safe: 'Nechať tak', go: 'Zapísať aj tak', danger: true,
      });
      if (!go) return;
    } else if (days < gap && !(date === today() && s.kind === 'early')) {
      const go = await ask({
        title: `Do ${gap} dní chýba ${dni(gap - days)}`,
        text: `${p.name}: naposledy ${fmt(prev)}. Skôr posielaj iba vtedy, keď ide lekár na dovolenku.`,
        safe: 'Počkať', go: 'Zapísať skôr',
      });
      if (!go) return;
    }
  }
  const apply = () => {
    p.dates.push(date); p.dates.sort(); save();
    closeSheet(); render(true);
    toast(`${p.name}: zapísané ${date === today() ? 'dnes' : fmt(date)}`, () => { p.dates = p.dates.filter(d => d !== date); save(); render(true); });
  };
  const li = sheet.open ? null : document.querySelector(`.row[data-id="${id}"]`);
  const leaves = li && ui.tab === 'dnes' && !norm(ui.q) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (leaves) { li.classList.add('leaving'); setTimeout(apply, 330); } else apply();
}

/* ---------- detail pacienta ---------- */
function openPatient(id) {
  const p = patient(id); if (!p) return;
  const s = status(p), d = doctor(p.doctorId), pc = place(p.placeId);
  let big, small;
  if (p.ended) { big = p.ended.reason === 'umrtie' ? 'Úmrtie' : 'Vyhojené'; small = `Zapísané ${fmt(p.ended.date)}. Už sa neponúka.`; }
  else if (!s.last) { big = 'Na rade'; small = 'Zatiaľ bez predpisu. Over a pošli lekárovi.'; }
  else if (s.kind === 'due') { big = 'Na rade'; small = `Naposledy ${fmt(s.last)}, ${predDnami(s.days)}.` + (s.over ? ` Mešká ${dni(s.over)}.` : ''); }
  else if (s.kind === 'early') { big = 'Pošli skôr'; small = `Naposledy ${fmt(s.last)}. Lekár ide na dovolenku ${fmt(d.vacFrom)}.`; }
  else if (s.kind === 'soon') { big = `Ešte ${dni(s.left)}`; small = `Naposledy ${fmt(s.last)}. Na rade ${fmt(s.dueDate)}.`; }
  else { big = 'Ešte nie'; small = `Predpis ${fmt(s.last)}, ${predDnami(s.days)}. Na rade ${fmt(s.dueDate)}.`; }
  const call = pc && pc.phone ? `<a class="call" href="tel:${esc(pc.phone.replace(/[^\d+]/g, ''))}">${phoneIcon}Zavolať</a>` : '';
  const hist = [...p.dates].reverse().map(dt => `<li><span>${fmt(dt)}</span><button type="button" class="textbtn danger" data-act="unwrite" data-id="${p.id}" data-date="${dt}">Zrušiť</button></li>`).join('');
  openSheet(`${head(esc(p.name))}
    <div class="hero ${p.ended ? '' : s.kind}">${ring(p, s, true)}<div><strong>${big}</strong><span>${tidy(small)}</span></div></div>
    ${p.ended
      ? `<button type="button" class="btn wide" data-act="revive" data-id="${p.id}">Vrátiť medzi aktívnych</button>`
      : `<button type="button" class="btn wide" data-act="tick" data-id="${p.id}">Odfajknúť dnešný predpis</button>`}
    <div class="facts">
      <div><span class="k">Lekár</span><span class="v">${esc(d ? d.name : '–')}</span></div>
      <div><span class="k">Zariadenie</span><span class="v">${esc(pc ? pc.name : '–')}${pc && pc.contact ? `<br><span class="k">${esc(pc.contact)}</span>` : ''}</span>${call}</div>
      ${p.note ? `<div><span class="k">Poznámka</span><span class="v">${esc(p.note)}</span></div>` : ''}
    </div>
    ${p.ended ? '' : `<form data-form="other-day" data-id="${p.id}"><label class="field"><span>Predpis bol v iný deň</span>
      <div class="pair"><input type="date" name="date" max="${today()}" required><button type="submit" class="btn ghost">Zapísať deň</button></div></label><p class="err"></p></form>`}
    ${hist ? `<h3 class="sub-h">Zapísané predpisy</h3><ul class="hist">${hist}</ul>` : ''}
    ${p.ended ? '' : `<h3 class="sub-h">Už nedostáva krytie</h3><div class="pair">
      <button type="button" class="btn ghost" data-act="end" data-id="${p.id}" data-reason="vyhojene">Vyhojené</button>
      <button type="button" class="btn ghost" data-act="end" data-id="${p.id}" data-reason="umrtie">Úmrtie</button></div>`}
    <button type="button" class="btn ghost wide" style="margin-top:22px" data-act="edit-patient" data-id="${p.id}">Upraviť meno, lekára, zariadenie</button>`);
}
const options = (list, sel) => [...list].sort(byName).map(o => `<option value="${o.id}"${o.id === sel ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
function editPatient(id) {
  const p = patient(id);
  openSheet(`${head('Upraviť pacienta')}<form data-form="patient" data-id="${p.id}">
    <label class="field"><span>Meno</span><input type="text" name="name" value="${esc(p.name)}" autocomplete="off" required></label>
    <label class="field"><span>Lekár</span><select name="doc">${options(S.doctors, p.doctorId)}</select></label>
    <label class="field"><span>Zariadenie</span><select name="place">${options(S.places, p.placeId)}</select></label>
    <label class="field"><span>Poznámka</span><input type="text" name="note" value="${esc(p.note || '')}" autocomplete="off"></label>
    <p class="err"></p>
    <div class="stack"><button type="submit" class="btn wide">Uložiť zmeny</button>
    <button type="button" class="btn danger wide" data-act="del-patient" data-id="${p.id}">Vymazať pacienta</button></div></form>`);
}

/* ---------- pridanie pacientov ---------- */
function radios(name, list, sel, newLabel) {
  const c = (v, label, on) => `<label class="chip"><input type="radio" name="${name}" value="${v}"${on ? ' checked' : ''}><span>${esc(label)}</span></label>`;
  return `<div class="chips"${list.length ? '' : ' hidden'}>${[...list].sort(byName).map(o => c(o.id, o.name, o.id === sel)).join('')}${c('new', newLabel, !list.length || sel === 'new')}</div>`;
}
function openAdd() {
  const doc = draft.doc || (ui.doc !== 'all' ? ui.doc : null) || (S.doctors.length === 1 ? S.doctors[0].id : null);
  const pl2 = draft.place || (S.places.length === 1 ? S.places[0].id : null);
  openSheet(`${head('Pridať pacientov')}<form data-form="add" novalidate>
    <fieldset><legend>Lekár</legend>${radios('doc', S.doctors, doc, 'Nový lekár')}
      <label class="reveal"><span>Meno nového lekára</span><input type="text" name="docNew" autocomplete="off"></label><p class="err" data-err="doc"></p></fieldset>
    <fieldset><legend>Zariadenie<span class="hint">ADOS-ka alebo domov dôchodcov, odkiaľ pacienti sú</span></legend>${radios('place', S.places, pl2, 'Nové zariadenie')}
      <label class="reveal"><span>Názov nového zariadenia</span><input type="text" name="placeNew" autocomplete="off"></label><p class="err" data-err="place"></p></fieldset>
    <label class="field"><span>Mená pacientov<span class="hint">Každé meno na nový riadok</span></span>
      <textarea name="names" autocomplete="off" autocapitalize="words" spellcheck="false">${esc(draft.names)}</textarea><p class="err" data-err="names"></p></label>
    <fieldset><legend>Kedy dostali posledný predpis</legend>
      <div class="chips">
        <label class="chip"><input type="radio" name="when" value="none" checked><span>Ešte nie</span></label>
        <label class="chip"><input type="radio" name="when" value="today"><span>Dnes</span></label>
        <label class="chip"><input type="radio" name="when" value="date"><span>Iný deň</span></label>
      </div>
      <label class="reveal"><span>Deň posledného predpisu</span><input type="date" name="date" max="${today()}"></label><p class="err" data-err="when"></p></fieldset>
    <button type="submit" class="btn wide" id="add-go">Pridať pacientov</button></form>`);
  countNames();
}
const namesOf = v => v.split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
function countNames() {
  const ta = $('#sheet textarea[name=names]'); if (!ta) return;
  const n = namesOf(ta.value).length;
  $('#add-go').textContent = n ? `Pridať ${n} ${pl(n, 'pacienta', 'pacientov', 'pacientov')}` : 'Pridať pacientov';
}
async function submitAdd(f) {
  const v = Object.fromEntries(new FormData(f));
  const err = (k, m) => { f.querySelector(`[data-err=${k}]`).textContent = m; };
  ['doc', 'place', 'names', 'when'].forEach(k => err(k, ''));
  let bad = false;
  const names = namesOf(v.names || '');
  if (!v.doc || (v.doc === 'new' && !v.docNew.trim())) { err('doc', v.doc === 'new' ? 'Napíš meno lekára.' : 'Vyber lekára.'); bad = true; }
  if (!v.place || (v.place === 'new' && !v.placeNew.trim())) { err('place', v.place === 'new' ? 'Napíš názov zariadenia.' : 'Vyber zariadenie.'); bad = true; }
  if (!names.length) { err('names', 'Napíš aspoň jedno meno.'); bad = true; }
  if (v.when === 'date' && !v.date) { err('when', 'Vyber deň.'); bad = true; }
  if (bad) { const first = [...f.querySelectorAll('.err')].find(e => e.textContent); first.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }

  const seen = new Set();
  const uniq = names.filter(n => !seen.has(norm(n)) && seen.add(norm(n)));
  const dups = uniq.filter(n => S.patients.some(p => norm(p.name) === norm(n)));
  let list = uniq;
  if (dups.length) {
    const ex = S.patients.find(p => norm(p.name) === norm(dups[0]));
    const keep = await ask({
      title: dups.length === 1 ? `${dups[0]} už v zozname je` : `${dups.length} mená už v zozname sú`,
      text: `${dups.slice(0, 4).join(', ')}${dups.length > 4 ? ' a ďalší' : ''}. ${ex.name} patrí k lekárovi ${doctor(ex.doctorId)?.name || '–'}. Dvakrát zapísaný pacient môže dostať predpis dvakrát.`,
      safe: 'Preskočiť rovnaké mená', go: 'Pridať aj tak',
    });
    if (!keep) list = uniq.filter(n => !dups.includes(n));
  }
  let docId = v.doc, placeId = v.place;
  if (docId === 'new') {
    const ex = S.doctors.find(d => norm(d.name) === norm(v.docNew));
    docId = ex ? ex.id : uid();
    if (!ex) S.doctors.push({ id: docId, name: v.docNew.trim(), vacFrom: '', vacTo: '' });
  }
  if (placeId === 'new') {
    const ex = S.places.find(p => norm(p.name) === norm(v.placeNew));
    placeId = ex ? ex.id : uid();
    if (!ex) S.places.push({ id: placeId, name: v.placeNew.trim(), contact: '', phone: '' });
  }
  const date = v.when === 'today' ? today() : v.when === 'date' ? v.date : null;
  for (const name of list) S.patients.push({ id: uid(), name, doctorId: docId, placeId, dates: date ? [date] : [], ended: null, note: '' });
  save();
  draft = { names: '', doc: docId, place: placeId };
  closeSheet(); render();
  toast(list.length ? `Pridaní: ${list.length}` : 'Nikto nový nepribudol');
}

/* ---------- lekár a zariadenie ---------- */
function editDoc(id) {
  const d = id ? doctor(id) : { name: '', vacFrom: '', vacTo: '' };
  const n = id ? S.patients.filter(p => p.doctorId === id).length : 0;
  openSheet(`${head(id ? 'Upraviť lekára' : 'Pridať lekára')}<form data-form="doc" data-id="${id || ''}">
    <label class="field"><span>Meno lekára</span><input type="text" name="name" value="${esc(d.name)}" autocomplete="off" required></label>
    <fieldset><legend>Dovolenka<span class="hint">Pacientov, ktorým predpis vyjde na dovolenku, ponúkne appka skôr.</span></legend>
      <div class="pair"><label class="reveal" style="display:block;margin:0"><span>Od</span><input type="date" name="vacFrom" value="${d.vacFrom || ''}"></label>
      <label class="reveal" style="display:block;margin:0"><span>Do</span><input type="date" name="vacTo" value="${d.vacTo || ''}"></label></div></fieldset>
    <p class="err"></p>
    <div class="stack"><button type="submit" class="btn wide">${id ? 'Uložiť zmeny' : 'Pridať lekára'}</button>
    ${id && (d.vacFrom || d.vacTo) ? `<button type="button" class="btn ghost wide" data-act="clear-vac" data-id="${id}">Zrušiť dovolenku</button>` : ''}
    ${id ? (n ? `<p class="meta" style="color:var(--muted);font-size:15px">Lekár má ${pacientov(n)}, preto sa nedá vymazať.</p>` : `<button type="button" class="btn danger wide" data-act="del-doc" data-id="${id}">Vymazať lekára</button>`) : ''}</div></form>`);
}
function editPlace(id) {
  const pc = id ? place(id) : { name: '', contact: '', phone: '' };
  const n = id ? S.patients.filter(p => p.placeId === id).length : 0;
  openSheet(`${head(id ? 'Upraviť zariadenie' : 'Pridať zariadenie')}<form data-form="place" data-id="${id || ''}">
    <label class="field"><span>Názov<span class="hint">Napríklad ADOS alebo domov dôchodcov a obec</span></span><input type="text" name="name" value="${esc(pc.name)}" autocomplete="off" required></label>
    <label class="field"><span>Komu volať</span><input type="text" name="contact" value="${esc(pc.contact)}" autocomplete="off"></label>
    <label class="field"><span>Telefón</span><input type="tel" name="phone" value="${esc(pc.phone)}" inputmode="tel" autocomplete="off"></label>
    <p class="err"></p>
    <div class="stack"><button type="submit" class="btn wide">${id ? 'Uložiť zmeny' : 'Pridať zariadenie'}</button>
    ${id ? (n ? `<p class="meta" style="color:var(--muted);font-size:15px">Zariadenie má ${pacientov(n)}, preto sa nedá vymazať.</p>` : `<button type="button" class="btn danger wide" data-act="del-place" data-id="${id}">Vymazať zariadenie</button>`) : ''}</div></form>`);
}

/* ---------- záloha a pripomienka ---------- */
function download(name, type, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function backup() {
  S.lastBackup = today(); save();
  const name = `krytia-zaloha-${today()}.json`, text = JSON.stringify(S, null, 1);
  try {
    const file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Záloha Krytia' }); render(true); return; }
  } catch (e) { if (e.name === 'AbortError') { render(true); return; } }
  download(name, 'application/json', text);
  render(true); toast('Záloha uložená medzi stiahnuté súbory');
}
async function restore(file) {
  let d;
  try { d = JSON.parse(await file.text()); } catch (e) { d = null; }
  if (!d || !Array.isArray(d.patients) || !Array.isArray(d.doctors) || !Array.isArray(d.places)) { toast('Tento súbor nie je záloha z tejto appky'); return; }
  const go = await ask({
    title: 'Nahradiť zoznam zálohou?',
    text: `V zozname je teraz ${pacientov(S.patients.length)}. Záloha ich má ${d.patients.length}${d.lastBackup ? ` a je z ${fmt(d.lastBackup)}` : ''}. Terajší zoznam sa prepíše.`,
    safe: 'Nechať terajší zoznam', go: 'Nahradiť zálohou', danger: true,
  });
  if (!go) return;
  /* Záloha nahrádza zoznam aj v účte: jej položky dostanú čas teraz, čo v nej nie je, sa vymaže. */
  const keep = S.gone;
  S = shape(d);
  S.gone = Object.assign({}, keep);
  for (const k of COLS) for (const o of S[k]) o.u = 0;
  save();
  const now = Date.now();
  for (const k of COLS) for (const o of S[k]) { o.u = now; delete S.gone[o.id]; }
  S.settings.u = now;
  snap = snapshotOf(S); persist(); if (window.KrytiaCloud) window.KrytiaCloud.changed();
  ui.doc = 'all'; render(); toast('Zoznam je obnovený zo zálohy');
}
function ics() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  const stamp = `${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}`;
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Krytia//SK', 'BEGIN:VEVENT', 'UID:krytia-ranna-pripomienka@krytia',
    `DTSTAMP:${stamp}T000000Z`, `DTSTART:${stamp}T070000`, 'DURATION:PT10M', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'SUMMARY:Krytia: kto je dnes na rade', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Krytia: kto je dnes na rade', 'TRIGGER:PT0M',
    'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  download('krytia-pripomienka.ics', 'text/calendar', text);
  toast('Otvor stiahnutý súbor a potvrď pridanie do kalendára');
}

/* ---------- udalosti ---------- */
const acts = {
  tab: b => { ui.tab = b.dataset.tab; ui.q = ''; render(); },
  doc: b => { ui.doc = b.dataset.id; render(true); },
  ended: b => { ui.ended = b.dataset.v === '1'; render(true); },
  open: b => openPatient(b.dataset.id),
  tick: b => tick(b.dataset.id),
  add: () => openAdd(),
  close: () => closeSheet(),
  'edit-patient': b => editPatient(b.dataset.id),
  'edit-doc': b => editDoc(b.dataset.id),
  'edit-place': b => editPlace(b.dataset.id),
  backup, ics,
  restore: () => $('#file').click(),
  unwrite: async b => {
    const p = patient(b.dataset.id), dt = b.dataset.date;
    const go = await ask({ title: `Zrušiť predpis z ${fmt(dt)}?`, text: `${p.name} bude znova na rade podľa predchádzajúceho predpisu. Hodí sa, keď systém lekára predpis nepustil.`, safe: 'Nechať zapísaný', go: 'Zrušiť predpis', danger: true });
    if (!go) return;
    p.dates = p.dates.filter(d => d !== dt); save(); render(true); openPatient(p.id);
  },
  end: b => {
    const p = patient(b.dataset.id);
    p.ended = { reason: b.dataset.reason, date: today() }; save(); closeSheet(); render(true);
    toast(`${p.name}: ${b.dataset.reason === 'umrtie' ? 'úmrtie' : 'vyhojené'}, už sa neponúka`, () => { p.ended = null; save(); render(true); });
  },
  revive: b => { const p = patient(b.dataset.id); p.ended = null; save(); closeSheet(); render(true); toast(`${p.name} je späť medzi aktívnymi`); },
  'del-patient': async b => {
    const p = patient(b.dataset.id);
    const go = await ask({ title: `Vymazať ${p.name}?`, text: 'Zmizne aj so zapísanými predpismi. Pri úmrtí alebo vyhojení pacienta radšej ukonči, zostane v histórii.', safe: 'Nechať', go: `Vymazať ${p.name}`, danger: true });
    if (!go) return;
    S.patients = S.patients.filter(x => x !== p); save(); closeSheet(); render(true); toast(`${p.name}: vymazané`);
  },
  'del-doc': b => { S.doctors = S.doctors.filter(d => d.id !== b.dataset.id); if (ui.doc === b.dataset.id) ui.doc = 'all'; save(); closeSheet(); render(true); },
  'del-place': b => { S.places = S.places.filter(p => p.id !== b.dataset.id); save(); closeSheet(); render(true); },
  google: () => acts.social('google'),
  apple: () => acts.social('apple'),
  social: async which => {
    if (!window.KrytiaCloud) { ui.googleErr = 'Nie je pripojenie na internet.'; render(); return; }
    ui.googleErr = ''; ui.busy = true; render();
    try { await window.KrytiaCloud[which](); }
    catch (e) {
      ui.busy = false;
      ui.googleErr = e && ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code) ? '' : authMsg(e && e.code);
      render();
    }
  },
  mode: () => { ui.email = ($('form[data-form=login] input[name=email]') || {}).value || ui.email; ui.mode = ui.mode === 'new' ? 'in' : 'new'; render(); },
  reset: async () => {
    const f = $('form[data-form=login]'), email = f.email.value.trim(), err = f.querySelector('.err');
    if (!email || !email.includes('@')) { err.textContent = 'Najprv napíš e-mail, na ktorý pošleme odkaz na nové heslo.'; f.email.focus(); return; }
    if (!window.KrytiaCloud) { err.textContent = 'Nie je pripojenie na internet.'; return; }
    try { await window.KrytiaCloud.reset(email); toast(`Ak účet existuje, na ${email} prišiel odkaz na nové heslo`); }
    catch (e) { err.textContent = authMsg(e && e.code); }
  },
  'push-toggle': () => {
    const p = pushPrefs();
    if (pushState().on) { pushRun(async () => { await pushOff(); savePush({ ...p, on: false }); toast('Ranné upozornenie je vypnuté'); }); return; }
    /* Povolenie sa musí vypýtať hneď v ťuknutí, inak ho iPhone nezobrazí. */
    const perm = Notification.requestPermission();
    pushRun(async () => {
      if (await perm !== 'granted') throw new Error('denied');
      await pushRegister(p); savePush({ ...p, on: true }); writeSummary();
      toast(`Ranné upozornenie je zapnuté na ${p.time.replace(/^0/, '')}`);
    });
  },
  'push-time': b => { const p = { ...pushPrefs(), time: b.dataset.v }; savePush(p); pushRun(() => pushRegister(p)); },
  'push-days': () => { const p0 = pushPrefs(), p = { ...p0, days: p0.days === 'all' ? 'work' : 'all' }; savePush(p); pushRun(() => pushRegister(p)); },
  'push-test': () => pushRun(async () => { await pushPost('/test', await pushSub(true)); toast('Skúšobné upozornenie príde o pár sekúnd'); }),
  rule: b => {
    const k = b.dataset.k, s = { ...S.settings };
    s[k] = Math.min(120, Math.max(1, s[k] + Number(b.dataset.d)));
    if (k === 'early' && s.early > s.gap) s.early = s.gap;
    if (k === 'gap' && s.early > s.gap) s.early = s.gap;
    S.settings = { ...S.settings, gap: s.gap, early: s.early }; save(); render(true);
  },
  mail: () => { ui.mailOpen = true; render(); const f = $('form[data-form=login] input[name=email]'); if (f) f.focus(); },
  'code-forgot': async () => {
    const n = S.patients.length;
    const go = await ask({
      title: 'Nastaviť nový kód?',
      text: n
        ? `Bez starého kódu sa zoznam v účte nedá otvoriť. Nový kód zašifruje zoznam z tohto zariadenia (${pacientov(n)}) a ten nahradí zoznam v účte. Ostatné zariadenia budú pýtať nový kód a ich zoznamy sa potom pridajú.`
        : 'Na tomto zariadení zatiaľ nie je žiadny zoznam. Nový kód začne s prázdnym zoznamom a ten v účte sa nahradí. Ak má zoznam iné zariadenie, nastav nový kód radšej tam.',
      safe: 'Skúsiť znova starý kód', go: 'Nastaviť nový kód', danger: true,
    });
    if (!go) return;
    ui.code = 'reset'; render();
  },
  'code-back': () => { ui.code = 'enter'; render(); },
  logout: async () => {
    const pending = ui.sync !== 'ok';
    const go = await ask({
      title: 'Odhlásiť sa na tomto zariadení?',
      text: pending ? 'Niektoré zmeny ešte nie sú v účte, chýba pripojenie. Po odhlásení sa stratia.' : 'Zoznam ostane v účte. Na tomto zariadení sa ukáže znova po prihlásení.',
      safe: 'Nechať tak', go: 'Odhlásiť sa', danger: pending,
    });
    if (!go) return;
    localStorage.removeItem(OWNER); localStorage.removeItem(KEY);
    /* Odhlásené zariadenie už nemá dostávať ranné upozornenia ani ukazovať počet na ikone. */
    if (pushState().support === 'yes') pushOff().catch(() => {});
    savePush({ ...pushPrefs(), on: false });
    try { if ('caches' in window) caches.delete('krytia-prehlad'); if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {}); } catch (e) { /* nič */ }
    S = blank(); snap = snapshotOf(S); acct = null; ui.locked = true; ui.code = null; ui.mode = 'in'; ui.mailOpen = false; ui.tab = 'dnes';
    render();
    if (window.KrytiaCloud) window.KrytiaCloud.logout();
  },
  'clear-vac': b => { const d = doctor(b.dataset.id); d.vacFrom = d.vacTo = ''; save(); closeSheet(); render(true); toast('Dovolenka zrušená'); },
};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && acts[b.dataset.act]) acts[b.dataset.act](b);
});
document.addEventListener('input', e => {
  if (e.target.id === 'q') { ui.q = e.target.value; renderList(); }
  if (e.target.name === 'names') { draft.names = e.target.value; countNames(); }
  const err = e.target.closest('fieldset, .field, form')?.querySelector('.err');
  if (err) err.textContent = '';
});
document.addEventListener('toggle', e => { if (e.target.matches && e.target.matches('details.more')) ui.soonOpen = e.target.open; }, true);
document.addEventListener('change', e => { if (e.target.id === 'file' && e.target.files[0]) { restore(e.target.files[0]); e.target.value = ''; } });

const forms = {
  login: submitLogin,
  code: submitCode,
  add: submitAdd,
  'other-day': f => tick(f.dataset.id, f.date.value),
  patient: f => {
    const p = patient(f.dataset.id), name = f.name.value.replace(/\s+/g, ' ').trim();
    if (!name) { f.querySelector('.err').textContent = 'Napíš meno.'; return; }
    Object.assign(p, { name, doctorId: f.doc.value, placeId: f.place.value, note: f.note.value.trim() });
    save(); closeSheet(); render(true); toast('Zmeny uložené');
  },
  doc: f => {
    const name = f.name.value.trim(), a = f.vacFrom.value, b = f.vacTo.value, err = f.querySelector('.err');
    if (!name) { err.textContent = 'Napíš meno lekára.'; return; }
    if (!!a !== !!b) { err.textContent = 'Pri dovolenke vyplň oba dni, od aj do.'; return; }
    if (a && b < a) { err.textContent = 'Dovolenka končí skôr, než začína.'; return; }
    if (f.dataset.id) Object.assign(doctor(f.dataset.id), { name, vacFrom: a, vacTo: b });
    else S.doctors.push({ id: uid(), name, vacFrom: a, vacTo: b });
    save(); closeSheet(); render(true); toast(f.dataset.id ? 'Zmeny uložené' : 'Lekár pridaný');
  },
  place: f => {
    const name = f.name.value.trim();
    if (!name) { f.querySelector('.err').textContent = 'Napíš názov zariadenia.'; return; }
    const v = { name, contact: f.contact.value.trim(), phone: f.phone.value.trim() };
    if (f.dataset.id) Object.assign(place(f.dataset.id), v); else S.places.push({ id: uid(), ...v });
    save(); closeSheet(); render(true); toast(f.dataset.id ? 'Zmeny uložené' : 'Zariadenie pridané');
  },
};
document.addEventListener('submit', e => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  forms[f.dataset.form](f);
});

/* Deň sa môže zmeniť, kým je appka otvorená na pozadí. */
let shownDay = today();
document.addEventListener('visibilitychange', () => { if (!document.hidden && shownDay !== today()) { shownDay = today(); render(true); } });

/* Most k účtu: cloud.js sem hlási prihlásenie a zoznam z účtu, appka mu hlási zmeny. */
window.Krytia = {
  signedIn(uid, email) {
    const owner = localStorage.getItem(OWNER);
    if (owner && owner !== uid) { S = blank(); snap = snapshotOf(S); persist(); }
    localStorage.setItem(OWNER, uid);
    acct = { email };
    const was = ui.locked;
    ui.locked = false; ui.busy = false;
    if (was) { ui.code = 'wait'; ui.tab = 'dnes'; render(); } else if (ui.tab === 'nastavenia' && !sheet.open) render(true);
  },
  signedOut() {
    if (localStorage.getItem(OWNER)) { localStorage.removeItem(OWNER); localStorage.removeItem(KEY); S = blank(); snap = snapshotOf(S); }
    acct = null; ui.locked = true; ui.code = null; ui.busy = false; render();
  },
  /* Účet potrebuje šifrovací kód: new = prvý raz, enter = ďalšie zariadenie, changed = kód sa zmenil inde. */
  needCode(mode) {
    if (ui.code === 'reset' || ui.busy) return;
    if (ui.code !== mode) { if (sheet.open) closeSheet(); if (askBox.open) askBox.close(); ui.code = mode; render(); }
  },
  codeOk() {
    if (!ui.code) return;
    ui.code = null; ui.busy = false; render();
  },
  loginError(code) {
    if (!ui.locked || !code) return;
    ui.busy = false; ui.googleErr = authMsg(code); render();
  },
  current: () => S,
  merged: remote => merge(S, shape(remote)),
  /* Prevezme zoznam z účtu. Vráti true, keď má toto zariadenie niečo, čo v účte ešte nie je. */
  absorb(remote) {
    const r = shape(remote), m = merge(S, r);
    if (canon(m) !== canon(S)) {
      S = m; snap = snapshotOf(S); persist();
      if (!ui.locked && !sheet.open && !askBox.open) render(true);
      else if (!ui.locked) renderList();
    }
    return canon(m) !== canon(r);
  },
  status(s) {
    if (ui.sync === s) return;
    ui.sync = s;
    const el = $('.sync');
    if (el && ui.tab === 'nastavenia' && !ui.locked && !sheet.open) render(true);
  },
};

if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) navigator.serviceWorker.register('sw.js');
/* Ťuknutie na upozornenie otvorí appku na obrazovke Dnes. */
if (new URLSearchParams(location.search).get('z') === 'upozornenie') ui.tab = 'dnes';
render();
