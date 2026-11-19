/* Účet a rovnaký zoznam na všetkých zariadeniach (Firebase).
   Zoznam je v databáze ako jeden dokument users/<účet>; pravidlá v firestore.rules púšťajú ku nemu iba jeho majiteľa.
   Appka funguje aj bez signálu: zmeny drží v zariadení a do účtu ich pošle, keď sa pripojí. */
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
if (new URLSearchParams(location.search).has('emu') && ['localhost', '127.0.0.1'].includes(location.hostname)) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const K = window.Krytia;
let ref = null, stop = null, timer = null, dirty = false, running = null;

function schedule(ms) {
  dirty = true;
  K.status(navigator.onLine ? 'saving' : 'wait');
  clearTimeout(timer);
  timer = setTimeout(push, ms);
}

async function push() {
  if (!ref) return;
  if (running) { await running.catch(() => {}); if (!dirty) return; }
  if (!navigator.onLine) { K.status('wait'); return; }
  dirty = false;
  const target = ref;
  running = runTransaction(db, async tx => {
    const s = await tx.get(target);
    const merged = s.exists() ? K.merged(JSON.parse(s.data().state)) : K.current();
    tx.set(target, { state: JSON.stringify(merged), at: serverTimestamp() });
    return merged;
  });
  try {
    const merged = await running;
    if (target === ref) K.absorb(merged);
    if (!dirty) K.status('ok');
  } catch (e) {
    dirty = true;
    K.status('wait');
    clearTimeout(timer);
    timer = setTimeout(push, 15000);
  } finally { running = null; }
}

onAuthStateChanged(auth, user => {
  if (stop) { stop(); stop = null; }
  ref = null;
  if (!user) { K.signedOut(); return; }
  K.signedIn(user.uid, user.email);
  ref = doc(db, 'users', user.uid);
  stop = onSnapshot(ref, snap => {
    if (snap.metadata.hasPendingWrites) return;
    if (!snap.exists()) { schedule(0); return; }
    const ahead = K.absorb(JSON.parse(snap.data().state));
    if (ahead) schedule(300);
    else if (!dirty) K.status('ok');
  }, () => K.status('wait'));
});

addEventListener('online', () => { if (dirty) push(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && dirty) push(); });

window.KrytiaCloud = {
  changed: () => { if (ref) schedule(700); },
  login: (email, pw) => signInWithEmailAndPassword(auth, email, pw),
  register: (email, pw) => createUserWithEmailAndPassword(auth, email, pw),
  reset: email => sendPasswordResetEmail(auth, email),
  logout: () => { dirty = false; clearTimeout(timer); return signOut(auth); },
};
