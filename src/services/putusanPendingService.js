/**
 * Putusan pending — satu jawaban untuk pertanyaan yang sebenarnya ditanyakan
 * koder: "klaim ini akan dipending atau tidak, dan kalau iya karena apa?"
 *
 * Koder tidak ingin membetulkan data di tabel. Ia ingin tahu keputusannya.
 * Seluruh pemeriksaan yang sudah ada — validasi aturan, kegawatdaruratan,
 * syarat penunjang, ketentuan kombinasi kode, konsistensi antar data — selama
 * ini tersebar di beberapa kartu dan harus dibaca satu per satu. Modul ini
 * merangkumnya jadi satu putusan beserta alasannya, diurutkan dari yang paling
 * berisiko.
 *
 * YANG SENGAJA TIDAK DILAKUKAN: memberi angka persentase.
 *
 * Belum ada satu pun klaim di sistem ini yang hasil akhirnya dari BPJS sudah
 * diketahui — rekap pending yang ada memuat periode Januari–Mei 2026,
 * sedangkan klaim yang tersimpan periode Juli–September. Irisannya nol. Jadi
 * ketepatan putusan ini BELUM PERNAH TERUKUR sama sekali, dan angka seperti
 * "85% kemungkinan pending" akan jadi angka karangan yang terdengar
 * meyakinkan. Yang bisa dipertanggungjawabkan hanyalah: alasan apa yang
 * ditemukan, dari aturan mana, dan atas bukti apa.
 *
 * Deterministik: tidak memanggil AI dan tidak memakai token.
 */

/** Urutan keparahan, dari yang paling berisiko. */
const BOBOT = { tinggi: 0, critical: 0, major: 1, sedang: 1, minor: 2, rendah: 2, info: 3 };

const STATUS = {
  BERISIKO: 'berisiko_pending',
  PERLU_DICEK: 'perlu_dicek',
  BERSIH: 'tidak_ditemukan_alasan',
};

function bobot(keparahan) {
  const b = BOBOT[String(keparahan || '').toLowerCase()];
  return b === undefined ? 2 : b;
}

/**
 * Alasan yang berasal dari rekap pending BPJS RS ini sendiri diberi tanda
 * terpisah. Bedanya nyata: aturan itu lahir dari klaim yang BENAR-BENAR pernah
 * ditolak di sini, bukan dari dugaan atas kelengkapan berkas.
 */
function dariRekapPending(sumber) {
  return /rekap pending/i.test(String(sumber || ''));
}

function tambah(daftar, alasan) {
  if (!alasan || !alasan.ringkas) return;
  // AI tidak boleh menghapus temuan berbasis pemeriksaan yang masih berlaku.
  if (['Aturan validasi', 'Kamus kode resmi', 'Ketentuan kombinasi kode', 'Konsistensi antar data',
    'Syarat penunjang diagnosis', 'Cakupan usia', 'Referensi klaim BPJS', 'Telaah catatan casemix',
    'Telaah rekomendasi TKMKB', 'BA kesepakatan Kemenkes-BPJS', 'PNPK Kemenkes',
    'Kesesuaian STT (BA 2024)', 'PNPK IDAI pneumonia anak', 'Casemix Alignment Checklist', 'Versi berkas'].includes(alasan.sumber_pemeriksaan)) {
    alasan.pertahankan_otomatis = true;
  }
  alasan.poin = alasan.poin || [
    { label: 'Alasan', isi: alasan.ringkas },
    ...(alasan.bukti ? [{ label: 'Bukti / sumber', isi: alasan.bukti }] : []),
    ...(alasan.penjelasan ? [{ label: 'Dasar pemeriksaan', isi: alasan.penjelasan }] : []),
    ...(alasan.tindakan ? [{ label: 'Perbaikan', isi: alasan.tindakan }] : []),
  ];
  daftar.push(alasan);
}

/**
 * Rangkum seluruh temuan jadi satu putusan.
 *
 * @param {Object} aiReview isi ai_review
 * @param {Array} validationErrors baris validation_errors
 * @returns {{status, ringkasan, alasan: Array, jumlah: Object}}
 */
const CATATAN_UMUM = /^Kutipan menunjukkan dokumentasi terkait/i;
/** Kalimat pertama catatan kriteria beserta bagian "Terbaca: ..." bila ada. */
function intiCatatan(c) {
  const t = String(c || '').trim();
  // Hanya catatan yang menyebut isi berkas (terbaca/tidak tertulis); catatan pedoman umum tidak memperjelas.
  if (!t || CATATAN_UMUM.test(t) || !/\b(?:terbaca|tidak tertulis|belum tertulis|tidak ada|tidak terbaca)\b/i.test(t)) return '';
  const kalimat = t.split(/(?<=\.)\s+/);
  const terbaca = kalimat.find(k => /^Terbaca\s*:/i.test(k));
  return [kalimat[0], terbaca && terbaca !== kalimat[0] ? terbaca : null].filter(Boolean).join(' ').replace(/\.$/, '');
}

