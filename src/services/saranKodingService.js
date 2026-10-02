/**
 * Saran koding — diagnosis, prosedur, INA-CBG, dan tarif yang disusun dari
 * isi berkas supaya klaim sebesar mungkin diterima. Ditampilkan di tab
 * "Saran AI" (permintaan klien 1 Okt 2026); TIDAK pernah mengisi DIAGLIST/
 * PROCLIST -- penerapannya tetap keputusan koder casemix.
 *
 * Sumber (semuanya sudah ada di ai_review, tidak ada panggilan AI baru):
 *  - diagnosis: DIAGLIST yang sah di kamus ICD-10 WHO (urutan koder
 *    dipertahankan) + diagnosis dari resume (suggested_codes, kamus_valid);
 *  - aturan kombinasi Berita Acara (ketentuanKlaimKombinasi.json), mis.
 *    J44.9 + J18.9 -> J44.0 (KMB-12);
 *  - prosedur: PROCLIST yang sah di kamus ICD-9-CM + usulan prosedur yang
 *    tervalidasi kamus + tindakan yang terbaca dari resume/triase (resep saja
 *    tidak cukup -- resep adalah rencana, bukan catatan tindakan);
 *  - INA-CBG & tarif: hitungInacbgDanTarif (heuristik + tabel PMK 3/2023),
 *    BUKAN grouper resmi E-Klaim.
 */
const { evaluasiKombinasiKode, normalisasiKode, pecahDaftarKode } = require('./ketentuanKlaimService');
const { deskripsiDiagnosis, deskripsiProsedur, padananWho } = require('./kamusKodeService');
const { groupCodesToInaCBG } = require('./inacbgGroupingService');
const { createHash } = require('crypto');

const SUMBER_TINDAKAN_SAH = new Set(['resume_medis', 'triase_igd']);
const NAMA_SUMBER_ATURAN = { ba_2018: 'Berita Acara Kesepakatan 2018' };

function tambahKode(daftar, kode, isi) {
  const k = normalisasiKode(kode);
  if (!k) return;
  const ada = daftar.find(d => d.kode === k);
  if (ada) {
    for (const a of isi.asal || []) if (!ada.asal.includes(a)) ada.asal.push(a);
    for (const b of isi.bukti || []) {
      if (!ada.bukti.some(x => x.halaman === b.halaman && x.kutipan === b.kutipan)) ada.bukti.push(b);
    }
    return;
  }
  daftar.push({ kode: k, asal: [...(isi.asal || [])], bukti: [...(isi.bukti || [])], catatan: isi.catatan || null });
}

/**
 * Terapkan aturan kombinasi kode sampai tidak ada yang berubah lagi.
 * ganti_gabungan: kode utama + pasangan diganti satu kode gabungan, di posisi
 * kode paling depan yang terdampak (supaya diagnosis utama tetap di depan).
 * buang_pasangan: kode pasangan dibuang karena sudah tercakup kode utama.
 */
