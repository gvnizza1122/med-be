/**
 * Ambang klinis (vital-sign thresholds) dipakai layer "bukti kegawatan" pada
 * mesin pencarian kode (lihat pencarianKodeService.js) maupun rule engine
 * (dikerjakan agen lain terhadap kontrak skema yang sama). Modul ini HANYA
 * memiliki tabel `ambang_klinis` + fungsi murni pembaca ambang -- logika
 * "determinan vs bukti" (bagian 3 dari catatan produk) sengaja TIDAK dibangun
 * di sini, itu tugas modul lain.
 *
 * PENTING -- INI TITIK AWAL, BUKAN KEPUTUSAN FINAL. Kutipan dari catatan
 * produk sendiri: "Ambang klinis disimpan sebagai pengaturan ... Nilai
 * akhirnya ditetapkan casemix RS". Baris seed di bawah ditandai
 * `sumber='default_awal'`; `diubah_oleh`/`diubah_pada` tetap NULL sampai ada
 * yang mengubahnya lewat UI admin (belum dibangun, di luar cakupan tugas ini).
 *
 * FORMAT `nilai_ambang` -- JSON teks, BUKAN string bebas gaya ">=180/120"
 * dari catatan produk aslinya. Dipilih karena JSON bisa di-parse pasti tanpa
 * menulis grammar comparator buatan sendiri; catatan produk sendiri
 * mengizinkan "JSON terstruktur kecil ATAU string sederhana" -- ini pilihan
 * JSON-nya, didokumentasikan di sini sebagai satu-satunya tempat format ini
 * perlu dipahami:
 *   tekanan_darah : {"sistolOp":">=","sistol":180,"diastolOp":">=","diastol":120}
 *                   (krisis hipertensi = SALAH SATU ambang terlampaui, bukan keduanya)
 *   suhu          : {"op":">=","nilai":40}
 *   nyeri_vas     : {"berat":[7,10],"sedang":[4,6],"ringan":[1,3]}  (inklusif)
 *   spo2          : {"op":"<","nilai":94}
 *   nadi          : {"op":">","nilai":100}
 */

const DEFAULT_AMBANG = [
  {
    penanda: 'tekanan_darah',
    nilaiAmbang: { sistolOp: '>=', sistol: 180, diastolOp: '>=', diastol: 120 },
    arti: 'Bukti krisis hipertensi. Cocokkan dengan diagnosis dokter',
  },
  {
    penanda: 'suhu',
    // Catatan produk sendiri: definisi hiperpireksia bervariasi 40-41 derajat C;
    // 40 dipakai sebagai batas bawah yang lebih aman (lebih sensitif) sampai
    // casemix menetapkan angka final.
    nilaiAmbang: { op: '>=', nilai: 40 },
    arti: 'Bukti hiperpireksia',
  },
  {
    penanda: 'nyeri_vas',
    nilaiAmbang: { berat: [7, 10], sedang: [4, 6], ringan: [1, 3] },
    arti: 'Bukti kegawatan',
  },
  {
    penanda: 'spo2',
    nilaiAmbang: { op: '<', nilai: 94 },
    arti: 'Bukti gangguan napas',
  },
  {
    penanda: 'nadi',
    nilaiAmbang: { op: '>', nilai: 100 },
    arti: 'Takikardi, bukti kegawatan',
  },
];

