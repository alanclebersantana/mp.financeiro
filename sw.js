/* MP Planejamento Financeiro — service worker
   Estratégia: rede primeiro, cache como rede de segurança.
   O sistema é online (Firestore), então nunca servimos dado velho quando há conexão;
   o cache existe para a casca do app abrir offline e para a instalação funcionar. */
const VERSAO = 'mp-01';
const CASCA = ['./', './index.html', './instalar.html', './mobile.html', './manifest.webmanifest',
               './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(CASCA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(nomes => Promise.all(nomes.filter(n => n !== VERSAO).map(n => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', e => { if (e.data === 'atualizar') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;                       // gravações nunca passam por aqui
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;             // Firebase, fontes e CDN vão direto à rede

  e.respondWith(
    fetch(req)
      .then(res => {
        const copia = res.clone();
        caches.open(VERSAO).then(c => c.put(req, copia)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
