/**
 * Tab "Pemeriksaan penunjang": daftar pemeriksaan yang SUDAH dilakukan ke
 * pasien (laboratorium, CTG, EKG, radiologi, ...) beserta hasil lab per
 * parameter. Disusun ulang dari halaman berkas yang tersimpan (ocr_results),
 * tanpa AI, supaya berkas lama ikut memakai pembaca terbaru.
 *
 * Bukti tiap pemeriksaan diberi peran menurut jenis halamannya: hasil
 * (lembar hasil/rekaman), permintaan (daftar di resume/triase), atau tagihan
 * (rincian biaya). Pemeriksaan yang hanya tercatat di tagihan tetap tampil,
 * tetapi ditandai belum ada lembar hasilnya.
 */
const { classifyPageDocumentType } = require('./pdfPageClassifier');
const { bacaTemuanPenunjang } = require('./temuanPenunjangService');
const { bacaBarisLab } = require('./bacaLabService');
const { isLembarGrouper } = require('./lembarGrouperService');
const { deskripsiProsedur } = require('./kamusKodeService');
const { bacaPa, sifatPa } = require('./kodingNeoplasmaService');

// ICD-9-CM 91.x9 "other microscopic examination" menurut asal jaringan.
function kodeIcd9Pa(teks) {
  const t = String(teks || '').toLowerCase();
  if (/serviks|cervix|uter|endometri|ovari|adneks|vulva|vagina|plasenta/.test(t)) return '91.49';
  if (/prostat|buli|vesika|bladder|uretra|ginjal|ren\b/.test(t)) return '91.39';
  if (/tulang|bone|otot|muscle|sendi|joint|sinovi/.test(t)) return '91.59';
  if (/kulit|skin|dermis|epiderm|subkutis|subcut|keloid|dermatofibroma|nevus|lipoma|payudara|mamma|kista/.test(t)) return '91.69';
  return '91.89';
}

const PERAN_HALAMAN = {
  lab_results: 'hasil', radiology: 'hasil', ekg: 'hasil', laporan_operasi: 'hasil', patologi_anatomi: 'hasil',
  resume_medis: 'permintaan', triase_igd: 'permintaan', spri: 'permintaan',
  rincian_biaya: 'tagihan',
};
const URUTAN_PERAN = { hasil: 0, permintaan: 1, tagihan: 2, catatan: 3 };
// Rekaman alat (kertas CTG/EKG) tidak berjudul; rekamannya sendiri adalah hasil.
const REKAMAN_ALAT = new Set(['ctg', 'ekg']);
const KATEGORI_LAB = new Set(['hematologi', 'kimia_klinik', 'serologi', 'mikrobiologi', 'urin_feses']);
// Pemeriksaan darah (hematologi, kimia, serologi -- darah rutin, SGOT/SGPT,
// BT/CT, HBsAg, GDS) satu pemeriksaan laboratorium darah, ICD-9-CM 90.59.
// Kode lain (bila kamus memberi kode berbeda) tetap ditunjukkan.
const KATEGORI_DARAH = new Set(['hematologi', 'kimia_klinik', 'serologi']);
const KODE_DARAH = '90.59';
// Nama komponen seperti yang lazim tertulis di resume.
const NAMA_KOMPONEN = {
  darah_lengkap: 'Darah rutin', fungsi_hati: 'SGOT/SGPT', fungsi_ginjal: 'Ureum/kreatinin',
  masa_perdarahan: 'BT/CT', hepatitis: 'HBsAg', gds: 'Gula darah sewaktu', gdp: 'Gula darah puasa',
};
// Parameter hemostasis sering tercetak tanpa judul bagian sendiri.
const HEMOSTASIS = /masa\s+(?:pembekuan|perdarahan)|bleeding\s+time|clotting\s+time|\b(?:pt|aptt|inr)\b/i;

// Judul bagian pada lembar hasil laboratorium.
const JUDUL_BAGIAN = [
  [/^hematolog/i, 'Hematologi'],
  [/^(?:index|indeks)\s+eritrosit/i, 'Indeks eritrosit'],
  [/^(?:hitung\s+jenis|diff)\w*.*\babs/i, 'Hitung jenis (absolut)'],
  [/^(?:hitung\s+jenis|diff)/i, 'Hitung jenis (%)'],
  [/^(?:hemostasis|koagulasi|faal\s+hemostasis)/i, 'Hemostasis'],
  [/^kimia/i, 'Kimia klinik'],
  [/^(?:faal\s+hati|fungsi\s+hati)/i, 'Fungsi hati'],
  [/^(?:faal\s+ginjal|fungsi\s+ginjal)/i, 'Fungsi ginjal'],
  [/^elektrolit/i, 'Elektrolit'],
  [/^(?:imuno|serolog)/i, 'Imunologi & serologi'],
  [/^urin/i, 'Urinalisis'],
  [/^(?:feses|tinja)/i, 'Feses'],
];
// Hasil kualitatif yang tidak berangka ("HBsAg Kualitatif Negatif Negatif").
const KUALITATIF = /^(.{2,40}?)\s+(non[\s-]?reaktif|reaktif|negatif|positif|negative|positive)\b(?:\s+(non[\s-]?reaktif|reaktif|negatif|positif|negative|positive))?/i;
const BUKAN_PARAMETER = /^(?:no\.?|nama|jk|umur|alamat|tgl|jam|dokter|kamar|diagnosa|catatan|pemeriksaan|hasil|rs\b|telp|email)/i;

