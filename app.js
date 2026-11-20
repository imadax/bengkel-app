/*
 * Imada Motor - aplikasi web (PWA) sederhana.
 * Tanpa framework dan tanpa build tool: HTML + CSS + JavaScript biasa.
 *
 * Daftar isi file ini:
 *   1. Helper kecil
 *   2. Penyimpanan LOKAL (IndexedDB)       <- cadangan kalau cloud belum diisi
 *      (penyimpanan CLOUD ada di cloud.js; keduanya punya "bentuk" yang sama)
 *   3. Daftar barang
 *   4. Totalan (keranjang)
 *   5. Cetak struk
 *   6. Riwayat nota
 *   7. Backup (ekspor / impor)
 *   8. Pengaturan, font, tab
 *   9. Mulai aplikasi (pilih mode lokal / cloud, login)
 *
 * Bentuk "adapter" data (dipakai variabel `data`):
 *   watchItems(cb)      cb dipanggil dengan daftar barang, dan lagi setiap ada perubahan
 *   saveItem(item)      simpan (ada item.id = ubah, tidak ada = baru)
 *   deleteItem(id)
 *   bulkSaveItems(list)
 *   watchReceipts(cb) / addReceipt(r) / deleteReceipt(id)
 *   watchDrafts(cb) / saveDraft(d) / deleteDraft(id)      draft nota
 *   watchStockLog(cb) / applyStock(moves)                  stok + riwayatnya
 *   watchSettings(cb) / saveSettings({shopName, qris})   qris = gambar (data URL), kosong = belum ada
 */
'use strict';

const APP_VERSION = '3.7.0';
const DB_NAME = 'harga-bengkel';
const BACKUP_REMINDER_DAYS = 7;
const MAX_HISTORY = 100;

/* ===================================================================
 * 1. HELPER KECIL
 * =================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 15000 -> "Rp 15.000"
const rupiah = (n) => 'Rp ' + Math.round(n || 0).toLocaleString('id-ID');

// "15.000" atau "Rp 15000" -> 15000 (ambil digitnya saja)
const parsePrice = (s) => Number(String(s).replace(/[^\d]/g, ''));

// 15000 -> "15.000" (tanpa "Rp", seperti kolom di nota kertas)
const numFmt = (n) => Math.round(n || 0).toLocaleString('id-ID');

const norm = (s) => String(s).toLowerCase().trim();
const byName = (a, b) => a.name.localeCompare(b.name, 'id');
const fmtDate = (ms) => new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

// Pencarian: semua kata yang diketik harus ada di nama barang.
// Contoh: "oli 0.8" cocok dengan "Oli Yamalube 0.8L".
function matches(name, query) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const n = norm(name);
  return words.every((w) => n.includes(w));
}

// Membuat elemen HTML tanpa innerHTML (lebih aman dari injeksi teks).
// h('button', { class: 'btn', onclick: fn }, 'Teks')
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// Penyimpanan kecil untuk pengaturan (localStorage), dibungkus try/catch
// karena bisa gagal di mode penyamaran atau kalau diblokir.
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* abaikan */
    }
  },
};

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ===================================================================
 * 2. PENYIMPANAN LOKAL (IndexedDB)
 * Dipakai kalau firebase-config.js belum diisi. Data hanya ada di HP ini.
 * =================================================================== */

