const { susunPutusan, segarkanAlasanValidasi } = require('../../services/putusanPendingService');

// MUNAWIR (0170R0110926V001943): putusan disusun saat DIAGLIST kosong (RV-05),
// lalu DIAGLIST diisi otomatis J44.9;J18.9 -- RV-05 tetap tampil sebagai alasan.
const RV05 = { rule_id: 'RV-05', field_name: 'diagnosa_list', error_message: 'DIAGLIST wajib diisi minimal 1 kode diagnosa.', severity: 'critical', actual_value: '(kosong)' };
const KD01 = { id: 'KD-01', nama: 'Nebulisasi tanpa obat pendukung di resep', keparahan: 'tinggi', diverifikasi: true, yang_ditemukan: { kutipan: 'Nebulisasi', page_number: 2 } };
const KD10 = { id: 'KD-10', nama: 'Temuan paru resume bertentangan dengan triase', keparahan: 'rendah', diverifikasi: true };

describe('segarkanAlasanValidasi', () => {
  test('RV-05 yang sudah teratasi dibuang; alasan lain tetap', () => {
    const p = susunPutusan({ konsistensi_data: [KD01] }, [RV05]);
    const segar = segarkanAlasanValidasi(p, []);
    expect(segar.alasan.map(a => a.kode)).toEqual(['KD-01']);
    expect(segar.status).toBe('berisiko_pending');
    expect(segar.jumlah.total).toBe(1);
  });

  test('satu-satunya alasan berat teratasi -> turun ke perlu_dicek', () => {
    const p = susunPutusan({ konsistensi_data: [KD10] }, [RV05]);
    expect(p.status).toBe('berisiko_pending');
    const segar = segarkanAlasanValidasi(p, []);
    expect(segar.status).toBe('perlu_dicek');
    expect(segar.alasan.map(a => a.kode)).toEqual(['KD-10']);
  });

  test('semua alasan teratasi -> bersih', () => {
    const segar = segarkanAlasanValidasi(susunPutusan({}, [RV05]), []);
    expect(segar.status).toBe('tidak_ditemukan_alasan');
    expect(segar.alasan).toEqual([]);
  });

  test('error yang masih berlaku dipertahankan; tanpa perubahan -> null', () => {
    const p = susunPutusan({ konsistensi_data: [KD01] }, [RV05]);
    expect(segarkanAlasanValidasi(p, [RV05])).toBeNull();
    expect(segarkanAlasanValidasi(null, [])).toBeNull();
  });
});
