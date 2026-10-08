/**
 * Rule Engine - Validates claim records against validation rules
 * Based on BPJS/INACBG requirements and BA Kesepakatan BPJS No. 1247/2024
 * * Rules:
 * RV-01: SEP Format (uppercase) - CRITICAL
 * RV-02: NOKARTU Format (13 digit) - CRITICAL
 * RV-03: Admission <= Discharge Date - CRITICAL
 * RV-04: Age cross-check with BIRTH_DATE - MAJOR
 * RV-05: ICD-10 Diagnosis code format - MAJOR
 * RV-06: ICD-9-CM Procedure code format - MAJOR
 * RV-07: KELAS_RAWAT valid (1/2/3) - MAJOR
 * RV-08: DISCHARGE_STATUS valid (1/2/3/4/5) - MAJOR
 * RV-09: NAMA_PASIEN not empty - CRITICAL
 * RV-10: Tarif discrepancy check - MINOR
 * RV-11: Kelengkapan Dokumen Rehabilitasi Medik (BA 1247/2024) - MAJOR
 * RV-12: Kelengkapan Dokumen Eksisi Tumor & PA (BA 1247/2024) - MAJOR
 * RV-13: Validasi Gabung Episode Konsul Internal (BA 1247/2024) - MAJOR
 * RV-14: Validasi Episode Rujukan Internal RJTL (BA 1247/2024) - MAJOR
 * RV-15: Flagging Otomatisasi Program Rujuk Balik / PRB (BA 1247/2024) - MAJOR
 * RV-16: Batasan Maksimal Iterasi Obat Kronis (BA 1247/2024) - MAJOR
 * RV-17: Telaah indikasi odontektomi RJ/RI dilakukan oleh referensi RK-17 (BA 2024)
 * RV-18: Kode Kombinasi I10 + I25.9 -> I11.9 (mining data pending BPJS riil) - MINOR
 * RV-20: Kriteria Kegawatan IGD (kode nyeri generik tanpa bukti kegawatan) - MINOR
 * RV-21: Validasi TARIF_INACBG vs Tabel Resmi PMK 3/2023 (Regional 1 x Kelas D Swasta) - MAJOR
 */

// ICD-10: Letter followed by 2+ digits, optionally dot + digits
const { matchPrbCategory } = require('./prbRules');
const { getTarifResmi, validateTarifDiscrepancy } = require('./tarifInacbgLookup');
const { validateWithRuleLogic } = require('./genericRuleValidator');

const ICD10_PATTERN = /^[A-Z]\d{2}(\.\d{1,4})?$/i;
// ICD-9-CM: 2-3 digits, optionally dot + digits
const ICD9CM_PATTERN = /^\d{2,3}(\.\d{1,4})?$/;

/**
 * Run all active validation rules on a single record
 * @param {Object} record - Parsed claim record
 * @param {Array} activeRules - Active validation rules from DB
 * @returns {Array} Array of error objects
 */