async function createLocalData() {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    // Dipanggil saat database dibuat atau naik versi
    req.onupgradeneeded = () => {
      for (const name of ['items', 'receipts', 'drafts', 'stockLog']) {
        if (!req.result.objectStoreNames.contains(name)) {
          req.result.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // Mengubah request IndexedDB (berbasis event) menjadi Promise
  const asPromise = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const objectStore = (name, mode) => db.transaction(name, mode).objectStore(name);
  const getAll = (name) => asPromise(objectStore(name, 'readonly').getAll());

  // Daftar "pendengar": setiap kali data berubah, semua pendengar diberi data terbaru
  const watchers = { items: new Set(), receipts: new Set(), drafts: new Set(), stockLog: new Set() };
  const emit = async (name) => {
    const rows = await getAll(name);
    watchers[name].forEach((cb) => cb(rows));
  };
  const watch = (name, cb) => {
    watchers[name].add(cb);
    getAll(name).then(cb);
    return () => watchers[name].delete(cb);
  };
  const put = async (name, value) => {
    const key = await asPromise(objectStore(name, 'readwrite').put(value));
    await emit(name);
    return key;
  };
  const remove = async (name, id) => {
    await asPromise(objectStore(name, 'readwrite').delete(id));
    await emit(name);
  };

  return {
    kind: 'local',
    watchItems: (cb) => watch('items', cb),
    // Gabungkan dengan data lama supaya field stok tidak hilang saat edit nama/harga
    async saveItem(item) {
      if (item.id != null) {
        const old = await asPromise(objectStore('items', 'readonly').get(item.id));
        if (old) item = { ...old, ...item };
      }
      return put('items', item);
    },
    deleteItem: (id) => remove('items', id),
    async bulkSaveItems(list) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('items', 'readwrite');
        list.forEach((item) => tx.objectStore('items').put(item));
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      await emit('items');
    },
    watchReceipts: (cb) => watch('receipts', cb),
    addReceipt: (receipt) => put('receipts', receipt),
    deleteReceipt: (id) => remove('receipts', id),
    watchDrafts: (cb) => watch('drafts', cb),
    saveDraft: (draft) => put('drafts', draft),
    deleteDraft: (id) => remove('drafts', id),
    watchStockLog: (cb) => watch('stockLog', cb),
    // Ubah stok dan catat riwayatnya dalam satu transaksi
    async applyStock(moves) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['items', 'stockLog'], 'readwrite');
        const itemStore = tx.objectStore('items');
        const logStore = tx.objectStore('stockLog');
        for (const m of moves) {
          const req = itemStore.get(m.itemId);
          req.onsuccess = () => {
            const it = req.result;
            if (!it) return;
            it.stock = (typeof it.stock === 'number' ? it.stock : 0) + m.delta;
            itemStore.put(it);
            if (!m.noLog) {
              logStore.add({
                itemId: m.itemId, name: m.name, type: m.type, qty: m.delta,
                after: it.stock, at: m.at, note: m.note || '', receiptId: m.receiptId ?? null,
              });
            }
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
      await emit('items');
      await emit('stockLog');
    },
    watchSettings(cb) {
      cb({ shopName: store.get('shopName', ''), qris: store.get('qris', '') });
      return () => {};
    },
    saveSettings(values) {
      if ('shopName' in values) store.set('shopName', values.shopName);
      if ('qris' in values) store.set('qris', values.qris);
    },
  };
}

/* ===================================================================
 * Keadaan aplikasi (disimpan di memori, diisi oleh adapter data)
 * =================================================================== */

let data;                       // adapter data aktif (lokal atau cloud)
let items = [];                 // daftar barang
let itemsLoaded = false;        // sudah menerima data pertama?
let receipts = [];              // riwayat nota
let drafts = [];                // draft nota yang belum dicetak
let stockLog = [];              // riwayat stok masuk / keluar
let currentDraftId = null;      // draft yang sedang dibuka di halaman Buat Nota
let settings = { shopName: '' };
let stopWatching = [];          // fungsi untuk berhenti mendengar (saat logout)

// Catatan untuk panel Diagnosa
const diag = { lastError: '-', sync: '-', cloudTest: 'belum dicoba' };
const describeError = (e) => (e ? `${e.code || 'error'}: ${e.message || e}` : '-');

/* ===================================================================
 * 3. DAFTAR BARANG (termasuk stok)
 * Barang punya field `stock` (angka) hanya kalau stoknya dihitung.
 * Tanpa field itu (mis. jasa servis) stok tidak dihitung dan tidak berkurang.
 * =================================================================== */

const isTracked = (item) => !!item && typeof item.stock === 'number';
const stockLabel = (n) => (n === 0 ? 'Stok habis' : `Stok ${n}`);

// Tulisan kecil "Stok 5" di bawah nama barang (merah kalau habis / minus)
function stockTag(item) {
  if (!isTracked(item)) return null;
  return h('span', { class: 'stock-tag block' + (item.stock <= 0 ? ' low' : '') }, stockLabel(item.stock));
}

let editingId = null;   // id barang yang sedang diedit (null = tambah baru)

function renderItems() {
  updateHome();
  const query = $('#itemSearch').value;
  const rows = items.filter((i) => matches(i.name, query)).sort(byName);
  $('#itemList').replaceChildren(...rows.map(itemRow));
  $('#itemCount').textContent = !itemsLoaded
    ? 'Memuat…'
    : items.length === 0
      ? 'Belum ada barang. Ketuk "+ Barang" untuk mulai, atau masukkan data dari file di Pengaturan.'
      : `${rows.length} dari ${items.length} barang`;
}

// Satu baris = satu tombol besar. Ketuk untuk edit (hapus ada di dalam dialog edit).
function itemRow(item) {
  return h('li', { class: 'tap' },
    h('button', { class: 'item-btn', type: 'button', onclick: () => openItemDialog(item) },
      h('span', { class: 'grow' },
        h('span', { class: 'item-name block' }, item.name),
        stockTag(item)),
      h('span', { class: 'item-price' }, rupiah(item.price))));
}

function openItemDialog(item) {
  editingId = item ? item.id : null;
  $('#btnDeleteItem').hidden = !item;
  $('#itemDialogTitle').textContent = item ? 'Edit barang' : 'Tambah barang';
  $('#itemName').value = item ? item.name : '';
  $('#itemPrice').value = item ? item.price : '';

  // Stok: barang yang sudah dihitung stoknya -> tambah / koreksi. Selain itu -> stok awal.
  const tracked = isTracked(item);
  $('#stockInitBlock').hidden = tracked;
  $('#stockEditBlock').hidden = !tracked;
  $('#stockInit').value = '';
  $('#stockAdd').value = '';
  $('#stockFix').value = '';
  $('#stockEditBlock details').open = false;
  if (tracked) $('#stockNow').textContent = item.stock;
  $('#itemDialog').showModal();
}

async function saveItem(event) {
  event.preventDefault(); // cegah form memuat ulang halaman
  const name = $('#itemName').value.trim();
  const rawPrice = $('#itemPrice').value.trim();
  if (!name || !rawPrice) return toast('Nama dan harga harus diisi');

  const item = { name, price: parsePrice(rawPrice), updatedAt: Date.now() };
  if (editingId !== null) item.id = editingId;

  // Rencana perubahan stok (kalau ada): tambah stok, koreksi, atau stok awal
  const old = editingId !== null ? items.find((i) => i.id === editingId) : null;
  const at = Date.now();
  const moves = [];
  let running = isTracked(old) ? old.stock : 0;
  const plan = (delta, type, note, noLog = false) => {
    running += delta;
    moves.push({ delta, type, note, noLog, name, at, after: running });
  };
  if (isTracked(old)) {
    const add = parsePrice($('#stockAdd').value);
    if (add > 0) plan(add, 'in', 'Tambah stok');
    const fixRaw = $('#stockFix').value.trim();
    if (fixRaw !== '') {
      const fix = parsePrice(fixRaw);
      if (fix !== running) plan(fix - running, 'adjust', 'Koreksi stok');
    }
  } else {
    const raw = $('#stockInit').value.trim();
    if (raw !== '') {
      const n = parsePrice(raw);
      plan(n, 'in', 'Stok awal', n === 0);   // stok awal 0: cukup mulai dihitung, tanpa catatan
    }
  }

  try {
    const id = await data.saveItem(item);
    if (moves.length) {
      moves.forEach((m) => { m.itemId = id; });
      await data.applyStock(moves);
    }
    $('#itemDialog').close();
    toast('Tersimpan');
  } catch (err) {
    console.error(err);
    toast('Gagal menyimpan');
  }
}

async function removeItem() {
  const item = items.find((i) => i.id === editingId);
  if (!item) return;
  if (!confirm(`Hapus "${item.name}" dari daftar?`)) return;
  try {
    await data.deleteItem(item.id);
    $('#itemDialog').close();
    toast('Dihapus');
  } catch (err) {
    console.error(err);
    toast('Gagal menghapus');
  }
}

/* ===================================================================
 * 4. TOTALAN (KERANJANG)
 * Bentuk satu baris: { key, itemId (kosong untuk barang manual), name, price, qty }
 * Keranjang hanya ada di memori (hilang kalau halaman ditutup).
 * =================================================================== */

let cart = [];

const laborAmount = () => parsePrice($('#calcLabor').value) || 0;   // ongkos jasa (boleh kosong)
const cartTotal = () => cart.reduce((sum, c) => sum + c.price * c.qty, 0) + laborAmount();

// Hasil pencarian di atas keranjang
function renderCalcResults() {
  const query = $('#calcSearch').value.trim();
  const box = $('#calcResults');
  if (!query) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }

  const found = items.filter((i) => matches(i.name, query)).sort(byName).slice(0, 8);
  const rows = found.map((item) =>
    h('li', { class: 'tap' },
      h('button', {
        class: 'item-btn', type: 'button',
        onclick: () => {
          addToCart(item);
          $('#calcSearch').value = '';
          renderCalcResults();
        },
      }, h('span', { class: 'grow' }, h('span', { class: 'item-name block' }, item.name), stockTag(item)),
         h('span', { class: 'item-price' }, rupiah(item.price)))));

  // Kalau tidak ada yang cocok, tawarkan tambah manual dengan nama yang diketik
  if (found.length === 0) {
    rows.push(h('li', { class: 'tap' },
      h('button', { class: 'item-btn', type: 'button', onclick: () => openManualDialog(query) },
        `Tidak ada. Tambah "${query}" secara manual`)));
  }
  box.replaceChildren(...rows);
  box.hidden = false;
}

function addToCart(item) {
  const key = 'i' + item.id;
  const existing = cart.find((c) => c.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, itemId: item.id, name: item.name, price: item.price, qty: 1 });
  renderCart();
}



function updateTotals() {
  $('#cartTotal').textContent = rupiah(cartTotal());
  const any = cart.length > 0 || laborAmount() > 0;   // nota hanya ongkos juga boleh
  $('#btnPrint').disabled = !any;
  $('#btnDraft').disabled = !cartHasContent();
  $('#btnClear').disabled = !cartHasContent();
}

