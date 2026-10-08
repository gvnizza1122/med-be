const {
  evaluasiKombinasiKode,
  aturanBelumTerverifikasi,
  ringkasKetentuan,
} = require('../../services/ketentuanKlaimService');

describe('ketentuanKlaimService — Tipe 3 (aturan kombinasi kode)', () => {
  test('menangkap kombinasi yang memang diatur', () => {
    const kasus = [
      ['I63.9;R40.1', 'KMB-02', 'R40.1'],
      ['A01.0;A09', 'KMB-03', 'A09'],
      ['N23;N39.0', 'KMB-04', 'N39.0'],
      ['N19;I10', 'KMB-05', 'I10'],
      ['J18.0;R56.0', 'KMB-07', 'R56.0'],
      ['J45.0;J44.1', 'KMB-08', 'J44.1'],
      ['I50.0;J81', 'KMB-10', 'J81'],
    ];
    for (const [diaglist, kodeAturan, terdampak] of kasus) {
      const temuan = evaluasiKombinasiKode(diaglist);
      const cocok = temuan.find(t => t.kode === kodeAturan);
      expect(cocok).toBeDefined();
      expect(cocok.kode_terdampak).toContain(terdampak);
    }
  });

  test('kode gabungan disertakan untuk aksi ganti_gabungan', () => {
    expect(evaluasiKombinasiKode('N19;I10')[0].kode_gabungan).toBe('I12.0');
    expect(evaluasiKombinasiKode('J44.9;J06.9')[0].kode_gabungan).toBe('J44.1'); // BA 2019 butir 78
    // KMB-08 (catatan RS asma+PPOK -> J45.9) bertentangan dengan ICD-10/BA 2019 butir 89: kini telaah, tidak digabung otomatis.
    expect(evaluasiKombinasiKode('J45.0;J44.1')[0]).toMatchObject({ kode: 'KMB-08', aksi: 'telaah', kode_gabungan: null });
  });

  // Aturan yang kode ICD-nya belum dipastikan koder tidak boleh ikut menilai
  // klaim -- dokumen sumber menyebutnya dengan nama penyakit, bukan kode.
  test('aturan yang belum terverifikasi TIDAK dievaluasi', () => {
    expect(evaluasiKombinasiKode('A90;D69.6')).toEqual([]);   // KMB-06
    expect(evaluasiKombinasiKode('I11.9;I51.7')).toEqual([]); // KMB-09
    expect(aturanBelumTerverifikasi().length).toBeGreaterThan(0);
    aturanBelumTerverifikasi().forEach(a => expect(a.alasan).toBeTruthy());
  });

  test('tidak menandai apa pun tanpa dasar', () => {
    expect(evaluasiKombinasiKode('A01.0')).toEqual([]);       // satu kode
    expect(evaluasiKombinasiKode('')).toEqual([]);
    expect(evaluasiKombinasiKode(null)).toEqual([]);
    expect(evaluasiKombinasiKode('E11.9;I10')).toEqual([]);   // tidak ada aturannya
  });

  // Prefiks yang lebih spesifik tidak boleh tertarik oleh yang lebih umum.
  test('pencocokan prefiks menghormati tingkat kekhususan kode', () => {
    expect(evaluasiKombinasiKode('I63;R40.1').length).toBeGreaterThan(0);   // I63 tanpa subkode
    // Kebalikannya: aturan KMB-07 menyebut J18.0 (pneumonia lobaris), jadi
    // J18 umum TIDAK boleh ikut tertandai -- kalau ikut, aturan spesifik
    // akan bocor ke diagnosis yang lebih luas.
    expect(evaluasiKombinasiKode('J18;R56.0')).toEqual([]);
    expect(evaluasiKombinasiKode('J18.0;R56.0').length).toBeGreaterThan(0);
  });

  test('menerima array maupun teks dipisah titik koma/koma', () => {
    expect(evaluasiKombinasiKode(['A01.0', 'A09']).length).toBe(1);
    expect(evaluasiKombinasiKode('A01.0, A09').length).toBe(1);
    expect(evaluasiKombinasiKode('a01.0;a09').length).toBe(1); // huruf kecil
  });

  test('tiap temuan membawa sumber & kutipannya untuk berargumen dengan verifikator', () => {
    const t = evaluasiKombinasiKode('A01.0;A09')[0];
    expect(['casemix_rs', 'ba_2018', 'keduanya']).toContain(t.sumber);
    expect(t.kutipan_sumber).toBeTruthy();
  });

  test('ringkasan aturan konsisten', () => {
    const r = ringkasKetentuan();
    expect(r.aktif + r.belum_terverifikasi).toBe(r.total);
    expect(r.aktif).toBeGreaterThan(0);
  });
});
