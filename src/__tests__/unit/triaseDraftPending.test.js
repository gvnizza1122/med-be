/**
 * Triase empat kotak + draf jawaban berbukti. Data sintetis.
 */
const { nilaiTriase, kotakBerlaku } = require('../../services/triasePendingService');
const {
  TIDAK_ADA_BUKTI, susunPoin, pastikanTerverifikasi, rakitTeks, hitung, pilihDenganAi,
  buatDraft, setujuiDraft, tolakDraft, tampilanSampingan,
} = require('../../services/draftJawabanPendingService');

const KLAIM = { id: 'c1', sep: '0170R0110826V000001', jenis_klaim: 'RAWAT_JALAN', diagnosa_list: 'A09;I10', prosedur_list: '89.03' };

const HAL_GAWAT = [
  { page_number: 2, ocr_text: 'FORMULIR TRIASE IGD\nKategori triase: MERAH\nPasien datang dengan penurunan kesadaran' },
  { page_number: 3, ocr_text: 'Resume Medis\nDiagnosis: diare akut A09\nTerapi cairan' },
];
const HAL_NONGAWAT = [
  { page_number: 2, ocr_text: 'TRIASE IGD\nKategori triase: HIJAU\nKeluhan ringan' },
];

describe('triase kegawatdaruratan', () => {
  test('A: ada triase dan indikator kegawatan, dengan kutipan terverifikasi', () => {
    const t = nilaiTriase({ alasan_raw: 'cek kegawatan', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBe('A');
    const kr = Object.fromEntries(t.kriteria.map((x) => [x.id, x]));
    expect(kr.gawat_halaman_triase.terpenuhi).toBe(true);
    expect(kr.gawat_indikator.terpenuhi).toBe(true);
    expect(kr.gawat_nongawat.terpenuhi).toBe(false);
    expect(kr.gawat_indikator.bukti[0]).toMatchObject({ halaman: 2 });
  });

  test('triase non-gawat tanpa indikator kegawatan memerlukan keputusan koder, bukan otomatis melepas klaim', () => {
    const t = nilaiTriase({ alasan_raw: 'cek kegawatan', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: HAL_NONGAWAT });
    expect(t.kotak).toBeNull();
    expect(t.perlu_keputusan_koder).toBe(true);
    expect(t.alasan_kotak).toMatch(/non-gawat/);
  });

  test('B: tidak ada triase sama sekali', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: [{ page_number: 1, ocr_text: 'Resume medis rawat jalan biasa' }] });
    expect(t.kotak).toBe('B');
    expect(t.dokumen_dibutuhkan).toContain('Triase IGD');
  });
});

describe('bukti pending memerlukan konteks, bukan kemunculan kata', () => {
  const nilai = (kategori, alasan_raw, text) => nilaiTriase({ kategori, alasan_raw, klaim: KLAIM,
    halaman: [{ page_number: 1, ocr_text: text }] });
  test('gejala disangkal tidak membuat triase hijau menjadi bisa dijawab', () => {
    expect(nilai('kegawatdaruratan','cek kegawatan',
      'TRIASE IGD\nKategori triase: HIJAU\nTidak ada sesak, tidak ada nyeri dada, tidak ada syok').kotak).toBeNull();
  });
  test('negasi gejala lain tidak membuang gejala positif di klausa berikutnya', () => {
    expect(nilai('kegawatdaruratan','cek kegawatan',
      'TRIASE IGD\nTidak ada sesak, pasien kejang').kotak).toBe('A');
  });
  test.each([
    'Resume medis\nRencana: USG jika diperlukan. Pemeriksaan belum dilakukan.',
    'RINCIAN BIAYA\nUSG abdomen Rp 200.000',
    'Resume medis\nHasil radiologi akan dilampirkan',
  ])('rencana/tagihan/sebutan hasil tidak menjadi dokumen hasil radiologi', text => {
    expect(nilai('dokumen_tidak_lengkap','Lampirkan hasil radiologi',text).kotak).toBe('B');
  });
  test('hasil radiologi negatif tetap merupakan dokumen hasil', () => {
    expect(nilai('dokumen_tidak_lengkap','Lampirkan hasil radiologi',
      'HASIL PEMERIKSAAN RADIOLOGI\nFoto thorax\nKesan: tidak tampak infiltrat').kotak).toBe('A');
  });
  test('kode diagnosis disangkal tidak menjadi bukti pendukung', () => {
    const r=nilai('kode_diagnosis','Diagnosis J18.9 tidak sesuai',
      'Resume medis\nDiagnosis J18.9 disangkal. Tidak ditemukan bukti pneumonia.');
    expect(r.kotak).toBe('C');
  });
  test('negasi sebelum kode ICD dengan batas spasi tidak menjadi bukti pendukung', () => {
    expect(nilai('kode_diagnosis','Diagnosis J18.9 tidak sesuai',
      'Resume medis\nTidak ada J18.9').kotak).toBe('C');
  });
  test('kode pada tagihan tidak menjadi bukti klinis', () => {
    expect(nilai('kode_tindakan','Kode 93.94 tidak sesuai',
      'RINCIAN BIAYA\nNebulisasi 93.94 Rp 150.000').kotak).toBe('C');
  });
});