// Ada isi di halaman Buat Nota? (barang, ongkos, atau data pelanggan)
function cartHasContent() {
  return cart.length > 0 || laborAmount() > 0
    || ['#calcCustomer', '#calcMotor', '#calcPlate'].some((id) => $(id).value.trim() !== '');
}

// Ringkasan data pelanggan yang tampil saat kotaknya dilipat
function updateCustSummary() {
  const v = ['#calcCustomer', '#calcMotor', '#calcPlate'].map((id) => $(id).value.trim()).filter(Boolean);
  $('#custSummary').textContent = v.join(' · ');
  updateTotals();
}

function renderCart() {
  $('#cartList').replaceChildren(...cart.map(cartRow));
  $('#cartEmpty').hidden = cart.length > 0;
  updateTotals();
}

// Petunjuk stok di baris totalan; merah kalau jumlah melebihi stok (tetap boleh dijual)
function cartStockHint(c) {
  const it = c.itemId != null ? items.find((i) => i.id === c.itemId) : null;
  if (!isTracked(it)) return null;
  const short = c.qty > it.stock;
  return h('div', { class: 'stock-tag' + (short ? ' low' : '') },
    short ? `Stok tinggal ${Math.max(it.stock, 0)}` : `Stok ${it.stock}`);
}

// Satu baris di totalan: nama, harga (bisa diubah), jumlah (- / +), subtotal.
function cartRow(c) {
  const subtotal = h('div', { class: 'subtotal' }, rupiah(c.price * c.qty));

  // Harga bisa diubah langsung untuk transaksi ini (tidak mengubah daftar barang).
  // Hanya teks total yang diperbarui supaya ketukan berikutnya tidak hilang.
  const priceInput = h('input', {
    class: 'price-input', type: 'text', inputmode: 'numeric',
    'aria-label': 'Harga satuan', value: c.price,
    onchange: (e) => {
      c.price = parsePrice(e.target.value);
      e.target.value = c.price;
      subtotal.textContent = rupiah(c.price * c.qty);
      updateTotals();
    },
  });

  return h('li', {},
    h('div', { class: 'cart-top' },
      h('div', { class: 'grow' }, h('div', { class: 'item-name' }, c.name), cartStockHint(c)),
      h('button', {
        class: 'btn small danger', type: 'button', 'aria-label': 'Hapus dari totalan',
        onclick: () => { cart = cart.filter((x) => x !== c); renderCart(); },
      }, '✕')),
    h('div', { class: 'cart-bottom' },
      priceInput,
      h('div', { class: 'stepper' },
        h('button', {
          class: 'btn small', type: 'button', 'aria-label': 'Kurangi',
          onclick: () => { if (c.qty > 1) { c.qty -= 1; renderCart(); } },
        }, '−'),
        h('span', { class: 'qty' }, c.qty),
        h('button', {
          class: 'btn small', type: 'button', 'aria-label': 'Tambah',
          onclick: () => { c.qty += 1; renderCart(); },
        }, '+')),
      subtotal));
}

function openManualDialog(name = '') {
  $('#manualForm').reset();
  $('#manualName').value = name;
  $('#manualQty').value = '1';
  $('#manualDialog').showModal();
}

async function addManual(event) {
  event.preventDefault();
  const name = $('#manualName').value.trim();
  const rawPrice = $('#manualPrice').value.trim();
  const qty = Math.max(1, parsePrice($('#manualQty').value) || 1);
  if (!name || !rawPrice) return toast('Nama dan harga harus diisi');
  const price = parsePrice(rawPrice);

  cart.push({ key: 'm' + Date.now() + Math.random(), name, price, qty });

  if ($('#manualSave').checked) {
    try {
      await data.saveItem({ name, price, updatedAt: Date.now() });
    } catch (err) {
      console.error(err);
      toast('Barang masuk totalan, tapi gagal disimpan ke daftar');
    }
  }

  $('#manualDialog').close();
  $('#calcSearch').value = '';
  renderCalcResults();
  renderCart();
}

// Kosongkan semua isian tanpa bertanya (dipakai setelah cetak dan setelah simpan draft)
function resetForm() {
  cart = [];
  currentDraftId = null;
  $('#calcCustomer').value = '';
  $('#calcMotor').value = '';
  $('#calcPlate').value = '';
  $('#calcLabor').value = '';
  updateCustSummary();
  renderCart();
  renderDrafts();
}

function clearCart() {
  const msg = currentDraftId != null
    ? 'Kosongkan nota ini? Draft yang sudah tersimpan tidak ikut terhapus.'
    : 'Kosongkan nota ini?';
  if (!confirm(msg)) return;
  resetForm();
}

/* ---------- Draft nota ----------
 * Isi halaman Buat Nota bisa disimpan dulu (mis. motor belum selesai),
 * lalu dilanjutkan kapan saja sambil membuat nota lain.
 * Stok TIDAK berkurang sampai nota dicetak. */

function formSnapshot() {
  return {
    customer: $('#calcCustomer').value.trim(),
    motor: $('#calcMotor').value.trim(),
    plate: $('#calcPlate').value.trim(),
    labor: laborAmount(),
    lines: cart.map(({ itemId, name, price, qty }) => ({ itemId: itemId ?? null, name, price, qty })),
  };
}

// Simpan isi halaman sekarang sebagai draft (menimpa draft yang sedang dibuka, atau draft baru)
async function persistDraft() {
  const now = Date.now();
  const existing = drafts.find((d) => d.id === currentDraftId);
  const draft = { ...formSnapshot(), createdAt: existing ? existing.createdAt : now, updatedAt: now };
  if (currentDraftId != null) draft.id = currentDraftId;
  return data.saveDraft(draft);
}

async function saveDraftAndClear() {
  if (!cartHasContent()) return;
  try {
    await persistDraft();
    resetForm();
    toast('Disimpan sebagai draft');
  } catch (err) {
    console.error(err);
    toast('Gagal menyimpan draft');
  }
}