function terapkanKombinasi(diagnosis) {
  const perubahan = [];
  for (let putaran = 0; putaran < 5; putaran++) {
    const temuan = evaluasiKombinasiKode(diagnosis.map(d => d.kode));
    const berlaku = temuan.find(t => t.aksi === 'buang_pasangan' || (t.aksi === 'ganti_gabungan' && t.kode_gabungan));
    if (!berlaku) break;

    const dibuang = new Set(berlaku.aksi === 'ganti_gabungan'
      ? [...berlaku.kode_utama, ...berlaku.kode_terdampak]
      : berlaku.kode_terdampak);
    const posisi = diagnosis.findIndex(d => dibuang.has(d.kode));
    const buktiLama = diagnosis.filter(d => dibuang.has(d.kode)).flatMap(d => d.bukti);
    const sisa = diagnosis.filter(d => !dibuang.has(d.kode));

    if (berlaku.aksi === 'ganti_gabungan') {
      const gabungan = normalisasiKode(berlaku.kode_gabungan);
      if (!sisa.some(d => d.kode === gabungan)) {
        sisa.splice(Math.max(0, Math.min(posisi, sisa.length)), 0, {
          kode: gabungan, asal: ['kombinasi'], bukti: buktiLama, catatan: berlaku.pesan,
        });
      }
    }
    perubahan.push({
      aturan: berlaku.kode,
      nama: berlaku.nama,
      aksi: berlaku.aksi,
      dari: [...dibuang],
      menjadi: berlaku.aksi === 'ganti_gabungan' ? normalisasiKode(berlaku.kode_gabungan) : null,
      pesan: berlaku.pesan,
      sumber: NAMA_SUMBER_ATURAN[berlaku.sumber] || berlaku.sumber || null,
      kutipan_sumber: berlaku.kutipan_sumber || null,
    });
    diagnosis.splice(0, diagnosis.length, ...sisa);
  }
  return perubahan;
}

/**
 * @param {Object} record baris claim_records (diagnosa_list, prosedur_list, jenis_klaim, kelas_rawat)
 * @param {Object} aiReview isi ai_review
 * @param {Function} hitungInacbgDanTarif dari aiReviewService (disuntikkan supaya modul ini tidak bergantung balik)
 */
