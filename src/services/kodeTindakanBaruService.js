/**
 * Memberi kode pada tindakan yang belum ada di kamus.
 *
 * Kamus tindakan bawaan hanya memuat segelintir istilah. Begitu berkas memuat
 * tindakan baru — "pasang kateter", "jahit luka", "ganti verban" — kolom
 * prosedur akan kosong sampai seseorang menambahkannya secara manual. AI
 * dipakai untuk menutup celah itu.
 *
 * TIGA LAPIS PENGAMAN, dan urutannya penting:
 *
 *   1. Kamus yang dipelajari. Istilah yang pernah diberi kode disimpan, jadi
 *      kemunculan berikutnya dijawab tanpa memanggil AI sama sekali —
 *      deterministik, seketika, dan tanpa biaya. AI dipanggil SEKALI seumur
 *      hidup per istilah, bukan sekali per klaim.
 *
 *   2. Kode wajib ada di kamus ICD-9-CM resmi. Ini menangkap kode karangan,
 *      yang merupakan kegagalan paling sering pada pemberian kode oleh model.
 *
 *   3. Setiap pemetaan dicatat beserta kalimat asal dan tanggalnya. Pagar
 *      nomor 2 TIDAK bisa menangkap kode yang nyata tetapi keliru — misalnya
 *      "pasang kateter" diberi kode selang lambung. Kode seperti itu lolos
 *      semua pemeriksaan otomatis. Catatan ini satu-satunya cara memperbaiki
 *      kekeliruan semacam itu sekaligus untuk seluruh klaim yang terdampak,
 *      alih-alih mencarinya satu per satu.
 *
 * Batas yang jujur: tidak ada pemeriksaan otomatis yang bisa memastikan sebuah
 * kode ICD-9 benar-benar menggambarkan tindakan yang dimaksud. Yang bisa
 * dijamin hanyalah kodenya nyata dan pemetaannya tercatat.
 */

const { getDb } = require('../database/init');
const gatewayModelService = require('./gatewayModelService');