function bagianUntuk(baris) {
  const t = String(baris || '').replace(/[^A-Za-z\s-]/g, ' ').trim();
  const cocok = JUDUL_BAGIAN.find(([pola]) => pola.test(t));
  return cocok ? cocok[1] : null;
}

function statusNilai(b) {
  const flag = String(b.flag_cetak || '').toUpperCase();
  if (flag === 'H') return 'tinggi';
  if (flag === 'L') return 'rendah';
  const r = b.rujukan;
  const n = Number(b.nilai);
  if (!r || !Number.isFinite(n)) return null;
  if (r.max != null && n > r.max) return 'tinggi';
  if (r.min != null && n < r.min) return 'rendah';
  return 'normal';
}

/** Hasil laboratorium per halaman, dikelompokkan menurut judul bagian. */
function bacaLaboratorium(halamanLab) {
  return halamanLab.map(({ page_number: halaman, ocr_text: teks }) => {
    const baris = String(teks || '').split(/\r?\n/);
    const angka = new Map(bacaBarisLab(teks, { halaman }).map(b => [Number(String(b.id_baris || '').split(':')[1]), b]));
    const tanggal = (/tgl\.?\s*(?:keluar\s+hasil|permintaan|periksa)\s*:?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i.exec(teks) || [])[1] || null;
    const kelompok = [];
    let aktif = null;
    const masuk = (item) => {
      if (HEMOSTASIS.test(item.ditulis || '')) {
        let h = kelompok.find(k => k.nama === 'Hemostasis');
        if (!h) { h = { nama: 'Hemostasis', baris: [] }; kelompok.push(h); }
        h.baris.push(item);
        return;
      }
      if (!aktif) { aktif = { nama: 'Pemeriksaan', baris: [] }; kelompok.push(aktif); }
      aktif.baris.push(item);
    };
    baris.forEach((isi, i) => {
      const judul = bagianUntuk(isi);
      if (judul && !angka.has(i)) { aktif = { nama: judul, baris: [] }; kelompok.push(aktif); return; }
      const b = angka.get(i);
      if (b) {
        masuk({
          parameter: b.parameter_baku || b.parameter_ditulis, ditulis: b.parameter_ditulis,
          hasil: b.nilai_teks, satuan: b.satuan || null, rujukan: b.rujukan ? b.rujukan.teks : null,
          flag: b.flag_cetak || null, status: statusNilai(b),
          perlu_cek: Boolean(b.perlu_cek_manusia && b.parameter), dikenali: Boolean(b.parameter),
          kutipan: b.kutipan,
        });
        return;
      }
      const k = KUALITATIF.exec(isi.trim());
      if (k && !BUKAN_PARAMETER.test(k[1])) {
        const hasil = k[2];
        masuk({
          parameter: k[1].trim(), ditulis: k[1].trim(), hasil, satuan: null, rujukan: k[3] || null, flag: null,
          status: k[3] ? (hasil.toLowerCase().replace(/[\s-]/g, '') === k[3].toLowerCase().replace(/[\s-]/g, '') ? 'normal' : 'tinggi') : null,
          perlu_cek: false, dikenali: true, kutipan: isi.trim().slice(0, 200),
        });
      }
    });
    return { halaman, tanggal, kelompok: kelompok.filter(k => k.baris.length > 0) };
  }).filter(h => h.kelompok.length > 0);
}

/**
 * @param {Array<{page_number, ocr_text}>} halaman ocr_results record
 * @returns {{pemeriksaan: Array, laboratorium: Array, ringkasan: Object}}
 */
