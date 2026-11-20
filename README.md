# Imada Motor

Aplikasi web (PWA) untuk daftar harga dan totalan di bengkel. Jalan di HP Android lewat Chrome, bisa di-install ke layar utama, dan tetap bisa dibuka tanpa internet.

Tanpa framework dan tanpa build tool: HTML, CSS, dan JavaScript biasa, supaya semua yang terjadi bisa dibaca dan dipahami.

Dua mode penyimpanan, dipilih otomatis:

- **Lokal** (bawaan): data di dalam HP. Dipakai selama `firebase-config.js` belum diisi.
- **Cloud**: data di Firebase dengan login Google. Aktif setelah kamu mengikuti `SETUP-FIREBASE.md`.

## Fitur

- Daftar harga: tambah, edit, hapus, cari (semua kata yang diketik harus cocok, mis. "oli 0.8"). Ketuk satu barang untuk mengedit.
- Totalan: cari lalu ketuk barang, atur jumlah, ubah harga untuk transaksi itu saja, atau tambah barang manual.
- Totalan dan cetak meniru nota kertas (kolom Banyaknya, Nama Barang, Harga, Jumlah) dengan isian pelanggan, jenis motor, dan plat. Cetak untuk printer kecil 58/80 mm atau A4, bisa disimpan jadi PDF.
- Stok: tiap barang boleh punya stok (kosong = tidak dihitung, cocok untuk jasa). Stok berkurang otomatis saat nota dicetak, dan bertambah lewat "Tambah stok" di dialog barang. Semua perubahan tercatat di Riwayat → Stok.
- Draft nota: isi halaman Buat Nota bisa disimpan dulu dan dilanjutkan nanti. Stok baru berkurang saat nota dicetak.
- QRIS: gambar QRIS diunggah di Pengaturan, lalu ditampilkan ke pelanggan lewat tombol QRIS di halaman Buat Nota.
- Riwayat nota: setiap nota yang dicetak tersimpan. Bisa dilihat, dicetak ulang, disalin ke totalan, atau dihapus.
- Ramah mata: tombol A- / A+ (6 tingkat ukuran), kontras tinggi, tombol besar.
- Cloud: data otomatis tersimpan, bisa dipakai offline, status sinkron di bar atas.
- Mode lokal: tombol "Simpan cadangan" satu langkah, plus pengingat tiap 7 hari.

## Isi folder

| File | Fungsi |
|---|---|
| `index.html` | Kerangka halaman: layar login, Beranda, menu samping, halaman, dialog, area struk |
| `style.css` | Tampilan (mobile-first, satuan rem) dan aturan cetak `@media print` |
| `app.js` | Logika aplikasi (9 bagian, lihat daftar isi di atas file) |
| `cloud.js` | Penyimpanan cloud (Firebase Auth + Firestore), dimuat hanya di mode cloud |
| `firebase-config.js` | Tempat menaruh konfigurasi Firebase |
| `firestore.rules` | Aturan keamanan database (ditempel di konsol Firebase) |
| `sw.js` | Service worker: cache file supaya jalan offline |
| `manifest.webmanifest` | Data agar bisa di-install (nama, ikon, warna) |
| `icons/` | Ikon aplikasi |
| `contoh-backup.json` | Data contoh untuk mencoba fitur masukkan data |
| `SETUP-FIREBASE.md` | Langkah membuat proyek Firebase |

## Teknologi yang dipakai (dan di mana melihatnya)

| Teknologi | Dipakai untuk | Lihat di |
|---|---|---|
| Pola adapter | `app.js` tidak peduli data di lokal atau cloud, keduanya punya fungsi yang sama | `app.js` komentar paling atas, bagian 2 |
| IndexedDB | Penyimpanan mode lokal | `app.js` bagian 2 |
| Firebase Authentication | Login Google | `cloud.js` (`onUser`, `signIn`) |
| Cloud Firestore | Database cloud, realtime lewat `onSnapshot` | `cloud.js` |
| Firestore offline cache | Tulis tanpa internet, tersinkron otomatis | `cloud.js` (`persistentLocalCache`, komentar di atas file) |
| Aturan keamanan Firestore | Satu akun hanya bisa akses datanya sendiri | `firestore.rules` |
| ES module + `import()` dinamis | Memuat Firebase hanya saat dibutuhkan | `app.js` fungsi `init`, `cloud.js` |
| Service Worker + Cache API | Offline; strategi network-first | `sw.js` |
| Web App Manifest | Bisa di-install seperti aplikasi | `manifest.webmanifest` |
| `<dialog>` | Form dan detail nota sebagai pop-up | `index.html`, `app.js` bagian 3, 4, 6 |
| `@media print` dan `@page` | Layout struk dan ukuran kertas | `style.css` paling bawah, `app.js` bagian 5 |
| rem dan custom property CSS | Ukuran font yang bisa diatur | `style.css`, `app.js` bagian 8 |
| Web Share API, Blob | Kirim dan unduh file cadangan | `app.js` bagian 7 |
| DOM tanpa `innerHTML` (fungsi `h`) | Membuat elemen dengan aman | `app.js` bagian 1 |

