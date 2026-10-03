/**
 * Agen Casemix -- inti (mode otomatis): menyatukan seluruh lapisan menjadi satu
 * laporan casemix yang dapat ditinjau petugas, sesuai format kerja tim:
 * ringkasan klinis & kronologi, rekomendasi koding berstatus, persyaratan
 * klaim, pertanyaan klarifikasi, risiko pending, alternatif koding yang SAH
 * beserta dampak kelompok/tarif (dari grouper, bukan karangan), dan jejak
 * kerja (langkah yang dijalankan + biaya AI).
 *
 * Laporan disusun TANPA AI dari hasil lapisan yang sudah berjalan (aturan
 * koding, agen tinjau, penalaran diagnosis, pemeriksa kritis, Sol), sehingga
 * murah dan selalu sesuai data terbaru. Tidak mengubah data klaim.
 */
const { deskripsiDiagnosis, deskripsiProsedur } = require('./kamusKodeService');
const { kodeFinal } = require('./pemeriksaKritisService');
const { labelSumber } = require('./registriRegulasiService');

const LABEL_STATUS = {
  terkonfirmasi: 'didukung_bukti', perlu_klarifikasi: 'perlu_klarifikasi', diagnosis_banding: 'perlu_klarifikasi',
  riwayat: 'belum_cukup_bukti', belum_cukup_bukti: 'belum_cukup_bukti',
};

function grup(hitung, record, dx, px) {
  if (!dx.length || typeof hitung !== 'function') return { inacbg: null, deskripsi: null, tarif: null };
  const h = hitung(dx, px, record.jenis_klaim || record.JENIS_KLAIM, record.kelas_rawat || record.KELAS_RAWAT, null);
  return { inacbg: h && h.inacbgResult ? h.inacbgResult.code : null, deskripsi: h && h.inacbgResult ? h.inacbgResult.description : null,
    tarif: h && h.tarifResult && h.tarifResult.amount != null ? Number(h.tarifResult.amount) : null };
}

/** Alternatif koding yang SAH: hanya variasi yang punya dasar dokumentasi. */
function alternatifKoding({ record, dx, px, penalaran, kritis, hitung }) {
  const dasar = grup(hitung, record, dx, px);
  const hasil = [];
  const tambah = (judul, dx2, px2, syarat, jenis) => {
    const g = grup(hitung, record, dx2, px2);
    if (!g.inacbg || (g.inacbg === dasar.inacbg && JSON.stringify(dx2) === JSON.stringify(dx) && JSON.stringify(px2) === JSON.stringify(px))) return;
    hasil.push({ jenis, judul, diagnosis: dx2, prosedur: px2, ...g, selisih_tarif: dasar.tarif != null && g.tarif != null ? g.tarif - dasar.tarif : null, syarat });
  };
  // Diagnosis sekunder yang belum didukung: dampak bila TIDAK dikode (sisi kepatuhan).
  const lemah = ((penalaran && penalaran.diagnosis) || []).filter(d => d.peran === 'sekunder' && d.status !== 'terkonfirmasi').map(d => d.kode);
  if (lemah.length) {
    tambah(`Tanpa diagnosis sekunder yang belum didukung bukti (${lemah.join(', ')})`, dx.filter(k => !lemah.includes(k)), px,
      'Berlaku bila klarifikasi dokter tidak menguatkan diagnosis tersebut.', 'kepatuhan');
  }
  // Prosedur yang terbaca dilakukan tetapi belum dikode (sisi rugi RS).
  for (const t of ((kritis && kritis.temuan) || []).filter(x => x.jenis === 'kode_terlewat' && /\b\d{2}\.\d{1,2}\b/.test(x.pesan))) {
    const kode = (t.pesan.match(/\b(\d{2}\.\d{1,2})\b/) || [])[1];
    if (kode && deskripsiProsedur(kode) && !px.includes(kode)) {
      tambah(`Dengan prosedur ${kode} ${deskripsiProsedur(kode)}`, dx, [...px, kode], 'Berlaku bila tindakan tersebut benar dilakukan dan terdokumentasi.', 'optimasi');
    }
  }
  return { dasar: { diagnosis: dx, prosedur: px, ...dasar }, alternatif: hasil };
}