describe('triase koding', () => {
  test('A: kode yang disebut BPJS tertulis di berkas', () => {
    const t = nilaiTriase({ alasan_raw: 'Diagnosis A09 tidak sesuai', kategori: 'kode_diagnosis', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBe('A');
    expect(t.topik_bukti[0].kutipan[0]).toMatchObject({ halaman: 3 });
  });

  test('C: kode yang disebut BPJS tidak tertulis di berkas', () => {
    const t = nilaiTriase({ alasan_raw: 'Diagnosis J18.9 tidak sesuai', kategori: 'kode_diagnosis', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBe('C');
    expect(t.kode_dipersoalkan).toEqual(['J18.9']);
  });

  test('tanpa kode di alasan, kode klaim dipakai sebagai patokan', () => {
    const t = nilaiTriase({ alasan_raw: 'diagnosis tidak sesuai', kategori: 'kode_diagnosis', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBe('C'); // I10 tidak ada di halaman
    expect(t.kode_dipersoalkan).toEqual(['I10']);
  });

  test('kode tindakan diperiksa ke prosedur klaim', () => {
    const t = nilaiTriase({ alasan_raw: 'kode tindakan tidak sesuai', kategori: 'kode_tindakan', klaim: KLAIM, halaman: [{ page_number: 4, ocr_text: 'Tindakan: pemasangan infus 89.03' }] });
    expect(t.kotak).toBe('A');
  });
});

describe('triase dokumen', () => {
  test('A bila semua dokumen yang disebut ada', () => {
    const t = nilaiTriase({ alasan_raw: 'Lampirkan resume medis', kategori: 'dokumen_tidak_lengkap', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBe('A');
  });
  test('B bila salah satu tidak ada, daftar dokumen disebut', () => {
    const t = nilaiTriase({ alasan_raw: 'Lampirkan resume medis dan hasil laboratorium', kategori: 'dokumen_tidak_lengkap', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBe('B');
    expect(t.dokumen_dibutuhkan).toEqual(['Hasil laboratorium']);
  });
  test('dokumen tak dikenali -> kotak null, bukan tebakan', () => {
    const t = nilaiTriase({ alasan_raw: 'lengkapi berkas', kategori: 'dokumen_tidak_lengkap', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBeNull();
    expect(t.alasan_kotak).toMatch(/penilaian koder/);
  });
});

describe('triase kasus tanpa berkas', () => {
  test('klaim tidak ada -> B dengan alasan jelas', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: null, halaman: [] });
    expect(t.kotak).toBe('B');
    expect(t.alasan_kotak).toMatch(/Klaim tidak ada/);
  });
  test('klaim ada tetapi halaman kosong -> B', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: [] });
    expect(t.kotak).toBe('B');
    expect(t.alasan_kotak).toMatch(/teks halaman/);
  });
  test('kategori tanpa kriteria -> null', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'tarif_kelas_rawat', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(t.kotak).toBeNull();
  });
  test('hasil tidak memuat angka keyakinan', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: HAL_GAWAT });
    expect(JSON.stringify(t)).not.toMatch(/confidence|keyakinan|persen|probab/i);
  });
  test('kotak manual mengalahkan hasil hitung', () => {
    expect(kotakBerlaku({ kotak: 'A', kotak_manual: 'D' })).toBe('D');
    expect(kotakBerlaku({ kotak: 'A', kotak_manual: null })).toBe('A');
    expect(kotakBerlaku(null)).toBeNull();
  });
});

describe('susunPoin: aturan keras bukti', () => {
  test('poin tanpa kutipan berbunyi PERSIS "bukti tidak ditemukan di berkas"', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: [{ page_number: 1, ocr_text: 'Resume biasa' }] });
    const poin = susunPoin(t, 'B');
    expect(poin.length).toBeGreaterThan(0);
    for (const p of poin.filter((x) => x.jenis_poin === 'bukti')) {
      expect(p.kalimat).toBe('bukti tidak ditemukan di berkas');
      expect(p.kalimat).toBe(TIDAK_ADA_BUKTI);
      expect(p.kutipan).toBeNull();
      expect(p.terverifikasi).toBe(false);
    }
  });

  test('setiap kalimat bukti membawa halaman + kutipan yang ada di halaman itu', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: HAL_GAWAT });
    const poin = pastikanTerverifikasi(susunPoin(t, 'A'), HAL_GAWAT);
    const bukti = poin.filter((p) => p.terverifikasi);
    expect(bukti.length).toBeGreaterThan(0);
    for (const p of bukti) {
      const hal = HAL_GAWAT.find((h) => h.page_number === p.halaman);
      expect(hal.ocr_text.toLowerCase()).toContain(p.kutipan.toLowerCase());
      expect(p.kalimat).toContain(p.kutipan);
    }
  });

  test('kutipan yang tidak ada di halaman diturunkan menjadi "bukti tidak ditemukan"', () => {
    const palsu = [{ topik: 'X', jenis_poin: 'bukti', kalimat: 'Tercatat pada halaman 2: "pasien kejang hebat"', halaman: 2, kutipan: 'pasien kejang hebat', terverifikasi: true }];
    const [p] = pastikanTerverifikasi(palsu, HAL_GAWAT);
    expect(p.kalimat).toBe(TIDAK_ADA_BUKTI);
    expect(p.terverifikasi).toBe(false);
    expect(p.kutipan).toBeNull();
  });

  test('halaman yang tidak ada di berkas -> tidak terverifikasi', () => {
    const [p] = pastikanTerverifikasi([{ topik: 'X', jenis_poin: 'bukti', kalimat: 'k', halaman: 99, kutipan: 'MERAH', terverifikasi: true }], HAL_GAWAT);
    expect(p.terverifikasi).toBe(false);
  });

  test('kotak D menambah poin sikap yang menyebut kriterianya', () => {
    const t = nilaiTriase({ alasan_raw: 'x', kategori: 'kegawatdaruratan', klaim: KLAIM, halaman: HAL_NONGAWAT });
    const poin = susunPoin(t, 'D');
    const sikap = poin.find((p) => p.jenis_poin === 'sikap');
    expect(sikap.kalimat).toMatch(/tidak mempertahankan/);
    expect(sikap.sumber_kriteria).toMatch(/non-gawat/);
  });

  test('teks draf dan hitungan', () => {
    const poin = [
      { topik: 'A', jenis_poin: 'bukti', kalimat: 'Tercatat pada halaman 2: "MERAH"', terverifikasi: true },
      { topik: 'B', jenis_poin: 'bukti', kalimat: TIDAK_ADA_BUKTI, terverifikasi: false },
    ];
    expect(rakitTeks(poin)).toBe('1. A: Tercatat pada halaman 2: "MERAH"\n2. B: bukti tidak ditemukan di berkas');
    expect(hitung(poin)).toEqual({ terbukti: 1, tanpa_bukti: 1 });
  });

  test('pilihan AI hanya mengurutkan/memilih kutipan yang sudah ada', () => {
    const t = { alasan_kotak: 'x', topik_bukti: [{ topik: 'T', kutipan: [
      { halaman: 1, kutipan: 'satu', terverifikasi: true }, { halaman: 2, kutipan: 'dua', terverifikasi: true }] }] };
    const poin = susunPoin(t, 'A', { pilihan: { T: [1] } });
    expect(poin).toHaveLength(1);
    expect(poin[0].kutipan).toBe('dua');
  });
});