async function resumeDraft(d) {
  // Isi yang sedang dikerjakan disimpan dulu supaya tidak hilang
  if (cartHasContent()) {
    try {
      await persistDraft();
      toast('Nota sebelumnya disimpan ke draft');
    } catch (err) {
      console.error(err);
      return toast('Gagal menyimpan nota yang sedang dibuka');
    }
  }
  cart = d.lines.map((l) => ({ key: 'd' + Date.now() + Math.random(), ...l }));
  currentDraftId = d.id;
  $('#calcCustomer').value = d.customer || '';
  $('#calcMotor').value = d.motor || '';
  $('#calcPlate').value = d.plate || '';
  $('#calcLabor').value = d.labor > 0 ? numFmt(d.labor) : '';
  updateCustSummary();
  renderCart();
  renderDrafts();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteDraft(d) {
  if (!confirm('Hapus draft ini?')) return;
  try {
    await data.deleteDraft(d.id);
    if (d.id === currentDraftId) currentDraftId = null;
    renderDrafts();
    toast('Draft dihapus');
  } catch (err) {
    console.error(err);
    toast('Gagal menghapus draft');
  }
}

function draftRow(d) {
  const title = [d.customer, d.motor, d.plate].filter(Boolean).join(' · ') || 'Tanpa nama';
  const total = d.lines.reduce((sum, l) => sum + l.price * l.qty, 0) + (d.labor || 0);
  const open = d.id === currentDraftId;
  return h('li', {},
    h('div', { class: 'draft-info' },
      h('div', { class: 'item-name clip' }, title),
      h('div', { class: 'muted small' }, `${d.lines.length} barang · ${rupiah(total)} · ${fmtDate(d.updatedAt)}`)),
    h('div', { class: 'draft-actions' },
      open
        ? h('span', { class: 'muted small' }, 'Sedang dibuka')
        : h('button', { class: 'btn small primary', type: 'button', onclick: () => resumeDraft(d) }, 'Lanjutkan'),
      h('button', { class: 'btn small danger', type: 'button', 'aria-label': 'Hapus draft', onclick: () => deleteDraft(d) }, '✕')));
}

function renderDrafts() {
  const list = drafts.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  $('#draftBox').hidden = list.length === 0;
  $('#draftSummary').textContent = `${list.length} tersimpan`;
  $('#draftList').replaceChildren(...list.map(draftRow));
  updateHome();
}

/* ===================================================================
 * 5. CETAK STRUK
 * Struk dibuat di #printArea (tersembunyi). Saat window.print() dipanggil,
 * CSS @media print menyembunyikan semuanya kecuali #printArea.
 * Di Android: pilih "Simpan sebagai PDF" atau printer yang tersedia.
 *
 * Satu "nota" (receipt) berbentuk:
 *   { createdAt, note, total, lines: [{ name, price, qty }] }
 * Nota disimpan ke riwayat saat tombol cetak ditekan.
 * =================================================================== */

function applyPaper() {
  const size = store.get('paper', '58');
  // @page mengatur ukuran kertas. "auto" = tinggi mengikuti isi struk.
  const css = size === 'A4' ? '@page { size: A4; margin: 15mm; }'
    : size === 'A5' ? '@page { size: A5; margin: 10mm; }'
    : `@page { size: ${size}mm auto; margin: 2mm; }`;
  $('#pageStyle').textContent = css;
  $('#printArea').dataset.paper = size;
}

const MIN_ROWS = 10;   // jumlah baris minimal di nota kertas A5/A4 (baris kosong seperti kertas)

// Data kepala nota. Nama bengkel ikut Pengaturan (cloud); baris lainnya disimpan per HP.
const SHOP_DEFAULT = { name: 'IMADA MOTOR', tag: 'SERVIS / ONDERDEL', addr: 'Jln. Tambakromo - Kayen', tel: '081 390 420 121' };

function shopInfo() {
  return {
    name: settings.shopName || SHOP_DEFAULT.name,
    tag: store.get('shopTag', SHOP_DEFAULT.tag),
    addr: store.get('shopAddr', SHOP_DEFAULT.addr),
    tel: store.get('shopTel', SHOP_DEFAULT.tel),
  };
}

function applyNotaHead() {
  const s = shopInfo();
  $('#homeShop').textContent = s.name;
  $('#drawerShop').textContent = s.name;
  $('#homeTag').textContent = s.tag;
  for (const id of ['#calcCustomer', '#calcMotor', '#calcPlate']) $(id).addEventListener('input', updateCustSummary);
  $('#calcLabor').addEventListener('input', updateTotals);
  $('#calcLabor').addEventListener('change', (e) => {
    const v = parsePrice(e.target.value);
    e.target.value = v > 0 ? numFmt(v) : '';
    updateTotals();
  });
  for (const [id, key] of [['#shopTag', 'shopTag'], ['#shopAddr', 'shopAddr'], ['#shopTel', 'shopTel']]) {
    if (document.activeElement !== $(id)) $(id).value = store.get(key, '');
  }
}

// Struk dibuat meniru nota kertas: kepala, empat kolom, lalu "Jumlah Rp.".
// Kertas 58 mm terlalu sempit untuk tabel, jadi memakai susunan dua baris per barang.
function buildReceipt(r) {
  const paper = store.get('paper', '58');
  const narrow = paper === '58';
  const s = shopInfo();

  const who = [['Pelanggan', r.customer], ['Motor', r.motor], ['Plat', r.plate]];
  const legacy = r.customer == null && r.motor == null && r.plate == null ? r.note : '';
  const toLines = who
    .filter(([, v]) => !narrow || v)
    .map(([k, v]) => h('div', { class: 'pn-line' }, v ? `${k}: ${v}` : ''));
  toLines.push(h('div', { class: 'pn-line pn-date' }, fmtDate(r.createdAt)));

  const head = h('div', { class: 'pn-head' },
    h('div', { class: 'pn-brand' },
      h('div', { class: 'pn-shop' }, s.name),
      h('div', { class: 'pn-tag' }, s.tag),
      h('div', { class: 'pn-addr' }, s.addr),
      h('div', { class: 'pn-tel' }, s.tel)),
    h('div', { class: 'pn-to' }, toLines));

  const parts = [head];
  if (legacy) parts.push(h('div', { class: 'pn-note' }, 'Catatan: ' + legacy));

  if (narrow) {
    parts.push(h('div', { class: 'pn-rule' }));
    for (const l of r.lines) {
      parts.push(h('div', { class: 'r-row' },
        h('div', { class: 'r-name' }, l.name),
        h('div', { class: 'r-line' },
          h('span', {}, `${l.qty} x ${numFmt(l.price)}`),
          h('span', {}, numFmt(l.price * l.qty)))));
    }
    if (r.labor > 0) {
      parts.push(h('div', { class: 'r-row' },
        h('div', { class: 'r-name' }, 'Ongkos'),
        h('div', { class: 'r-line' }, h('span', {}, ''), h('span', {}, numFmt(r.labor)))));
    }
  } else {
    const cells = (a, b, c, d, cls = '') => h('div', { class: 'pn-row ' + cls },
      h('div', { class: 'c' }, a), h('div', { class: 'nm' }, b), h('div', { class: 'rt' }, c), h('div', { class: 'rt b' }, d));
    const rows = r.lines.map((l) => cells(l.qty, l.name, numFmt(l.price), numFmt(l.price * l.qty)));
    if (r.labor > 0) rows.push(cells('', 'Ongkos', numFmt(r.labor), numFmt(r.labor)));   // banyaknya dikosongkan
    if (paper === 'A4' || paper === 'A5') while (rows.length < MIN_ROWS) rows.push(cells('', '', '', '', 'blank'));
    parts.push(h('div', { class: 'pn-table' },
      h('div', { class: 'pn-th' }, h('div', {}, 'BANYAKNYA'), h('div', {}, 'NAMA BARANG'), h('div', {}, 'HARGA'), h('div', {}, 'JUMLAH')),
      rows));
  }

  parts.push(h('div', { class: 'pn-sum' }, h('span', {}, 'Jumlah Rp.'), h('strong', {}, numFmt(r.total))));

  $('#printArea').replaceChildren(h('div', { class: 'pn ' + (narrow ? 'pn-58' : 'pn-wide') }, parts));
}

function printNow(receipt) {
  applyPaper();
  buildReceipt(receipt);
  window.print();
}

async function printCart() {
  if (cart.length === 0 && laborAmount() === 0) return;
  const customer = $('#calcCustomer').value.trim();
  const motor = $('#calcMotor').value.trim();
  const plate = $('#calcPlate').value.trim();

  // Barang yang stoknya dihitung akan dikurangi sesuai jumlah yang dijual
  const stockOut = [];
  for (const c of cart) {
    const it = c.itemId != null ? items.find((i) => i.id === c.itemId) : null;
    if (isTracked(it)) stockOut.push({ itemId: it.id, name: it.name, qty: c.qty, after: it.stock - c.qty });
  }

  const receipt = {
    createdAt: Date.now(),
    customer,
    motor,
    plate,
    note: [customer, motor, plate].filter(Boolean).join(' · '),   // ringkasan untuk riwayat
    labor: laborAmount(),   // ongkos jasa; sudah termasuk di total
    total: cartTotal(),
    lines: cart.map(({ itemId, name, price, qty }) => ({ itemId: itemId ?? null, name, price, qty })),
    stockOut: stockOut.map(({ itemId, name, qty }) => ({ itemId, name, qty })),   // untuk mengembalikan stok kalau nota dihapus
  };

  let receiptId = null;
  try {
    receiptId = await data.addReceipt(receipt); // masuk riwayat
  } catch (err) {
    console.error(err);
    toast('Nota tercetak, tapi gagal masuk riwayat');
  }

  if (stockOut.length > 0) {
    try {
      await data.applyStock(stockOut.map((o) => ({
        itemId: o.itemId, delta: -o.qty, type: 'out', name: o.name, after: o.after,
        at: receipt.createdAt, note: receipt.note, receiptId,
      })));
    } catch (err) {
      console.error(err);
      toast('Nota tersimpan, tapi stok gagal dikurangi');
    }
  }

  // Kalau nota ini berasal dari draft, draft-nya sudah selesai
  if (currentDraftId != null) {
    try { await data.deleteDraft(currentDraftId); } catch (err) { console.error(err); }
  }

  printNow(receipt);
  // Halaman dikosongkan supaya nota yang sama tidak tersimpan dan mengurangi stok dua kali.
  // Mau cetak lagi? Buka Riwayat, lalu "Cetak ulang".
  resetForm();
}

/* ===================================================================
 * 6. RIWAYAT NOTA
 * =================================================================== */

let viewingReceipt = null;

function renderHistory() {
  updateHome();
  const rows = receipts.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HISTORY);
  $('#historyList').replaceChildren(...rows.map(historyRow));
  $('#historyEmpty').hidden = rows.length > 0;
}