function susunSaranKoding(record, aiReview, hitungInacbgDanTarif) {
  const ai = aiReview && typeof aiReview === 'object' ? aiReview : {};
  const rec = record || {};
  const tidakDipakai = [];
  const diagnosis = [];
  const prosedur = [];

  // 1. Diagnosis klaim saat ini (urutan koder dipertahankan).
  const diaglist = pecahDaftarKode(rec.diagnosa_list || rec.DIAGLIST);
  for (const kode of diaglist) {
    if (!deskripsiDiagnosis(kode)) {
      const who = padananWho(kode);
      if (who) {
        tambahKode(diagnosis, who, { asal: ['diaglist'], catatan: `${kode} bukan kode ICD-10 WHO; padanannya ${who} (kategori tanpa subkode).` });
        continue;
      }
      tidakDipakai.push({ kode, jenis: 'diagnosis', alasan: 'Tidak ada di kamus ICD-10 WHO (kemungkinan kode ICD-10-CM). Cari padanan WHO-nya.' });
      continue;
    }
    tambahKode(diagnosis, kode, { asal: ['diaglist'] });
  }

  // 2. Diagnosis yang terbaca dari berkas (resume medis).
  const saran = Array.isArray(ai.suggested_codes) ? ai.suggested_codes : [];
  for (const s of saran.filter(x => x && x.type === 'diagnosis' && x.code)) {
    if (s.disangkal === true || s.boleh_isi_otomatis === false) {
      tidakDipakai.push({ kode: normalisasiKode(s.code), jenis: 'diagnosis', alasan: 'Disangkal berkas atau hanya tertulis di anamnesis, bukan diagnosis.' });
      continue;
    }
    const bukti = s.quotation ? [{ kutipan: String(s.quotation).slice(0, 200), halaman: s.page_number || null, sumber: 'resume_medis' }] : [];
    if (s.kamus_valid !== true || !deskripsiDiagnosis(s.code)) {
      // Kode ICD-10-CM yang padanan WHO-nya pasti (mis. J81.0 -> J81) tetap
      // disarankan dalam bentuk WHO; selebihnya tidak ditebak.
      const who = padananWho(s.code);
      if (who) {
        tambahKode(diagnosis, who, { asal: ['resume'], bukti, catatan: `${normalisasiKode(s.code)} bukan kode ICD-10 WHO; padanannya ${who} (kategori tanpa subkode).` });
        continue;
      }
      // Kode yang belum berpadanan WHO tetap ditampilkan (bukan dibuang)
      // supaya saran & tarif tidak kosong; koder memilih kode WHO-nya.
      if (s.belum_who === true) {
        tambahKode(diagnosis, s.code, { asal: ['resume'], bukti, catatan: `${normalisasiKode(s.code)} belum ada di ICD-10 WHO dan padanannya belum pasti. Disimpan sementara; pilih kode WHO yang setara sebelum diunggah.` });
        continue;
      }
      tidakDipakai.push({ kode: normalisasiKode(s.code), jenis: 'diagnosis', alasan: 'Belum tervalidasi kamus ICD-10 WHO.' });
      continue;
    }
    tambahKode(diagnosis, s.code, { asal: ['resume'], bukti, catatan: s.catatan_aturan || null });
  }

  // Tinjauan hanya mengubah susunan saran; DIAGLIST/status tersimpan tetap utuh.
  const tinjauan = ai.tinjauan_diagnosis || (evaluasiKombinasiKode(diagnosis.map(d => d.kode)).length ? {
    status: 'belum_dinilai', ringkasan: 'Kombinasi kode perlu ditinjau terhadap bukti kasus sebelum menentukan saran akhir.',
    kode_rekomendasi: [], kandidat: [], klarifikasi: [],
  } : null);
  const pilihan = tinjauan?.versi === 1 && tinjauan.status === 'ada_saran'
    && Array.isArray(tinjauan.kode_rekomendasi) && tinjauan.kode_rekomendasi.length > 0
    && tinjauan.kode_rekomendasi.every(k => diagnosis.some(d => d.kode === k)
      && tinjauan.kandidat?.some(c => c.kode === k && c.status === 'didukung'))
    ? tinjauan.kode_rekomendasi : null;
  if (pilihan) {
    for (const d of diagnosis.filter(d => !pilihan.includes(d.kode))) {
      tidakDipakai.push({ kode: d.kode, jenis: 'diagnosis', alasan: 'Tidak diprioritaskan dalam saran kasus ini. Diagnosis dokter tetap perlu ditinjau koder, belum dihapus dari klaim.' });
    }
    const terpilih = pilihan.map(k => diagnosis.find(d => d.kode === k));
    diagnosis.splice(0, diagnosis.length, ...terpilih);
  }
  // Bila tinjauan belum memadai, jangan memaksakan kode gabungan atau tarif saran.
  const belumFinal = Boolean(tinjauan && !pilihan);
  const perubahan = belumFinal ? [] : terapkanKombinasi(diagnosis);
  diagnosis.forEach((d, i) => {
    d.peran = belumFinal ? undefined : i === 0 ? 'utama' : 'sekunder';
    d.deskripsi = deskripsiDiagnosis(d.kode) || null;
  });

  // 4. Prosedur: PROCLIST, usulan AI tervalidasi, tindakan dari resume/triase.
  for (const kode of pecahDaftarKode(rec.prosedur_list || rec.PROCLIST)) {
    if (!deskripsiProsedur(kode)) {
      tidakDipakai.push({ kode, jenis: 'prosedur', alasan: 'Tidak ada di kamus ICD-9-CM.' });
      continue;
    }
    tambahKode(prosedur, kode, { asal: ['proclist'] });
  }
  for (const s of saran.filter(x => x && x.type === 'procedure' && x.code)) {
    if (s.kamus_valid !== true || !deskripsiProsedur(s.code) || s.disangkal === true) continue;
    tambahKode(prosedur, s.code, {
      asal: ['resume'],
      catatan: s.catatan_aturan || null,
      bukti: s.quotation ? [{ kutipan: String(s.quotation).slice(0, 200), halaman: s.page_number || null, sumber: 'resume_medis' }] : [],
    });
  }
  for (const t of Array.isArray(ai.temuan_tindakan) ? ai.temuan_tindakan : []) {
    if (!t || !t.kode_usulan) continue;
    const buktiSah = (t.bukti || []).filter(b => SUMBER_TINDAKAN_SAH.has(b.sumber));
    if (buktiSah.length === 0) continue; // hanya di resep: rencana, bukan tindakan
    if (!deskripsiProsedur(t.kode_usulan)) continue;
    tambahKode(prosedur, t.kode_usulan, {
      asal: ['tindakan'],
      bukti: buktiSah.map(b => ({ kutipan: String(b.kutipan || '').slice(0, 200), halaman: b.page_number || null, sumber: b.sumber })),
    });
  }
  // Pemeriksaan penunjang yang terbaca dari berkas (kamus penunjang: darah
  // rutin -> 90.59, ro thorax -> 87.44, EKG -> 89.52). Casemix mengodekan
  // penunjang seperti ini; tanpa langkah ini saran prosedur hanya berisi
  // tindakan (berkas KHOIRIYAH: casemix 90.59;89.52;87.44, saran AI kosong).
  for (const t of Array.isArray(ai.temuan_penunjang) ? ai.temuan_penunjang : []) {
    if (!t || !t.kode_usulan || !deskripsiProsedur(t.kode_usulan)) continue;
    tambahKode(prosedur, t.kode_usulan, {
      asal: ['penunjang'],
      bukti: t.kutipan ? [{ kutipan: String(t.kutipan).slice(0, 200), halaman: t.page_number || null, sumber: 'penunjang' }] : [],
    });
  }
  // Seksio sesarea berjenis (74.0-74.4) sudah mencakup "74.99 unspecified"
  // yang biasanya datang dari kamus tindakan ("sectio") -- jangan dobel.
  if (prosedur.some(p => /^74\.[0-4]/.test(p.kode))) {
    for (const p of prosedur.filter(x => /^74\.9/.test(x.kode))) {
      tidakDipakai.push({ kode: p.kode, jenis: 'prosedur', alasan: 'Seksio sesarea sudah dikode dengan jenisnya; kode "unspecified type" tidak dipakai bersamaan.' });
    }
    prosedur.splice(0, prosedur.length, ...prosedur.filter(x => !/^74\.9/.test(x.kode)));
  }
  // Kode "lokasi/jenis tidak disebut" (xx.x0) tidak dipakai bila kode
  // saudaranya yang spesifik sudah ada (79.30 vs 79.35 ORIF femur).
  for (const p of prosedur.filter(x => /^\d{2}\.\d0$/.test(x.kode)
    && prosedur.some(y => y !== x && y.kode.slice(0, 4) === x.kode.slice(0, 4)))) {
    tidakDipakai.push({ kode: p.kode, jenis: 'prosedur', alasan: `Sudah ada kode yang lebih spesifik (${prosedur.filter(y => y !== p && y.kode.slice(0, 4) === p.kode.slice(0, 4)).map(y => y.kode).join(', ')}).` });
    prosedur.splice(prosedur.indexOf(p), 1);
  }
  prosedur.forEach(p => { p.deskripsi = deskripsiProsedur(p.kode) || null; });

  // 5. INA-CBG & tarif dari kode saran.
  const jenisKlaim = rec.jenis_klaim || rec.JENIS_KLAIM || null;
  const kelasRawat = rec.kelas_rawat ?? rec.KELAS_RAWAT ?? null;
  let inacbg = null;
  // Diagnosis belum final: tidak ada estimasi tarif (kombinasi kode bisa
  // mengubah kelompok), KECUALI kelompoknya ditentukan prosedur bedah/
  // persalinan (sesar -> O-6-10 apa pun diagnosis utamanya). Itu ditampilkan
  // sebagai perkiraan sementara.
  const kelompokProsedur = belumFinal && diagnosis.length > 0
    && (groupCodesToInaCBG(diagnosis.map(d => d.kode), prosedur.map(p => p.kode), rec.jenis_klaim || rec.JENIS_KLAIM) || {}).berbasis_prosedur === true;
  if ((!belumFinal || kelompokProsedur) && diagnosis.length > 0 && typeof hitungInacbgDanTarif === 'function') {
    const h = hitungInacbgDanTarif(diagnosis.map(d => d.kode), prosedur.map(p => p.kode), jenisKlaim, kelasRawat, null);
    if (h && h.inacbgResult) {
      inacbg = {
        kode: h.inacbgResult.code,
        deskripsi: h.inacbgResult.description || null,
        tarif: h.tarifResult && h.tarifResult.amount != null ? Number(h.tarifResult.amount) : null,
        catatan_tarif: h.tarifResult && h.tarifResult.amount == null ? h.tarifResult.note || null : null,
        sumber: h.tarifResult ? h.tarifResult.source : null,
        sementara: belumFinal,
        kelas_asumsi: Boolean(h.tarifResult && h.tarifResult.kelas_asumsi),
      };
    }
  }

  // 6. Pembanding: klaim saat ini.
  const klaimSaatIni = {
    diagnosis: diaglist,
    prosedur: pecahDaftarKode(rec.prosedur_list || rec.PROCLIST),
    inacbg: ai.inacbg_result ? ai.inacbg_result.code || null : null,
    tarif: ai.tariff_result && ai.tariff_result.amount != null ? Number(ai.tariff_result.amount) : null,
  };
  const samaUrut = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const samaHimpunan = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const samaDenganKlaim = samaUrut(diagnosis.map(d => d.kode), klaimSaatIni.diagnosis)
    && samaHimpunan(prosedur.map(p => p.kode), klaimSaatIni.prosedur);

  const catatan = [];
  if (belumFinal) {
    catatan.push(inacbg
      ? 'Pilihan diagnosis belum final. Kode ditampilkan sebagai kandidat; INA-CBG/tarif adalah perkiraan sementara dari kelompok prosedur (severity masih bisa berubah menurut diagnosis sekunder final).'
      : 'Pilihan diagnosis belum final. Kode ditampilkan sebagai kandidat; penggabungan dan tarif saran menunggu klarifikasi.');
  }
  if (pilihan) catatan.push('Saran mengikuti tinjauan bukti kasus. Pemilihan diagnosis utama dan perubahan data tetap keputusan koder.');
  if (diagnosis.length === 0) catatan.push('Belum ada diagnosis yang terbaca dari berkas maupun DIAGLIST.');
  if (perubahan.length > 0) catatan.push('Kode digabung/dibuang sesuai aturan kombinasi Berita Acara; terapkan ke DIAGLIST bila koder setuju.');
  catatan.push('INA-CBG & tarif adalah perkiraan aplikasi (tabel PMK 3/2023), bukan hasil grouper resmi E-Klaim.');

  const casemix = bandingkanCasemix(ai.lembar_grouper, diagnosis, prosedur, inacbg);
  if (casemix) {
    catatan.push(casemix.semua_cocok
      ? 'Saran AI sama dengan hasil casemix (lembar grouper E-Klaim).'
      : casemix.inti_cocok
        ? 'Diagnosis, INA-CBG, dan tarif saran AI sama dengan hasil casemix; ada perbedaan prosedur yang tidak mengubah tarif.'
        : 'Saran AI berbeda dari hasil casemix (lembar grouper E-Klaim); lihat perbandingan.');
  }

  return {
    versi_data: createHash('sha256').update(JSON.stringify([rec.diagnosa_list || rec.DIAGLIST, rec.prosedur_list || rec.PROCLIST, rec.ai_review || null, rec.jenis_klaim || rec.JENIS_KLAIM, rec.kelas_rawat])).digest('hex'),
    tinjauan_diagnosis: tinjauan,
    diagnosis_belum_final: belumFinal,
    diagnosis,
    prosedur,
    perubahan,
    tidak_dipakai: tidakDipakai,
    inacbg,
    klaim_saat_ini: klaimSaatIni,
    sama_dengan_klaim: samaDenganKlaim,
    selisih_tarif: inacbg && inacbg.tarif != null && klaimSaatIni.tarif != null ? inacbg.tarif - klaimSaatIni.tarif : null,
    catatan,
    casemix,
  };
}

