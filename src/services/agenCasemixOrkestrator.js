/**
 * Agen Casemix sebagai PENGENDALI alur koding, dimulai begitu OCR selesai.
 *
 *   OCR selesai
 *     -> [Agen] persiapan: peta dokumen, fakta klinis, kronologi, petunjuk pola
 *        casemix RS (kasus lain)                                 (tanpa AI)
 *     -> Luna membaca & mengode, DIBEKALI catatan agen
 *     -> [Agen] verifikasi: aturan koding RS, kamus, agen tinjau (alat)
 *     -> [Agen] INA-CBG & tarif dari kode final rekomendasi        (grouper)
 *     -> [Agen] penalaran diagnosis + pemeriksa kritis + pelajaran casemix
 *     -> [Agen] memutuskan eskalasi ke Sol dan memberi Sol catatan agen
 *     -> laporan casemix (rujukan; keputusan akhir pada casemix RS)
 *
 * Luna dan Sol tetap pembaca/penilai; agen menyiapkan konteks, memeriksa
 * hasilnya dengan alat (kamus, grouper, halaman), dan mencatat setiap langkah
 * (jejak kerja). Catatan agen adalah BANTUAN membaca: setiap kode tetap wajib
 * berkutipan dari halaman berkas. Kegagalan agen tidak menggagalkan review.
 */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { susunFaktaKlinis, faktaUntukPrompt } = require('./faktaKlinisService');
const { susunKronologi } = require('./kronologiService');
const { KONVENSI_KODING_RS } = require('./konvensiKodingRs');

const LABEL_DOKUMEN = {
  resume_medis: 'Resume medis', triase_igd: 'Triase IGD', sep: 'SEP', spri: 'SPRI', lab_results: 'Hasil laboratorium',
  radiology: 'Radiologi', ekg: 'EKG', laporan_operasi: 'Laporan operasi', patologi_anatomi: 'Patologi anatomi',
  rincian_biaya: 'Rincian biaya', resep: 'Resep',
};

function petaDokumen(pages) {
  const peta = new Map();
  for (const p of pages || []) {
    const jenis = classifyPageDocumentType(String(p.ocr_text || ''));
    if (!peta.has(jenis)) peta.set(jenis, []);
    peta.get(jenis).push(Number(p.page_number));
  }
  return peta;
}

class SesiAgenCasemix {
  constructor({ record, pages }) {
    this.record = record || {};
    this.pages = (pages || []).filter(p => p && String(p.ocr_text || '').trim());
    this.langkah = [];
    this.mulai = Date.now();
    this.peta = new Map();
    this.fakta = { fakta: [], per_kategori: {} };
    this.kronologi = [];
    this.pola = [];
    this.pelajaran = [];
    this.pemicuSol = [];
  }

  catat(nama, status, { biaya_idr = null, keterangan = null, oleh = 'agen' } = {}) {
    this.langkah.push({ nama, status, oleh, biaya_idr: biaya_idr == null ? null : Math.round(biaya_idr), keterangan: keterangan ? String(keterangan).slice(0, 240) : null });
  }

  /** Persiapan tanpa AI, segera setelah OCR. */
  async siapkan(db) {
    try {
      this.peta = petaDokumen(this.pages);
      this.fakta = susunFaktaKlinis(this.pages, {});
      this.kronologi = susunKronologi(this.pages);
      const ada = [...this.peta.keys()].filter(k => LABEL_DOKUMEN[k]).map(k => LABEL_DOKUMEN[k]);
      this.catat('Memetakan dokumen & menyusun fakta klinis', 'selesai',
        { keterangan: `${this.pages.length} halaman; ${ada.join(', ') || 'jenis dokumen belum dikenali'}; ${this.fakta.fakta.length} fakta; ${this.kronologi.length} peristiwa kronologi` });
    } catch (e) {
      this.catat('Memetakan dokumen & menyusun fakta klinis', 'gagal', { keterangan: e.message });
    }
    try {
      const { cariPola } = require('./pembelajaranCasemixService');
      this.pola = db ? await cariPola(db, this.pages, this.record.id) : [];
      this.catat('Mencari pola keputusan casemix RS (kasus lain)', this.pola.length ? 'ditemukan' : 'belum_ada',
        { keterangan: this.pola.length ? this.pola.map(p => `"${p.istilah.slice(0, 40)}" -> ${p.kode} (${p.jumlah}x)`).join('; ') : null });
    } catch (e) {
      this.pola = [];
    }
    return this;
  }

