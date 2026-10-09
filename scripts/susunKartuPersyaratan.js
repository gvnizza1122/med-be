/**
 * Menyusun src/data/kartuPersyaratan.json: kartu persyaratan klaim per
 * kelompok diagnosis dari (1) aturan aplikasi yang sudah ada (butir
 * "otomatis") dan (2) draf butir PNPK berbantuan AI yang kutipannya sudah
 * divalidasi terhadap PDF (src/data/kartuPnpkDraf.json; butir "agen").
 * Tidak memanggil AI.
 *
 *   node scripts/susunKartuPersyaratan.js --pnpk      # daftar PNPK yang perlu draf AI
 *   node scripts/susunKartuPersyaratan.js --gabung DIR # gabungkan tmp_kartu/*.json ke kartuPnpkDraf.json
 *   node scripts/susunKartuPersyaratan.js             # susun kartu
 */
const fs = require('fs');
const path = require('path');
const pnpk = require('../src/services/pnpkPengetahuanService');
const { aturanUntukDx } = require('../src/services/kartuPersyaratanService');

const DATA = path.join(__dirname, '../src/data');
const r = (...a) => a;
// [id, judul, prefiks dx, usia (semua|dewasa|anak), contoh kode untuk memilih PNPK, prefiks px opsional]
const KELOMPOK = [
  r('KP-PNEUMONIA-DEWASA', 'Pneumonia (dewasa)', ['J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18'], 'dewasa', ['J18.9']),
  r('KP-PNEUMONIA-ANAK', 'Pneumonia (anak)', ['J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18'], 'anak', ['J18.9']),
  r('KP-DENGUE-DEWASA', 'Infeksi dengue (dewasa)', ['A90', 'A91'], 'dewasa', ['A91']),
  r('KP-DENGUE-ANAK', 'Infeksi dengue (anak/remaja)', ['A90', 'A91'], 'anak', ['A91']),
  r('KP-PPOK', 'PPOK', ['J44'], 'dewasa', ['J44.9']),
  r('KP-ASMA', 'Asma', ['J45', 'J46'], 'semua', ['J45.9']),
  r('KP-BRONKITIS', 'Bronkitis akut/kronik', ['J20', 'J40', 'J41', 'J42'], 'semua', ['J20.9']),
  r('KP-TB', 'Tuberkulosis', ['A15', 'A16', 'A17', 'A18', 'A19'], 'semua', ['A15.0']),
  r('KP-HIPERTENSI', 'Hipertensi (dewasa)', ['I10', 'I11', 'I12', 'I13', 'I15'], 'dewasa', ['I10']),
  r('KP-DM', 'Diabetes melitus', ['E10', 'E11', 'E12', 'E13', 'E14'], 'semua', ['E11.9']),
  r('KP-PGK', 'Penyakit ginjal kronik', ['N18'], 'semua', ['N18.5']),
  r('KP-GGA', 'Gagal ginjal akut', ['N17'], 'semua', ['N17.9']),
  r('KP-STROKE', 'Stroke', ['I60', 'I61', 'I62', 'I63', 'I64'], 'dewasa', ['I63.9']),
  r('KP-SKA', 'Sindrom koroner akut / angina', ['I20', 'I21', 'I22', 'I24', 'I25'], 'dewasa', ['I21.9', 'I20.9']),
  r('KP-GAGAL-JANTUNG', 'Gagal jantung', ['I50'], 'semua', ['I50.9']),
  r('KP-ISK', 'Infeksi saluran kemih', ['N10', 'N11', 'N30', 'N39.0'], 'semua', ['N39.0']),
  r('KP-TIFOID', 'Demam tifoid', ['A01'], 'semua', ['A01.0']),
  r('KP-SEPSIS', 'Sepsis', ['A40', 'A41', 'R65', 'P36'], 'semua', ['A41.9']),
  r('KP-STT', 'Tumor jaringan lunak / benjolan', ['R22', 'D17', 'D21', 'C49'], 'semua', ['D17.9']),
  r('KP-HERNIA', 'Hernia', ['K40', 'K41', 'K42', 'K43', 'K46'], 'semua', ['K40.9']),
  r('KP-APENDISITIS', 'Apendisitis / infeksi intraabdominal', ['K35', 'K36', 'K37', 'K65'], 'semua', ['K35.8']),
  r('KP-KATARAK', 'Katarak', ['H25', 'H26', 'H28'], 'semua', ['H25.9']),
  r('KP-LUKA-BAKAR', 'Luka bakar', ['T20', 'T21', 'T22', 'T23', 'T24', 'T25', 'T29', 'T30', 'T31'], 'semua', ['T24.2', 'T31.1']),
  r('KP-KEJANG-EPILEPSI', 'Kejang / epilepsi', ['R56', 'G40', 'G41'], 'semua', ['G40.9']),
  r('KP-COT', 'Cedera otak traumatik', ['S06'], 'semua', ['S06.0']),
  r('KP-FRAKTUR', 'Fraktur', ['S02', 'S12', 'S22', 'S32', 'S42', 'S52', 'S62', 'S72', 'S82', 'S92', 'T02'], 'semua', ['S72.0']),
  r('KP-ANEMIA-THALASEMIA', 'Anemia / thalasemia', ['D50', 'D53', 'D56', 'D61', 'D62', 'D63', 'D64'], 'semua', ['D56.1']),
  r('KP-NEONATUS', 'Neonatus: BBLR, asfiksia, hiperbilirubinemia', ['P07', 'P21', 'P58', 'P59'], 'anak', ['P07.1', 'P59.9', 'P21.0']),
  r('KP-OBSTETRI', 'Kehamilan dan persalinan', ['O'], 'semua', ['O14.1', 'O42.1']),
  r('KP-PERDARAHAN-SCBA', 'Perdarahan saluran cerna / ulkus peptikum berdarah', ['K25', 'K26', 'K27', 'K28', 'K92'], 'semua', ['K92.2']),
  // Dispepsia/gastritis tidak memakai PNPK perdarahan saluran cerna; hanya aturan aplikasi.
  r('KP-DISPEPSIA', 'Gastritis/dispepsia', ['K29', 'K30'], 'semua', []),
];
const USIA = { dewasa: [18, 120, 45], anak: [0, 17, 6], semua: [0, 120, 45] };