/**
 * Bandingkan saran AI dengan hasil casemix dari lembar grouper E-Klaim
 * (ai_review.lembar_grouper, dibaca tanpa AI -- lihat lembarGrouperService).
 * Lembar itu PEMBANDING, bukan rujukan: saran AI disusun tanpa melihatnya.
 */
function bandingkanCasemix(lembar, diagnosis, prosedur, inacbg) {
  if (!lembar || !lembar.inacbg) return null;
  const kodeAi = diagnosis.map(d => d.kode);
  const kodeCm = (lembar.diagnosis || []).map(d => normalisasiKode(d.kode));
  const prosAi = prosedur.map(p => p.kode);
  const prosCm = (lembar.prosedur || []).map(p => normalisasiKode(p.kode));
  const himpunan = (ai, cm) => ({
    sama: ai.filter(k => cm.includes(k)),
    hanya_ai: ai.filter(k => !cm.includes(k)),
    hanya_casemix: cm.filter(k => !ai.includes(k)),
  });
  const utamaAi = kodeAi[0] || null;
  const utamaCm = kodeCm[0] || null;
  const tarifAi = inacbg && inacbg.tarif != null ? inacbg.tarif : null;
  const tarifCm = lembar.inacbg.tarif != null ? lembar.inacbg.tarif : null;

  const hasil = {
    sumber: 'Lembar grouper E-Klaim (hasil casemix)',
    halaman: lembar.halaman || null,
    versi_eklaim: lembar.versi_eklaim || null,
    casemix: {
      diagnosis: (lembar.diagnosis || []).map(d => ({ kode: normalisasiKode(d.kode), deskripsi: d.deskripsi || null, peran: d.peran })),
      prosedur: (lembar.prosedur || []).map(p => ({ kode: normalisasiKode(p.kode), deskripsi: p.deskripsi || null })),
      inacbg: lembar.inacbg,
      total_tarif: lembar.total_tarif,
    },
    diagnosis_utama: {
      ai: utamaAi,
      casemix: utamaCm,
      cocok: Boolean(utamaAi && utamaAi === utamaCm),
      sekategori: Boolean(utamaAi && utamaCm && utamaAi.slice(0, 3) === utamaCm.slice(0, 3)),
    },
    diagnosis: himpunan(kodeAi, kodeCm),
    prosedur: himpunan(prosAi, prosCm),
    inacbg: { ai: inacbg ? inacbg.kode : null, casemix: lembar.inacbg.kode, cocok: Boolean(inacbg && inacbg.kode === lembar.inacbg.kode) },
    tarif: { ai: tarifAi, casemix: tarifCm, selisih: tarifAi != null && tarifCm != null ? tarifAi - tarifCm : null },
  };
  // Inti: diagnosis & INA-CBG/tarif sama. Prosedur minor tambahan dari AI
  // (oksigen, injeksi) yang tidak dikode casemix tidak mengubah tarif.
  hasil.inti_cocok = hasil.diagnosis_utama.cocok
    && hasil.diagnosis.hanya_ai.length === 0 && hasil.diagnosis.hanya_casemix.length === 0
    && hasil.inacbg.cocok && hasil.tarif.selisih === 0;
  hasil.semua_cocok = hasil.diagnosis_utama.cocok
    && hasil.diagnosis.hanya_ai.length === 0 && hasil.diagnosis.hanya_casemix.length === 0
    && hasil.prosedur.hanya_ai.length === 0 && hasil.prosedur.hanya_casemix.length === 0
    && hasil.inacbg.cocok;
  return hasil;
}

module.exports = { susunSaranKoding, terapkanKombinasi, bandingkanCasemix };
