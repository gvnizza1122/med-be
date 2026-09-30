/**
 * Pemantau pergeseran alasan pending BPJS (Tahap 2) — fungsi MURNI.
 *
 * Mengamati rekap pending dari waktu ke waktu dan memberi TANDA bila pola
 * alasan bergeser: (1) kategori alasan yang belum pernah muncul, (2) pangsa
 * satu kategori melonjak jauh di atas rata-rata 3 bulan sebelumnya, (3)
 * lonjakan pending per diagnosis.
 *
 * SIFAT KEAMANAN
 *  - Hanya membaca baris yang disuntikkan; tidak menyentuh DB, jaringan, atau
 *    model. Baris asli dari bpjs_pending_responses (kolom: tanggal_pending,
 *    alasan_raw, alasan_parsed, kdinacbg, nama_peserta, sep, ...) cukup
 *    dipetakan pemanggil; hanya `tanggal`, `kategori`, dan kunci diagnosis yang
 *    dibaca. Nama peserta/SEP/kartu tidak dipakai dan tidak dikembalikan.
 *  - Keluarannya tanda untuk dilihat manusia. Tidak ada gerbang: tanda tidak
 *    menahan klaim, tidak mengubah status pending, dan tidak mengaktifkan rule.
 *  - Data tipis dijawab jujur: tanpa bulan pembanding sama sekali,
 *    data_cukup=false dan tidak ada tanda (tabel pending saat ini kosong).
 *  - Ambang (rasio 2x, selisih >= 10 poin persen, minimal 5 kasus) adalah
 *    PERKIRAAN awal yang dapat diatur lewat opsi; belum dikalibrasi terhadap
 *    data nyata RS.
 */

const BAWAAN = Object.freeze({
  jendela: 3,          // jumlah bulan pembanding (kalender) sebelum bulan pantau
  rasio: 2,            // pangsa/jumlah harus >= rasio x rata-rata
  selisihPangsa: 0.10, // dan naik >= 10 poin persen (pangsa)
  minKasus: 5,         // dan minimal sekian kasus di bulan pantau
});

function normKategori(k) {
  const s = String(k == null ? '' : k).trim().toLowerCase().replace(/[\s\-/]+/g, '_');
  return s || 'tidak_terklasifikasi';
}

