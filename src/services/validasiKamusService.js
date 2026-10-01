/**
 * Satu-satunya pemeriksa keberadaan kode di kamus resmi (ICD-10 WHO /
 * ICD-9-CM) yang dipakai bersama oleh jalur pengisian otomatis dan
 * pemeriksaan klaim. Deterministik, tidak memanggil AI.
 *
 * KENAPA ADA (catatan programmer 2026-10-01, kasus Eifelin J45.3):
 *
 *  1. Gangguan kamus TIDAK BOLEH dibaca sebagai "kode tidak dikenal".
 *     Sebelumnya query yang gagal mengembalikan false, dan tabel kosong
 *     membuat SEMUA kode tampak di luar kamus -- aplikasi lalu menuduh
 *     diagnosis pasien salah padahal kamusnya yang tidak siap. Di sini ada
 *     tiga status yang berbeda tegas:
 *       valid       -> kode ada di kamus
 *       not_found   -> kamus siap dan kodenya memang tidak ada
 *       unavailable -> kamus tidak bisa dibaca / kosong; TIDAK ada
 *                      kesimpulan apa pun tentang kodenya
 *
 *  2. Keberadaan di kamus BUKAN bukti kecocokan klinis. Layanan ini hanya
 *     menjawab "kode ini ada di daftar resmi atau tidak" -- kecocokan dengan
 *     isi berkas diperiksa terpisah (pagar kutipan, KD-14, dst).
 */

const KAMUS = {
  diagnosis: { tabel: 'icd10_who_codes', nama: 'ICD-10 WHO 2010' },
  prosedur: { tabel: 'icd9_cm_procedures', nama: 'ICD-9-CM 2010' },
};

const STATUS = { VALID: 'valid', TIDAK_ADA: 'not_found', TIDAK_TERSEDIA: 'unavailable' };

function normalKode(kode) {
  return String(kode || '').trim().toUpperCase();
}

/**
 * Periksa sekumpulan kode terhadap kamus satu sistem.
 *
 * @param {object} db helper db (punya .all)
 * @param {string[]} kodes
 * @param {'diagnosis'|'prosedur'} jenis
 * @returns {Promise<{status: 'tersedia'|'tidak_tersedia', alasan: string|null,
 *   dataset: {tabel: string, nama: string, jumlah: number|null},
 *   hasil: Object<string, 'valid'|'not_found'|'unavailable'>}>}
 */
async function periksaKode(db, kodes, jenis = 'diagnosis') {
  const kamus = KAMUS[jenis] || KAMUS.diagnosis;
  const unik = [...new Set((kodes || []).map(normalKode).filter(Boolean))];
  const dataset = { tabel: kamus.tabel, nama: kamus.nama, jumlah: null };

  const tidakTersedia = (alasan) => ({
    status: 'tidak_tersedia',
    alasan,
    dataset,
    hasil: Object.fromEntries(unik.map((k) => [k, STATUS.TIDAK_TERSEDIA])),
  });

  // Kesiapan kamus dulu: tabel yang kosong harus dibedakan dari "kode tidak
  // ada". Tanpa ini, satu migrasi yang gagal mengisi tabel membuat seluruh
  // klaim tampak penuh kode salah.
  try {
    const baris = await db.all(`SELECT COUNT(*) AS jumlah, MIN(source) AS sumber, MAX(imported_at) AS diimpor_pada FROM ${kamus.tabel}`, []);
    const jumlah = Number(baris && baris[0] && baris[0].jumlah);
    if (!Number.isFinite(jumlah) || jumlah < 0) return tidakTersedia('Jumlah entri kamus tidak terbaca');
    dataset.jumlah = jumlah;
    dataset.sumber = baris[0].sumber || null;
    dataset.diimpor_pada = baris[0].diimpor_pada || null;
    dataset.identitas = `${kamus.tabel}|${dataset.sumber || 'tidak_tercatat'}|${dataset.diimpor_pada || 'tidak_tercatat'}|${jumlah}`;
    if (jumlah === 0) return tidakTersedia('Tabel kamus kosong');
  } catch (err) {
    return tidakTersedia(`Kamus tidak bisa dibaca: ${err.message}`);
  }

  if (unik.length === 0) return { status: 'tersedia', alasan: null, dataset, hasil: {} };

  let ada;
  try {
    const tanda = unik.map(() => '?').join(', ');
    const rows = await db.all(`SELECT code FROM ${kamus.tabel} WHERE UPPER(code) IN (${tanda})`, unik);
    ada = new Set((rows || []).map((r) => normalKode(r.code)));
  } catch (err) {
    return tidakTersedia(`Kamus tidak bisa dibaca: ${err.message}`);
  }

  return {
    status: 'tersedia',
    alasan: null,
    dataset,
    hasil: Object.fromEntries(unik.map((k) => [k, ada.has(k) ? STATUS.VALID : STATUS.TIDAK_ADA])),
  };
}