describe('pilihDenganAi', () => {
  const triase = { topik_bukti: [{ topik: 'T', kutipan: [
    { halaman: 1, kutipan: 'satu' }, { halaman: 2, kutipan: 'dua' }] }] };

  test('memakai tugas rancang_jawaban_pending dengan dikenal, dan menyaring nomor tak sah', async () => {
    const panggil = jest.fn().mockResolvedValue({ ok: true, hasil: { pilihan: { T: [1, 7, 'a', 0] } }, model: 'luna' });
    const r = await pilihDenganAi({ alasanRaw: 'r', triase, dikenal: { nama: 'BUDI TEST' }, panggil });
    expect(panggil.mock.calls[0][0]).toBe('rancang_jawaban_pending');
    expect(panggil.mock.calls[0][1].dikenal).toEqual({ nama: 'BUDI TEST' });
    expect(r.pilihan).toEqual({ T: [1, 0] });
  });

  test('model gagal -> pilihan kosong', async () => {
    const panggil = jest.fn().mockResolvedValue({ ok: false });
    expect((await pilihDenganAi({ alasanRaw: 'r', triase, dikenal: {}, panggil })).pilihan).toEqual({});
  });

  test('tanpa kandidat ganda model tidak dipanggil', async () => {
    const panggil = jest.fn();
    await pilihDenganAi({ alasanRaw: 'r', triase: { topik_bukti: [{ topik: 'T', kutipan: [{ halaman: 1, kutipan: 'a' }] }] }, dikenal: {}, panggil });
    expect(panggil).not.toHaveBeenCalled();
  });
});