/** 'YYYY-MM-DD', 'DD/MM/YYYY', 'DD-MM-YYYY', 'YYYY-MM', Date -> 'YYYY-MM' atau null. */
function bulanDari(tanggal) {
  if (tanggal instanceof Date && !isNaN(tanggal)) {
    return `${tanggal.getFullYear()}-${String(tanggal.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(tanggal == null ? '' : tanggal).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?/);
  if (m) return ok(m[1], m[2]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return ok(m[3], m[2]);
  return null;
}
function ok(th, bl) {
  const b = Number(bl);
  return b >= 1 && b <= 12 ? `${th}-${String(b).padStart(2, '0')}` : null;
}

function geserBulan(bulan, n) {
  const [th, bl] = bulan.split('-').map(Number);
  const idx = th * 12 + (bl - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

/**
 * Ringkas baris menjadi peta bulan -> {total, kategori:{}, diagnosis:{}}.
 * @param {object[]} rows
 * @param {{kategorikan?:(row)=>string, kunciDiagnosis?:(row)=>string}} [opsi]
 */
function ringkasPerBulan(rows, opsi = {}) {
  const kategorikan = opsi.kategorikan || ((r) => r.kategori ?? r.alasan_parsed);
  const kunciDx = opsi.kunciDiagnosis || ((r) => r.diagnosis ?? r.kode_diagnosis ?? r.kdinacbg);
  const peta = {};
  for (const r of rows || []) {
    if (!r) continue;
    const bulan = r.bulan ? bulanDari(r.bulan) : bulanDari(r.tanggal_pending ?? r.tanggal);
    if (!bulan) continue;
    const b = peta[bulan] || (peta[bulan] = { total: 0, kategori: {}, diagnosis: {} });
    b.total++;
    const kat = normKategori(kategorikan(r));
    b.kategori[kat] = (b.kategori[kat] || 0) + 1;
    const dx = kunciDx(r);
    if (dx != null && String(dx).trim() !== '') {
      const d = String(dx).trim().toUpperCase();
      b.diagnosis[d] = (b.diagnosis[d] || 0) + 1;
    }
  }
  return peta;
}

function bulanPembanding(peta, bulanIni, jendela) {
  const daftar = [];
  for (let i = 1; i <= jendela; i++) {
    const b = geserBulan(bulanIni, -i);
    if (peta[b] && peta[b].total > 0) daftar.push(b);
  }
  return daftar; // hanya bulan yang benar-benar punya data
}

function rata(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Kategori yang muncul di bulan pantau tetapi tidak pernah di bulan sebelumnya. */
function deteksiKategoriBaru(peta, bulanIni, opsi = {}) {
  const o = { ...BAWAAN, ...opsi };
  const kini = peta[bulanIni];
  if (!kini) return [];
  const dikenal = new Set((o.kategoriDikenal || []).map(normKategori));
  for (const [b, v] of Object.entries(peta)) {
    if (b < bulanIni) Object.keys(v.kategori).forEach((k) => dikenal.add(k));
  }
  const hasil = [];
  for (const [kat, n] of Object.entries(kini.kategori)) {
    if (!dikenal.has(kat) && n >= 1) hasil.push({ kategori: kat, jumlah: n, pangsa: +(n / kini.total).toFixed(4) });
  }
  return hasil.sort((a, b) => b.jumlah - a.jumlah);
}

/** Pangsa kategori jauh di atas rata-rata pangsa bulan-bulan pembanding. */
function deteksiLonjakanPangsa(peta, bulanIni, opsi = {}) {
  const o = { ...BAWAAN, ...opsi };
  const kini = peta[bulanIni];
  const banding = bulanPembanding(peta, bulanIni, o.jendela);
  if (!kini || banding.length === 0) return [];
  const hasil = [];
  for (const [kat, n] of Object.entries(kini.kategori)) {
    const pangsa = n / kini.total;
    const rerata = rata(banding.map((b) => (peta[b].kategori[kat] || 0) / peta[b].total));
    if (rerata === 0) continue; // kategori baru -> urusan deteksiKategoriBaru
    if (n >= o.minKasus && pangsa >= o.rasio * rerata && pangsa - rerata >= o.selisihPangsa) {
      hasil.push({
        kategori: kat, jumlah: n, pangsa: +pangsa.toFixed(4), rata_pangsa_pembanding: +rerata.toFixed(4),
        rasio: +(pangsa / rerata).toFixed(2), bulan_pembanding: banding,
      });
    }
  }
  return hasil.sort((a, b) => b.rasio - a.rasio);
}

/** Jumlah pending per diagnosis melonjak dibanding rata-rata bulan pembanding. */
function deteksiLonjakanDiagnosis(peta, bulanIni, opsi = {}) {
  const o = { ...BAWAAN, ...opsi };
  const kini = peta[bulanIni];
  const banding = bulanPembanding(peta, bulanIni, o.jendela);
  if (!kini || banding.length === 0) return [];
  const hasil = [];
  for (const [dx, n] of Object.entries(kini.diagnosis)) {
    if (n < o.minKasus) continue;
    const rerata = rata(banding.map((b) => peta[b].diagnosis[dx] || 0));
    if (rerata === 0 || n >= o.rasio * rerata) {
      hasil.push({
        diagnosis: dx, jumlah: n, rata_pembanding: +rerata.toFixed(2),
        rasio: rerata === 0 ? null : +(n / rerata).toFixed(2), baru_muncul: rerata === 0,
        bulan_pembanding: banding,
      });
    }
  }
  return hasil.sort((a, b) => (b.rasio ?? Infinity) - (a.rasio ?? Infinity) || b.jumlah - a.jumlah);
}

/**
 * Titik masuk: jalankan ketiga deteksi untuk bulan pantau.
 * @param {object[]} rows baris rekap pending (lihat header)
 * @param {{bulan?:string, kategorikan?, kunciDiagnosis?, jendela?, rasio?, selisihPangsa?, minKasus?, kategoriDikenal?:string[]}} [opsi]
 */
function pantauPergeseran(rows, opsi = {}) {
  const peta = ringkasPerBulan(rows, opsi);
  const bulanAda = Object.keys(peta).sort();
  const bulanIni = opsi.bulan || bulanAda[bulanAda.length - 1] || null;
  const o = { ...BAWAAN, ...opsi };
  if (!bulanIni || !peta[bulanIni]) {
    return {
      bulan: bulanIni, data_cukup: false, bulan_pembanding: [], kategori_baru: [], lonjakan_pangsa: [],
      lonjakan_diagnosis: [], catatan: 'Tidak ada data pending pada bulan pantau.',
    };
  }
  const banding = bulanPembanding(peta, bulanIni, o.jendela);
  const cukup = banding.length > 0;
  const kategoriBaru = deteksiKategoriBaru(peta, bulanIni, opsi);
  return {
    bulan: bulanIni,
    total_bulan_ini: peta[bulanIni].total,
    data_cukup: cukup,
    bulan_pembanding: banding,
    // Tanpa bulan pembanding, "baru" tidak bermakna (semuanya baru).
    kategori_baru: cukup ? kategoriBaru : [],
    lonjakan_pangsa: deteksiLonjakanPangsa(peta, bulanIni, opsi),
    lonjakan_diagnosis: deteksiLonjakanDiagnosis(peta, bulanIni, opsi),
    catatan: cukup ? null : 'Belum ada bulan pembanding; belum ada tanda yang bisa dihitung.',
  };
}

module.exports = {
  BAWAAN, bulanDari, normKategori, ringkasPerBulan, deteksiKategoriBaru,
  deteksiLonjakanPangsa, deteksiLonjakanDiagnosis, pantauPergeseran,
};
