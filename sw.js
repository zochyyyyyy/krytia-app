/* Appka funguje aj bez signálu: súbory sa uložia do telefónu a na pozadí sa obnovujú.
   Zobrazuje aj ranné upozornenie: počet pacientov na rade si spočíta z prehľadu, ktorý appka uložila
   do telefónu (iba počty, žiadne mená). */
const CACHE = 'krytia-6';
const KEEP = ['krytia-prehlad'];
const FILES = ['./', 'index.html', 'app.css', 'app.js', 'cloud.js', 'firebase-config.js', 'vendor/firebase.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || fresh;
  }));
});

const z2 = n => String(n).padStart(2, '0');
const isoNow = () => { const d = new Date(); return `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}`; };
const pac = n => `${n} ${n === 1 ? 'pacient' : n >= 2 && n <= 4 ? 'pacienti' : 'pacientov'}`;

async function morningText() {
  try {
    const r = await (await caches.open('krytia-prehlad')).match('prehlad.json');
    const day = r && (await r.json()).days[isoNow()];
    if (!day) return 'Otvor Krytiu a pozri, kto je dnes na rade.';
    if (!day.due) return 'Dnes nie je nikto na rade.';
    return `${pac(day.due)} ${day.due === 1 ? 'je' : day.due <= 4 ? 'sú' : 'je'} na rade${day.late ? `, z toho ${day.late} mešká` : ''}.`;
  } catch (e) { return 'Otvor Krytiu a pozri, kto je dnes na rade.'; }
}

self.addEventListener('push', e => {
  let kind = 'morning';
  try { kind = e.data.json().kind || kind; } catch (err) { /* prázdne upozornenie */ }
  e.waitUntil((async () => {
    const body = kind === 'test' ? 'Skúšobné upozornenie. Takto ti ráno pripomeniem, kto je na rade.' : await morningText();
    await self.registration.showNotification('Krytia', {
      body, tag: kind === 'test' ? 'krytia-test' : 'krytia-rano', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      data: { url: './?z=upozornenie' },
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { await c.focus(); return; } }
    await self.clients.openWindow(e.notification.data && e.notification.data.url || './');
  })());
});