/** DB tiruan berkeadaan untuk buatDraft/setujui/tolak. */
function dbTiruan({ pending, klaim = KLAIM, halaman = HAL_GAWAT }) {
  const drafts = [];
  return {
    drafts,
    prepare: (sql) => ({
      get: async (...p) => {
        if (/FROM bpjs_pending_responses bpr/.test(sql)) return pending;
        if (/FROM claim_records/.test(sql)) return klaim;
        if (/MAX\(versi\)/.test(sql)) return { v: drafts.filter((d) => d.pending_id === p[0]).length || null };
        if (/FROM draft_jawaban_pending WHERE id/.test(sql)) return drafts.find((d) => d.id === p[0]);
        return undefined;
      },
      all: async (...p) => {
        if (/FROM ocr_results/.test(sql)) return halaman;
        if (/FROM draft_jawaban_pending WHERE pending_id/.test(sql)) return drafts.filter((d) => d.pending_id === p[0]).sort((a, b) => b.versi - a.versi);
        return [];
      },
      run: async (...p) => {
        if (/INSERT INTO draft_jawaban_pending/.test(sql)) {
          drafts.push({
            id: p[0], pending_id: p[1], versi: p[2], status: 'draft', kotak: p[3], kategori: p[4], teks_draft: p[5], poin: p[6],
            jumlah_poin_terbukti: p[7], jumlah_poin_tanpa_bukti: p[8], dibuat_dengan: p[9], dibuat_oleh: p[10],
          });
        } else if (/SET status = 'diganti'/.test(sql)) {
          drafts.filter((d) => d.pending_id === p[0] && d.status === 'draft').forEach((d) => { d.status = 'diganti'; });
        } else if (/SET status = 'siap'/.test(sql)) {
          const d = drafts.find((x) => x.id === p[2]); if (d && d.status === 'draft') Object.assign(d, { status: 'siap', disetujui_oleh: p[0], catatan_koder: p[1] });
        } else if (/SET status = 'ditolak'/.test(sql)) {
          const d = drafts.find((x) => x.id === p[2]); if (d && d.status === 'draft') Object.assign(d, { status: 'ditolak', ditolak_oleh: p[0], alasan_tolak: p[1] });
        }
        return { changes: 1 };
      },
    }),
  };
}

const PENDING = {
  id: 'p1', sep: KLAIM.sep, nama_peserta: 'BUDI TEST', nokartu: '0000000000001', mrn: 'RM000', claim_record_id: 'c1',
  alasan_raw: 'Harap cek kembali penagihan kondisi kegawatan', kategori: 'kegawatdaruratan', jenis_rawat: 'rawat_jalan',
  jawaban_rs_manual: 'JAWABAN LAMA RS', kotak_manual: null,
};