/**
 * Tempelkan status kamus ke setiap entri code_evidence, MEMISAHKAN tiga hal
 * yang sebelumnya tercampur dalam satu review_status:
 *   evidence_found     -- kodenya tertulis di berkas (bukti tercetak)
 *   dictionary_status  -- kodenya ada di kamus resmi
 *   review_status      -- kesimpulan untuk koder
 *
 * Kode yang tertulis di berkas tapi tidak ada di kamus dulu tampil hijau
 * "VALID" (karena buktinya ketemu) sementara kode_luar_kamus menandainya
 * bermasalah -- dua sinyal saling bertentangan di layar yang sama.
 *
 * @param {Array} codeEvidence ai_review.code_evidence (diubah di tempat)
 * @param {{diagnosis?: object, prosedur?: object}} hasilPeriksa keluaran periksaKode per jenis
 */
function tandaiStatusKamusEvidence(codeEvidence, hasilPeriksa = {}) {
  for (const e of codeEvidence || []) {
    if (!e || !e.code) continue;
    const jenis = e.type === 'procedure' ? 'prosedur' : 'diagnosis';
    const periksa = hasilPeriksa[jenis];
    e.evidence_found = e.found === true;
    if (!periksa) continue;
    const status = periksa.status === 'tidak_tersedia'
      ? STATUS.TIDAK_TERSEDIA
      : (periksa.hasil[normalKode(e.code)] || null);
    if (!status) continue;
    e.dictionary_status = status;
    e.review_flags = (Array.isArray(e.review_flags) ? e.review_flags : [])
      .filter(f => !f || f.sumber !== 'validasi_kamus');
    if (status === STATUS.TIDAK_ADA || status === STATUS.TIDAK_TERSEDIA) {
      e.review_status = 'PENDING';
      const pesan = status === STATUS.TIDAK_TERSEDIA ? 'Validasi kamus belum tersedia'
        : (e.evidence_found ? 'Tercantum di dokumen; perlu verifikasi kode' : 'Kode tidak ditemukan di kamus');
      const flags = Array.isArray(e.review_flags) ? e.review_flags : [];
      if (!flags.some((f) => f && f.reason === pesan)) flags.push({ reason: pesan, sumber: 'validasi_kamus' });
      e.review_flags = flags;
    }
    e.coding_review_status = e.review_status || (e.evidence_found ? 'VALID' : 'PENDING');
  }
  return codeEvidence;
}

/**
 * Galat validasi (bentuk ruleEngine) untuk kode DIAGLIST/PROCLIST yang tidak
 * ada di kamus resmi. Dipakai jalur yang menyimpan kode dari ketikan koder
 * (update-values), supaya kode tak dikenal tidak pernah tersimpan berstatus
 * valid / siap kirim. Memakai rule RV-05 / RV-06 yang sudah ada -- rule itu
 * hanya memeriksa FORMAT, dan "J45.3" lolos format meski tidak ada di WHO.
 *
 * Kamus tidak tersedia -> galat kesiapan validasi, bukan tuduhan kode salah.
 *
 * @param {object} db
 * @param {{diagnosa_list?: string, prosedur_list?: string}} dbRecord
 * @param {Array} galatAda galat ruleEngine yang sudah ada (untuk hindari dobel)
 */
async function galatKamusRecord(db, dbRecord, galatAda = []) {
  const pisah = (v) => String(v || '').split(/[;,]/).map(s => normalKode(s)).filter(s => s && s !== '-');
  const sudah = new Set((galatAda || []).map(g => `${g.rule_id}|${normalKode(g.actual_value)}`));
  const galat = [];
  const jalur = [
    { jenis: 'diagnosis', kodes: pisah(dbRecord.diagnosa_list), rule: 'RV-05', field: 'diagnosa_list', label: 'diagnosa' },
    { jenis: 'prosedur', kodes: pisah(dbRecord.prosedur_list), rule: 'RV-06', field: 'prosedur_list', label: 'prosedur' },
  ];
  for (const j of jalur) {
    if (j.kodes.length === 0) continue;
    const periksa = await periksaKode(db, j.kodes, j.jenis);
    if (periksa.status !== 'tersedia') {
      galat.push({
        rule_id: j.rule, field_name: j.field, severity: 'major',
        error_message: 'Validasi kamus belum tersedia. Keabsahan kode belum dapat diperiksa; klaim belum siap dikirim.',
        expected_value: `Kamus ${periksa.dataset.nama} tersedia`, actual_value: j.kodes.join(';'),
        dictionary_status: STATUS.TIDAK_TERSEDIA,
      });
      continue;
    }
    for (const kode of j.kodes) {
      if (periksa.hasil[kode] !== STATUS.TIDAK_ADA || sudah.has(`${j.rule}|${kode}`)) continue;
      sudah.add(`${j.rule}|${kode}`);
      galat.push({
        rule_id: j.rule,
        field_name: j.field,
        severity: 'major',
        error_message: `Kode ${j.label} "${kode}" tidak ada di kamus ${periksa.dataset.nama} yang dipakai BPJS. Periksa ulang kodenya sebelum klaim dikirim.`,
        expected_value: `Kode yang ada di ${periksa.dataset.nama}`,
        actual_value: kode,
        dictionary_status: STATUS.TIDAK_ADA,
      });
    }
  }
  return galat;
}

module.exports = { KAMUS, STATUS, periksaKode, tandaiStatusKamusEvidence, galatKamusRecord, normalKode };