function dokumenKelompok([, , , usia, contoh]) {
  const umur = USIA[usia][2];
  const rec = { admission_date: new Date().toISOString().slice(0, 10), umur_tahun: umur, birth_date: `${new Date().getFullYear() - umur}-01-01` };
  // "semua": PNPK anak dan dewasa sama-sama relevan.
  const ambil = u => pnpk.dokumenUntukKlaim({ ...rec, umur_tahun: u, birth_date: `${new Date().getFullYear() - u}-01-01` }, { dx: contoh, maks: 3 });
  const docs = usia === 'semua' ? [...ambil(45), ...ambil(6)] : ambil(umur);
  return [...new Map(docs.map(d => [d.katalog_id, d])).values()];
}

const KATEGORI_ATURAN = { kombinasi: 'koding', rekap_rs: 'penunjang', catatan_rs: 'koding' };

function susun() {
  const draf = (() => { try { return require(path.join(DATA, 'kartuPnpkDraf.json')); } catch (_) { return { dokumen: {} }; } })();
  const kartu = [];
  for (const g of KELOMPOK) {
    const [id, judul, dx, usia, , px = []] = g;
    const [uMin, uMax] = USIA[usia];
    const aturan = aturanUntukDx(dx, px, { usiaMin: uMin, usiaMax: uMax });
    const butir = aturan.map((a, i) => ({
      id: `${id}-A${String(i + 1).padStart(2, '0')}`, cara: 'otomatis', aturan_id: a.id, kategori: KATEGORI_ATURAN[a.jenis] || 'kriteria_diagnosis',
      syarat: `${a.nama}: ${a.syarat}`.slice(0, 300), jenis_sumber: a.jenis,
      sumber: { id: a.sumber.id || null, label: a.sumber.label, nomor: a.sumber.nomor || null, halaman: a.sumber.halaman || null },
      ...(a.hospital_codes?.length ? { hospital_codes: a.hospital_codes } : {}),
    }));
    const docs = dokumenKelompok(g);
    let n = 0;
    for (const d of docs) {
      const dd = draf.dokumen[d.katalog_id];
      for (const b of dd?.butir || []) {
        if (b.sama_dengan) continue; // sudah dinilai aturan aplikasi
        if (usia === 'anak' && b.usia === 'dewasa') continue;
        if (usia === 'dewasa' && b.usia === 'anak') continue;
        butir.push({ id: `${id}-P${String(++n).padStart(2, '0')}`, cara: 'agen', kategori: b.kategori, syarat: b.syarat, usia: b.usia,
          jenis_sumber: 'pnpk', kutipan: b.kutipan,
          sumber: { katalog_id: d.katalog_id, label: `PNPK ${d.nomor}`, nomor: d.nomor, halaman: String(b.halaman) } });
      }
    }
    kartu.push({ id, judul, dx, px, usia, status: 'draf',
      sumber_pnpk: docs.map(d => ({ katalog_id: d.katalog_id, judul: d.judul, nomor: d.nomor, berlaku_mulai: d.berlaku_mulai, draf_ai: Boolean(draf.dokumen[d.katalog_id]) })),
      butir });
  }
  const keluar = {
    versi: `KARTU-PERSYARATAN-${new Date().toISOString().slice(0, 10)}`,
    keterangan: 'Kartu persyaratan klaim per kelompok diagnosis. Butir "otomatis" = aturan aplikasi yang sudah ada (status dari pemeriksaan klaim). Butir "agen" = DRAF syarat PNPK berbantuan AI dengan kutipan persis PDF yang tervalidasi; perlu telaah casemix/dokter. Bukan keputusan BPJS.',
    sumber_draf_ai: draf.versi || null,
    kartu,
  };
  fs.writeFileSync(path.join(DATA, 'kartuPersyaratan.json'), JSON.stringify(keluar, null, 1) + '\n');
  console.log(`${kartu.length} kartu; butir otomatis ${kartu.reduce((s, k) => s + k.butir.filter(b => b.cara === 'otomatis').length, 0)}, butir agen ${kartu.reduce((s, k) => s + k.butir.filter(b => b.cara === 'agen').length, 0)}`);
}

const arg = process.argv.slice(2);
if (arg[0] === '--pnpk') console.log([...new Set(KELOMPOK.flatMap(g => dokumenKelompok(g).map(d => d.katalog_id)))].join(' '));
else if (arg[0] === '--gabung') {
  const dir = arg[1];
  const file = path.join(DATA, 'kartuPnpkDraf.json');
  const ada = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { dokumen: {} };
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) { const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); ada.dokumen[d.katalog_id] = d; }
  ada.versi = `DRAF-KARTU-PNPK-${new Date().toISOString().slice(0, 10)}`;
  ada.keterangan = 'Hasil AI per PNPK (scripts/drafKartuPnpk.js): hanya butir yang kutipannya ditemukan persis pada teks PDF. DRAF, belum ditelaah.';
  fs.writeFileSync(file, JSON.stringify(ada, null, 1) + '\n');
  console.log(`${Object.keys(ada.dokumen).length} dokumen draf`);
} else susun();

module.exports = { KELOMPOK };