/**
 * Ringkasan kartu referensi (RK/TKMKB/catatan casemix) yang terbaca sekilas:
 * sebut kriteria yang belum ada dan isi yang terbaca, bukan "dokumentasi perlu
 * ditinjau". Bukti titipan aturan lain (id "ATURAN:kriteria") tidak dihitung.
 */
function ringkasKartu(t, cadangan) {
  const gagal = (t.bukti || []).filter(x => x.status !== 'bukti_ditemukan' && !String(x.id || '').includes(':'));
  if (!gagal.length) return `${t.nama}: ${cadangan}`;
  const rinci = gagal.map(x => intiCatatan(x.catatan)).filter(Boolean);
  return rinci.length === 1 && gagal.length === 1 ? `${t.nama}: ${rinci[0]}`
    : `${t.nama}: belum ada di berkas -- ${gagal.map(x => x.nama).join(' / ')}`;
}
function rincianKartu(t) {
  const milik = (t.bukti || []).filter(x => !String(x.id || '').includes(':'));
  const ada = milik.filter(x => x.status === 'bukti_ditemukan').map(x => `${x.nama}${kutipBukti(x)}`);
  const kurang = milik.filter(x => x.status !== 'bukti_ditemukan').map(x => `${x.nama}${intiCatatan(x.catatan) ? ` (${intiCatatan(x.catatan)})` : ''}`);
  return `${ada.length ? ` Sudah tertulis: ${ada.join('; ')}.` : ''}${kurang.length ? ` Belum ada/tidak memenuhi: ${kurang.join('; ')}.` : ''}`;
}

/** Kombinasi kode: sebut kode yang terkena dan arah perbaikannya. */
function ringkasKombinasi(k) {
  const kode = [...(k.kode_utama || []), ...(k.kode_terdampak || [])].join(' + ');
  const arah = k.kode_gabungan ? `dikode gabungan ${k.kode_gabungan}`
    : k.aksi === 'buang_pasangan' ? `${(k.kode_terdampak || []).join(', ')} tidak dikode terpisah`
    : k.kode_saran ? `disarankan ${k.kode_saran}` : k.aksi === 'urutan' ? 'urutan diagnosis utama perlu diubah' : 'perlu ditelaah';
  return `${k.nama || k.kode}: ${kode ? `${kode} -- ` : ''}${arah}`;
}

/** Nilai vital saat datang yang terbaca, untuk alasan kegawatdaruratan. */
function vitalTerbaca(kgd) {
  const v = kgd?.vital_findings || {};
  const n = k => v[k]?.nilai ?? null;
  return [kgd?.esi?.skor ? `ESI ${kgd.esi.skor}` : null,
    n('GCS') !== null ? `GCS ${n('GCS')}` : null,
    n('TD_sistolik') !== null ? `TD ${n('TD_sistolik')}/${n('TD_diastolik') ?? '-'}` : null,
    n('HR') !== null ? `nadi ${n('HR')}` : null, n('RR') !== null ? `napas ${n('RR')}` : null,
    n('SpO2') !== null ? `SpO2 ${n('SpO2')}%` : null, n('Suhu') !== null ? `suhu ${n('Suhu')}` : null].filter(Boolean);
}

/** Kutipan singkat bukti pertama sebuah kriteria: ' -- "..." (hal. n)'. */
function kutipBukti(x) {
  const r = x.bukti?.[0];
  return r?.kutipan ? ` -- "${String(r.kutipan).trim().slice(0, 90)}"${r.page_number ? ` (hal. ${r.page_number})` : ''}` : '';
}

/**
 * Ringkasan alasan BA/PNPK yang terbaca sekilas: menyebut syarat yang tidak
 * ada atau angka yang bertentangan beserta halamannya -- bukan "kriteria belum
 * terlihat". Ringkasan kurasi pada aturan (ringkas_telaah) tetap didahulukan.
 */
/** Isi kriteria yang gagal: angka terbaca dikutip apa adanya (satuan asli), bukan "tidak memenuhi ambang". */
function rincianKriteria(x) {
  const r = x.bukti?.[0];
  const umum = !x.catatan || /terbaca, tidak memenuhi ambang/i.test(x.catatan);
  const kutip = x.nilai_terbaca && r?.kutipan ? `tertulis "${String(r.kutipan).trim().slice(0, 80)}"${r.page_number ? ` (hal. ${r.page_number})` : ''}` : '';
  if (umum) return kutip || (x.catatan ? String(x.catatan).replace(/\.$/, '') : '');
  return [String(x.catatan).replace(/\.$/, ''), kutip].filter(Boolean).join('; ');
}

