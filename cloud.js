/*
 * Penyimpanan cloud memakai Firebase (Firestore + login Google).
 *
 * File ini adalah ES module yang dimuat hanya kalau firebase-config.js sudah
 * diisi (lihat app.js, fungsi init). Library Firebase diambil dari CDN resmi
 * Google, jadi tidak perlu npm atau build tool.
 *
 * Bentuk data di Firestore:
 *   users/{uid}/items/{id}      -> { name, price, updatedAt }
 *   users/{uid}/receipts/{id}   -> { createdAt, note, total, lines: [{name, price, qty}] }
 *   users/{uid}/meta/settings   -> { shopName }
 *
 * PENTING soal offline: Firestore menyimpan salinan data di HP. Saat
 * menulis, ia langsung memperbarui salinan itu dan mengirim ke server
 * begitu ada internet. Karena itu fungsi tulis di bawah TIDAK di-await:
 * kalau di-await, tombol Simpan akan "menggantung" selama offline.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, deleteDoc, writeBatch, query, orderBy, limit,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const BATCH_SIZE = 400; // batas Firestore 500 operasi per batch

export function createCloud(config) {
  const app = initializeApp(config);
  const auth = getAuth(app);
  const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  let uid = null;
  let writeErrorHandler = () => {};
  let syncHandler = () => {};

  const col = (name) => collection(db, 'users', uid, name);
  const settingsRef = () => doc(db, 'users', uid, 'meta', 'settings');

  // Jalankan tulis tanpa menunggu server; laporkan error kalau ada.
  const fire = (promise) => {
    promise.catch((err) => {
      console.error(err);
      writeErrorHandler(err);
    });
  };

  const snapshotOptions = { includeMetadataChanges: true };
  const reportSync = (snap) => syncHandler({
    pending: snap.metadata.hasPendingWrites,
    fromCache: snap.metadata.fromCache,
  });

  return {
    kind: 'cloud',

    /* ---------- Akun ---------- */
    onUser(callback) {
      return onAuthStateChanged(auth, (user) => {
        uid = user ? user.uid : null;
        if (user) {
          // Buat dokumen induk users/{uid}. Tanpa ini, konsol Firebase menampilkan
          // ID akun dengan huruf miring ("dokumen tidak ada") dan sulit dicari.
          fire(setDoc(doc(db, 'users', uid), { email: user.email || '', lastLogin: Date.now() }, { merge: true }));
        }
        callback(user ? { name: user.displayName || '', email: user.email || '' } : null);
      });
    },
    getUid: () => uid,
    // Tes sambungan: tulis satu dokumen dan TUNGGU server Firebase menerimanya.
    // Hasil: berhasil, ditolak (mis. permission-denied), atau tidak ada balasan.
    ping() {
      if (!uid) return Promise.resolve({ ok: false, code: 'no-user', message: 'Belum login' });
      const timeout = new Promise((resolve) => setTimeout(() => resolve({
        ok: false,
        code: 'timeout',
        message: 'Tidak ada balasan dari server Firebase dalam 10 detik (cek internet, VPN, pemblokir iklan, atau antivirus)',
      }), 10000));
      const write = setDoc(doc(db, 'users', uid, 'meta', 'ping'), { at: Date.now() })
        .then(() => ({ ok: true }), (err) => ({ ok: false, code: err.code || 'error', message: err.message || String(err) }));
      return Promise.race([write, timeout]);
    },
    signIn: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),
    onWriteError(handler) { writeErrorHandler = handler; },
    onSync(handler) { syncHandler = handler; },

    /* ---------- Barang ---------- */
    watchItems(callback, onError) {
      return onSnapshot(col('items'), snapshotOptions, (snap) => {
        callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        reportSync(snap);
      }, onError);
    },
    // item.id ada -> perbarui; tidak ada -> buat baru (id dibuat otomatis)
    saveItem(item) {
      const { id, ...fields } = item;
      const ref = id ? doc(col('items'), id) : doc(col('items'));
      fire(setDoc(ref, fields));
      return ref.id;
    },
    deleteItem(id) {
      fire(deleteDoc(doc(col('items'), id)));
    },
    bulkSaveItems(list) {
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = writeBatch(db);
        for (const item of list.slice(i, i + BATCH_SIZE)) {
          const { id, ...fields } = item;
          batch.set(id ? doc(col('items'), id) : doc(col('items')), fields);
        }
        fire(batch.commit());
      }
    },

    /* ---------- Riwayat nota ---------- */
    watchReceipts(callback, onError) {
      const q = query(col('receipts'), orderBy('createdAt', 'desc'), limit(100));
      return onSnapshot(q, snapshotOptions, (snap) => {
        callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        reportSync(snap);
      }, onError);
    },
    addReceipt(receipt) {
      const ref = doc(col('receipts'));
      fire(setDoc(ref, receipt));
      return ref.id;
    },
    deleteReceipt(id) {
      fire(deleteDoc(doc(col('receipts'), id)));
    },

    /* ---------- Pengaturan bersama (nama bengkel) ---------- */
    watchSettings(callback, onError) {
      return onSnapshot(settingsRef(), (snap) => callback(snap.exists() ? snap.data() : {}), onError);
    },
    saveSettings(values) {
      fire(setDoc(settingsRef(), values, { merge: true }));
    },
  };
}
