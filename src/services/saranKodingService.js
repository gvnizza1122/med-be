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
const { createHash } = require('crypto');
const { PROSEDUR_RUTIN_TIDAK_DIKODE, ALASAN_PROSEDUR_RUTIN, penunjangBerhasil } = require('./konvensiKodingRs');

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
      tidakDipakai.push({ kode: normalisasiKode(s.code), jenis: 'diagnosis', alasan: s.alasan_tahan || s.catatan_alternatif
        || (s.belum_who ? 'Belum tervalidasi kamus ICD-10 WHO.' : 'Disangkal berkas atau belum terbukti sebagai diagnosis akhir dokter.') });
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
      // Kandidat yang belum berpadanan WHO tetap tercatat sebagai tidak
      // dipakai; koder memilih padanan sebelum kode masuk rekomendasi tarif.
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
  // Belum final (tanpa lembar grouper casemix pun): Agen Casemix tetap memberi
  // rekomendasi SEMENTARA mengikuti urutan diagnosis dokter, dengan status
  // klarifikasi per kode dari tinjauan -- bukan daftar kosong tanpa tarif.
  const statusTinjauan = new Map(((tinjauan && tinjauan.kandidat) || []).map(c => [c.kode, c]));
  diagnosis.forEach((d, i) => {
    d.peran = i === 0 ? 'utama' : 'sekunder';
    d.deskripsi = deskripsiDiagnosis(d.kode) || null;
    const c = statusTinjauan.get(d.kode);
    if (belumFinal && c) {
      d.status_tinjauan = c.status;
      if (c.status !== 'didukung' && c.alasan) d.catatan = [d.catatan, `Perlu klarifikasi: ${String(c.alasan).slice(0, 300)}`].filter(Boolean).join(' ');
    }
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
    if (s.boleh_isi_otomatis === false) {
      tidakDipakai.push({ kode: normalisasiKode(s.code), jenis: 'prosedur', alasan: s.alasan_tahan || 'Pelaksanaan tindakan perlu diverifikasi sebelum mengisi kode.' });
      continue;
    }
    if (s.kamus_valid !== true || !deskripsiProsedur(s.code) || s.disangkal === true || s.boleh_isi_otomatis === false) continue;
    tambahKode(prosedur, s.code, {
      asal: ['resume'],
      catatan: s.catatan_aturan || null,
      bukti: s.quotation ? [{ kutipan: String(s.quotation).slice(0, 200), halaman: s.page_number || null, sumber: 'resume_medis' }] : [],
    });
  }
  for (const t of Array.isArray(ai.temuan_tindakan) ? ai.temuan_tindakan : []) {
    if (!t || !t.kode_usulan || t.disangkal || t.boleh_isi_otomatis === false) continue;
    const buktiSah = (t.bukti_kode || t.bukti || []).filter(b => SUMBER_TINDAKAN_SAH.has(b.sumber));
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
    if (!penunjangBerhasil({ temuan_penunjang: [t] }).length) {
      tidakDipakai.push({ kode: normalisasiKode(t.kode_usulan), jenis: 'prosedur', alasan: 'Petunjuk pemeriksaan ditemukan, tetapi hasil atau pelaksanaannya belum terkonfirmasi. Resep/tagihan tidak menjadi bukti prosedur.' });
      continue;
    }
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
  // Konvensi casemix RS: tindakan rutin (injeksi, infus, IV cath, kateter,
  // oksigen) tidak dikode. Saran aplikasi dibuang; isian koder di PROCLIST
  // tidak dihapus, hanya diberi catatan.
  for (const p of prosedur.filter(x => PROSEDUR_RUTIN_TIDAK_DIKODE.has(x.kode))) {
    if (p.asal.includes('proclist')) { p.catatan = `${ALASAN_PROSEDUR_RUTIN} Kode ini ada di PROCLIST; pertimbangkan untuk dihapus.`; continue; }
    tidakDipakai.push({ kode: p.kode, jenis: 'prosedur', alasan: ALASAN_PROSEDUR_RUTIN });
    prosedur.splice(prosedur.indexOf(p), 1);
  }
  prosedur.forEach(p => { p.deskripsi = deskripsiProsedur(p.kode) || null; });

  // 5. INA-CBG & tarif dari kode saran.
  const jenisKlaim = rec.jenis_klaim || rec.JENIS_KLAIM || null;
  const kelasRawat = require('./kelasPerawatanService').kelasTarif(rec);
  let inacbg = null;
  // Diagnosis belum final: tidak ada estimasi tarif (kombinasi kode bisa
  // mengubah kelompok), KECUALI kelompoknya ditentukan prosedur bedah/
  // persalinan (sesar -> O-6-10 apa pun diagnosis utamanya). Itu ditampilkan
  // sebagai perkiraan sementara.
  // Belum final: tetap dihitung sebagai perkiraan SEMENTARA dari rekomendasi
  // agen (urutan diagnosis dokter), ditandai jelas.
  if (diagnosis.length > 0 && typeof hitungInacbgDanTarif === 'function') {
    // Wasit yang sama dengan Agen Casemix (grouper aplikasi vs tebakan Luna).
    const { pilihInacbg } = require('./agenCasemixOrkestrator');
    const tebakanLuna = (ai.agen_casemix && ai.agen_casemix.grouper && ai.agen_casemix.grouper.tebakan_luna) || null;
    const h = pilihInacbg(hitungInacbgDanTarif, diagnosis.map(d => d.kode), prosedur.map(p => p.kode), { jenis_klaim: jenisKlaim, kelas_rawat: kelasRawat }, tebakanLuna).hasil;
    if (h && h.inacbgResult) {
      inacbg = {
        kode: h.inacbgResult.code,
        deskripsi: h.inacbgResult.description || null,
        tarif: h.tarifResult && h.tarifResult.amount != null ? Number(h.tarifResult.amount) : null,
        catatan_tarif: h.tarifResult?.note || null,
        sumber: h.tarifResult ? h.tarifResult.source : null,
        sementara: belumFinal,
        kelas_asumsi: Boolean(h.tarifResult && h.tarifResult.kelas_asumsi),
        perlu_verifikasi_grouper: Boolean(h.tarifResult?.perlu_verifikasi_grouper),
        skenario_severity: h.tarifResult?.skenario_severity || [],
        kelas_perawatan: require('./kelasPerawatanService').informasiKelas(rec),
      };
    }
  }

  // 6. Pembanding: klaim saat ini.
  let dataAsli = rec.raw_data || rec;
  if (typeof dataAsli === 'string') { try { dataAsli = JSON.parse(dataAsli); } catch (_) { dataAsli = {}; } }
  const klaimSaatIni = {
    diagnosis: diaglist,
    prosedur: pecahDaftarKode(rec.prosedur_list || rec.PROCLIST),
    inacbg: dataAsli.INACBG || dataAsli.INA_CBG || null,
    tarif: dataAsli.TARIF_INACBG && Number.isFinite(Number(dataAsli.TARIF_INACBG)) ? Number(dataAsli.TARIF_INACBG) : null,
  };
  const samaUrut = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const samaHimpunan = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const samaDenganKlaim = samaUrut(diagnosis.map(d => d.kode), klaimSaatIni.diagnosis)
    && samaHimpunan(prosedur.map(p => p.kode), klaimSaatIni.prosedur);

  const catatan = [];
  if (belumFinal) {
    const perluKlarifikasi = diagnosis.filter(d => d.status_tinjauan && d.status_tinjauan !== 'didukung').map(d => d.kode);
    catatan.push(`Rekomendasi sementara Agen Casemix mengikuti urutan diagnosis dokter${perluKlarifikasi.length ? `; ${perluKlarifikasi.join(', ')} perlu klarifikasi` : ''}. `
      + (inacbg ? 'INA-CBG/tarif adalah perkiraan sementara dan dapat berubah bila klarifikasi mengubah diagnosis.' : 'INA-CBG belum terhitung dari kode ini.'));
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
  hasil.alasan_perbedaan = [];
  for (const kode of hasil.diagnosis.hanya_ai) {
    const d = diagnosis.find(x => x.kode === kode);
    hasil.alasan_perbedaan.push({ jenis: 'diagnosis', kode, pesan: d?.alasan_tinjauan || d?.catatan || 'Kandidat aplikasi berasal dari diagnosis akhir/bukti episode ini. Tidak otomatis dihapus agar mengikuti casemix.', bukti: d?.bukti || [] });
  }
  for (const kode of hasil.diagnosis.hanya_casemix)
    hasil.alasan_perbedaan.push({ jenis: 'diagnosis', kode, pesan: 'Kode terdapat pada hasil casemix tetapi belum masuk rekomendasi berbukti aplikasi. Keberadaannya pada lembar grouper saja tidak menjadi dasar menambahkan diagnosis.', bukti: [] });
  for (const kode of hasil.prosedur.hanya_ai) {
    const p = prosedur.find(x => x.kode === kode);
    hasil.alasan_perbedaan.push({ jenis: 'prosedur', kode, pesan: p?.catatan || 'Tindakan/hasil pemeriksaan ditemukan pada berkas tetapi tidak tercantum dalam prosedur casemix. Tinjau pelaksanaan dan kode; tambahan prosedur tidak selalu mengubah kelompok.', bukti: p?.bukti || [] });
  }
  for (const kode of hasil.prosedur.hanya_casemix)
    hasil.alasan_perbedaan.push({ jenis: 'prosedur', kode, pesan: 'Prosedur terdapat pada lembar casemix, tetapi belum mempunyai kandidat terverifikasi pada saran. Periksa sumber tindakan; aplikasi tidak menyalin kode pembanding.', bukti: [] });
  if (!hasil.inacbg.cocok) {
    const base = kode => String(kode || '').replace(/-[^-]+$/, '');
    hasil.alasan_perbedaan.push({ jenis: 'grouper', pesan: base(hasil.inacbg.ai) === base(hasil.inacbg.casemix)
      ? 'Kelompok dasar sama, tingkat keparahan berbeda. Installer menyediakan pemetaan dasar dan tarif; matriks severity lengkap belum tersedia. Aplikasi menampilkan acuan tingkat I dan skenario, tanpa menyalin tingkat casemix.'
      : 'Kelompok dasar berbeda. Periksa diagnosis utama, tindakan definitif, dan prosedur tambahan. Tarif lebih tinggi tidak membuktikan kode lebih tepat.', bukti: [] });
  }
  if (inacbg?.kelas_perawatan) {
    const kelas = inacbg.kelas_perawatan;
    hasil.kelas_perawatan = kelas;
    if (kelas.naik_kelas || hasil.tarif.selisih !== 0)
      hasil.alasan_perbedaan.push({ jenis: 'tarif', pesan: `${kelas.catatan} Samakan kelas hak, regional, jenis RS, versi tarif dan severity saat membandingkan nominal.`, bukti: [] });
  }
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