function ringkasButir(b, label) {
  const topik = String(b.nama || b.id).split(':')[0].trim();
  const kriteria = (b.bukti || []).filter(x => !x.info && !String(x.id || '').includes(':'));
  if (b.kontradiksi_angka === true) {
    const x = kriteria.find(k => k.status !== 'bukti_ditemukan' && k.nilai_terbaca) || kriteria.find(k => k.status !== 'bukti_ditemukan');
    if (x) {
      return `${topik}: tidak memenuhi syarat ${label} "${x.nama}" -- ${rincianKriteria(x) || 'nilai tertulis tidak memenuhi'}`;
    }
    return `${topik}: nilai terbaca tidak memenuhi ambang ${label}`;
  }
  if (b.ringkas_telaah) return `${b.nama}: ${b.ringkas_telaah}`;
  const kurang = kriteria.filter(x => x.status !== 'bukti_ditemukan').map(x => x.nama);
  if (b.status === 'perlu_cek_manual' && kriteria.length && !kurang.length) return `${topik}: bukti dasar ditemukan, tetapi diagnosis/indikasi masih memerlukan evaluasi casemix`;
  return kurang.length ? `${topik}: belum ada di berkas -- ${kurang.join(' / ')} (syarat ${label})`
    : `${topik}: kriteria ${label} belum terlihat di berkas`;
}