function validateRecord(record, activeRules) {
  const errors = [];
  const ruleMap = {};
  activeRules.forEach(r => { ruleMap[r.id] = r; });

  // RV-01: Format SEP - must be uppercase
  if (ruleMap['RV-01']?.is_active) {
    const sep = record.sep || '';
    if (sep) {
      if (sep !== sep.toUpperCase()) {
        errors.push({
          rule_id: 'RV-01',
          field_name: 'sep',
          severity: 'critical',
          error_message: ruleMap['RV-01'].error_message || 'SEP mengandung huruf kecil. Harus uppercase semua (contoh: huruf "v" harus "V").',
          expected_value: sep.toUpperCase(),
          actual_value: sep
        });
      }
      if (sep.length < 10) {
        errors.push({
          rule_id: 'RV-01',
          field_name: 'sep',
          severity: 'critical',
          error_message: 'Format SEP tidak valid. SEP terlalu pendek.',
          expected_value: 'Minimal 10 karakter (contoh: 0000R0000126V000011)',
          actual_value: sep
        });
      }
    } else if (record.has_bpjs_page !== false) {
      // has_bpjs_page === false: dokumen ini memang tidak punya halaman
      // SEP/BPJS (terdeteksi dari isi PDF, lihat pdfPageClassifier.js) —
      // SEP kosong di sini bukan berarti AI gagal ekstrak, tapi memang
      // bukan klaim BPJS. Tidak dianggap error.
      errors.push({
        rule_id: 'RV-01',
        field_name: 'sep',
        severity: 'critical',
        error_message: 'SEP wajib diisi.',
        expected_value: 'Nomor SEP valid',
        actual_value: '(kosong)'
      });
    }
  }

  // RV-02: Format NOKARTU - 13 digit angka
  if (ruleMap['RV-02']?.is_active) {
    const nokartu = record.nokartu || '';
    if (nokartu) {
      if (!/^\d{13}$/.test(nokartu)) {
        errors.push({
          rule_id: 'RV-02',
          field_name: 'nokartu',
          severity: 'critical',
          error_message: ruleMap['RV-02'].error_message || 'NOKARTU harus 13 digit angka.',
          expected_value: '13 digit angka',
          actual_value: `${nokartu} (${nokartu.length} karakter)`
        });
      }
    } else if (record.has_bpjs_page !== false) {
      // Lihat catatan RV-01 di atas — sama, dokumen tanpa halaman BPJS
      // tidak dianggap error kalau NOKARTU kosong.
      errors.push({
        rule_id: 'RV-02',
        field_name: 'nokartu',
        severity: 'critical',
        error_message: 'NOKARTU wajib diisi.',
        expected_value: '13 digit angka',
        actual_value: '(kosong)'
      });
    }
  }

  // RV-03: Admission <= Discharge date
  if (ruleMap['RV-03']?.is_active) {
    const adm = record.admission_date;
    const dis = record.discharge_date;
    if (adm && dis) {
      const admDate = new Date(adm);
      const disDate = new Date(dis);
      if (!isNaN(admDate) && !isNaN(disDate) && admDate > disDate) {
        errors.push({
          rule_id: 'RV-03',
          field_name: 'admission_date',
          severity: 'critical',
          error_message: ruleMap['RV-03'].error_message || 'Tanggal masuk harus sebelum atau sama dengan tanggal keluar.',
          expected_value: `<= ${dis}`,
          actual_value: adm
        });
      }
    }
    if (!adm) {
      errors.push({
        rule_id: 'RV-03',
        field_name: 'admission_date',
        severity: 'critical',
        error_message: 'Tanggal masuk (ADMISSION_DATE) wajib diisi.',
        expected_value: 'Format tanggal valid',
        actual_value: '(kosong)'
      });
    }
    if (!dis) {
      errors.push({
        rule_id: 'RV-03',
        field_name: 'discharge_date',
        severity: 'critical',
        error_message: 'Tanggal keluar (DISCHARGE_DATE) wajib diisi.',
        expected_value: 'Format tanggal valid',
        actual_value: '(kosong)'
      });
    }
  }

  // RV-04: Cross-check Umur with BIRTH_DATE
  if (ruleMap['RV-04']?.is_active) {
    const birthDate = record.birth_date;
    const admDate = record.admission_date;
    const umur = record.umur_tahun;
    // Bayi baru lahir (neonatal) yang UMUR_TAHUN=0 itu VALID secara klinis —
    // dikecualikan dari kedua cabang di bawah lewat kode ICD-10 P00-P99
    // (satu-satunya sinyal objektif dari dokumen, bukan tebakan).
    const isNeonatalDiagnosis = /(?:^|;)\s*P\d{2}/i.test(record.diagnosa_list || '');
    const birth = birthDate ? new Date(birthDate) : null;
    const birthValid = birth && !isNaN(birth);

    if (admDate && (umur === 0 || umur === '0') && !birthValid && !isNeonatalDiagnosis) {
      // Sebelumnya di-skip diam-diam kalau BIRTH_DATE kosong/tidak valid —
      // UMUR=0 tanpa BIRTH_DATE untuk lolos tanpa verifikasi. Sekarang wajib
      // ditandai supaya verifikator mengisi BIRTH_DATE secara manual.
      errors.push({
        rule_id: 'RV-04',
        field_name: 'umur_tahun',
        severity: 'major',
        error_message: 'UMUR_TAHUN 0 tapi TGL_LAHIR kosong/tidak valid sehingga tidak bisa dicek silang — kemungkinan data umur belum benar diisi.',
        expected_value: 'TGL_LAHIR valid untuk verifikasi umur, atau kode diagnosis neonatal (P00-P99) kalau memang bayi baru lahir',
        actual_value: `umur_tahun=0, birth_date=${birthDate || '(kosong)'}`
      });
    } else if (birthValid && admDate && umur !== undefined && umur !== null) {
      const admission = new Date(admDate);
      if (!isNaN(admission)) {
        let calcAge = admission.getFullYear() - birth.getFullYear();
        const monthDiff = admission.getMonth() - birth.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && admission.getDate() < birth.getDate())) {
          calcAge--;
        }
        if (Math.abs(umur - calcAge) > 1 && !(isNeonatalDiagnosis && Number(umur) === 0)) {
          errors.push({
            rule_id: 'RV-04',
            field_name: 'umur_tahun',
            severity: 'major',
            error_message: ruleMap['RV-04'].error_message || 'Umur tidak sesuai dengan tanggal lahir (toleransi 1 tahun).',
            expected_value: `${calcAge} tahun (dari TGL_LAHIR: ${birthDate})`,
            actual_value: `${umur} tahun`
          });
        }
      }
    }
  }

  // RV-05: ICD-10 Diagnosis codes
  if (ruleMap['RV-05']?.is_active) {
    const diagStr = record.diagnosa_list || '';
    if (!diagStr || diagStr === '' || diagStr === '-') {
      errors.push({
        rule_id: 'RV-05',
        field_name: 'diagnosa_list',
        severity: 'major',
        error_message: 'DIAGLIST wajib diisi minimal 1 kode diagnosa.',
        expected_value: 'Minimal 1 kode ICD-10',
        actual_value: '(kosong)'
      });
    } else {
      const diags = diagStr.split(';').map(d => d.trim()).filter(d => d && d !== '-');
      if (diags.length === 0) {
        errors.push({
          rule_id: 'RV-05',
          field_name: 'diagnosa_list',
          severity: 'major',
          error_message: 'DIAGLIST wajib diisi minimal 1 kode diagnosa.',
          expected_value: 'Minimal 1 kode ICD-10',
          actual_value: '(kosong)'
        });
      } else {
        const invalidDiags = diags.filter(diag => !ICD10_PATTERN.test(diag));
        invalidDiags.forEach(diag => {
          errors.push({
            rule_id: 'RV-05',
            field_name: 'diagnosa_list',
            severity: 'major',
            error_message: `Kode diagnosa ICD-10 tidak valid: ${diag}`,
            expected_value: 'Format ICD-10 (contoh: E11.9, I10, J18.0)',
            actual_value: diag
          });
        });
      }
    }
  }

  // RV-06: ICD-9-CM Procedure codes
  if (ruleMap['RV-06']?.is_active) {
    const procStr = record.prosedur_list || '';
    if (procStr && procStr !== '-') {
      const procs = procStr.split(';').map(p => p.trim()).filter(p => p && p !== '-');
      procs.forEach(proc => {
        if (!ICD9CM_PATTERN.test(proc)) {
          errors.push({
            rule_id: 'RV-06',
            field_name: 'prosedur_list',
            severity: 'major',
            error_message: `Kode prosedur ICD-9-CM tidak valid: ${proc}`,
            expected_value: 'Format ICD-9-CM (contoh: 88.72, 99.04, 90.59)',
            actual_value: proc
          });
        }
      });
    }
  }

  // RV-07: Kelas Rawat (1, 2, or 3)
  if (ruleMap['RV-07']?.is_active) {
    const kelas = record.kelas_rawat;
    if (kelas === undefined || kelas === null || kelas === '' || kelas === 0) {
      errors.push({
        rule_id: 'RV-07',
        field_name: 'kelas_rawat',
        severity: 'major',
        error_message: ruleMap['RV-07'].error_message || 'Kelas rawat wajib diisi (1, 2, atau 3).',
        expected_value: '1, 2, atau 3',
        actual_value: '(kosong)'
      });
    } else {
      const kelasNum = Number(kelas);
      if (![1, 2, 3].includes(kelasNum)) {
        errors.push({
          rule_id: 'RV-07',
          field_name: 'kelas_rawat',
          severity: 'major',
          error_message: ruleMap['RV-07'].error_message || 'Kelas rawat hanya boleh 1, 2, atau 3.',
          expected_value: '1, 2, atau 3',
          actual_value: String(kelas)
        });
      }
    }
  }

  // RV-08: Discharge Status
  if (ruleMap['RV-08']?.is_active) {
    const status = record.discharge_status;
    if (status === undefined || status === null || status === '' || status === 0) {
      errors.push({
        rule_id: 'RV-08',
        field_name: 'discharge_status',
        severity: 'major',
        error_message: ruleMap['RV-08'].error_message || 'Status keluar wajib diisi.',
        expected_value: '1 (Pulang atas persetujuan dokter), 2 (Dirujuk), 3 (APS/pulang paksa), 4 (Meninggal), atau 5 (Lainnya)',
        actual_value: '(kosong)'
      });
    } else {
      const statusNum = Number(status);
      if (![1, 2, 3, 4, 5].includes(statusNum)) {
        errors.push({
          rule_id: 'RV-08',
          field_name: 'discharge_status',
          severity: 'major',
          error_message: ruleMap['RV-08'].error_message || 'Status keluar hanya boleh 1 (Atas persetujuan dokter), 2 (Dirujuk), 3 (APS), 4 (Meninggal), atau 5 (Lainnya).',
          expected_value: '1 (Pulang atas persetujuan dokter), 2 (Dirujuk), 3 (APS/pulang paksa), 4 (Meninggal), atau 5 (Lainnya)',
          actual_value: String(status)
        });
      }
    }
  }

  // RV-09: Nama Pasien Required
  if (ruleMap['RV-09']?.is_active) {
    if (!record.nama_pasien || record.nama_pasien.trim() === '' || record.nama_pasien.trim() === '-') {
      errors.push({
        rule_id: 'RV-09',
        field_name: 'nama_pasien',
        severity: 'critical',
        error_message: ruleMap['RV-09'].error_message || 'Nama pasien wajib diisi.',
        expected_value: 'Nama pasien',
        actual_value: '(kosong)'
      });
    }
  }

  // RV-10: Selisih Tarif RS vs INACBG
  if (ruleMap['RV-10']?.is_active) {
    const tarifRs = record.tarif_rs || 0;
    const totalTarif = record.total_tarif || 0;
    if (totalTarif > 0 && tarifRs > 0) {
      const selisih = Math.abs(tarifRs - totalTarif);
      const pct = (selisih / totalTarif) * 100;
      if (pct > 50) {
        errors.push({
          rule_id: 'RV-10',
          field_name: 'tarif_rs',
          severity: 'minor',
          error_message: `Selisih tarif RS vs INACBG: ${pct.toFixed(1)}% (> 50%). Selisih: Rp ${selisih.toLocaleString('id-ID')}`,
          expected_value: `Tarif INACBG: Rp ${totalTarif.toLocaleString('id-ID')}`,
          actual_value: `Tarif RS: Rp ${tarifRs.toLocaleString('id-ID')} (selisih ${pct.toFixed(1)}%)`
        });
      }
    }
  }

  // RV-11: Rehabilitasi Medik Check (ICD-9-CM 93.0-93.8) -- KECUALI 93.9x
  // (93.90-93.99, "Respiratory therapy": nebulizer/oksigen/ventilasi dst,
  // BUKAN Rehabilitasi Medik/KFR sama sekali, tidak pernah butuh Lembar
  // Program/Uji Fungsi/Bukti Pendampingan). Sebelumnya proc.startsWith('93')
  // menyapu SELURUH bab 93.x termasuk 93.94 (nebulizer IGD rutin) sebagai
  // "butuh dokumen Rehab Medik lengkap" -- bug nyata, 30 dari 32 record
  // riil dengan kode 93.x di DB ini HANYA punya kode 93.9x (murni terapi
  // respirasi IGD, mis. 90.59;87.44;93.94 -- workup IGD standar), bukan
  // rehab sama sekali. Dilaporkan Afri (10 Sep 2026), root cause diverifikasi
  // via query DB riil, bukan asumsi.
  if (ruleMap['RV-11']?.is_active) {
    const procStr = record.prosedur_list || '';
    if (procStr && procStr !== '-') {
      const procs = procStr.split(';').map(p => p.trim());
      const isRehabCode = proc => proc.startsWith('93') && !proc.startsWith('93.9');
      const hasRehab = procs.some(isRehabCode);
      if (hasRehab) {
        // Validation check for prolonged therapy without re-assessment
        if (record.los > 14 && !record.has_re_assessment_sp_kfr) {
          errors.push({
            rule_id: 'RV-11',
            field_name: 'prosedur_list',
            severity: 'major',
            error_message: 'Pelayanan KFR > 14 hari wajib menyertakan lembar evaluasi berkala/re-assessment oleh Dokter Sp.KFR minimal 2 minggu sekali.',
            expected_value: 'Lembar Evaluasi / Re-assessment Sp.KFR',
            actual_value: `LOS: ${record.los} hari tanpa re-assessment`
          });
        } else {
          errors.push({
            rule_id: 'RV-11',
            field_name: 'prosedur_list',
            severity: 'major',
            error_message: ruleMap['RV-11'].error_message || 'Tindakan Rehabilitasi Medik (93...) terdeteksi. Sesuai BA 1247/2024, wajib melampirkan Lembar Program, Lembar Uji Fungsi, dan Bukti Pendampingan.',
            expected_value: 'Dokumen Rehabilitasi Medik Lengkap',
            actual_value: procs.filter(isRehabCode).join(', ')
          });
        }
      }
    }
  }

  // RV-12: Eksisi tumor neoplasma (ICD-10 C00-D48) with surgery procedure
  if (ruleMap['RV-12']?.is_active) {
    const diagStr = record.diagnosa_list || '';
    const procStr = record.prosedur_list || '';

    if (diagStr && diagStr !== '-') {
      const diags = diagStr.split(';').map(d => d.trim().toUpperCase());
      const hasTumor = diags.some(diag => {
        const firstLetter = diag.charAt(0);
        if (firstLetter === 'C') return true;
        if (firstLetter === 'D') {
          const num = parseInt(diag.substring(1, 3));
          return !isNaN(num) && num <= 48;
        }
        return false;
      });

      if (hasTumor && procStr && procStr !== '-') {
        const procs = procStr.split(';').map(p => p.trim());
        const hasSurgery = procs.some(proc => {
          const num = parseFloat(proc);
          return !isNaN(num) && num < 87.0;
        });

        // 18 Sep 2026: SEBELUM ini RV-12 selalu fire begitu kode diagnosis+
        // prosedur cocok, TANPA pernah cek apakah dokumennya sendiri SUDAH
        // menyertakan Laporan Operasi/Hasil PA -- klaim yang lampirannya
        // sudah lengkap tetap selalu ditandai "Error" (false positive nyata,
        // ditemukan dari laporan user pada klaim riil). has_laporan_operasi/
        // has_hasil_pa dihitung dari teks dokumen (deteksi marker, lihat
        // pdfExtractionPipeline.js) -- konservatif: default false utk record
        // lama sebelum kolom ini ada, jadi tidak melonggarkan validasi tanpa
        // sengaja, cuma benar2 clear kalau markernya KETEMU eksplisit.
        if (hasSurgery && !(record.has_laporan_operasi && record.has_hasil_pa)) {
          errors.push({
            rule_id: 'RV-12',
            field_name: 'diagnosa_list',
            severity: 'major',
            error_message: ruleMap['RV-12'].error_message || 'Diagnosis tumor neoplasma (C00-D48) terdeteksi dengan prosedur bedah. Sesuai BA 1247/2024, wajib melampirkan Laporan Operasi Eksisi dan Hasil Pemeriksaan Patologi Anatomi (PA).',
            expected_value: 'Hasil PA & Laporan Operasi Eksisi',
            actual_value: `Diag: ${diags.join(', ')} | Procs: ${procs.join(', ')}` +
              (record.has_laporan_operasi ? ' | Laporan Operasi: ADA, Hasil PA: TIDAK TERDETEKSI' :
                record.has_hasil_pa ? ' | Hasil PA: ADA, Laporan Operasi: TIDAK TERDETEKSI' : '')
          });
        }
      }
    }
  }

  // RV-13: Validasi Gabung Episode Konsul Internal
  if (ruleMap['RV-13']?.is_active) {
    if (record.jenis_konsultasi === 'KONSUL_INTERNAL' && record.jumlah_episode_klaim > 1) {
      errors.push({
        rule_id: 'RV-13',
        field_name: 'jumlah_episode_klaim',
        severity: 'minor',
        error_message: 'Telaah BA 1247/2024: label konsul internal perlu dicocokkan dengan surat dan jawaban konsul. Satu episode bila pasien dikembalikan ke dokter perujuk, walau berbeda hari. Kunjungan antar-poli saja belum memastikan konsul internal.',
        expected_value: 'Konfirmasi surat/jawaban konsul dan pengembalian ke perujuk sebelum menetapkan episode',
        actual_value: `${record.jumlah_episode_klaim} Episode`
      });
    }
  }

  // RV-14: Validasi Episode Rujukan Internal RJTL
  if (ruleMap['RV-14']?.is_active) {
    if (record.jenis_konsultasi === 'RUJUKAN_INTERNAL' && record.is_same_day && record.jumlah_episode_klaim > 1) {
      errors.push({
        rule_id: 'RV-14',
        field_name: 'jumlah_episode_klaim',
        severity: 'minor',
        error_message: 'Telaah BA 1247/2024: cocokkan surat rujukan internal, tanggal dan pengembalian ke perujuk. Rujukan yang tidak dikembalikan dapat dua episode bila berbeda hari; jumlah kunjungan saja belum menetapkan episode.',
        expected_value: 'Periksa dokumen rujukan dan tanggal pelayanan sebelum memisahkan episode',
        actual_value: `Terpisah ${record.jumlah_episode_klaim} Episode pada hari yang sama`
      });
    }
  }

  // RV-15: Flagging Otomatisasi Program Rujuk Balik (PRB)
  // Riwayat sistem berasal dari kategori diagnosis yang sama, bukan
  // pembuktian obat yang sama. BA memerlukan telaah obat 3 bulan dan
  // pengecualian kegawatan/diagnosis di luar PRB; perkiraan ini hanya telaah.
  if (ruleMap['RV-15']?.is_active) {
    const prbCategory = matchPrbCategory(record.diagnosa_list);
    if (prbCategory && record.histori_obat_kronis_bulan_berturut >= 3 && !record.prb_exempt_reason) {
      if (!record.flag_rujuk_balik_prb) {
        errors.push({
          rule_id: 'RV-15',
          field_name: 'diagnosa_list',
          severity: 'minor',
          error_message: 'Telaah BA 1247/2024: riwayat kategori diagnosis PRB mencapai 3 bulan. Konfirmasi obat kronis yang sama 3 bulan berturut-turut serta pengecualian kegawatdaruratan/diagnosis di luar PRB; riwayat diagnosis saja belum memastikan kewajiban rujuk balik.',
          expected_value: 'Cocokkan resep/riwayat obat dan pengecualian sebelum menetapkan PRB',
          actual_value: `Kategori diagnosis ${prbCategory}, terekam ${record.histori_obat_kronis_bulan_berturut} bulan berturut-turut; kesamaan obat belum terverifikasi`
        });
      }
    }
  }

  // RV-16: Batasan Maksimal Iterasi Obat Kronis
  // urutan_iterasi diisi ESTIMASI oleh detectAndFlagPRB() di claimFiles.js —
  // dokumen PDF tidak pernah mencantumkan nomor iterasi resep secara eksplisit,
  // jadi dihitung dari JUMLAH kunjungan diagnosis kategori PRB yang sama dalam
  // bulan yang sama (proxy, bukan nomor iterasi resep asli — pesan di bawah
  // menyebut ini eksplisit supaya verifikator tidak salah anggap ini pasti).
  if (ruleMap['RV-16']?.is_active) {
    if (record.urutan_iterasi > 2) {
      errors.push({
        rule_id: 'RV-16',
        field_name: 'urutan_iterasi',
        severity: 'minor',
        error_message: 'Telaah BA 1247/2024: iterasi resep obat kronis maksimal 2 kali. Jumlah kunjungan kategori diagnosis yang sama merupakan perkiraan, bukan nomor iterasi resep asli; periksa resep sebelum menyatakan batas iterasi terlampaui.',
        expected_value: 'Konfirmasi nomor iterasi resep asli dan tempat pengambilan obat bulan ke-2/ke-3',
        actual_value: `Estimasi ${record.urutan_iterasi}x kunjungan diagnosis kronis sama bulan ini (dihitung dari riwayat, bukan nomor iterasi resep asli — mohon cek manual)`
      });
    }
  }

  // RV-17 lama menyamakan kode 23.19/rawat inap dengan ketidaklayakan klaim.
  // BA 2024 aspek medis 3 mengakui RJ maupun RI sesuai indikasi. Telaah bukti
  // RK-17 dilakukan referensiKlaimService; jangan menolak dari jenis rawat saja.

  // RV-20: Kriteria Kegawatan IGD — deterministik (cek kode ICD eksplisit),
  // pelengkap pola AI "kegawatan_lemah" (aiReviewService.js) yang baca
  // konteks kalimat S/O. Dua sudut pandang berbeda dipertahankan berdampingan
  // (bukan duplikat): ini menyala pasti kalau kodenya cocok, AI menyala kalau
  // narasinya lemah walau kodenya belum tentu "nyeri generik". WARNING —
  // pakai severity 'minor' (severity CHECK di DB cuma terima
  // critical/major/minor; determineStatus() memetakan minor -> status
  // "pending", TIDAK memblokir submit, konsisten dengan RV-10).
  // TIDAK AKTIF sejak 21 Sep 2026 (disengaja, keputusan klien). Kategori
  // GAWAT_DARURAT dihapus -- kunjungan IGD kini berkategori RAWAT_JALAN --
  // sehingga syarat di bawah tidak akan pernah terpenuhi lagi. Tampilan
  // RV-20 di frontend juga sudah disembunyikan lebih dulu.
  //
  // Untuk menghidupkannya kembali: syaratnya TIDAK BISA sekadar diganti ke
  // RAWAT_JALAN (itu akan menyalakan RV-20 untuk semua rawat jalan biasa,
  // bukan cuma IGD). validateRecord() hanya menerima record dan dipanggil
  // dari 11 tempat -- sebagian tanpa akses teks PDF -- jadi pemicu berbasis
  // isi dokumen seperti hasIgdVisitSignal() (lihat pdfPageClassifier.js,
  // dipakai aiReviewService.js untuk kegawatan_lemah) tidak bisa dipakai di
  // sini. Yang dibutuhkan: penanda kunjungan IGD yang ikut TERSIMPAN di
  // record (kolom baru, diisi saat ekstraksi).
  if (ruleMap['RV-20']?.is_active && record.jenis_klaim === 'GAWAT_DARURAT') {
    const NYERI_CODES = [/^R10/i, /^R51/i, /^R52/i, /^R07/i, /^M54/i, /^G43/i, /^M79/i];
    const KEGAWATAN_CODES = [/^I21/i, /^I22/i, /^I46/i, /^J96/i, /^J18/i, /^N17/i, /^K35/i, /^R57/i, /^A41/i, /^R41/i];
    const codes = (record.diagnosa_list || '').split(';').map(c => c.trim()).filter(Boolean);
    const hasNyeriOnly = codes.some(c => NYERI_CODES.some(re => re.test(c)));
    const hasKegawatan = codes.some(c => KEGAWATAN_CODES.some(re => re.test(c)));

    if (hasNyeriOnly && !hasKegawatan) {
      let msg = ruleMap['RV-20'].error_message ||
        'Diagnosis IGD ini hanya kode nyeri generik tanpa bukti kegawatan objektif. Pastikan TTV abnormal/pemeriksaan penunjang terdokumentasi sebelum submit.';
      const umur = Number(record.umur_tahun);
      if (!isNaN(umur) && umur > 0 && umur < 7) {
        msg += ' Untuk pasien anak, gunakan skala nyeri FLACC, bukan VAS.';
      }
      errors.push({
        rule_id: 'RV-20',
        field_name: 'diagnosa_list',
        severity: 'minor',
        error_message: msg,
        expected_value: 'TTV abnormal / pemeriksaan penunjang / kode kegawatan pendamping terdokumentasi',
        actual_value: `Diagnosa: ${codes.join(';')}`
      });
    }
  }

  // RV-18: Kode Kombinasi I10 + I25.9 — dari mining data pending BPJS
  // riil Jan-Mei 2026 (RS Lestari Raharja): BPJS/TKMKB konsisten menolak
  // kode I10 (hipertensi esensial) dan I25.9 (PJK kronik) yang dicantumkan
  // TERPISAH, dan meminta kode gabungan I11.9 (penyakit jantung hipertensif)
  // — pola coding-combination standar, jadi aman dideteksi otomatis (bukan
  // penilaian klinis kasus-per-kasus seperti mayoritas alasan pending
  // lainnya yang ditemukan saat mining).
  if (ruleMap['RV-18']?.is_active) {
    const diagStr = record.diagnosa_list || '';
    if (diagStr && diagStr !== '-') {
      const codes = diagStr.split(';').map(c => c.trim().toUpperCase());
      const hasI10 = codes.some(c => c === 'I10');
      const hasI259 = codes.some(c => c === 'I25.9');
      if (hasI10 && hasI259) {
        errors.push({
          rule_id: 'RV-18',
          field_name: 'diagnosa_list',
          severity: 'minor',
          error_message: ruleMap['RV-18'].error_message ||
            'Kode I10 dan I25.9 dicantumkan terpisah. BPJS/TKMKB biasanya meminta kode gabungan I11.9 (penyakit jantung hipertensif) untuk kombinasi diagnosis ini, bukan dua kode terpisah.',
          expected_value: 'I11.9 (kode gabungan)',
          actual_value: `Diagnosa: ${codes.join(';')}`
        });
      }
    }
  }

  // RV-21: Validasi TARIF_INACBG klaim vs tabel resmi INA-CBG PMK No. 3
  // Tahun 2023 (Regional 1 x Kelas D Swasta -- satu-satunya kombinasi yang
  // relevan untuk RS Lestari Raharja). Kalau INACBG terisi dan kodenya ada
  // di tabel resmi, TARIF_INACBG klaim wajib cocok dengan tarif resmi untuk
  // kelas rawat klaim ini (kelas rawat diabaikan untuk RAWAT_JALAN karena
  // tarif RJTL tidak distratifikasi per kelas di dokumen sumber). Lihat
  // src/services/tarifInacbgLookup.js dan src/data/tarif_inacbg_pmk3_2023_r1_kelasD_swasta.json
  // (field "meta") untuk metode ekstraksi & cross-check.
  if (ruleMap['RV-21']?.is_active) {
    const kode = (record.inacbg_code || '').trim().toUpperCase();
    if (kode) {
      const resVal = validateTarifDiscrepancy(kode, require('./kelasPerawatanService').kelasTarif(record), record.tarif_inacbg);
      if (resVal.status === 'TARIF_TIDAK_BERLAKU') {
        errors.push({
          rule_id: 'RV-21',
          field_name: 'inacbg_code',
          severity: 'minor',
          // Fix 21 Sep 2026: pakai alasan spesifik dari getTarifResmi kalau
          // ada -- ini membedakan "kelas rawat tidak diketahui/tidak valid"
          // dari "kode ada tapi kolom kelas ini memang '-' di dokumen
          // sumber", dua penyebab yang sebelumnya sama-sama tampil sebagai
          // pesan generik "TIDAK memiliki tarif" tanpa penjelasan.
          error_message: ruleMap['RV-21'].error_message || resVal.alasan ||
            `Kode INACBG ${kode} ditemukan di tabel resmi PMK 3/2023, tapi TIDAK memiliki tarif yang dijamin (tanda "-") untuk Regional 1 x Kelas D Swasta pada kelas rawat klaim ini. Periksa ulang ketepatan kode/kelas rawat.`,
          expected_value: 'Kode dengan tarif resmi berlaku untuk kelas rawat ini',
          actual_value: `${kode} (kelas_rawat=${record.kelas_rawat ?? '(kosong)'})`
        });
      } else if (resVal.status === 'DISCREPANCY' && resVal.selisih > 0) {
        errors.push({
          rule_id: 'RV-21',
          field_name: 'tarif_inacbg',
          severity: 'major',
          error_message: ruleMap['RV-21'].error_message ||
            `TARIF_INACBG klaim (Rp ${resVal.tarifKlaim.toLocaleString('id-ID')}) memiliki selisih Rp ${resVal.selisih.toLocaleString('id-ID')} dibanding tarif resmi PMK No. 3 Tahun 2023 (Rp ${resVal.tarifResmi.toLocaleString('id-ID')}) untuk kode ${kode} (Regional 1, Kelas D Swasta, kelas rawat ${record.kelas_rawat ?? '(kosong)'}).`,
          expected_value: `Rp ${resVal.tarifResmi.toLocaleString('id-ID')}`,
          actual_value: `Rp ${resVal.tarifKlaim.toLocaleString('id-ID')} (selisih Rp ${resVal.selisih.toLocaleString('id-ID')})`
        });
      }
    }
  }

  // Aturan konfigurabel disimpan di DB terpisah dari rule kode-bawaan.
  // Jalankan hanya aturan aktif dan jangan menganggap rule_logic yang gagal
  // diparse sebagai validasi sukses (service mengembalikan daftar kosong).
  for (const rule of activeRules || []) {
    if (rule && rule.rule_type === 'configurable' && rule.is_active) {
      errors.push(...validateWithRuleLogic(record, rule));
    }
  }

  return errors;
}

/**
 * Determine validation status based on errors
 */
function determineStatus(errors) {
  if (errors.length === 0) return 'valid';
  const hasCriticalOrMajor = errors.some(e => e.severity === 'critical' || e.severity === 'major');
  return hasCriticalOrMajor ? 'error' : 'pending';
}

module.exports = { validateRecord, determineStatus };
