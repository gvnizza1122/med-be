const { susunPutusan, STATUS } = require('../../services/putusanPendingService');

const kons = (o) => ({ id: 'KD-X', nama: 'Temuan', pesan: '...', keparahan: 'tinggi', diverifikasi: true, yang_ditemukan: null, yang_dicari: null, sumber_aturan: null, ...o });

describe('susunPutusan — menjawab "pending atau tidak"', () => {
  test('tidak ada temuan -> dinyatakan bersih', () => {
    const p = susunPutusan({}, []);
    expect(p.status).toBe(STATUS.BERSIH);
    expect(p.alasan).toEqual([]);
  });

  test('ada temuan berat -> berisiko pending', () => {
    const p = susunPutusan({ konsistensi_data: [kons({ keparahan: 'tinggi' })] }, []);
    expect(p.status).toBe(STATUS.BERISIKO);
    expect(p.ringkasan).toMatch(/1 hal/);
  });

  test('hanya temuan sedang -> perlu dicek, bukan berisiko', () => {
    const p = susunPutusan({ konsistensi_data: [kons({ keparahan: 'sedang' })] }, []);
    expect(p.status).toBe(STATUS.PERLU_DICEK);
  });

  test('menghitung jumlah yang berat, bukan seluruh temuan', () => {
    const p = susunPutusan({
      konsistensi_data: [kons({ keparahan: 'tinggi' }), kons({ keparahan: 'sedang' }), kons({ keparahan: 'tinggi' })],
    }, []);
    expect(p.jumlah.berat).toBe(2);
    expect(p.jumlah.total).toBe(3);
  });
});

describe('urutan alasan', () => {
  // Aturan yang lahir dari klaim yang BENAR-BENAR pernah ditolak di RS ini
  // bobotnya berbeda dari dugaan kelengkapan berkas, jadi naik ke atas.
  test('alasan dari rekap pending BPJS didahulukan', () => {
    const p = susunPutusan({
      konsistensi_data: [
        kons({ nama: 'Dugaan kelengkapan', sumber_aturan: 'Kelengkapan dasar klaim' }),
        kons({ nama: 'Pernah ditolak', sumber_aturan: 'Rekap pending BPJS RS Lestari Raharja: ...' }),
      ],
    }, []);
    expect(p.alasan[0].ringkas).toBe('Pernah ditolak');
    expect(p.alasan[0].dari_rekap_pending).toBe(true);
  });

  test('yang sudah disahkan koder didahulukan atas yang belum', () => {
    const p = susunPutusan({
      konsistensi_data: [
        kons({ nama: 'Belum disahkan', diverifikasi: false }),
        kons({ nama: 'Sudah disahkan', diverifikasi: true }),
      ],
    }, []);
    expect(p.alasan[0].ringkas).toBe('Sudah disahkan');
  });
});

describe('kehati-hatian', () => {
  // Semua alasan menentukan status, termasuk dari aturan yang belum ditelaah
  // koder. Menahan temuan di belakang gerbang persetujuan berarti koder tetap
  // harus membaca dan menilainya sendiri — memeriksa ulang apa yang sudah
  // diperiksa sistem, yaitu kerja dua kali. Aturan yang keliru diperbaiki di
  // berkas aturannya, bukan dengan menahan seluruh temuan.
  test('aturan yang belum disahkan tetap menentukan status', () => {
    const p = susunPutusan({ konsistensi_data: [kons({ keparahan: 'tinggi', diverifikasi: false })] }, []);
    expect(p.status).toBe(STATUS.BERISIKO);
    expect(p.alasan).toHaveLength(1);
  });

  // Daftar obat di berkas RS ini nyaris tidak terbaca OCR. Menyebut itu sebagai
  // alasan pending berarti menyalahkan rumah sakit atas kegagalan sistem
  // membaca berkasnya sendiri.
  test('syarat yang perlu dicek manual tidak dihitung sebagai alasan pending', () => {
    const p = susunPutusan({
      syarat_penunjang: [{
        id: 'SP-01', kode_diagnosis: 'J18.9', diverifikasi: true, sumber_aturan: 'x',
        syarat: [
          { nama: 'Antibiotik intravena minimal 72 jam', status: 'perlu_cek_manual' },
          { nama: 'Rontgen toraks', status: 'terpenuhi' },
        ],
      }],
    }, []);
    expect(p.alasan).toEqual([]);
    expect(p.status).toBe(STATUS.BERSIH);
  });

  // Selisih identitas yang ringan hampir selalu salah baca OCR.
  test('temuan identitas ringan tidak jadi alasan pending', () => {
    const p = susunPutusan({
      identitas_halaman: [
        { page_number: 9, jenis: 'nama_tidak_cocok', keparahan: 'rendah', pesan: '...', ditemukan: 'x' },
      ],
    }, []);
    expect(p.alasan).toEqual([]);
  });

  test('identitas berat tetap jadi alasan', () => {
    const p = susunPutusan({
      identitas_halaman: [
        { page_number: 4, jenis: 'identitas_berbeda', keparahan: 'tinggi', pesan: '...', ditemukan: 'x' },
      ],
    }, []);
    expect(p.alasan).toHaveLength(1);
    expect(p.status).toBe(STATUS.BERISIKO);
  });

  // Belum ada satu pun klaim di sistem ini yang hasil akhirnya dari BPJS sudah
  // diketahui, jadi ketepatan putusan ini belum pernah terukur. Angka
  // persentase akan jadi angka karangan yang terdengar meyakinkan.
  test('tidak pernah memberi angka persentase', () => {
    const p = susunPutusan({ konsistensi_data: [kons({})] }, []);
    const teks = JSON.stringify(p);
    expect(teks).not.toMatch(/\d+\s*%/);
    expect(p.catatan_keandalan).toMatch(/belum pernah terukur/i);
  });

  test('menyatakan diri sebagai dugaan, bukan keputusan BPJS', () => {
    expect(susunPutusan({}, []).catatan_keandalan).toMatch(/bukan keputusan BPJS/i);
  });

  test('masukan kosong atau cacat tidak bikin error', () => {
    expect(susunPutusan(null, null).status).toBe(STATUS.BERSIH);
    expect(susunPutusan(undefined, undefined).alasan).toEqual([]);
  });
});

describe('alasan membawa bukti dan tindakan', () => {
  test('kutipan dan halaman ikut disertakan', () => {
    const p = susunPutusan({
      konsistensi_data: [kons({ yang_ditemukan: { kutipan: 'Cara Bayar : UMUM', page_number: 2 }, yang_dicari: 'SEP kosong' })],
    }, []);
    expect(p.alasan[0].bukti).toMatch(/Cara Bayar : UMUM/);
    expect(p.alasan[0].bukti).toMatch(/hal\. 2/);
    expect(p.alasan[0].tindakan).toMatch(/SEP kosong/);
  });

  test('aturan validasi lama ikut masuk sebagai alasan', () => {
    const p = susunPutusan({}, [{ rule_id: 'RV-05', error_message: 'DIAGLIST kosong', severity: 'major' }]);
    expect(p.alasan[0].kode).toBe('RV-05');
    expect(p.alasan[0].sumber_pemeriksaan).toBe('Aturan validasi');
  });
});