function susunPutusan(aiReviewMasuk = {}, validationErrorsMasuk = []) {
  // Nilai bawaan parameter hanya berlaku untuk undefined, bukan null — dan
  // ai_review yang belum pernah diisi memang tersimpan sebagai null.
  const aiReview = aiReviewMasuk || {};
  const validationErrors = validationErrorsMasuk || [];
  const alasan = [];
  if(aiReview.laporan_operasi?.cakupan?.analisis_berkas_berubah===true)tambah(alasan,{
    sumber_pemeriksaan:'Versi berkas',kode:'BERKAS-BARU',ringkas:'Berkas berubah setelah analisis terakhir',
    keparahan:'sedang',diverifikasi:false,wajib_pending:false,dari_rekap_pending:false,
    tindakan:'Baca ulang seluruh berkas terbaru sebelum memakai saran dan kesimpulan analisis sebelumnya.'});

  // 1. Aturan validasi yang sudah lama ada.
  for (const e of validationErrors || []) {
    // RV-13..16 dapat berasal dari perkiraan lintas-kunjungan, termasuk
    // temuan lama dengan severity major. Label itu belum membuktikan
    // pengembalian konsul, kesamaan obat, atau nomor iterasi resep asli.
    const adminManual=['RV-13','RV-14','RV-15','RV-16'].includes(e.rule_id);
    tambah(alasan, {
      sumber_pemeriksaan: 'Aturan validasi',
      kode: e.rule_id || null,
      ringkas: adminManual ? `${e.rule_id}: dokumentasi administrasi perlu ditelaah` : e.error_message || e.field_name,
      penjelasan: adminManual ? 'Temuan dapat berasal dari perkiraan kunjungan/diagnosis. Cocokkan surat konsul/rujukan, pengembalian ke perujuk, obat yang sama dan urutan resep sesuai BA 2024 sebelum menetapkan kesalahan klaim.' : undefined,
      keparahan: adminManual ? 'sedang' : e.severity === 'critical' ? 'tinggi' : e.severity === 'major' ? 'tinggi' : 'sedang',
      bukti: e.actual_value || null,
      tindakan: adminManual ? 'Periksa dokumen administrasi asli dan pengecualian; jangan menetapkan dari perkiraan kunjungan saja.' : e.expected_value || null,
      diverifikasi: !adminManual,
      ...(adminManual?{wajib_pending:false}:{}),
      dari_rekap_pending: false,
    });
  }

  // Kode di luar kamus resmi. Ditaruh lebih dulu karena ini bukan dugaan
  // melainkan fakta yang bisa diperiksa: kodenya ada atau tidak ada di kamus.
  for (const k of aiReview.kode_luar_kamus || []) {
    // Kode yang DIISI aplikasi sebagai cadangan (belum berpadanan WHO) adalah
    // tugas koder memilih kode, bukan alasan pending dari berkas.
    const dariAplikasi = k.asal === 'saran_aplikasi';
    tambah(alasan, {
      sumber_pemeriksaan: 'Kamus kode resmi',
      kode: k.kode,
      ringkas: dariAplikasi ? `Kode diagnosis "${k.kode}" perlu dipilihkan padanan ICD-10 WHO` : `Kode ${k.jenis} "${k.kode}" tidak ada di kamus resmi`,
      penjelasan: k.pesan,
      keparahan: dariAplikasi ? 'sedang' : 'tinggi',
      bukti: null,
      tindakan: 'Ganti dengan kode yang ada di kamus, atau hapus kalau keliru',
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  // Kunjungan IGD yang TIDAK memenuhi kriteria kegawatdaruratan (Permenkes
  // 47/2018 Pasal 3 ayat 2): BPJS mempending klaim IGD tanpa kriteria gawat
  // darurat -- permintaan klien 1 Okt 2026. Hanya kunjungan IGD (klaim poli
  // tidak pernah pending karena ini) dan hanya bila penilaian benar-benar
  // dijalankan. Borderline belum dianggap terpenuhi. Alasan ini WAJIB: AI
  // putusan tidak boleh menggugurkannya (lihat putusanPendingAiService).
  const kgd = aiReview.kegawatdaruratan_assessment;
  if (kgd && kgd.kunjungan_igd === true && kgd.has_data === true && Array.isArray(kgd.kriteria)
    && !kgd.kriteria.some(k => k && (k.status === 'ya' || k.status === 'TERPENUHI'))) {
    const borderline = kgd.kriteria.filter(k => k && k.status === 'borderline');
    tambah(alasan, {
      sumber_pemeriksaan: 'Kriteria kegawatdaruratan',
      kode: 'KGD-IGD',
      ringkas: `Kunjungan IGD tanpa kriteria gawat darurat K1-K5${vitalTerbaca(kgd).length ? `: tercatat ${vitalTerbaca(kgd).join(', ')}` : ''}`,
      penjelasan: 'Tidak ada kriteria K1-K5 (Permenkes 47/2018 Pasal 3 ayat 2) yang terpenuhi dari pemeriksaan fisik dan tanda vital di Triase/Resume IGD.'
        + ` ${kgd.kriteria.map(k => `${k.kriteria} ${k.label || ''}: ${k.status}${k.catatan ? ` (${String(k.catatan).replace(/\.$/, '')})` : ''}`).join('; ')}.`
        + (borderline.length > 0
          ? ` Mendekati ambang: ${borderline.map(k => `${k.kriteria} (${k.catatan || k.label || 'borderline'})`).join('; ')}.`
          : ''),
      keparahan: 'tinggi',
      bukti: kgd.kriteria.map(k => `${k.kriteria}: ${k.status}`).join(', '),
      tindakan: 'Pastikan pemeriksaan fisik dan tanda vital saat datang tercatat lengkap di Triase/Resume IGD',
      diverifikasi: true,
      dari_rekap_pending: false,
      wajib_pending: true,
    });
  }

  // 2. Konsistensi antar data — data yang diklaim tanpa pendukungnya.
  for (const k of aiReview.konsistensi_data || []) {
    // Label UMUM pada resume tidak menggugurkan penjaminan oleh SEP BPJS.
    // Filter juga temuan tersimpan yang dibuat sebelum aturan ini diperbaiki.
    if (k.id === 'KD-02') continue;
    tambah(alasan, {
      sumber_pemeriksaan: 'Konsistensi antar data',
      kode: k.id,
      ringkas: k.nama,
      penjelasan: k.pesan,
      keparahan: k.keparahan,
      bukti: k.yang_ditemukan && k.yang_ditemukan.kutipan
        ? `"${k.yang_ditemukan.kutipan}"${k.yang_ditemukan.page_number ? ` (hal. ${k.yang_ditemukan.page_number})` : ''}`
        : null,
      tindakan: k.yang_dicari ? `Pastikan ada: ${k.yang_dicari}` : null,
      diverifikasi: k.diverifikasi === true,
      dari_rekap_pending: dariRekapPending(k.sumber_aturan),
    });
  }

  // 3. Syarat penunjang diagnosis. Yang berstatus "perlu dicek manual" TIDAK
  //    ikut jadi alasan — itu keterbatasan pembacaan kami, bukan kekurangan
  //    berkasnya, dan menyebutnya sebagai alasan pending akan menyalahkan
  //    rumah sakit atas kegagalan sistem membaca.
  for (const s of aiReview.syarat_penunjang || []) {
    if(s.perlu_konfirmasi_cakupan) tambah(alasan,{sumber_pemeriksaan:'Syarat penunjang diagnosis',kode:`${s.id}-CAKUPAN`,ringkas:`${s.kode_diagnosis}: syarat rekap pending RS (${(s.syarat||[]).map(x=>x.nama).join(', ')}) perlu dicek berlakunya untuk ${s.usia_pasien!=null?`pasien usia ${s.usia_pasien} tahun`:'pasien anak/usia belum terbaca'}`,penjelasan:s.sumber_aturan,keparahan:'sedang',wajib_pending:false,diverifikasi:false,dari_rekap_pending:true,tindakan:'Konfirmasi cakupan syarat rekap pending RS terhadap usia, indikasi pemeriksaan, dan pedoman yang berlaku pada episode.'});
    if (s.perlu_konfirmasi_tanggal === true || s.diverifikasi !== true) continue;
    for (const syarat of s.syarat || []) {
      if (syarat.status === 'terpenuhi' || syarat.status === 'perlu_cek_manual') continue;
      tambah(alasan, {
        sumber_pemeriksaan: 'Syarat penunjang diagnosis',
        kode: s.id,
        ringkas: `${s.kode_diagnosis} — ${syarat.nama} ${syarat.status === 'tidak_ada' ? 'tidak ada' : 'hasilnya belum terbaca'}`,
        penjelasan: s.sumber_aturan,
        keparahan: syarat.status === 'tidak_ada' ? 'tinggi' : 'sedang',
        bukti: syarat.kutipan ? `"${syarat.kutipan}"${syarat.page_number ? ` (hal. ${syarat.page_number})` : ''}` : null,
        tindakan: `Lengkapi bukti ${syarat.nama.toLowerCase()} sebelum submit`,
        diverifikasi: s.diverifikasi === true,
        dari_rekap_pending: dariRekapPending(s.sumber_aturan),
      });
    }
  }

  const usiaBelum = (aiReview.referensi_klaim?.temuan || []).find(t=>t.id==='RK-USIA');
  if(usiaBelum) tambah(alasan,{sumber_pemeriksaan:'Cakupan usia',kode:'RK-USIA',ringkas:'Usia belum terkonfirmasi; kriteria kasus belum dapat dipilih',penjelasan:usiaBelum.catatan,keparahan:'sedang',wajib_pending:false,diverifikasi:false,dari_rekap_pending:false,tindakan:'Konfirmasi tanggal lahir dan awal episode atau umur pasien sebelum menentukan jalur anak/dewasa.'});

  // Ketentuan BA dengan masa berlaku terkonfirmasi menjadi temuan telaah,
  // bukan keputusan penolakan. PNPK dan manual lama tidak menjadi syarat wajib.
  for (const t of aiReview.referensi_klaim?.temuan || []) {
    if (t.jenis_ketentuan !== 'verifikasi_klaim_bpjs' || t.status !== 'bukti_belum_cukup'
      || t.berlaku_pada_episode !== true || t.sumber?.status_verifikasi !== 'terverifikasi') continue;
    tambah(alasan, { sumber_pemeriksaan:'Referensi klaim BPJS', kode:t.id,
      ringkas:ringkasKartu(t,'dukungan dokumentasi perlu ditinjau'), penjelasan:`${t.catatan}${rincianKartu(t)}`,
      keparahan:'sedang', tindakan:'Tinjau bukti dan pengecualian sesuai butir sumber; jangan mengganti diagnosis otomatis.',
      bukti:`${t.sumber.judul} (${t.sumber.nomor}), halaman ${t.sumber.halaman}`, diverifikasi:true, dari_rekap_pending:false });
  }

  // Catatan pengguna menambah telaah, bukan putusan pending wajib atau aturan nasional.
  for (const t of aiReview.referensi_klaim?.temuan || []) {
    if (t.jenis_ketentuan !== 'catatan_casemix' || t.perlu_telaah_koding !== true) continue;
    const b=t.bukti.flatMap(b=>b.bukti).find(b=>b.metode==='numerik') || t.bukti.flatMap(b=>b.bukti)[0];
    tambah(alasan,{sumber_pemeriksaan:'Telaah catatan casemix',kode:t.id,
      ringkas:ringkasKartu(t,'nilai dan syarat perlu ditelaah'),penjelasan:`${t.catatan}${rincianKartu(t)}`,
      keparahan:'sedang',bukti:b?`${b.kutipan} (hal. ${b.page_number})`:null,
      tindakan:'Konfirmasi bersama casemix/DPJP; jangan mengganti kode otomatis.',
      diverifikasi:false,dari_rekap_pending:false,wajib_pending:false});
  }

  // Rekomendasi TKMKB menambah telaah dokumentasi; masa berlaku belum dikonfirmasi.
  for(const t of aiReview.referensi_klaim?.temuan||[]) {
    if(t.jenis_ketentuan!=='rekomendasi_tkmkb'||!t.perlu_telaah_dokumen)continue;
    tambah(alasan,{sumber_pemeriksaan:'Telaah rekomendasi TKMKB',kode:t.id,ringkas:ringkasKartu(t,'dokumentasi perlu ditelaah'),
      penjelasan:`${t.catatan}${rincianKartu(t)}`,keparahan:'sedang',bukti:`${t.sumber.judul}, halaman ${t.sumber.halaman}`,
      tindakan:'Cocokkan bukti, kelompok usia, pengecualian dan pedoman episode bersama DPJP/casemix.',
      diverifikasi:false,dari_rekap_pending:false,wajib_pending:false});
  }

  // BA kesepakatan 2018 (aspek medis): butir dengan kriteria yang terbaca dari
  // berkas. Satu alasan per topik -- dilewati bila aturan yang ditempeli
  // (gabung_ke) sudah memberi alasan. Angka terbaca yang bertentangan dengan
  // ambang = tinggi; selain itu sedang. Tidak pernah wajib (masa berlaku BA
  // dan pembaruan sesudahnya tetap ditelaah).
  for (const t of aiReview.referensi_klaim?.temuan || []) {
    const butirBa = [...(/^(?:BA-\d{2}|PNPK)-/.test(String(t.id)) ? [t] : []), ...(t.rujukan_ba_2018 || [])];
    for (const b of butirBa) {
      if (b.tanpa_putusan === true) continue;
      if (!['bukti_belum_cukup', 'belum_dapat_dinilai', 'perlu_cek_manual'].includes(b.status)) continue;
      if (b.menilai_putusan !== true && !/^(?:PNPK|BA-\d{2})-/.test(String(b.id))) continue;
      if (b.status === 'perlu_cek_manual' && !b.bukti?.length && !b.katalog_id && !(b.sumber?.jenis === 'pedoman_klinis')) continue;
      const topik = [t.id, b.id, ...(b.gabung_ke || [])];
      const sama = alasan.filter(a => topik.includes(a.kode));
      // Satu alasan per topik. Angka yang bertentangan dengan ambang BA (tinggi)
      // menggantikan telaah topik sama yang lebih ringan; isinya tetap disebut.
      if (sama.length && (b.kontradiksi_angka !== true || sama.some(a => a.wajib_pending || bobot(a.keparahan) === 0))) continue;
      const digantikan = sama.map(a => a.ringkas);
      for (const a of sama) alasan.splice(alasan.indexOf(a), 1);
      const milik = (b.bukti || []).filter(x => !String(x.id || '').includes(':'));
      const kurang = milik.filter(x => x.status !== 'bukti_ditemukan').map(x => `${x.nama}${rincianKriteria(x) ? ` (${rincianKriteria(x)})` : ''}`);
      const tertulis = milik.filter(x => !x.info && x.status === 'bukti_ditemukan').map(x => `${x.nama}${kutipBukti(x)}`);
      const pendukung = (b.bukti || []).filter(x => x.info).map(x => `${x.nama}: ${x.bukti?.[0]?.kutipan || ''}${x.bukti?.[0]?.page_number ? ` (hal. ${x.bukti[0].page_number})` : ''}`);
      const butir = b.butir || t.sumber?.butir, halaman = b.halaman || t.sumber?.halaman, sumberBa = b.sumber || t.sumber || {};
      const pnpk = sumberBa.jenis === 'pedoman_klinis';
      const label = `${pnpk ? 'PNPK' : 'BA'} ${(String(sumberBa.versi || sumberBa.id).match(/20\d\d/) || [''])[0]}`.trim();
      tambah(alasan, { sumber_pemeriksaan: pnpk ? 'PNPK Kemenkes' : 'BA kesepakatan Kemenkes-BPJS', kode: b.id,
        ringkas: b.status === 'belum_dapat_dinilai' ? `${b.nama}: bukti klinis belum terbaca untuk menilai syarat ${label}` : ringkasButir(b, label),
        penjelasan: `Syarat ${label} (${butir}, hal. ${halaman}): ${b.catatan}${tertulis.length ? ` Sudah tertulis: ${tertulis.join('; ')}.` : ''}${kurang.length ? ` Belum ada/tidak memenuhi: ${kurang.join('; ')}.` : ''}${pendukung.length ? ` Temuan pendukung yang tertulis: ${pendukung.join('; ')}.` : ''}${digantikan.length ? ` Juga ditelaah pada topik yang sama: ${digantikan.join('; ')}.` : ''}`,
        keparahan: b.kontradiksi_angka === true ? 'tinggi' : 'sedang',
        bukti: `${sumberBa.judul || label} (${sumberBa.nomor || '-'}), ${butir}, halaman ${halaman}`,
        tindakan: 'Lengkapi atau tunjukkan bukti kriteria pada berkas, atau konfirmasi diagnosis/indikasi bersama DPJP dan casemix. Kode tidak diganti otomatis.',
        diverifikasi: false, dari_rekap_pending: false, wajib_pending: false });
    }
  }

  // Rawat inap STT (BA 2024 aspek medis no. 1): kode yang diajukan harus
  // mencerminkan lesi yang memenuhi kriteria rawat inap. Yang berat WAJIB --
  // di luar kriteria BA diklaimkan sebagai rawat jalan (KASUS ACUAN STT).
  const stt = aiReview.kesesuaian_stt;
  if (stt && stt.ringkas) {
    tambah(alasan, { sumber_pemeriksaan: 'Kesesuaian STT (BA 2024)', kode: stt.id, ringkas: stt.ringkas,
      poin: stt.poin,
      penjelasan: stt.penjelasan, keparahan: stt.keparahan, bukti: stt.bukti_ringkas || null, tindakan: stt.tindakan,
      diverifikasi: true, dari_rekap_pending: false, wajib_pending: stt.wajib_pending === true });
  }

  // Pneumonia anak dinilai dengan PNPK IDAI (bukan kriteria dewasa). Telaah
  // dokumentasi indikasi rawat inap; bukan alasan wajib.
  const anak = aiReview.pneumonia_anak;
  if (anak && anak.perlu_telaah) {
    const nilai = [anak.rr_tertinggi ? `RR tertinggi ${anak.rr_tertinggi.nilai} x/menit (hal. ${anak.rr_tertinggi.page_number})` : null,
      anak.spo2_terendah ? `SpO2 terendah ${anak.spo2_terendah.nilai}% (hal. ${anak.spo2_terendah.page_number})` : null].filter(Boolean).join('; ');
    tambah(alasan, { sumber_pemeriksaan: 'PNPK IDAI pneumonia anak', kode: 'PNPK-IDAI-PNEUMONIA',
      ringkas: anak.vital_terbaca ? `Pneumonia anak rawat inap tanpa kriteria rawat inap PNPK IDAI yang tertulis${nilai ? `: ${nilai}` : ''}` : 'Pneumonia anak: tanda vital untuk indikasi rawat inap (napas, SpO2) tidak terbaca',
      penjelasan: `${anak.catatan.join(' ')} Kriteria rawat inap ${anak.kelompok}: ${anak.kriteria_rawat_inap.map(k => k.nama).join('; ')}.`,
      keparahan: 'sedang', bukti: nilai || null,
      tindakan: 'Pastikan indikasi rawat inap anak tercatat (mis. SpO2, frekuensi napas sesuai usia, distres/grunting, dehidrasi, asupan) pada triase/resume; gram sputum dan CURB-65/PSI tidak berlaku untuk anak.',
      diverifikasi: false, dari_rekap_pending: false, wajib_pending: false });
  }

  // 4. Ketentuan kombinasi kode.
  for (const k of aiReview.kombinasi_kode || []) {
    tambah(alasan, {
      sumber_pemeriksaan: 'Ketentuan kombinasi kode',
      kode: k.kode || null,
      ringkas: ringkasKombinasi(k),
      penjelasan: k.pesan,
      keparahan: k.keparahan || 'tinggi',
      bukti: k.kutipan_sumber || null,
      tindakan: k.pesan || null,
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  // 5. Identitas lintas halaman — hanya yang berat. Selisih ringan hampir
  //    selalu salah baca OCR, bukan alasan pending.
  for (const i of aiReview.identitas_halaman || []) {
    if (i.keparahan !== 'tinggi') continue;
    tambah(alasan, {
      sumber_pemeriksaan: 'Identitas antar halaman',
      kode: i.jenis,
      ringkas: `Halaman ${i.page_number} kemungkinan milik pasien lain`,
      penjelasan: i.pesan,
      keparahan: 'tinggi',
      bukti: i.ditemukan ? `Di halaman: ${i.ditemukan}` : null,
      tindakan: 'Periksa berkas fisiknya',
      diverifikasi: true,
      dari_rekap_pending: false,
    });
  }

  alasan.sort((a, b) => {
    // Alasan yang lahir dari klaim yang benar-benar pernah ditolak di RS ini
    // naik ke atas: bobotnya berbeda dari dugaan kelengkapan berkas.
    if (a.dari_rekap_pending !== b.dari_rekap_pending) return a.dari_rekap_pending ? -1 : 1;
    if (a.diverifikasi !== b.diverifikasi) return a.diverifikasi ? -1 : 1;
    return bobot(a.keparahan) - bobot(b.keparahan);
  });

  // SELURUH alasan menentukan status, termasuk yang aturannya belum ditelaah
  // koder. Sebelumnya yang belum disahkan hanya ditampilkan tanpa memengaruhi
  // putusan — tapi itu berarti koder tetap harus membaca dan menilainya
  // sendiri, yaitu memeriksa ulang apa yang sudah diperiksa sistem. Kerja dua
  // kali, dan gunanya hilang.
  //
  // Aturan yang ternyata keliru diperbaiki atau dimatikan di berkas aturannya,
  // bukan dengan menahan seluruh temuan di belakang gerbang persetujuan.
  const berat = alasan.filter(a => bobot(a.keparahan) === 0);

  let status = STATUS.BERSIH;
  let ringkasan = 'Tidak ditemukan alasan yang biasa membuat klaim dipending.';
  if (berat.length > 0) {
    status = STATUS.BERISIKO;
    ringkasan = berat.length === 1
      ? 'Ada 1 hal yang berisiko membuat klaim ini dipending.'
      : `Ada ${berat.length} hal yang berisiko membuat klaim ini dipending.`;
  } else if (alasan.length > 0) {
    status = STATUS.PERLU_DICEK;
    ringkasan = `Ada ${alasan.length} hal yang sebaiknya dicek sebelum submit.`;
  }


  return {
    status,
    ringkasan,
    // Dinyatakan terbuka supaya putusan ini tidak dibaca sebagai keputusan BPJS.
    catatan_keandalan:
      'Catatan: ini perkiraan aplikasi, bukan keputusan BPJS. Ketepatannya belum pernah terukur karena belum ada klaim di sistem ini yang hasil BPJS-nya sudah diketahui.',
    alasan,
    jumlah: {
      total: alasan.length,
      berat: berat.length,
      dari_rekap_pending: alasan.filter(a => a.dari_rekap_pending).length,
    },
  };
}

/**
 * Buang alasan "Aturan validasi" yang sudah tidak berlaku setelah validasi
 * dihitung ulang. Putusan disusun SAAT AI review, sering ketika DIAGLIST/
 * PROCLIST masih kosong; begitu kolom itu diisi otomatis, error validasinya
 * hilang tetapi alasannya (mis. RV-05 "DIAGLIST wajib diisi ... (kosong)")
 * tetap tampil di Analisis Risiko dan tetap menahan klaim di status pending.
 * Ditemukan pada MUNAWIR (0000R0000126V000004, 1 Okt 2026).
 *
 * Alasan dari pemeriksaan lain tidak disentuh. Status diturunkan hanya bila
 * alasan berat yang tersisa sudah tidak ada.
 *
 * @param {Object} putusan ai_review.putusan_pending
 * @param {Array} errorBaru hasil validasi terbaru (berisi rule_id)
 * @returns {Object|null} putusan baru, atau null kalau tidak ada yang berubah
 */
function segarkanAlasanValidasi(putusan, errorBaru = []) {
  if (!putusan || !Array.isArray(putusan.alasan)) return null;
  const masihBerlaku = new Set((errorBaru || []).map(e => e && e.rule_id).filter(Boolean));
  const adminBaru=new Map(susunPutusan({},(errorBaru||[]).filter(e=>['RV-13','RV-14','RV-15','RV-16'].includes(e.rule_id))).alasan.map(a=>[a.kode,a]));
  const sisa = putusan.alasan.filter(a => !a || a.sumber_pemeriksaan !== 'Aturan validasi' || masihBerlaku.has(a.kode))
    .map(a=>a?.sumber_pemeriksaan==='Aturan validasi'&&adminBaru.has(a.kode)?adminBaru.get(a.kode):a);
  if (JSON.stringify(sisa) === JSON.stringify(putusan.alasan)) return null;

  const berat = sisa.filter(a => bobot(a.keparahan) === 0 || a.wajib_pending === true);
  let status = putusan.status;
  let ringkasan = putusan.ringkasan;
  if (sisa.length === 0) {
    status = STATUS.BERSIH;
    ringkasan = 'Tidak ditemukan alasan yang biasa membuat klaim dipending.';
  } else if (status === STATUS.BERISIKO && berat.length === 0) {
    status = STATUS.PERLU_DICEK;
    ringkasan = `Ada ${sisa.length} hal yang sebaiknya dicek sebelum submit.`;
  } else if (status === STATUS.BERISIKO) {
    ringkasan = `Ada ${sisa.length} alasan yang berisiko membuat klaim ini dipending.`;
  }
  return {
    ...putusan,
    status,
    ringkasan,
    alasan: sisa,
    jumlah: {
      total: sisa.length,
      berat: berat.length,
      dari_rekap_pending: sisa.filter(a => a.dari_rekap_pending).length,
    },
  };
}

function memerlukanTelaah(putusan) {
  return [STATUS.BERISIKO,STATUS.PERLU_DICEK].includes(putusan?.status) || (putusan?.alasan || []).some(a => a.pertahankan_otomatis === true || a.wajib_pending === true);
}
module.exports = { susunPutusan, segarkanAlasanValidasi, STATUS, memerlukanTelaah };