async function ensureSchema(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ambang_klinis (
      id SERIAL PRIMARY KEY,
      penanda VARCHAR(40) NOT NULL UNIQUE,
      nilai_ambang TEXT NOT NULL,
      arti TEXT NOT NULL,
      sumber TEXT,
      diubah_oleh TEXT,
      diubah_pada TIMESTAMP
    )
  `);
  for (const d of DEFAULT_AMBANG) {
    await db.run(
      `INSERT INTO ambang_klinis (penanda, nilai_ambang, arti, sumber)
       VALUES (?, ?, ?, 'default_awal')
       ON CONFLICT (penanda) DO NOTHING`,
      [d.penanda, JSON.stringify(d.nilaiAmbang), d.arti],
    );
  }
}

function bacaOp(op, nilai, ambang) {
  switch (op) {
    case '>=': return nilai >= ambang;
    case '>': return nilai > ambang;
    case '<=': return nilai <= ambang;
    case '<': return nilai < ambang;
    case '==': return nilai === ambang;
    default: throw new Error(`Operator ambang tidak dikenal: ${op}`);
  }
}

function dalamRentang(v, rentang) {
  if (!Array.isArray(rentang) || rentang.length !== 2) return false;
  const [min, maks] = rentang;
  return v >= min && v <= maks;
}

/** Ambil nilai_ambang terparse untuk satu penanda dari baris tabel; jatuh ke default bila baris hilang/rusak. */
function bacaNilai(baris, penanda) {
  const fallback = DEFAULT_AMBANG.find((d) => d.penanda === penanda);
  const row = (baris || []).find((r) => r.penanda === penanda);
  if (!row) return { nilai: fallback.nilaiAmbang, arti: fallback.arti, sumber: 'default_awal (baris tidak ada di tabel)' };
  let nilai;
  try {
    nilai = typeof row.nilai_ambang === 'string' ? JSON.parse(row.nilai_ambang) : row.nilai_ambang;
  } catch {
    nilai = fallback.nilaiAmbang; // nilai_ambang rusak -- jangan sampai layer evidence crash, pakai default & tetap jalan
  }
  return { nilai, arti: row.arti != null ? row.arti : fallback.arti, sumber: row.sumber || null };
}

/**
 * Bangun penerjemah ambang klinis (murni, tanpa DB) dari baris-baris tabel
 * `ambang_klinis` yang sudah dibaca. Dipisah dari `terjemahkanAmbangKlinis`
 * supaya logika pencocokan bisa diuji dengan data buatan tanpa DB tiruan.
 */
function buatPenerjemahDariBaris(baris) {
  const td = bacaNilai(baris, 'tekanan_darah');
  const suhu = bacaNilai(baris, 'suhu');
  const vas = bacaNilai(baris, 'nyeri_vas');
  const spo2 = bacaNilai(baris, 'spo2');
  const nadi = bacaNilai(baris, 'nadi');

  return {
    ambang: { tekanan_darah: td, suhu, nyeri_vas: vas, spo2, nadi },

    /** Krisis hipertensi = sistol ATAU diastol melampaui ambang (bukan keduanya wajib). */
    cocokTekananDarah(sistol, diastol) {
      const a = td.nilai;
      const cocok = bacaOp(a.sistolOp, Number(sistol), a.sistol) || bacaOp(a.diastolOp, Number(diastol), a.diastol);
      return { cocok, arti: cocok ? td.arti : null, ambang: a };
    },
    cocokSuhu(c) {
      const a = suhu.nilai;
      const cocok = bacaOp(a.op, Number(c), a.nilai);
      return { cocok, arti: cocok ? suhu.arti : null, ambang: a };
    },
    /** VAS: kategori selalu dikembalikan; `cocok` (bukti kegawatan) hanya true utk kategori 'berat'. */
    cocokVas(n) {
      const a = vas.nilai;
      const v = Number(n);
      let kategori = null;
      if (dalamRentang(v, a.berat)) kategori = 'berat';
      else if (dalamRentang(v, a.sedang)) kategori = 'sedang';
      else if (dalamRentang(v, a.ringan)) kategori = 'ringan';
      return { kategori, cocok: kategori === 'berat', arti: kategori === 'berat' ? vas.arti : null, ambang: a };
    },
    cocokSpo2(pct) {
      const a = spo2.nilai;
      const cocok = bacaOp(a.op, Number(pct), a.nilai);
      return { cocok, arti: cocok ? spo2.arti : null, ambang: a };
    },
    cocokNadi(n) {
      const a = nadi.nilai;
      const cocok = bacaOp(a.op, Number(n), a.nilai);
      return { cocok, arti: cocok ? nadi.arti : null, ambang: a };
    },
  };
}

async function terjemahkanAmbangKlinis(db) {
  const baris = await db.all('SELECT * FROM ambang_klinis');
  return buatPenerjemahDariBaris(baris);
}

module.exports = {
  DEFAULT_AMBANG,
  ensureSchema,
  terjemahkanAmbangKlinis,
  buatPenerjemahDariBaris,
  bacaOp,
  dalamRentang,
};
