/**
 * Pengenal pemeriksaan radiologi yang TIDAK bergantung ejaan vendor.
 *
 * Kamus penunjang (src/data/kamusPenunjang.json) mencocokkan varian persis,
 * sehingga format RS/vendor baru gagal dikenali -- laporan CT RS Soerojo
 * menulis "CT-Head tanpa kontras" / "HCTS Multislice" (SUPRIYATI
 * 0170R0111225V003428) dan 87.03 terlewat. Di sini pemeriksaan diurai menjadi
 * MODALITAS x BAGIAN TUBUH, lalu dipetakan ke kode ICD-9-CM:
 *   "HCTS", "CT-Head", "MSCT Brain", "CT Scan Kepala NK"  -> CT + kepala   -> 87.03
 *   "USG Whole Abdomen", "Ultrasonografi abdomen"         -> USG + abdomen -> 88.76
 *   "Foto Thorax PA", "Rontgen dada", "CXR"               -> X-ray + dada  -> 87.44
 * Dipakai hanya bila kamus tidak mengenali apa pun (cadangan), dan setiap kode
 * diverifikasi ke kamus ICD-9-CM sebelum dipakai.
 */
const { deskripsiProsedur } = require('./kamusKodeService');

const MODALITAS = [
  ['ct', /\b(?:h?ms?ct|hcts|ct[\s-]*(?:scan|head|kepala|brain|thorax|toraks|abdomen|spine)?|tomografi|computed\s+tomography|cat\s+scan)\b/i],
  ['mri', /\b(?:mri|magnetic\s+resonance)\b/i],
  ['usg', /\b(?:usg|ultrasonogra\w*|ultrasound|sonografi|echo(?:cardiogra\w*)?|ekokardiogra\w*)\b/i],
  ['foto', /\b(?:foto|rontgen|r[oö]ntgen|ro\.?|x[\s-]?ray|radiografi|cxr|bno)\b/i],
];

const BAGIAN = [
  ['kepala', /\b(?:head|kepala|brain|otak|cranium|kranium|cranial|skull|tengkorak|hcts)\b/i],
  ['dada', /\b(?:thorax|thoraks|toraks|dada|chest|cxr|paru|pulmo)\b/i],
  ['jantung', /\b(?:jantung|cardiac|heart|echo(?:cardiogra\w*)?|ekokardiogra\w*)\b/i],
  ['kehamilan', /\b(?:obstetri\w*|kehamilan|hamil|janin|fetal|gravid\w*|uterus\s+gravid)\b/i],
  ['saluran_kemih', /\b(?:ginjal|renal|kidney|kub|traktus\s+urinari\w*|urologi|vesica|buli)\b/i],
  ['abdomen', /\b(?:abdomen|abdominal|perut|hepar|liver|bno|whole\s+abdomen)\b/i],
  ['leher', /\b(?:leher|neck|tiroid|thyroid|colli)\b/i],
  ['tulang_belakang', /\b(?:vertebra\w*|spine|lumbal\w*|lumbosakral|cervical|servikal|thoracolumbal)\b/i],
  ['panggul', /\b(?:pelvis|panggul|hip|coxae)\b/i],
  ['pergelangan_tangan', /\b(?:manus|hand|tangan|wrist)\b/i],
  ['anggota_gerak', /\b(?:humerus|antebrachii|radius|ulna|manus|femur|cruris|tibia|fibula|pedis|genu|lutut|shoulder|bahu|elbow|wrist|ankle|ekstremitas|extremit\w*)\b/i],
];

const PETA = {
  ct: { kepala: '87.03', dada: '87.41', abdomen: '88.01', saluran_kemih: '88.01', _lain: '88.38' },
  mri: { kepala: '88.91', tulang_belakang: '88.93', _lain: '88.97' },
  usg: { abdomen: '88.76', kehamilan: '88.78', saluran_kemih: '88.75', dada: '88.73', leher: '88.71', jantung: '88.72', _lain: '88.79' },
  foto: { dada: '87.44', kepala: '87.17', abdomen: '88.19', panggul: '88.26', tulang_belakang: '87.24', pergelangan_tangan: '88.23', anggota_gerak: '88.33', _lain: null },
};

const NAMA = { ct: 'CT scan', mri: 'MRI', usg: 'USG', foto: 'Foto rontgen' };

/**
 * @param {string} teks satu baris / judul pemeriksaan
 * @returns {null | {kode, istilah_baku, modalitas, bagian, deskripsi}}
 */
function kenaliPemeriksaanRadiologi(teks) {
  const t = String(teks || '');
  if (t.length < 2 || t.length > 300) return null;
  const mod = MODALITAS.find(([, re]) => re.test(t));
  if (!mod) return null;
  // "Ro." / "foto" sendirian terlalu umum; wajib ada bagian tubuh.
  const bag = BAGIAN.find(([, re]) => re.test(t));
  const peta = PETA[mod[0]];
  const kode = bag ? (peta[bag[0]] || peta._lain) : (mod[0] === 'foto' ? null : null);
  if (!kode || !deskripsiProsedur(kode)) return null;
  return {
    kode,
    istilah_baku: `${NAMA[mod[0]]}${bag ? ` ${bag[0].replace(/_/g, ' ')}` : ''}`,
    modalitas: mod[0],
    bagian: bag ? bag[0] : null,
    deskripsi: deskripsiProsedur(kode),
  };
}

module.exports = { kenaliPemeriksaanRadiologi };