/** Persyaratan klaim: terpenuhi / belum ditemukan / perlu konfirmasi. */
function persyaratan(ai) {
  const daftar = [];
  for (const s of ai.syarat_penunjang || []) {
    for (const sy of s.syarat || []) {
      daftar.push({ syarat: `${s.nama_diagnosis || s.kode_diagnosis}: ${sy.nama || sy.deskripsi || sy.id}`,
        status: sy.status === 'terpenuhi' ? 'terpenuhi' : sy.status === 'perlu_cek_manual' ? 'perlu_konfirmasi' : 'belum_ditemukan',
        sumber: s.sumber_aturan || 'syarat penunjang RS', regulasi: labelSumber('REKAP-PENDING-RS'), bukti: sy.bukti || null });
    }
  }
  const igd = ai.kegawatdaruratan_assessment;
  if (igd && igd.kunjungan_igd === true && Array.isArray(igd.kriteria)) {
    const ya = igd.kriteria.filter(k => k.status === 'ya');
    daftar.push({ syarat: 'Kriteria kegawatdaruratan (Permenkes 47/2018) untuk kunjungan IGD',
      status: ya.length ? 'terpenuhi' : igd.kriteria.some(k => k.status === 'borderline') ? 'perlu_konfirmasi' : 'belum_ditemukan',
      sumber: 'Permenkes 47/2018 Pasal 3', regulasi: labelSumber('PMK-47-2018'), bukti: ya.map(k => k.kriteria).join(', ') || null });
  }
  for (const k of ai.kombinasi_kode || []) {
    daftar.push({ syarat: `Ketentuan kombinasi kode ${k.kode}: ${k.nama}`, status: 'perlu_konfirmasi', sumber: k.sumber || 'Berita Acara Kesepakatan', regulasi: labelSumber(k.sumber === 'casemix_rs' ? 'KONVENSI-KODING-RS' : 'BA-KESEPAKATAN-2018'), bukti: k.pesan || null });
  }
  const op = (ai.konsistensi_data || []).find(k => k.id === 'KD-OP');
  if (op) daftar.push({ syarat: 'Operasi terdokumentasi harus dikode tindakannya', status: 'belum_ditemukan', sumber: 'Konsistensi berkas', bukti: op.yang_ditemukan ? op.yang_ditemukan.kutipan : null });
  return daftar;
}