describe('buatDraft / persetujuan koder', () => {
  test('draf dibuat dengan status draft, bukan siap, dan poin terbukti tercatat', async () => {
    const db = dbTiruan({ pending: PENDING });
    const d = await buatDraft(db, 'p1', { userId: 'u1' });
    expect(d.status).toBe('draft');
    expect(d.versi).toBe(1);
    expect(d.kotak).toBe('A');
    expect(d.terbukti).toBeGreaterThan(0);
    expect(d.teks_draft).toMatch(/Tercatat pada halaman 2/);
  });

  test('tidak ada jalur ke status siap tanpa persetujuan: hanya setujuiDraft yang mengubahnya', async () => {
    const db = dbTiruan({ pending: PENDING });
    const d = await buatDraft(db, 'p1', { userId: 'u1' });
    expect(db.drafts[0].status).toBe('draft');
    await setujuiDraft(db, d.id, { userId: 'koder1' });
    expect(db.drafts[0]).toMatchObject({ status: 'siap', disetujui_oleh: 'koder1' });
  });

  test('persetujuan tanpa pengguna ditolak', async () => {
    const db = dbTiruan({ pending: PENDING });
    const d = await buatDraft(db, 'p1', {});
    await expect(setujuiDraft(db, d.id, {})).rejects.toMatchObject({ kode: 'tanpa_pengguna' });
    expect(db.drafts[0].status).toBe('draft');
  });

  test('poin tanpa bukti butuh pengakuan eksplisit koder', async () => {
    const db = dbTiruan({ pending: PENDING, halaman: [{ page_number: 1, ocr_text: 'Resume biasa saja' }] });
    const d = await buatDraft(db, 'p1', { userId: 'u1' });
    expect(d.tanpa_bukti).toBeGreaterThan(0);
    expect(d.teks_draft).toContain('bukti tidak ditemukan di berkas');
    await expect(setujuiDraft(db, d.id, { userId: 'k' })).rejects.toMatchObject({ kode: 'perlu_pengakuan' });
    const s = await setujuiDraft(db, d.id, { userId: 'k', akuiTanpaBukti: true });
    expect(s.status).toBe('siap');
  });

  test('kutipan yang gugur saat persetujuan (berkas berubah) membatalkan persetujuan', async () => {
    const db = dbTiruan({ pending: PENDING });
    const d = await buatDraft(db, 'p1', { userId: 'u1' });
    // teks halaman berubah setelah draf dibuat
    db.prepare = ((orig) => (sql) => {
      const o = orig(sql);
      if (/FROM ocr_results/.test(sql)) return { ...o, all: async () => [{ page_number: 2, ocr_text: 'teks sudah lain sama sekali' }] };
      return o;
    })(db.prepare);
    await expect(setujuiDraft(db, d.id, { userId: 'k' })).rejects.toMatchObject({ kode: 'bukti_gugur' });
    expect(db.drafts[0].status).toBe('draft');
  });
  test('draf lama dengan teks literal negasi ditolak oleh pemeriksaan konteks saat persetujuan', async () => {
    const halaman=[{page_number:2,ocr_text:'TRIASE IGD\nKategori triase: HIJAU\nTidak ada sesak'}];
    const db=dbTiruan({pending:PENDING,halaman});
    db.drafts.push({id:'lama',pending_id:'p1',status:'draft',kotak:'A',poin:JSON.stringify([
      {jenis_poin:'bukti',halaman:2,kutipan:'Tidak ada sesak',terverifikasi:true},
    ])});
    await expect(setujuiDraft(db,'lama',{userId:'k'})).rejects.toMatchObject({kode:'bukti_gugur'});
    expect(db.drafts[0].status).toBe('draft');
  });
  test('draf D lama tidak disetujui tanpa keputusan kotak D manual oleh koder', async()=>{
    const db=dbTiruan({pending:PENDING});
    const d=await buatDraft(db,'p1',{});
    db.drafts[0].kotak='D';
    await expect(setujuiDraft(db,d.id,{userId:'k'})).rejects.toMatchObject({kode:'perlu_keputusan_koder'});
  });

  test('draf yang sudah siap tidak bisa disetujui/ditolak lagi', async () => {
    const db = dbTiruan({ pending: PENDING });
    const d = await buatDraft(db, 'p1', {});
    await setujuiDraft(db, d.id, { userId: 'k' });
    await expect(setujuiDraft(db, d.id, { userId: 'k' })).rejects.toMatchObject({ kode: 'status_tidak_sah' });
    await expect(tolakDraft(db, d.id, { userId: 'k' })).rejects.toMatchObject({ kode: 'status_tidak_sah' });
  });

  test('tolak draf', async () => {
    const db = dbTiruan({ pending: PENDING });
    const d = await buatDraft(db, 'p1', {});
    const r = await tolakDraft(db, d.id, { userId: 'k', alasan: 'kurang lengkap' });
    expect(r.status).toBe('ditolak');
  });

  test('draf baru menggantikan draf lama yang masih draft (versi naik)', async () => {
    const db = dbTiruan({ pending: PENDING });
    await buatDraft(db, 'p1', {});
    const d2 = await buatDraft(db, 'p1', {});
    expect(d2.versi).toBe(2);
    expect(db.drafts[0].status).toBe('diganti');
  });

  test('belum dipetakan / kotak belum ada ditolak dengan kode jelas', async () => {
    await expect(buatDraft(dbTiruan({ pending: { ...PENDING, kategori: null } }), 'p1', {})).rejects.toMatchObject({ kode: 'belum_dipetakan' });
    await expect(buatDraft(dbTiruan({ pending: { ...PENDING, kategori: 'tarif_kelas_rawat' } }), 'p1', {})).rejects.toMatchObject({ kode: 'kotak_belum_ada' });
  });

  test('kotak manual dipakai untuk draf, mis. D menambah poin sikap', async () => {
    const db = dbTiruan({ pending: { ...PENDING, kotak_manual: 'D' } });
    const d = await buatDraft(db, 'p1', {});
    expect(d.kotak).toBe('D');
    expect(d.poin.some((p) => p.jenis_poin === 'sikap')).toBe(true);
  });

  test('AI dipakai hanya bila diminta, dan gagalnya AI tidak menggagalkan draf', async () => {
    const db = dbTiruan({ pending: PENDING });
    const panggil = jest.fn().mockRejectedValue(new Error('down'));
    const d = await buatDraft(db, 'p1', { pakaiAi: true, panggil });
    expect(d.dibuat_dengan).toBe('aturan');
    const db2 = dbTiruan({ pending: PENDING });
    const panggil2 = jest.fn();
    await buatDraft(db2, 'p1', { panggil: panggil2 });
    expect(panggil2).not.toHaveBeenCalled();
  });

  test('SQL draf tidak pernah menyentuh jawaban_rs_manual atau draft_klarifikasi', async () => {
    const semua = [];
    const db = dbTiruan({ pending: PENDING });
    const asli = db.prepare;
    db.prepare = (sql) => { semua.push(sql); return asli(sql); };
    const d = await buatDraft(db, 'p1', { userId: 'u' });
    await setujuiDraft(db, d.id, { userId: 'k' });
    for (const sql of semua.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s))) {
      expect(sql).not.toMatch(/jawaban_rs_manual|draft_klarifikasi|bpjs_pending_responses/);
    }
  });
});

