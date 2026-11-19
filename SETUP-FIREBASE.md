# Setup Firebase (sekali saja, sekitar 15 menit)

Selama `firebase-config.js` masih berisi `ISI_...`, aplikasi memakai penyimpanan lokal di HP. Setelah kamu mengisinya dengan benar, aplikasi otomatis pindah ke mode cloud dan meminta login Google.

Firebase punya paket gratis (Spark). Untuk aplikasi sekecil ini, pemakaiannya jauh di bawah batas gratis. Tampilan konsol Firebase dan kebijakan paket bisa berubah, jadi kalau ada langkah yang tidak cocok dengan tulisan di sini, ikuti petunjuk di layar.

## 1. Buat proyek

1. Buka https://console.firebase.google.com dan masuk dengan akun Google-mu.
2. **Create a project** (Buat proyek), beri nama misalnya `harga-bengkel`.
3. Google Analytics: matikan saja, tidak dibutuhkan.

## 2. Aktifkan login Google

1. Menu **Build**, lalu **Authentication**, lalu **Get started**.
2. Tab **Sign-in method**, pilih **Google**, aktifkan **Enable**.
3. Pilih email dukungan (email-mu), lalu **Save**.

## 3. Buat database Firestore

1. Menu **Build**, lalu **Firestore Database**, lalu **Create database**.
2. Lokasi: pilih yang terdekat, misalnya `asia-southeast2 (Jakarta)`. **Lokasi tidak bisa diubah nanti.**
3. Mode: **Production mode**.

## 4. Pasang aturan keamanan (penting)

1. Di Firestore, buka tab **Rules**.
2. Hapus isinya, tempel seluruh isi file `firestore.rules`, lalu **Publish**.

Aturan itu membuat setiap akun hanya bisa membaca dan menulis datanya sendiri. Tanpa langkah ini, database akan menolak semua akses (atau, kalau salah diatur, terbuka untuk umum).

## 5. Daftarkan aplikasi web dan salin konfigurasinya

1. Klik ikon roda gigi, **Project settings**.
2. Bagian **Your apps**, klik ikon web `</>`, beri nama (misalnya `harga-bengkel-web`). Tidak perlu centang Firebase Hosting.
3. Muncul blok `firebaseConfig`. Salin nilai `apiKey`, `authDomain`, `projectId`, dan `appId` ke file `firebase-config.js`, mengganti nilai `ISI_...`.

`apiKey` bukan rahasia. Itu hanya penanda proyek. Yang melindungi data adalah aturan di langkah 4.

## 6. Izinkan alamat tempat aplikasi di-hosting

1. **Authentication**, **Settings**, **Authorized domains**.
2. `localhost` sudah ada, jadi tes di laptop langsung bisa.
3. Setelah aplikasi di-deploy, tambahkan domainnya (contoh: `namamu.github.io` atau `xxx.netlify.app`). Kalau lupa, login Google akan gagal dengan pesan `auth/unauthorized-domain`.

## 7. Coba

1. Jalankan di laptop (`py -m http.server 8000`), buka `http://localhost:8000`.
2. Muncul layar **"Masuk dengan Google"**. Masuk.
3. Tab Pengaturan, **Pengaturan lainnya**, **Masukkan data dari file cadangan** untuk memasukkan daftar harga awal (`contoh-backup.json` untuk mencoba).
4. Cek di konsol Firebase, **Firestore Database**, tab **Data**: buka koleksi `users`, klik dokumen berisi ID akunmu, lalu subkoleksi **`items`**. (Bukan koleksi `items` di paling atas; barang disimpan di bawah akunmu.) ID akun juga tertulis di panel Diagnosa baris "Lokasi data".
5. Di Pengaturan, Pengaturan lainnya, ketuk **Tes sambungan cloud**. Hasilnya harus "BERHASIL". Kalau "GAGAL: permission-denied", aturan di langkah 4 belum terpasang. Kalau "timeout", internet atau pemblokir (VPN, adblock, antivirus) menghalangi Firebase.

## 8. Di HP ibumu

1. Buka alamat aplikasi di Chrome, lalu **Instal aplikasi**.
2. Login sekali dengan akun Google. Setelah itu login tetap tersimpan.
3. Tes offline: matikan data seluler, ubah satu harga, lalu nyalakan lagi. Di bar atas, status berubah dari "Menunggu internet" menjadi "Tersimpan di cloud".

## Satu akun untuk semua HP

Data disimpan per akun Google. Supaya HP ibumu dan HP-mu melihat daftar yang sama, login dengan akun yang **sama** di kedua HP (misalnya akun milik ibumu, atau akun khusus bengkel). Berbagi data antar dua akun yang berbeda butuh pengembangan tambahan.

## Kalau bermasalah

| Gejala | Kemungkinan penyebab |
|---|---|
| Login gagal, `auth/unauthorized-domain` | Domain belum ditambahkan di Authorized domains (langkah 6) |
| "Tidak punya izin membaca/menyimpan" | Aturan Firestore belum dipasang atau salah (langkah 4) |
| Popup login tidak muncul | Pop-up diblokir browser; izinkan pop-up untuk situs ini |
| Tombol login tetap "Memuat…" | `firebase-config.js` salah isi, atau tidak ada internet saat pertama dibuka. Lihat Console (F12) |
