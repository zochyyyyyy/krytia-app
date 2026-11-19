/* Účet a rovnaký zoznam na všetkých zariadeniach (Firebase), šifrovaný kódom, ktorý pozná iba majiteľ.
   Zoznam je v databáze ako jeden dokument users/<účet>. Mená sa zašifrujú ešte v zariadení (AES-GCM, kľúč z kódu
   cez PBKDF2), takže v databáze je iba nečitateľný text; pravidlá v firestore.rules navyše púšťajú iba majiteľa
   a iba šifrovaný obsah. Kľúč sa pamätá v zariadení (IndexedDB, nedá sa z neho vytiahnuť), kód sa zadáva raz
   na každom zariadení. Appka funguje aj bez signálu: zmeny drží v zariadení a do účtu ich pošle po pripojení. */
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, connectAuthEmulator,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut,
  initializeFirestore, memoryLocalCache, connectFirestoreEmulator, doc, onSnapshot, runTransaction, serverTimestamp,
} from './vendor/firebase.js';
/* Verejné údaje webovej appky Firebase; súbor je iba vo zverejnenej verzii (pozri README). */
import config from './firebase-config.js';

const app = initializeApp(config);
const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
auth.languageCode = 'sk';
const db = initializeFirestore(app, { localCache: memoryLocalCache() });
/* Skúška na počítači proti lokálnym emulátorom: adresa s ?emu */
if (new URLSearchParams(location.search).has('emu') && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

/* ---------- šifrovanie ---------- */
const ROUNDS = 600000;
const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function derive(code, saltB64) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations: ROUNDS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(obj, k, saltB64) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(obj))));
  return JSON.stringify({ enc: 1, salt: saltB64, iv: b64(iv), ct: b64(ct) });
}
async function open(w, k) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, k, unb64(w.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/* Kľúč v zariadení: IndexedDB uchová CryptoKey bez možnosti ho exportovať. */
const idb = () => new Promise((res, rej) => {
  const r = indexedDB.open('krytia-kluc', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('k');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function keyOp(mode, fn) {
  try {
    const d = await idb();
    return await new Promise((res, rej) => { const t = d.transaction('k', mode); const q = fn(t.objectStore('k')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
  } catch (e) { return undefined; }
}
const loadKey = id => keyOp('readonly', s => s.get(id));
const storeKey = (id, k) => keyOp('readwrite', s => s.put(k, id));
const dropKeys = () => keyOp('readwrite', s => s.clear());

/* ---------- synchronizácia ---------- */
const K = window.Krytia;
let uid = null, ref = null, stop = null, timer = null, dirty = false, running = null;
let key = null, salt = null, latest = null, force = false;

function schedule(ms) {
  dirty = true;
  if (!key) return;
  K.status(navigator.onLine ? 'saving' : 'wait');
  clearTimeout(timer);
  timer = setTimeout(push, ms);
}

async function push() {
  if (!ref || !key) return;
  if (running) { await running.catch(() => {}); if (!dirty) return; }
  if (!navigator.onLine) { K.status('wait'); return; }
  dirty = false;
  const target = ref, k = key, s = salt, overwrite = force;
  running = runTransaction(db, async tx => {
    const snap = await tx.get(target);
    let merged = K.current();
    if (snap.exists() && !overwrite) {
      const w = JSON.parse(snap.data().state);
      if (w.enc && w.salt !== s) throw Object.assign(new Error('kód sa zmenil'), { code: 'krytia/code-changed' });
      merged = K.merged(w.enc ? await open(w, k) : w);
    }
    tx.set(target, { state: await seal(merged, k, s), at: serverTimestamp() });
    return merged;
  });
  try {
    const merged = await running;
    force = false;
    if (target === ref) K.absorb(merged);
    if (!dirty) K.status('ok');
  } catch (e) {
    dirty = true;
    if (e && e.code === 'krytia/code-changed') { key = null; K.needCode('changed'); return; }
    K.status('wait');
    clearTimeout(timer);
    timer = setTimeout(push, 15000);
  } finally { running = null; }
}

/* Spracuje posledný stav z účtu. */
async function handle() {
  if (!uid) return;
  if (!latest) { if (key) schedule(0); else K.needCode('new'); return; }
  const w = JSON.parse(latest);
  if (!w.enc) { K.absorb(w); if (key) schedule(0); else K.needCode('new'); return; }
  if (!key || salt !== w.salt) {
    const had = !!key;
    const k = await loadKey(`${uid}:${w.salt}`);
    if (!k) { key = null; K.needCode(had ? 'changed' : 'enter'); return; }
    key = k; salt = w.salt;
  }
  let data;
  try { data = await open(w, key); } catch (e) { key = null; K.needCode('enter'); return; }
  K.codeOk();
  const ahead = K.absorb(data);
  if (ahead || dirty) schedule(300);
  else K.status('ok');
}

onAuthStateChanged(auth, user => {
  if (stop) { stop(); stop = null; }
  ref = null; key = null; salt = null; latest = null; uid = null;
  if (!user) { K.signedOut(); return; }
  uid = user.uid;
  K.signedIn(user.uid, user.email);
  ref = doc(db, 'users', user.uid);
  stop = onSnapshot(ref, snap => {
    if (snap.metadata.hasPendingWrites) return;
    latest = snap.exists() ? snap.data().state : null;
    handle();
  }, () => K.status('wait'));
});

addEventListener('online', () => { if (dirty) push(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && dirty) push(); });

async function newKey(code) {
  const s = b64(crypto.getRandomValues(new Uint8Array(16)));
  const k = await derive(code, s);
  await storeKey(`${uid}:${s}`, k);
  key = k; salt = s;
}

window.KrytiaCloud = {
  changed: () => { if (ref) schedule(700); },
  login: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
  register: (email, pw) => createUserWithEmailAndPassword(auth, email, pw),
  reset: email => sendPasswordResetEmail(auth, email),
  logout: async () => { dirty = false; clearTimeout(timer); key = null; await dropKeys(); return signOut(auth); },
  /* Prvý kód pre účet, ktorý ešte nemá šifrovaný zoznam. */
  async setCode(code) {
    await newKey(code);
    K.codeOk(); schedule(0);
  },
  /* Kód na ďalšom zariadení. Pri zlom kóde vyhodí chybu. */
  async enterCode(code) {
    const w = JSON.parse(latest);
    const k = await derive(code, w.salt);
    try { await open(w, k); } catch (e) { throw Object.assign(new Error('zlý kód'), { code: 'krytia/wrong-code' }); }
    await storeKey(`${uid}:${w.salt}`, k);
    key = k; salt = w.salt;
    await handle();
  },
  /* Zabudnutý kód: zoznam z tohto zariadenia sa zašifruje novým kódom a nahradí zoznam v účte. */
  async resetCode(code) {
    await newKey(code);
    force = true;
    K.codeOk(); schedule(0);
  },
};