function historyRow(r) {
  const summary = r.note || r.lines.map((l) => l.name).join(', ') || (r.labor > 0 ? 'Ongkos' : '');
  return h('li', { class: 'tap' },
    h('button', { class: 'item-btn', type: 'button', onclick: () => openReceipt(r) },
      h('span', { class: 'grow' },
        h('span', { class: 'item-name block' }, fmtDate(r.createdAt)),
        h('span', { class: 'muted small block clip' }, summary)),
      h('span', { class: 'item-price' }, rupiah(r.total))));
}

function openReceipt(r) {
  viewingReceipt = r;
  $('#receiptTitle').textContent = fmtDate(r.createdAt);
  $('#receiptNote').textContent = r.note || '';
  $('#receiptNote').hidden = !r.note;
  const lineRows = r.lines.map((l) =>
    h('li', {},
      h('div', { class: 'line-row' }, h('span', { class: 'item-name' }, l.name), h('strong', {}, rupiah(l.price * l.qty))),
      h('div', { class: 'qty-price' }, `${l.qty} x ${rupiah(l.price)}`)));
  if (r.labor > 0) {
    lineRows.push(h('li', {},
      h('div', { class: 'line-row' }, h('span', { class: 'item-name' }, 'Ongkos'), h('strong', {}, rupiah(r.labor)))));
  }
  $('#receiptLines').replaceChildren(...lineRows);
  $('#receiptTotal').textContent = rupiah(r.total);
  $('#receiptDialog').showModal();
}

// Salin isi nota lama ke totalan (berguna untuk pelanggan yang sama)
function reuseReceipt() {
  if (!viewingReceipt) return;
  cart = viewingReceipt.lines.map((l) => ({ key: 'h' + Date.now() + Math.random(), ...l }));
  currentDraftId = null;
  const legacy = viewingReceipt.customer == null && viewingReceipt.motor == null && viewingReceipt.plate == null;
  $('#calcCustomer').value = legacy ? (viewingReceipt.note || '') : (viewingReceipt.customer || '');
  $('#calcMotor').value = viewingReceipt.motor || '';
  $('#calcPlate').value = viewingReceipt.plate || '';
  $('#calcLabor').value = viewingReceipt.labor > 0 ? numFmt(viewingReceipt.labor) : '';
  updateCustSummary();
  renderCart();
  $('#receiptDialog').close();
  showTab('calc');
  toast('Disalin ke totalan');
}

async function deleteReceipt() {
  if (!viewingReceipt) return;
  if (!confirm('Hapus nota ini dari riwayat?')) return;
  const r = viewingReceipt;

  // Nota yang mengurangi stok: tawarkan mengembalikan stoknya
  const back = (r.stockOut || [])
    .map((o) => ({ o, it: items.find((i) => i.id === o.itemId) }))
    .filter((x) => isTracked(x.it));
  const restore = back.length > 0 && confirm('Kembalikan stok barang dari nota ini?');

  try {
    if (restore) {
      await data.applyStock(back.map(({ o, it }) => ({
        itemId: it.id, delta: o.qty, type: 'return', name: it.name, after: it.stock + o.qty,
        at: Date.now(), note: '', receiptId: r.id ?? null,
      })));
    }
    await data.deleteReceipt(r.id);
    $('#receiptDialog').close();
    toast(restore ? 'Dihapus, stok dikembalikan' : 'Dihapus');
  } catch (err) {
    console.error(err);
    toast('Gagal menghapus');
  }
}

/* ---------- Riwayat stok ---------- */

const STOCK_TYPES = { in: 'Stok masuk', out: 'Terjual', adjust: 'Koreksi stok', return: 'Nota dihapus, stok kembali' };

function showHist(which) {
  $$('.seg [data-hist]').forEach((b) => b.classList.toggle('active', b.dataset.hist === which));
  $('#histReceipts').hidden = which !== 'receipts';
  $('#histStock').hidden = which !== 'stock';
}

function renderStockLog() {
  const q = $('#stockSearch').value;
  const rows = stockLog
    .filter((l) => matches(l.name || '', q))
    .sort((a, b) => b.at - a.at)
    .slice(0, 300);
  $('#stockLogList').replaceChildren(...rows.map(stockLogRow));
  $('#stockLogEmpty').hidden = rows.length > 0;
}