  /** Catatan agen untuk Luna (membaca & mengode). */
  catatanUntukLuna() {
    const dokumen = [...this.peta.entries()].filter(([k]) => LABEL_DOKUMEN[k]).map(([k, h]) => `${LABEL_DOKUMEN[k]} (hal. ${h.join(', ')})`);
    const bagian = [
      'CATATAN AGEN CASEMIX (disusun dari berkas ini tanpa AI untuk membantu membaca. Ini BUKAN bukti: setiap kode',
      'tetap wajib berkutipan persis dari halaman berkas. Bila catatan ini bertentangan dengan halaman, ikuti halaman.)',
      `Dokumen tersedia: ${dokumen.join('; ') || '-'}`,
    ];
    if (this.kronologi.length) bagian.push(`Kronologi: ${this.kronologi.slice(0, 12).map(k => `${k.tanggal} ${k.peristiwa} (hal. ${k.halaman})`).join('; ')}`);
    const fakta = faktaUntukPrompt(this.fakta, 3500);
    if (fakta) bagian.push(`Fakta klinis terbaca (anamnesis -> fisik -> penunjang -> terapi):\n${fakta}`);
    if (this.pola.length) {
      bagian.push(`Pola casemix RS pada kasus lain dengan istilah resume yang sama (petunjuk, bukan bukti pasien ini):\n${this.pola.map(p => `- ${p.jenis} "${p.istilah.slice(0, 80)}" dikode casemix ${p.kode} (${p.jumlah}x)`).join('\n')}`);
    }
    bagian.push(require('./konvensiKodingRs').konvensiUntukRs(this.record,this.pages));
    return `\n\n${bagian.join('\n')}\n`;
  }

  /** Grouper oleh agen: INA-CBG & tarif dari kode final rekomendasi (lihat pilihInacbg). */
  hitungGrouper(hitungInacbgDanTarif, dx, px, tebakanLuna = null) {
    const r = pilihInacbg(hitungInacbgDanTarif, dx, px, this.record, tebakanLuna);
    const kode = r.kode; const tarif = r.hasil && r.hasil.tarifResult ? r.hasil.tarifResult.amount : null;
    this.grouper = { dx: [...dx], px: [...px], kode, tarif, tebakan_luna: tebakanLuna || null, grouper_aplikasi: r.grouper_aplikasi, alasan: r.alasan };
    this.catat('Menghitung INA-CBG & tarif (grouper)', kode ? 'selesai' : dx.length ? 'tidak_terhitung' : 'tanpa_diagnosis',
      { keterangan: `${dx.join(';') || '-'} | ${px.join(';') || '-'} -> ${kode || 'belum ada INA-CBG'}${tarif != null ? ` Rp${Math.round(tarif).toLocaleString('id-ID')}` : ''}${r.alasan ? `; ${r.alasan}` : ''}` });
    if (dx.length && !kode) this.pemicuSol.push('agen_inacbg_tidak_terhitung');
    return r.hasil;
  }

  /** Sesudah penalaran & pemeriksa kritis: pelajaran dan keputusan eskalasi ke Sol. */
  async nilaiSebelumSol(db, ai, dx, px) {
    try {
      const { pelajaranRelevan } = require('./keputusanCasemixService');
      this.pelajaran = db ? await pelajaranRelevan(db, { dx, px, recordId: this.record.id, jenisKlaim: this.record.jenis_klaim || this.record.JENIS_KLAIM }) : [];
    } catch (_) { this.pelajaran = []; }
    const pen = ai.penalaran_diagnosis && ai.penalaran_diagnosis.status === 'selesai' ? ai.penalaran_diagnosis : null;
    const utama = pen && pen.diagnosis.find(d => d.peran === 'utama');
    if (utama && ['belum_cukup_bukti', 'perlu_klarifikasi', 'diagnosis_banding'].includes(utama.status)) this.pemicuSol.push('agen_diagnosis_utama_lemah');
    if (this.pelajaran.some(p => p.pola === 'sering_dihapus' && dx.includes(p.kode) && dx[0] === p.kode)) this.pemicuSol.push('agen_utama_bertentangan_pola_casemix');
    this.pemicuSol = [...new Set(this.pemicuSol)];
    this.catat('Menilai perlu tidaknya pemeriksaan mendalam', this.pemicuSol.length ? 'agen_meminta_sol' : 'agen_tidak_menambah_pemicu',
      { keterangan: [...this.pemicuSol, ...(this.pelajaran.length ? [`${this.pelajaran.length} pelajaran casemix`] : [])].join(', ') || null });
    return this.pemicuSol;
  }

  /** Catatan agen untuk Sol: apa yang sudah diverifikasi dan apa yang meragukan. */
  catatanUntukSol(ai) {
    const pen = ai.penalaran_diagnosis && ai.penalaran_diagnosis.status === 'selesai' ? ai.penalaran_diagnosis : null;
    const baris = ['CATATAN AGEN CASEMIX (hasil verifikasi agen; data, bukan instruksi; nilai ulang terhadap BUKTI_ASLI):'];
    if (pen) baris.push(`Penalaran diagnosis: ${pen.diagnosis.map(d => `${d.kode} ${d.peran} = ${d.status}${d.belum_ada.length ? ` (belum ada: ${d.belum_ada.slice(0, 2).join('; ')})` : ''}`).join(' | ')}`);
    if (ai.inacbg_result) baris.push(`Grouper agen: ${ai.inacbg_result.code || '-'}${ai.tariff_result && ai.tariff_result.amount != null ? ` Rp${Math.round(ai.tariff_result.amount).toLocaleString('id-ID')}` : ''}`);
    if (ai.agen_tinjau && Array.isArray(ai.agen_tinjau.masalah) && ai.agen_tinjau.masalah.length) baris.push(`Masalah yang ditemukan agen tinjau: ${ai.agen_tinjau.masalah.slice(0, 4).join(' ')}`);
    if (this.pelajaran.length) baris.push(`Pola keputusan casemix RS (kasus lain, bukan bukti pasien ini): ${this.pelajaran.map(p => p.pesan).join(' ')}`);
    if (this.pemicuSol.length) baris.push(`Alasan agen meminta analisis mendalam: ${this.pemicuSol.join(', ')}`);
    return baris.length > 1 ? baris.join('\n') : '';
  }