function susunPemeriksaanPenunjang(halaman) {
  const pages = (Array.isArray(halaman) ? halaman : [])
    .filter(p => p && p.ocr_text && !isLembarGrouper(p.ocr_text))
    .map(p => ({ ...p, jenis: classifyPageDocumentType(p.ocr_text) }));
  const jenisHalaman = new Map(pages.map(p => [p.page_number, p.jenis]));

  // Pemeriksaan (per istilah kamus penunjang), bukti digabung lintas halaman.
  const temuan = bacaTemuanPenunjang(pages).temuan || [];
  const perId = new Map();
  for (const t of temuan) {
    if (!t || !t.istilah_id) continue;
    // Parameter tunggal (hemoglobin, hematokrit) sudah tampil di tabel lab.
    if (t.kategori === 'hematologi' && !t.kode_usulan && t.istilah_id !== 'masa_perdarahan') continue;
    const peran = PERAN_HALAMAN[jenisHalaman.get(t.page_number)] || (REKAMAN_ALAT.has(t.istilah_id) ? 'hasil' : 'catatan');
    const item = perId.get(t.istilah_id) || {
      id: t.istilah_id, nama: t.istilah_baku, kategori: t.kategori || null,
      kode_icd9: t.kode_usulan || null, deskripsi_icd9: t.kode_usulan ? deskripsiProsedur(t.kode_usulan) || null : null,
      bukti: [],
    };
    if (!item.bukti.some(b => b.halaman === t.page_number && b.kutipan === t.kutipan)) {
      item.bukti.push({ halaman: t.page_number, kutipan: t.kutipan || null, peran });
    }
    perId.set(t.istilah_id, item);
  }

  const halamanLab = pages.filter(p => p.jenis === 'lab_results');
  const laboratorium = bacaLaboratorium(halamanLab);
  // Ada lembar hasil lab -> pemeriksaan lab yang diminta di resume punya hasil.
  if (laboratorium.length > 0) {
    for (const item of perId.values()) {
      if (KATEGORI_LAB.has(item.kategori)
        && !item.bukti.some(b => b.peran === 'hasil')) {
        for (const h of laboratorium) item.bukti.push({ halaman: h.halaman, kutipan: 'Lembar hasil pemeriksaan laboratorium', peran: 'hasil' });
      }
    }
  }

  // Satukan pemeriksaan darah menjadi satu butir dengan rincian komponennya.
  const darah = [...perId.values()].filter(p => KATEGORI_DARAH.has(p.kategori));
  if (darah.length > 0 || laboratorium.length > 0) {
    for (const p of darah) perId.delete(p.id);
    const bukti = [];
    for (const b of darah.flatMap(p => p.bukti).filter(b => b.peran !== 'hasil')) {
      const sama = bukti.find(x => x.halaman === b.halaman && x.peran === b.peran);
      const isi = String(b.kutipan || '').replace(/^\s*\d+[.)]\s*/, '').trim();
      if (!sama) bukti.push({ ...b, kutipan: isi || null });
      else if (isi && !String(sama.kutipan || '').split(' · ').includes(isi)) sama.kutipan = sama.kutipan ? `${sama.kutipan} · ${isi}` : isi;
    }
    for (const h of laboratorium) {
      if (!bukti.some(b => b.halaman === h.halaman && b.peran === 'hasil')) {
        bukti.push({ halaman: h.halaman, kutipan: 'Lembar hasil pemeriksaan laboratorium', peran: 'hasil' });
      }
    }
    const kodeLain = [...new Map(darah.filter(p => p.kode_icd9 && p.kode_icd9 !== KODE_DARAH)
      .map(p => [p.kode_icd9, { kode: p.kode_icd9, deskripsi: p.deskripsi_icd9, untuk: p.nama }])).values()];
    perId.set('lab_darah', {
      id: 'lab_darah', nama: 'Pemeriksaan laboratorium darah', kategori: 'laboratorium',
      kode_icd9: KODE_DARAH, deskripsi_icd9: deskripsiProsedur(KODE_DARAH) || null,
      komponen: darah.map(p => NAMA_KOMPONEN[p.id] || p.nama),
      kode_lain: kodeLain,
      bukti,
    });
  }

  // Histopatologi: tampilkan kesimpulan & sifat, dan kode ICD-9-CM menurut
  // asal jaringan sebagai pilihan (tidak masuk otomatis ke daftar prosedur).
  const pa = perId.get('histopatologi');
  if (pa) {
    const halamanPa = pages.find(p => p.jenis === 'patologi_anatomi');
    if (halamanPa) {
      const hasil = bacaPa([halamanPa]);
      if (hasil) {
        pa.hasil_ringkas = hasil.kesimpulan;
        pa.sifat = sifatPa(hasil);
        const kodePa = kodeIcd9Pa(`${hasil.bahan} ${hasil.kesimpulan}`);
        pa.kode_lain = [{ kode: kodePa, deskripsi: deskripsiProsedur(kodePa) || null, untuk: 'pemeriksaan jaringan (pilihan; casemix RS belum mengodekan PA terpisah)' }];
      }
    }
  }

  const pemeriksaan = [...perId.values()].map(p => ({
    ...p,
    bukti: p.bukti.sort((a, b) => URUTAN_PERAN[a.peran] - URUTAN_PERAN[b.peran] || a.halaman - b.halaman),
    ada_hasil: p.bukti.some(b => b.peran === 'hasil'),
  })).sort((a, b) => Number(b.ada_hasil) - Number(a.ada_hasil) || String(a.nama).localeCompare(String(b.nama)));

  const semuaBaris = laboratorium.flatMap(h => h.kelompok.flatMap(k => k.baris));
  return {
    pemeriksaan,
    laboratorium,
    ringkasan: {
      jumlah_pemeriksaan: pemeriksaan.length,
      jumlah_parameter_lab: semuaBaris.length,
      jumlah_di_luar_rujukan: semuaBaris.filter(b => b.status === 'tinggi' || b.status === 'rendah').length,
    },
  };
}

module.exports = { susunPemeriksaanPenunjang, bacaLaboratorium };