function stockLogRow(l) {
  const plus = l.qty > 0;
  const kind = l.type === 'in' && l.note ? l.note : (STOCK_TYPES[l.type] || l.type);
  const detail = [fmtDate(l.at), kind, l.type === 'out' ? l.note : '',
    typeof l.after === 'number' ? `stok jadi ${l.after}` : ''].filter(Boolean).join(' · ');
  return h('li', {},
    h('div', { class: 'line-row' },
      h('span', { class: 'item-name' }, l.name),
      h('strong', { class: plus ? 'plus' : 'minus' }, (plus ? '+' : '−') + Math.abs(l.qty))),
    h('div', { class: 'qty-price' }, detail));
}

/* ===================================================================
 * 7. BACKUP (EKSPOR / IMPOR)
 * Format file: JSON berisi nama bengkel dan daftar { name, price }.
 * Di mode cloud, fitur ini tetap berguna untuk memindahkan data awal.
 * =================================================================== */

function buildBackup() {
  return JSON.stringify({
    app: 'harga-bengkel',
    version: 1,
    exportedAt: new Date().toISOString(),
    shopName: settings.shopName,
    items: items.map((i) => (isTracked(i) ? { name: i.name, price: i.price, stock: i.stock } : { name: i.name, price: i.price })),
  }, null, 2);
}

function backupFileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `backup-harga-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
}

function markBackedUp() {
  store.set('lastBackup', Date.now());
  updateBackupBanner();
}

function downloadBackup() {
  const blob = new Blob([buildBackup()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: backupFileName() });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markBackedUp();
  toast('Disimpan di folder Download');
}

// Web Share API: membuka menu "Bagikan" Android (WhatsApp, Drive, dll)
async function shareBackup() {
  const file = new File([buildBackup()], backupFileName(), { type: 'application/json' });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
    return toast('Berbagi file tidak didukung di sini. Pakai "Simpan cadangan".');
  }
  try {
    await navigator.share({ files: [file], title: 'Backup daftar harga' });
    markBackedUp();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      toast('Gagal membagikan. Coba "Simpan cadangan".');
    }
  }
}

async function importBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    return toast('File tidak valid');
  }

  const list = Array.isArray(parsed) ? parsed : parsed && parsed.items;
  if (!Array.isArray(list)) return toast('Format file tidak dikenali');

  // Bersihkan data, dan gabungkan nama kembar di dalam file (yang terakhir menang)
  const clean = new Map();
  for (const x of list) {
    const name = String((x && x.name) ?? '').trim();
    const price = Number(x && x.price);
    const stock = x && x.stock != null && x.stock !== '' && Number.isFinite(Number(x.stock)) ? Number(x.stock) : undefined;
    if (name && Number.isFinite(price) && price >= 0) clean.set(norm(name), { name, price, stock });
  }
  if (clean.size === 0) return toast('Tidak ada barang yang valid di file');

  if (!confirm(`Masukkan ${clean.size} barang? Barang dengan nama sama akan diperbarui harganya.`)) return;

  const existing = new Map(items.map((i) => [norm(i.name), i]));
  const toSave = [...clean.entries()].map(([key, x]) => {
    const old = existing.get(key);
    return old
      ? { ...old, price: x.price, updatedAt: Date.now() }
      : { name: x.name, price: x.price, updatedAt: Date.now(), ...(x.stock !== undefined ? { stock: x.stock } : {}) };
  });

  try {
    await data.bulkSaveItems(toSave);
    if (parsed && parsed.shopName && !settings.shopName) {
      settings.shopName = parsed.shopName;
      data.saveSettings({ shopName: parsed.shopName });
      applySettingsToUI();
    }
    toast(`${toSave.length} barang dimasukkan`);
  } catch (err) {
    console.error(err);
    toast('Gagal memasukkan data');
  }
}

// Pengingat cadangan hanya relevan di mode lokal (cloud sudah otomatis)
function updateBackupBanner() {
  const last = store.get('lastBackup', 0);
  const stale = !last || Date.now() - last > BACKUP_REMINDER_DAYS * 86400000;
  const local = data && data.kind === 'local';
  $('#backupBanner').hidden = !(local && items.length > 0 && stale);
  $('#lastBackup').textContent = last ? fmtDate(last) : 'Belum pernah';
}

/* ===================================================================
 * 8. PENGATURAN, FONT, TAB
 * =================================================================== */

// Ukuran tulisan: tombol A- / A+ di bar atas, diingat di HP.
// Semua ukuran di CSS memakai rem, jadi mengubah font-size <html> membesarkan semuanya.
// `fontStep` disimpan di memori sebagai sumber kebenaran; localStorage hanya
// untuk mengingat (kalau gagal, tombol tetap berfungsi).
const FONT_STEPS = [16, 18, 20, 23, 26, 30];   // dalam px
const FONT_DEFAULT = 2;                         // 20px
let fontStep = FONT_DEFAULT;

function applyFont() {
  document.documentElement.style.fontSize = FONT_STEPS[fontStep] + 'px';
  $('#fontDown').disabled = fontStep === 0;
  $('#fontUp').disabled = fontStep === FONT_STEPS.length - 1;
}

function changeFont(delta) {
  const next = fontStep + delta;
  if (next < 0 || next >= FONT_STEPS.length) return;
  fontStep = next;
  store.set('fontStep', fontStep);
  applyFont();
  toast(`Ukuran tulisan ${fontStep + 1} dari ${FONT_STEPS.length}`);
}

function loadFont() {
  const saved = Number(store.get('fontStep', FONT_DEFAULT));
  fontStep = Number.isInteger(saved) && saved >= 0 && saved < FONT_STEPS.length ? saved : FONT_DEFAULT;
  applyFont();
}

function applySettingsToUI() {
  const shop = settings.shopName || '';
  if (document.activeElement !== $('#shopName')) $('#shopName').value = shop;
  applyNotaHead();
  updateQris();
}

/* ---------- QRIS ----------
 * Gambar QRIS diunggah di Pengaturan, dikecilkan, lalu disimpan sebagai data URL
 * di pengaturan bersama (cloud) atau localStorage (mode lokal).
 * Tombol QRIS di halaman Buat Nota menampilkannya ke pelanggan. */

const QRIS_MAX_CHARS = 700000;   // batas ukuran data URL (dokumen Firestore maks 1 MiB)

function updateQris() {
  const has = !!settings.qris;
  $('#qrisPreviewBox').hidden = !has;
  $('#qrisEmpty').hidden = has;
  $('#btnQrisDelete').hidden = !has;
  $('#btnQris').hidden = !has;
  $('#qrisPick').textContent = has ? 'Ganti QRIS' : 'Unggah QRIS';
  if (has && $('#qrisPreview').getAttribute('src') !== settings.qris) $('#qrisPreview').src = settings.qris;
}

// Foto / screenshot -> JPEG berukuran wajar (kualitas tetap cukup untuk dipindai)
async function imageToDataUrl(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('format tidak didukung'));
      im.src = src;
    });
    for (const [maxSide, quality] of [[1000, 0.9], [1000, 0.75], [800, 0.75], [600, 0.7]]) {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';   // latar putih supaya gambar transparan tetap bisa dipindai
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= QRIS_MAX_CHARS) return url;
    }
    throw new Error('gambar terlalu besar');
  } finally {
    URL.revokeObjectURL(src);
  }
}

async function uploadQris(file) {
  let url;
  try {
    url = await imageToDataUrl(file);
  } catch (err) {
    console.error(err);
    return toast('Gambar tidak bisa dibaca. Pakai foto atau screenshot JPG / PNG.');
  }
  const previous = settings.qris;
  settings.qris = url;
  data.saveSettings({ qris: url });
  // Mode lokal: penyimpanan browser bisa penuh tanpa memberi tahu
  if (data.kind === 'local' && store.get('qris', '') !== url) {
    settings.qris = previous;
    updateQris();
    return toast('QRIS gagal disimpan (penyimpanan HP penuh)');
  }
  updateQris();
  toast('QRIS tersimpan');
}

function deleteQris() {
  if (!confirm('Hapus QRIS yang tersimpan?')) return;
  settings.qris = '';
  data.saveSettings({ qris: '' });
  updateQris();
  toast('QRIS dihapus');
}

function showQris() {
  if (!settings.qris) return;
  $('#qrisImg').src = settings.qris;
  const total = cartTotal();
  $('#qrisAmount').hidden = total <= 0;
  $('#qrisAmount').textContent = 'Total ' + rupiah(total);
  $('#qrisDialog').showModal();
}

const TAB_TITLES = { home: 'Beranda', calc: 'Buat Nota', items: 'Daftar Harga', history: 'Riwayat', settings: 'Pengaturan' };

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('.drawer [data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#appTitle').textContent = TAB_TITLES[name] || '';
  closeDrawer();
  window.scrollTo(0, 0);
  if (name === 'settings') renderDiag();
}

// Menu samping: dibuka dengan tombol tiga garis, ditutup dengan ketuk di luar menu, Esc, atau memilih menu.
function openDrawer() {
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('#drawer [data-tab].active').focus();
}

function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  $('#menuBtn').setAttribute('aria-expanded', 'false');
}

// Ringkasan di Beranda
function updateHome() {
  const out = items.filter((i) => isTracked(i) && i.stock <= 0).length;
  $('#homeItemCount').textContent = itemsLoaded
    ? `${items.length} barang${out ? ` · ${out} stok habis` : ''}`
    : 'Memuat…';
  $('#homeReceiptCount').textContent = receipts.length ? `${receipts.length} nota tersimpan` : 'Belum ada nota';
  $('#homeCalcSub').textContent = drafts.length
    ? `${drafts.length} draft menunggu dilanjutkan`
    : 'Pilih barang, isi pelanggan, lalu cetak';
}

// Panel Diagnosa: menampilkan versi file yang BENAR-BENAR berjalan dan keadaan cloud.
async function renderDiag() {
  const root = getComputedStyle(document.documentElement);
  const cssVer = root.getPropertyValue('--css-version').replace(/['"\s]/g, '') || 'TIDAK ADA (style.css lama)';
  const lines = [
    `app.js         : ${APP_VERSION}`,
    `style.css      : ${cssVer}`,
    `Mode           : ${data ? data.kind : '-'}`,
    `Internet       : ${navigator.onLine ? 'online' : 'offline'}`,
    `Tulisan        : tingkat ${fontStep + 1}/${FONT_STEPS.length} (${root.fontSize})`,
    `Barang / nota  : ${items.length} / ${receipts.length}`,
  ];
  if (data && data.kind === 'cloud') {
    lines.push(`Proyek         : ${window.FIREBASE_CONFIG.projectId}`);
    lines.push(`Akun           : ${$('#accountName').textContent}`);
    lines.push(`Lokasi data    : users / ${data.getUid() || '-'} / items`);
    lines.push(`Sinkron        : ${diag.sync}`);
    lines.push(`Tes cloud      : ${diag.cloudTest}`);
  } else {
    lines.push(`Firebase       : ${cloudConfigured() ? 'terisi tapi gagal dimuat' : 'belum diisi di firebase-config.js'}`);
  }
  lines.push(`Error terakhir : ${diag.lastError}`);
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const names = 'caches' in window ? await caches.keys() : [];
    lines.push(`Service worker : ${reg ? (reg.active ? 'aktif' : 'belum aktif') : 'tidak ada'}; cache: ${names.join(', ') || '-'}`);
  } catch {
    lines.push('Service worker : -');
  }
  $('#diagText').textContent = lines.join('\n');
}

// Minta browser agar data lokal tidak dihapus otomatis saat penyimpanan HP penuh
async function requestPersistentStorage() {
  const info = $('#persistInfo');
  try {
    if (navigator.storage && navigator.storage.persist) {
      const granted = (await navigator.storage.persisted()) || (await navigator.storage.persist());
      info.textContent = granted ? 'Ya' : 'Belum';
    } else {
      info.textContent = 'Tidak didukung';
    }
  } catch {
    info.textContent = '-';
  }
}

function bindEvents() {
  // Ukuran tulisan
  $('#fontDown').addEventListener('click', () => changeFont(-1));
  $('#fontUp').addEventListener('click', () => changeFont(1));

  // Tab
  $$('.drawer [data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.go)));
  $('#menuBtn').addEventListener('click', () => ($('#drawer').classList.contains('open') ? closeDrawer() : openDrawer()));
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('#bannerGo').addEventListener('click', () => showTab('settings'));

  // Daftar barang
  $('#itemSearch').addEventListener('input', renderItems);
  $('#btnAddItem').addEventListener('click', () => openItemDialog(null));
  $('#itemForm').addEventListener('submit', saveItem);
  $('#btnDeleteItem').addEventListener('click', removeItem);

  // Totalan
  $('#calcSearch').addEventListener('input', renderCalcResults);
  $('#btnManual').addEventListener('click', () => openManualDialog());
  $('#manualForm').addEventListener('submit', addManual);
  $('#btnClear').addEventListener('click', clearCart);
  $('#btnDraft').addEventListener('click', saveDraftAndClear);
  $('#btnQris').addEventListener('click', showQris);
  $('#qrisFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';   // supaya file yang sama bisa dipilih lagi
    if (file) await uploadQris(file);
  });
  $('#btnQrisDelete').addEventListener('click', deleteQris);
  $('#btnPrint').addEventListener('click', printCart);

  // Riwayat
  $$('.seg [data-hist]').forEach((b) => b.addEventListener('click', () => showHist(b.dataset.hist)));
  $('#stockSearch').addEventListener('input', renderStockLog);
  $('#btnReprint').addEventListener('click', () => viewingReceipt && printNow(viewingReceipt));
  $('#btnReuse').addEventListener('click', reuseReceipt);
  $('#btnDeleteReceipt').addEventListener('click', deleteReceipt);

  // Tombol "Batal"/"Tutup" di semua dialog
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // Pengaturan. Judul diperbarui saat mengetik, disimpan saat selesai (change).
  $('#shopName').addEventListener('input', (e) => {
    const name = e.target.value.trim() || SHOP_DEFAULT.name;
    for (const id of ['#homeShop', '#drawerShop']) $(id).textContent = name;
  });
  $('#shopName').addEventListener('change', (e) => {
    settings.shopName = e.target.value.trim();
    data.saveSettings({ shopName: settings.shopName });
  });
  for (const [id, key] of [['#shopTag', 'shopTag'], ['#shopAddr', 'shopAddr'], ['#shopTel', 'shopTel']]) {
    $(id).addEventListener('change', (e) => {
      store.set(key, e.target.value.trim());
      applyNotaHead();
    });
  }
  $('#paperSize').addEventListener('change', (e) => {
    store.set('paper', e.target.value);
    applyPaper();
  });

  // Diagnosa
  $('#tab-settings details.card').addEventListener('toggle', renderDiag);
  $('#btnDiagCopy').addEventListener('click', async () => {
    await renderDiag();
    try {
      await navigator.clipboard.writeText($('#diagText').textContent);
      toast('Info disalin. Tempel ke chat.');
    } catch {
      toast('Tidak bisa menyalin. Foto layar saja.');
    }
  });
  $('#btnDiagTest').addEventListener('click', async () => {
    const btn = $('#btnDiagTest');
    btn.disabled = true;
    diag.cloudTest = 'menguji…';
    renderDiag();
    const result = await data.ping();
    diag.cloudTest = result.ok
      ? 'BERHASIL: server Firebase menerima data'
      : `GAGAL: ${result.code} (${result.message})`;
    btn.disabled = false;
    renderDiag();
    toast(result.ok ? 'Sambungan cloud berhasil' : 'Sambungan cloud gagal, lihat Diagnosa');
  });

  // Backup
  $('#btnShare').addEventListener('click', shareBackup);
  $('#btnDownload').addEventListener('click', downloadBackup);
  $('#btnDownload2').addEventListener('click', downloadBackup);
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // supaya file yang sama bisa dipilih lagi
    if (file) await importBackup(file);
  });
}

/* ===================================================================
 * 9. MULAI APLIKASI
 * =================================================================== */

// Cloud dipakai hanya kalau firebase-config.js sudah diisi (bukan "ISI_...")
function cloudConfigured() {
  const c = window.FIREBASE_CONFIG;
  return Boolean(c && c.apiKey && c.projectId && !String(c.apiKey).startsWith('ISI_') && !String(c.projectId).startsWith('ISI_'));
}

function showError(text) {
  $('#dbErrorText').textContent = text;
  $('#dbError').hidden = false;
}

// Mulai mendengarkan data. Dipanggil sekali di mode lokal, dan setiap kali
// berhasil login di mode cloud.
function startWatching() {
  stopWatchingAll();
  itemsLoaded = false;
  renderItems();

  const onError = (err) => {
    console.error(err);
    diag.lastError = describeError(err);
    showError(err && err.code === 'permission-denied'
      ? 'Tidak punya izin membaca data. Periksa aturan Firestore (lihat SETUP-FIREBASE.md).'
      : 'Gagal membaca data. Coba muat ulang halaman.');
  };

  stopWatching.push(data.watchItems((list) => {
    items = list;
    itemsLoaded = true;
    renderItems();
    renderCalcResults();
    updateBackupBanner();
  }, onError));
  stopWatching.push(data.watchReceipts((list) => {
    receipts = list;
    renderHistory();
  }, onError));
  stopWatching.push(data.watchDrafts((list) => {
    drafts = list;
    renderDrafts();
  }, onError));
  stopWatching.push(data.watchStockLog((list) => {
    stockLog = list;
    renderStockLog();
  }, onError));
  stopWatching.push(data.watchSettings((values) => {
    settings = { shopName: '', ...values };
    applySettingsToUI();
  }, onError));
}

function stopWatchingAll() {
  stopWatching.forEach((stop) => { try { stop(); } catch { /* abaikan */ } });
  stopWatching = [];
}

function setLocked(locked) {
  document.body.classList.toggle('locked', locked);
  $('#loginScreen').hidden = !locked;
}

async function startCloud() {
  document.body.classList.add('cloud');
  $('#modeInfo').textContent = 'cloud';
  setLocked(true);

  data.onWriteError((err) => {
    diag.lastError = describeError(err);
    // Banner merah (bukan hanya toast) supaya kegagalan simpan tidak terlewat
    showError(err && err.code === 'permission-denied'
      ? 'Perubahan DITOLAK Firebase (permission-denied). Periksa aturan Firestore, lihat SETUP-FIREBASE.md langkah 4.'
      : 'Perubahan belum sampai ke cloud: ' + describeError(err));
  });
  data.onSync(({ pending }) => {
    const el = $('#syncState');
    el.hidden = false;
    el.textContent = pending ? '⏳ Menunggu internet…' : '☁ Tersimpan di cloud';
    diag.sync = pending ? 'menunggu server' : 'tersinkron';
  });

  $('#btnLogin').addEventListener('click', async () => {
    $('#btnLogin').disabled = true;
    $('#loginMsg').textContent = 'Membuka halaman login Google…';
    try {
      await data.signIn();
    } catch (err) {
      console.error(err);
      $('#btnLogin').disabled = false;
      $('#loginMsg').textContent = err && err.code === 'auth/popup-closed-by-user'
        ? 'Login dibatalkan. Ketuk tombol di atas untuk mencoba lagi.'
        : 'Gagal masuk. Pastikan ada internet, lalu coba lagi.';
    }
  });

  $('#btnLogout').addEventListener('click', async () => {
    if (!confirm('Keluar dari akun? Data tetap aman di cloud.')) return;
    await data.signOut();
  });

  data.onUser((user) => {
    if (user) {
      $('#accountName').textContent = user.email || user.name || '-';
      setLocked(false);
      startWatching();
    } else {
      stopWatchingAll();
      items = []; receipts = []; drafts = []; stockLog = []; itemsLoaded = false; cart = []; currentDraftId = null;
      renderItems(); renderHistory(); renderCart(); renderDrafts(); renderStockLog();
      $('#syncState').hidden = true;
      setLocked(true);
      $('#btnLogin').disabled = false;
      $('#loginMsg').textContent = 'Ketuk tombol di atas untuk masuk.';
    }
  });
}

async function init() {
  bindEvents();
  loadFont();
  $('#appVersion').textContent = APP_VERSION;
  $('#modeInfo').textContent = 'lokal';
  $('#paperSize').value = store.get('paper', '58');
  applyPaper();
  renderCart();
  renderHistory();

  // Pilih adapter data
  if (cloudConfigured()) {
    try {
      const { createCloud } = await import('./cloud.js?v=' + APP_VERSION);
      data = createCloud(window.FIREBASE_CONFIG);
    } catch (err) {
      console.error(err);
      showError('Tidak bisa memuat layanan cloud. Buka aplikasi dengan internet sekali, lalu coba lagi. Sementara ini memakai penyimpanan lokal.');
    }
  }
  if (!data) {
    try {
      data = await createLocalData();
    } catch (err) {
      console.error(err);
      showError('Penyimpanan tidak tersedia di browser ini (mungkin mode penyamaran). Data tidak akan tersimpan.');
      return;
    }
  }

  if (data.kind === 'cloud') await startCloud();
  else startWatching();

  updateBackupBanner();
  requestPersistentStorage();

  // Service worker: membuat aplikasi bisa dibuka tanpa internet
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.error('SW gagal:', err));
  }
}

init();