describe('tampilanSampingan', () => {
  test('memuat alasan | jawaban | bukti dan jawaban_rs_manual apa adanya', async () => {
    const db = dbTiruan({ pending: PENDING });
    await buatDraft(db, 'p1', {});
    const v = await tampilanSampingan(db, 'p1');
    expect(v.kolom.alasan_pending).toBe(PENDING.alasan_raw);
    expect(v.kolom.jawaban).toMatch(/Tercatat pada halaman/);
    expect(v.kolom.bukti.length).toBeGreaterThan(0);
    expect(v.kolom.bukti[0]).toMatchObject({ halaman: expect.any(Number), kutipan: expect.any(String), terverifikasi: true });
    expect(v.pending.jawaban_rs_manual).toBe('JAWABAN LAMA RS');
    expect(v.triase.kotak).toBe('A');
    expect(v.triase.kriteria.length).toBeGreaterThan(0);
    expect(v.riwayat_versi).toHaveLength(1);
  });

  test('tanpa draf: kolom jawaban null, kriteria tetap tampil', async () => {
    const db = dbTiruan({ pending: PENDING });
    const v = await tampilanSampingan(db, 'p1');
    expect(v.kolom.jawaban).toBeNull();
    expect(v.draft).toBeNull();
    expect(v.triase.label).toBe('Bisa dijawab');
  });
});