/** Jejak kerja agen: langkah yang dijalankan, statusnya, dan biaya AI. */
function jejakKerja(ai) {
  // Berkas yang dibaca dengan orkestrator: jejak langsung dari sesi agen (sejak OCR selesai).
  if (ai.agen_casemix && Array.isArray(ai.agen_casemix.langkah) && ai.agen_casemix.langkah.length) {
    return { langkah: ai.agen_casemix.langkah, total_biaya_ai_idr: ai.agen_casemix.total_biaya_ai_idr || 0, sumber: 'orkestrator', durasi_detik: ai.agen_casemix.durasi_detik };
  }
  const langkah = [];
  const catat = (nama, status, biaya, keterangan) => langkah.push({ nama, status, biaya_idr: biaya == null ? null : Math.round(biaya), keterangan: keterangan || null });
  if (ai.fakta_klinis) catat('Menyusun fakta klinis (anamnesis, fisik, penunjang, terapi)', 'selesai', 0, `${ai.fakta_klinis.jumlah} fakta berkutipan`);
  const aturan = [...(ai.koding_obstetri || []), ...(ai.koding_bedah || []), ...(ai.koding_neoplasma || [])];
  catat('Aturan koding RS (obstetri, bedah, neoplasma)', aturan.length ? 'mengubah' : 'tidak_ada_perubahan', 0, aturan.length ? aturan.map(a => `${a.aksi} ${a.kode}`).join(', ') : null);
  if (ai.agen_tinjau) catat('Agen tinjau (kamus, grouper, halaman)', ai.agen_tinjau.status, ai.agen_tinjau.biaya_idr, (ai.agen_tinjau.masalah || []).length ? `${ai.agen_tinjau.masalah.length} masalah` : null);
  if (ai.penalaran_diagnosis) catat('Penalaran diagnosis', ai.penalaran_diagnosis.status, ai.penalaran_diagnosis.biaya_idr, null);
  if (ai.analisis_kritis) catat('Pemeriksa kritis', ai.analisis_kritis.ai_gagal ? 'sebagian' : 'selesai', ai.analisis_kritis.biaya_idr, `keyakinan ${ai.analisis_kritis.skor_keyakinan}/100`);
  if (ai.tinjauan_diagnosis) catat('Tinjauan diagnosis', ai.tinjauan_diagnosis.status, null, null);
  const sol = ai.pemeriksaan_lanjutan;
  if (sol && sol.status !== 'tidak_diperlukan') catat('Pemeriksaan lanjutan (Sol)', sol.status, sol.biaya && sol.biaya.idr, sol.dari_cache ? 'dari cache' : (sol.pemicu || []).join(', '));
  const total = langkah.reduce((n, l) => n + (l.biaya_idr || 0), 0);
  return { langkah, total_biaya_ai_idr: total };
}

/**
 * @returns {object} laporan_casemix
 */