/** Samakan bentuk kalimat tindakan supaya "Inj. Omeprazole 1A" dan "inj omeprazole 1a" dianggap sama. */
function kunciIstilah(teks) {
  return String(teks || '')
    .toLowerCase()
    .replace(/\d+/g, '')          // dosis tidak membedakan jenis tindakan
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SISTEM_PROMPT = `Anda pemberi kode ICD-9-CM untuk klaim BPJS Indonesia.

Diberikan kalimat tindakan medis yang tertulis di resume medis rumah sakit.
Tentukan kode prosedur ICD-9-CM yang paling tepat untuk TIAP kalimat.

ATURAN MUTLAK:
- Hanya kode ICD-9-CM yang benar-benar ada. Jangan mengarang kode.
- Kalau tidak yakin, isi kode dengan null. Menjawab null jauh lebih baik
  daripada menebak: kode yang salah akan terkirim ke BPJS atas nama rumah
  sakit.
- Jangan memberi kode pada hal yang bukan tindakan (nama ruangan, catatan
  rencana, tanda tangan, kalimat kosong).
- Pemberian obat oral BUKAN prosedur. Hanya pemberian lewat suntikan atau
  infus yang dikode.

Jawab JSON: {"hasil":[{"teks":"...","kode":"99.29","nama":"Injeksi obat","yakin":"tinggi|sedang|rendah"}]}
Pakai kode null kalau tidak yakin.`;

/** Kamus yang sudah dipelajari, dibaca lebih dulu supaya AI tidak dipanggil ulang. */
async function ambilKamusDipelajari(db, kunci) {
  if (kunci.length === 0) return new Map();
  const tanda = kunci.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT kunci, kode, nama FROM kamus_tindakan_dipelajari WHERE kunci IN (${tanda})`,
    kunci,
  );
  return new Map(rows.map(r => [r.kunci, { kode: r.kode, nama: r.nama }]));
}

async function simpanKamus(db, kunci, kode, nama, teksAsal) {
  await db.run(
    `INSERT INTO kamus_tindakan_dipelajari (kunci, kode, nama, teks_asal, dipelajari_pada)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(kunci) DO UPDATE SET dipakai_terakhir = CURRENT_TIMESTAMP`,
    [kunci, kode, nama, String(teksAsal || '').slice(0, 200)],
  );
}

/** Kode wajib benar-benar ada di kamus ICD-9-CM resmi. */
async function saringKodeNyata(db, kode) {
  const bersih = [...new Set(kode.filter(Boolean).map(k => String(k).trim().toUpperCase()))];
  if (bersih.length === 0) return new Set();
  const tanda = bersih.map(() => '?').join(', ');
  const rows = await db.all(
    `SELECT code FROM icd9_cm_procedures WHERE upper(code) IN (${tanda})`,
    bersih,
  );
  return new Set(rows.map(r => String(r.code).toUpperCase()));
}

/**
 * Beri kode pada kalimat tindakan yang tidak dikenali kamus bawaan.
 *
 * @param {string[]} kalimatTindakan kalimat mentah dari kolom Tindakan
 * @returns {Promise<Array<{teks, kode, nama, dari}>>}
 */
async function kodekanTindakanBaru(kalimatTindakan, dikenal = {}) {
  const unik = [...new Set((kalimatTindakan || []).map(t => String(t || '').trim()).filter(Boolean))];
  if (unik.length === 0) return [];

  const db = getDb();
  const peta = new Map(unik.map(t => [t, kunciIstilah(t)]));
  const hasil = [];

  // Lapis 1 — yang sudah pernah dipelajari dijawab tanpa AI.
  let dipelajari = new Map();
  try {
    dipelajari = await ambilKamusDipelajari(db, [...new Set([...peta.values()])]);
  } catch (err) {
    console.warn(`[KodeTindakan] Kamus dipelajari tidak terbaca: ${err.message}`);
  }

  const belumDikenal = [];
  for (const teks of unik) {
    const k = peta.get(teks);
    const tersimpan = dipelajari.get(k);
    if (tersimpan && tersimpan.kode) {
      hasil.push({ teks, kode: tersimpan.kode, nama: tersimpan.nama, dari: 'kamus_dipelajari' });
    } else if (!dipelajari.has(k)) {
      belumDikenal.push(teks);
    }
    // kunci yang tersimpan dengan kode null = pernah ditanyakan dan AI tidak
    // yakin. Tidak ditanyakan lagi, supaya tidak membayar token berulang untuk
    // kalimat yang memang bukan tindakan.
  }
  if (belumDikenal.length === 0) return hasil;

  // Lapis 2 — tanya AI, lalu saring terhadap kamus resmi.
  if (!process.env.AI_PROVIDER_API_KEY && !process.env.KIMI_API_KEY) return hasil;

  let usulan = [];
  try {
    const panggilan = await gatewayModelService.panggilModel('kodekan_tindakan_baru', {
      system: SISTEM_PROMPT,
      prompt: belumDikenal.map(t => `- ${t}`).join('\n'),
      json: true,
      maxTokens: 1200,
      dikenal,
    }, { db });
    if (!panggilan.ok) throw new Error(panggilan.error || 'Panggilan gateway gagal');
    usulan = panggilan.hasil && Array.isArray(panggilan.hasil.hasil) ? panggilan.hasil.hasil : [];
  } catch (err) {
    console.warn(`[KodeTindakan] Gagal meminta kode: ${err.message}`);
    return hasil;
  }

  const nyata = await saringKodeNyata(db, usulan.map(u => u && u.kode));

  for (const u of usulan) {
    if (!u || !u.teks) continue;
    const kunci = kunciIstilah(u.teks);
    const kode = u.kode ? String(u.kode).trim().toUpperCase() : null;

    // Kode karangan dibuang di sini. Yang tersisa pasti ada di ICD-9-CM.
    const sah = kode && nyata.has(kode);

    try {
      await simpanKamus(db, kunci, sah ? kode : null, u.nama || null, u.teks);
    } catch (err) {
      console.warn(`[KodeTindakan] Gagal menyimpan pemetaan: ${err.message}`);
    }
    if (!sah) {
      if (kode) console.warn(`[KodeTindakan] Kode "${kode}" untuk "${u.teks}" tidak ada di ICD-9-CM — dibuang.`);
      continue;
    }
    hasil.push({ teks: u.teks, kode, nama: u.nama || 'Tindakan', dari: 'ai' });
  }

  return hasil;
}

module.exports = { kodekanTindakanBaru, kunciIstilah };
