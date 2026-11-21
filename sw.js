/*
 * Service worker: skrip di belakang layar yang mencegat permintaan file.
 * Tugasnya: menyimpan file aplikasi di cache supaya aplikasi tetap bisa
 * dibuka tanpa internet.
 *
 * Strategi:
 *   - File aplikasi sendiri (index.html, app.js, dll): NETWORK-FIRST.
 *     Kalau ada internet, selalu ambil versi terbaru. Kalau internet mati
 *     atau lambat (4 detik), pakai cache.
 *     PENTING: fetch memakai { cache: 'no-cache' } agar browser SELALU
 *     bertanya ke server dulu. Tanpa itu, browser boleh memakai salinan lama
 *     dari "cache HTTP" miliknya sendiri (server sederhana seperti
 *     `python -m http.server` tidak mengirim aturan cache, jadi browser
 *     menebak sendiri dan sering menyajikan file lama berjam-jam).
 *   - Library Firebase dari gstatic.com (alamatnya berversi, isinya tidak
 *     berubah): CACHE-FIRST.
 *   - Permintaan lain (database Firestore, login Google, dll) TIDAK disentuh.
 *     Jangan di-cache, karena itu data hidup.
 *
 * Saat mengubah versi aplikasi, ubah 3 tempat: VERSION di sini (dan nama
 * cache), APP_VERSION di app.js, dan "?v=" di index.html.
 */
const VERSION = '3.9.0';
const CACHE_NAME = 'harga-bengkel-v' + VERSION;

// Alamat harus sama persis dengan yang dipakai index.html dan app.js (termasuk ?v=)
const APP_FILES = [
  './',
  'index.html',
  'style.css?v=' + VERSION,
  'app.js?v=' + VERSION,
  'cloud.js?v=' + VERSION,
  'firebase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Saat dipasang: simpan semua file aplikasi, dengan melewati cache HTTP browser
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(APP_FILES.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (!response.ok) throw new Error('Gagal memuat ' + url);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

// Saat aktif: hapus cache versi lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(request, { cache: 'no-cache', signal: controller.signal });
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(cacheFirst(request));
  }
  // selain itu: biarkan lewat ke jaringan seperti biasa
});