function susunLaporanCasemix({ record, ai, faktaKlinis, saran, hitungInacbgDanTarif, kronologi = null, pelajaran = [], keputusan = null }) {
  const a = ai || {};
  const { dx, px } = kodeFinal(record, a);
  const penalaran = a.penalaran_diagnosis && a.penalaran_diagnosis.status === 'selesai' ? a.penalaran_diagnosis : null;
  const kritis = a.analisis_kritis || null;
  const perKat = (faktaKlinis && faktaKlinis.per_kategori) || {};
  const ambil = (k, n = 4) => (perKat[k] || []).slice(0, n).map(f => ({ teks: f.teks, halaman: f.halaman }));

  const statusPenalaran = new Map(((penalaran && penalaran.diagnosis) || []).map(d => [d.kode, d]));
  const buktiSaran = new Map([...(saran && saran.diagnosis ? saran.diagnosis : []), ...(saran && saran.prosedur ? saran.prosedur : [])].map(s => [s.kode, s]));
  const rekomendasi = [
    ...dx.map((k, i) => {
      const p = statusPenalaran.get(k); const s = buktiSaran.get(k);
      return { jenis: 'diagnosis', peran: i === 0 ? 'utama' : 'sekunder', kode: k, deskripsi: deskripsiDiagnosis(k) || null,
        status: p ? LABEL_STATUS[p.status] || 'perlu_klarifikasi' : (s && s.bukti && s.bukti.length ? 'didukung_bukti' : 'belum_dinilai'),
        alasan: p ? p.alasan : (s && s.catatan) || null,
        bukti: p ? p.mendukung.map(b => ({ kutipan: b.kutipan, halaman: b.halaman, jenis: b.jenis })) : ((s && s.bukti) || []).map(b => ({ kutipan: b.kutipan, halaman: b.halaman })),
        ketidakpastian: p ? [...p.belum_ada, ...p.melemahkan.map(m => m.catatan || m.kutipan)].filter(Boolean).slice(0, 4) : [] };
    }),
    ...px.map(k => {
      const s = buktiSaran.get(k);
      return { jenis: 'prosedur', kode: k, deskripsi: deskripsiProsedur(k) || null,
        status: s && s.bukti && s.bukti.length ? 'didukung_bukti' : 'belum_cukup_bukti',
        alasan: (s && s.catatan) || null, bukti: ((s && s.bukti) || []).map(b => ({ kutipan: b.kutipan, halaman: b.halaman })), ketidakpastian: [] };
    }),
  ];

  // Pertanyaan dari penalaran diagnosis didahulukan; catatan klarifikasi
  // tinjauan hanya dipakai bila penalaran belum tersedia (berkas lama).
  const pertanyaan = [
    ...((penalaran && penalaran.pertanyaan_klarifikasi) || []),
    ...(penalaran ? [] : ((a.tinjauan_diagnosis && a.tinjauan_diagnosis.klarifikasi) || []).map(q => ({ untuk: 'koder', pertanyaan: q, dasar: null, halaman: null }))),
  ].filter((q, i, arr) => arr.findIndex(x => x.pertanyaan === q.pertanyaan) === i).slice(0, 8);

  const risiko = [
    ...(((a.putusan_pending && a.putusan_pending.alasan) || []).map(r => ({ sumber: r.sumber_pemeriksaan, ringkas: r.ringkas, keparahan: r.keparahan, dasar: r.bukti || r.penjelasan || null }))),
    ...(((kritis && kritis.temuan) || []).filter(t => t.keparahan !== 'rendah').map(t => ({ sumber: 'Pemeriksa kritis', ringkas: t.pesan, keparahan: t.keparahan, dasar: t.bukti ? `"${t.bukti.kutipan}" (hal. ${t.bukti.page_number})` : null }))),
  ];

  const syarat = persyaratan(a);
  const alt = alternatifKoding({ record, dx, px, penalaran, kritis, hitung: hitungInacbgDanTarif });
  const perluKlarifikasi = rekomendasi.some(r => r.status !== 'didukung_bukti') || pertanyaan.length > 0 || syarat.some(s => s.status !== 'terpenuhi');
  const berisiko = risiko.some(r => r.keparahan === 'tinggi');
  return {
    versi: 'laporan-casemix-v1',
    // Aplikasi = casemix rujukan; keputusan akhir pada casemix RS.
    peran: 'casemix_rujukan',
    keputusan_casemix: keputusan,
    pelajaran_casemix: pelajaran,
    status: berisiko ? 'berisiko' : perluKlarifikasi ? 'perlu_klarifikasi' : 'siap_ditinjau',
    ringkasan_klinis: {
      narasi: (penalaran && penalaran.ringkasan) || null,
      keluhan: ambil('keluhan', 3), temuan_fisik: (perKat.fisik || []).filter(f => /abnormal|\+/.test(f.teks)).slice(0, 5).map(f => ({ teks: f.teks, halaman: f.halaman })),
      penunjang: ambil('penunjang', 6), tindakan: ambil('tindakan', 4),
      terapi: (perKat.terapi || []).filter(f => f.kelas_obat).slice(0, 6).map(f => ({ teks: f.teks, kelas: f.kelas_obat, halaman: f.halaman })),
    },
    kronologi,
    rekomendasi_koding: rekomendasi,
    persyaratan: syarat,
    pertanyaan_klarifikasi: pertanyaan,
    kondisi_tersirat: (penalaran && penalaran.kondisi_tersirat) || [],
    risiko_pending: risiko,
    alternatif_koding: alt,
    keyakinan: kritis ? { skor: kritis.skor_keyakinan, tingkat: kritis.tingkat } : null,
    jejak_kerja: jejakKerja(a),
    catatan: 'Agen casemix adalah casemix rujukan: rekomendasi untuk ditinjau. Keputusan akhir koding ada pada casemix RS, keputusan diagnosis milik dokter; perubahan data dan pengajuan klaim memerlukan persetujuan petugas.',
  };
}

module.exports = { susunLaporanCasemix, alternatifKoding, persyaratan, jejakKerja };