## Langkah-langkah

### 1. Coba di laptop (Windows)

Di cmd, masuk ke folder hasil ekstrak (`cd /d D:\lokasi\bengkel-harga`), lalu:

```
py -m http.server 8000
```

Buka `http://localhost:8000` di Chrome. Jangan buka `index.html` dengan klik dua kali, karena service worker dan modul hanya jalan di `localhost` atau `https`.

Coba: Pengaturan, Pengaturan lainnya, Masukkan data dari file cadangan, pilih `contoh-backup.json`. Lalu coba Totalan dan Cetak, lihat tab Riwayat.

**Kalau perubahan tidak terlihat setelah mengganti file** (misalnya tombol A+ tidak bekerja): kemungkinan besar Chrome menyajikan file lama dari cache. `python -m http.server` tidak mengirim aturan cache, jadi Chrome menebak sendiri dan bisa memakai file lama berjam-jam. Langkah pasti:

1. Tutup semua tab `localhost:8000`.
2. Buka `http://localhost:8000`, tekan **F12**, tab **Application**, **Service workers**, klik **Unregister**.
3. Tab **Application**, **Storage**, klik **Clear site data**.
4. Tab **Network**, centang **Disable cache** (selama DevTools terbuka), lalu tekan **Ctrl+Shift+R**.
5. Buka Pengaturan, Pengaturan lainnya, lihat panel **Diagnosa**: `app.js` dan `style.css` harus bertuliskan versi terbaru (3.7.0). Kalau salah satunya beda atau "TIDAK ADA", folder yang dilayani server bukan folder hasil ekstrak terbaru.

**Saat mengubah kode sendiri**, naikkan nomor versi di 3 tempat supaya semua browser pasti mengambil file baru: `VERSION` di `sw.js`, `APP_VERSION` di `app.js`, dan `?v=` di `index.html` (dua tempat) serta `--css-version` di `style.css`.

### 2. Pasang cloud

Ikuti `SETUP-FIREBASE.md`.

### 3. Taruh di internet (gratis)

HP butuh alamat `https` supaya bisa di-install dan jalan offline:

- **GitHub Pages**: buat repo, upload semua isi folder, Settings, Pages, pilih branch `main`.
- **Netlify Drop** (`app.netlify.com/drop`): seret folder ke halaman itu.

Setelah dapat alamatnya, tambahkan ke **Authorized domains** di Firebase (langkah 6 di `SETUP-FIREBASE.md`).

### 4. Install di HP ibumu

1. Buka alamat tadi di Chrome Android.
2. Menu titik tiga, **Instal aplikasi**.
3. Buka sekali saat ada internet, lalu login Google (mode cloud).

## Urutan membedah kode

1. `index.html`: lihat struktur tab dan dialog.
2. `app.js` bagian 1 (helper), terutama fungsi `h` dan `matches`.
3. Bagian 2 (penyimpanan lokal), lalu `cloud.js`. Bandingkan: fungsi yang sama, isi berbeda.
4. Bagian 3, 4, dan 6: alur "data berubah, pendengar dipanggil, `render...`, layar".
5. Bagian 9 (`init`, `startCloud`): bagaimana mode dan login dipilih.
6. Bagian 5 (cetak) bersama `@media print` di `style.css`.
7. `sw.js` dan `manifest.webmanifest`.

Latihan: tambah kolom "satuan" di barang, perbarui format cadangan, lalu perbarui aturan dan tampilan.

## Yang sudah diuji, dan yang belum

- Mode lokal diuji otomatis di Chromium dengan layar HP: impor, cari, tambah/edit/hapus, totalan, cetak, riwayat, font, cadangan, dan membuka ulang saat offline.
- Mode cloud diuji terhadap **Firebase tiruan** yang meniru fungsi yang dipakai `cloud.js`. Itu membuktikan logika aplikasi, bukan bahwa Firebase asli menerimanya. Uji pertama dengan proyek Firebase sungguhan masih harus kamu lakukan.
- Cache: diuji dengan server Python dan service worker bahwa file yang diganti langsung terbaca (`cache: 'no-cache'` di `sw.js`).
- Belum diuji di HP Android asli maupun dengan printer sungguhan.
- Printer thermal Bluetooth kadang butuh aplikasi pencetak tambahan di Android.

## Ide pengembangan

- Keranjang totalan belum tersimpan kalau halaman ditutup.
- Riwayat: filter per tanggal, total harian.
- Berbagi data antar akun yang berbeda (butuh model data "toko" dengan daftar anggota).
- Cetak lewat Bluetooth langsung (ESC/POS, Web Bluetooth).