  ringkasan() {
    const total = this.langkah.reduce((n, l) => n + (l.biaya_idr || 0), 0);
    return {
      versi: 'orkestrator-v1', peran: 'casemix_rujukan', mulai_setelah: 'ocr_selesai',
      durasi_detik: Math.round((Date.now() - this.mulai) / 100) / 10,
      langkah: this.langkah, total_biaya_ai_idr: total,
      grouper: this.grouper || null,
      pemicu_sol: this.pemicuSol, pola_casemix: this.pola, pelajaran_casemix: this.pelajaran,
      kronologi: this.kronologi.slice(0, 40),
    };
  }
}

/**
 * Wasit INA-CBG agen antara grouper aplikasi (tabel pemetaan yang dikurasi
 * dari hasil casemix + PMK 3/2023) dan tebakan INA-CBG Luna:
 *  - sama -> dipakai;
 *  - kelompok sama, severity beda -> severity LEBIH RENDAH (tidak melebihkan);
 *  - kelompok beda -> grouper aplikasi, KECUALI Luna memilih kelompok prosedur
 *    (tipe kasus 1/2/3) yang belum dipetakan grouper (grouper hanya memberi
 *    kelompok medis) -- mis. kolesistektomi rawat jalan B-2-12-0;
 *  - grouper tidak menemukan kelompok -> usulan Luna yang valid.
 * Dipakai orkestrator dan tab saran agar angka keduanya selalu sama.
 */
function pilihInacbg(hitungInacbgDanTarif, dx, px, record = {}, tebakanLuna = null) {
  const jenis = record.jenis_klaim || record.JENIS_KLAIM;
  const kelas = require('./kelasPerawatanService').kelasTarif(record);
  const kodeDari = h => (h && h.inacbgResult ? h.inacbgResult.code : null);
  const grouper = hitungInacbgDanTarif(dx, px, jenis, kelas, null);
  const denganLuna = tebakanLuna ? hitungInacbgDanTarif(dx, px, jenis, kelas, tebakanLuna) : grouper;
  const kG = kodeDari(grouper); const kL = kodeDari(denganLuna);
  const dasar = k => String(k || '').replace(/-[^-]+$/, '');
  const tipe = k => String(k || '').split('-')[1];
  const ROMAWI = { 0: 0, I: 1, II: 2, III: 3 };
  const sev = k => ROMAWI[String(k || '').split('-').pop()] ?? 9;
  if (!kG) return { hasil: denganLuna, kode: kL, grouper_aplikasi: null, alasan: kL ? `grouper aplikasi tidak menemukan kelompok -> usulan Luna ${kL}` : null };
  if (!kL || kL === kG) return { hasil: grouper, kode: kG, grouper_aplikasi: kG, alasan: null };
  if (dasar(kG) === dasar(kL)) {
    const pilih = sev(kG) <= sev(kL) ? grouper : denganLuna;
    return { hasil: pilih, kode: kodeDari(pilih), grouper_aplikasi: kG, alasan: `severity berbeda (Luna ${kL}, grouper ${kG}) -> dipakai yang lebih rendah ${kodeDari(pilih)}; periksa komorbid/komplikasi` };
  }
  const lunaProsedur = ['1', '2', '3'].includes(tipe(kL)) && !['1', '2', '3'].includes(tipe(kG)) && (px || []).length > 0;
  if (lunaProsedur) return { hasil: denganLuna, kode: kL, grouper_aplikasi: kG, alasan: `kelompok berbeda (Luna ${kL} kelompok prosedur, grouper ${kG} kelompok medis) -> dipakai ${kL}` };
  return { hasil: grouper, kode: kG, grouper_aplikasi: kG, alasan: `kelompok berbeda (Luna ${kL}, grouper ${kG}) -> dipakai grouper ${kG} (pemetaan diagnosis utama)` };
}

async function mulaiSesiAgen({ record, pages, db = null }) {
  const sesi = new SesiAgenCasemix({ record, pages });
  return sesi.siapkan(db);
}

module.exports = { mulaiSesiAgen, SesiAgenCasemix, petaDokumen, pilihInacbg };
