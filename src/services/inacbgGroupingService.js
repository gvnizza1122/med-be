/**
 * INA-CBG Grouping & Simulation Service
 * Based on PMK No. 3 Tahun 2023 (Regional 1, Kelas D, Swasta - RS Lestari Raharja)
 */

const { getTarifResmi, lookupTarifInacbg } = require('./tarifInacbgLookup');
const { padananGrouper } = require('./jembatanCmWho');
const { detectSpecialCmg, calculateTotalTopup } = require('./specialCmgService');

// Fix (1 Okt 2026): tarif INA-CBG di server selalu "Tidak ditemukan" walau
// DIAGLIST/PROCLIST sudah terbaca. Berkas RS ini tidak pernah memuat lembar
// hasil grouper E-Klaim, jadi tarif HANYA bisa datang dari fungsi ini lalu
// lookup PMK 3/2023 -- dan pemetaan lama rusak di dua tempat:
//  1. Banyak kategori yang dihasilkan TIDAK ADA di tabel PMK (R-4-18, O-4-15,
//     Z-4-21, C-4-19, H-4-13, T-4-19, dst.), sisanya sering salah kategori
//     (I10 hipertensi -> I-4-10 "Infark Myokard Akut", A09 -> A-4-15 "Infeksi
//     HIV", J18 pneumonia -> J-4-15, asma -> J-4-16 pneumonia).
//  2. Klaim RAWAT_JALAN/IGD (mayoritas klaim RS ini) selalu diberi kode CMG
//     rawat inap (-4-xx-I/II/III) yang tarifnya per kelas kamar -- padahal
//     rawat jalan memakai kode ambulatori (-5-xx-0) bertarif tunggal kelas D.
// Tabel di bawah memetakan rentang ICD-10 WHO ke kategori CMG yang deskripsinya
// di PMK 3/2023 memang sesuai, dan setiap kode akhir DIVERIFIKASI ada di tabel
// resmi (lookupTarifInacbg) sebelum dikembalikan. Kalau tidak ada aturan yang
// cocok, hasilnya null (bukan kode karangan) -- panel FE tetap "Pending
// verifikasi" dan koder mengisi INACBG dari grouper resmi E-Klaim.
//
// Format aturan: [dari, sampai, kategori], dibandingkan dengan kode ICD-10
// tanpa titik (mis. "J18.9" -> "J189") secara leksikografis; aturan pertama
// yang cocok menang, jadi aturan spesifik ditulis lebih dulu dari aturan bab.

// Rawat inap: kategori CMG medis (casemix 4), severity I/II/III ditambah di bawah.
const ATURAN_RAWAT_INAP = [
  // A00-B99 Infeksi
  ['A00', 'A09', 'K-4-16'], ['A15', 'A19', 'A-4-14'], ['A40', 'A41', 'A-4-10'],
  ['A80', 'A99', 'A-4-13'], ['B00', 'B09', 'A-4-13'], ['B15', 'B19', 'B-4-13'],
  ['B20', 'B24', 'A-4-15'], ['B25', 'B34', 'A-4-13'], ['A00', 'B99', 'A-4-14'],
  // C00-D48 Neoplasma (per organ; sisanya tidak dipetakan)
  ['C00', 'C14', 'U-4-10'], ['C15', 'C21', 'K-4-10'], ['C22', 'C25', 'B-4-11'],
  ['C26', 'C26', 'K-4-10'], ['C30', 'C32', 'U-4-10'], ['C33', 'C34', 'J-4-14'],
  ['C40', 'C41', 'M-4-13'], ['C49', 'C49', 'M-4-13'], ['C50', 'C50', 'L-4-11'],
  ['C51', 'C58', 'W-4-10'], ['C60', 'C63', 'V-4-10'], ['C64', 'C68', 'N-4-10'],
  ['C70', 'C72', 'G-4-11'], ['C81', 'C90', 'C-4-11'], ['C91', 'C95', 'C-4-10'],
  ['C96', 'C96', 'C-4-11'], ['D45', 'D47', 'C-4-14'],
  // Neoplasma jinak (D10-D36) & sifat tak tentu (D37-D48) per organ -- dulu
  // tidak dipetakan sama sekali, tumor jinak tanpa operasi tidak punya tarif
  // (ANNISA NUR CHASANAH D21.3). Subkode D48 dibedakan menurut jaringannya.
  ['D10', 'D11', 'U-4-10'], ['D12', 'D13', 'K-4-10'], ['D14', 'D15', 'J-4-14'],
  ['D16', 'D16', 'M-4-13'], ['D17', 'D17', 'M-4-13'], ['D18', 'D18', 'L-4-14'],
  ['D21', 'D21', 'M-4-13'], ['D22', 'D23', 'L-4-14'], ['D24', 'D24', 'L-4-11'],
  ['D25', 'D28', 'W-4-10'], ['D29', 'D29', 'V-4-10'], ['D30', 'D30', 'N-4-10'],
  ['D32', 'D33', 'G-4-11'], ['D37', 'D37', 'K-4-10'], ['D38', 'D38', 'J-4-14'],
  ['D39', 'D39', 'W-4-10'], ['D40', 'D40', 'V-4-10'], ['D41', 'D41', 'N-4-10'],
  ['D42', 'D43', 'G-4-11'], ['D480', 'D481', 'M-4-13'], ['D482', 'D482', 'G-4-11'],
  ['D483', 'D484', 'K-4-10'], ['D485', 'D485', 'L-4-14'], ['D486', 'D486', 'L-4-11'],
  ['D487', 'D489', 'M-4-13'],
  // D50-D89 Darah
  ['D57', 'D57', 'D-4-12'], ['D50', 'D64', 'D-4-13'], ['D65', 'D69', 'D-4-11'],
  ['D70', 'D70', 'D-4-10'], ['D50', 'D89', 'D-4-14'],
  // E00-E90 Endokrin & metabolik
  ['E00', 'E07', 'E-4-13'], ['E10', 'E14', 'E-4-10'], ['E15', 'E35', 'E-4-13'],
  ['E40', 'E68', 'E-4-10'], ['E70', 'E85', 'E-4-12'], ['E86', 'E87', 'E-4-11'],
  ['E00', 'E90', 'E-4-13'],
  // F00-F99 Jiwa (F10-F19 penyalahgunaan zat di grup T)
  ['F10', 'F10', 'T-4-11'], ['F11', 'F11', 'T-4-11'], ['F14', 'F14', 'T-4-11'],
  ['F12', 'F19', 'T-4-12'], ['F00', 'F09', 'F-4-16'], ['F20', 'F29', 'F-4-10'],
  ['F30', 'F31', 'F-4-13'], ['F32', 'F33', 'F-4-11'], ['F34', 'F39', 'F-4-14'],
  ['F40', 'F48', 'F-4-15'], ['F50', 'F50', 'F-4-18'], ['F60', 'F69', 'F-4-12'],
  ['F70', 'F79', 'F-4-16'], ['F80', 'F98', 'F-4-17'], ['F00', 'F99', 'F-4-19'],
  // G00-G99 Saraf
  ['G00', 'G03', 'G-4-18'], ['G04', 'G09', 'G-4-19'], ['G10', 'G32', 'G-4-11'],
  ['G35', 'G35', 'G-4-12'], ['G40', 'G41', 'G-4-22'], ['G43', 'G44', 'G-4-23'],
  ['G45', 'G45', 'G-4-16'], ['G50', 'G64', 'G-4-17'], ['G00', 'G99', 'G-4-26'],
  // H00-H95 Mata & telinga
  ['H46', 'H48', 'H-4-11'], ['H00', 'H59', 'H-4-12'], ['H65', 'H67', 'U-4-13'],
  ['H81', 'H81', 'U-4-11'], ['H60', 'H95', 'U-4-15'],
  // I00-I99 Sirkulasi
  ['I00', 'I09', 'I-4-18'], ['I10', 'I15', 'I-4-17'], ['I20', 'I20', 'I-4-20'],
  ['I21', 'I22', 'I-4-10'], ['I23', 'I25', 'I-4-16'], ['I26', 'I26', 'J-4-12'],
  ['I33', 'I33', 'I-4-11'], ['I34', 'I39', 'I-4-18'], ['I42', 'I43', 'I-4-22'],
  ['I46', 'I46', 'I-4-14'], ['I44', 'I49', 'I-4-19'], ['I50', 'I50', 'I-4-12'],
  ['I60', 'I62', 'G-4-13'], ['I63', 'I63', 'G-4-14'], ['I64', 'I69', 'G-4-15'],
  ['I70', 'I70', 'I-4-16'], ['I80', 'I82', 'I-4-13'], ['I00', 'I99', 'I-4-24'],
  // J00-J99 Pernapasan
  ['J00', 'J06', 'U-4-13'], ['J09', 'J11', 'J-4-15'], ['J12', 'J18', 'J-4-16'],
  ['J21', 'J21', 'J-4-18'], ['J20', 'J22', 'J-4-15'], ['J30', 'J39', 'U-4-15'],
  ['J40', 'J44', 'J-4-17'], ['J45', 'J46', 'J-4-18'], ['J47', 'J47', 'J-4-17'],
  ['J60', 'J84', 'J-4-19'], ['J90', 'J94', 'J-4-20'], ['J96', 'J96', 'J-4-11'],
  ['J00', 'J99', 'J-4-21'],
  // K00-K93 Pencernaan
  ['K00', 'K14', 'U-4-14'], ['K20', 'K23', 'K-4-12'], ['K25', 'K29', 'K-4-11'],
  ['K50', 'K51', 'K-4-13'], ['K52', 'K52', 'K-4-17'], ['K55', 'K55', 'K-4-14'],
  ['K56', 'K56', 'K-4-15'], ['K57', 'K57', 'K-4-13'], ['K70', 'K70', 'B-4-10'],
  ['K74', 'K74', 'B-4-10'], ['K71', 'K77', 'B-4-13'], ['K80', 'K83', 'B-4-14'],
  ['K85', 'K86', 'B-4-12'], ['K92', 'K92', 'K-4-14'], ['K00', 'K93', 'K-4-18'],
  // L00-L99 Kulit
  ['L00', 'L08', 'L-4-12'], ['L10', 'L14', 'L-4-10'], ['L00', 'L99', 'L-4-14'],
  // M00-M99 Muskuloskeletal
  ['M00', 'M01', 'M-4-15'], ['M05', 'M36', 'M-4-16'], ['M45', 'M54', 'M-4-17'],
  ['M79', 'M79', 'M-4-20'], ['M86', 'M86', 'M-4-14'], ['M00', 'M99', 'M-4-18'],
  // N00-N99 Ginjal, saluran kemih & reproduksi
  ['N00', 'N08', 'N-4-11'], ['N10', 'N12', 'N-4-12'], ['N17', 'N19', 'N-4-10'],
  ['N20', 'N23', 'N-4-13'], ['N30', 'N30', 'N-4-12'], ['N390', 'N390', 'N-4-12'],
  ['N40', 'N51', 'V-4-11'], ['N70', 'N77', 'W-4-11'], ['N80', 'N98', 'W-4-12'],
  ['N00', 'N99', 'N-4-16'],
  // O00-O99 Kehamilan (persalinan adalah grup prosedur, tidak dipetakan di sini)
  ['O03', 'O06', 'W-4-13'], ['O20', 'O20', 'W-4-14'], ['O47', 'O47', 'W-4-15'],
  ['O85', 'O92', 'W-4-17'], ['O00', 'O99', 'W-4-16'],
  // Q20-Q28 Kelainan jantung bawaan
  ['Q20', 'Q28', 'I-4-18'],
  // R00-R99 Gejala & tanda
  ['R00', 'R01', 'I-4-19'], ['R04', 'R04', 'U-4-12'], ['R07', 'R07', 'I-4-20'],
  ['R00', 'R09', 'J-4-21'], ['R10', 'R19', 'K-4-17'], ['R30', 'R39', 'N-4-15'],
  ['R40', 'R40', 'G-4-21'], ['R42', 'R42', 'U-4-11'], ['R50', 'R50', 'A-4-12'],
  ['R51', 'R51', 'G-4-23'], ['R55', 'R55', 'I-4-21'], ['R56', 'R56', 'G-4-22'],
  ['R00', 'R99', 'Z-4-11'],
  // S00-T98 Cedera & keracunan
  ['S060', 'S060', 'G-4-25'], ['S06', 'S06', 'G-4-24'], ['S02', 'S02', 'G-4-24'],
  ['S12', 'S14', 'G-4-10'], ['S22', 'S22', 'J-4-13'], ['S32', 'S34', 'G-4-10'],
  ['S72', 'S72', 'M-4-10'], ['S27', 'S27', 'J-4-13'],
  ['S42', 'S43', 'M-4-12'], ['S52', 'S53', 'M-4-12'], ['S62', 'S63', 'M-4-12'],
  ['S82', 'S83', 'M-4-12'], ['S92', 'S93', 'M-4-12'],
  ['T20', 'T32', 'S-4-16'], ['T36', 'T65', 'S-4-12'], ['T74', 'T74', 'S-4-14'],
  ['T78', 'T78', 'S-4-11'], ['T80', 'T88', 'S-4-13'], ['S00', 'T98', 'S-4-17'],
  // Z00-Z99 Faktor status kesehatan
  ['Z510', 'Z510', 'C-4-12'], ['Z511', 'Z512', 'C-4-13'], ['Z50', 'Z50', 'Z-4-10'],
  ['Z00', 'Z99', 'Z-4-12'],
];

// Rawat jalan/IGD: kode ambulatori casemix 5 bertarif tunggal (kolom kelas D).
const ATURAN_RAWAT_JALAN = [
  ['A00', 'A09', 'Q-5-25-0'], ['A15', 'A19', 'Q-5-43-0'], ['B20', 'B24', 'Q-5-34-0'],
  ['A00', 'B99', 'Q-5-35-0'],
  ['C00', 'D48', 'Q-5-43-0'], ['D50', 'D69', 'Q-5-33-0'],
  ['E86', 'E87', 'Q-5-36-0'],
  ['F10', 'F19', 'Q-5-10-0'], ['F70', 'F79', 'F-5-15-0'], ['F80', 'F98', 'F-5-16-0'],
  ['F00', 'F99', 'F-5-14-0'],
  ['G00', 'G09', 'Q-5-27-0'], ['G40', 'G41', 'Q-5-27-0'], ['G45', 'G45', 'Q-5-27-0'],
  ['G50', 'G64', 'G-5-17-0'],
  ['I46', 'I46', 'Q-5-37-0'], ['I21', 'I22', 'Q-5-30-0'], ['I44', 'I49', 'Q-5-30-0'],
  ['I50', 'I50', 'Q-5-29-0'], ['I05', 'I09', 'Q-5-29-0'], ['I34', 'I38', 'Q-5-29-0'],
  ['I42', 'I42', 'Q-5-29-0'], ['I10', 'I15', 'Q-5-44-0'], ['I00', 'I99', 'Q-5-43-0'],
  ['J09', 'J18', 'Q-5-38-0'], ['J20', 'J22', 'Q-5-26-0'], ['J45', 'J46', 'Q-5-26-0'],
  ['J40', 'J44', 'Q-5-43-0'], ['J47', 'J47', 'Q-5-43-0'], ['J00', 'J99', 'Q-5-42-0'],
  ['K00', 'K08', 'Q-5-12-0'], ['K52', 'K52', 'Q-5-25-0'], ['K20', 'K93', 'K-5-18-0'],
  ['N10', 'N12', 'Q-5-40-0'], ['N30', 'N30', 'Q-5-40-0'], ['N390', 'N390', 'Q-5-40-0'],
  ['N17', 'N17', 'Q-5-32-0'], ['N20', 'N23', 'Q-5-32-0'], ['N18', 'N19', 'Q-5-43-0'],
  ['O20', 'O20', 'Q-5-20-0'], ['O03', 'O06', 'Q-5-21-0'], ['O47', 'O47', 'Q-5-22-0'],
  ['O85', 'O92', 'Q-5-24-0'], ['O00', 'O99', 'Q-5-23-0'],
  ['R10', 'R19', 'Q-5-25-0'], ['R56', 'R56', 'Q-5-27-0'], ['R57', 'R57', 'Q-5-37-0'],
  ['S06', 'S06', 'Q-5-28-0'],
  ['S02', 'S02', 'Q-5-31-0'], ['S12', 'S12', 'Q-5-31-0'], ['S22', 'S22', 'Q-5-31-0'],
  ['S32', 'S32', 'Q-5-31-0'], ['S42', 'S42', 'Q-5-31-0'], ['S52', 'S52', 'Q-5-31-0'],
  ['S62', 'S62', 'Q-5-31-0'], ['S72', 'S72', 'Q-5-31-0'], ['S82', 'S82', 'Q-5-31-0'],
  ['S92', 'S92', 'Q-5-31-0'], ['T36', 'T65', 'Q-5-41-0'], ['S00', 'T98', 'Q-5-39-0'],
  ['Z00', 'Z02', 'Q-5-13-0'], ['Z10', 'Z13', 'Q-5-13-0'], ['Z03', 'Z09', 'Q-5-18-0'],
  ['Z23', 'Z27', 'Q-5-16-0'], ['Z34', 'Z36', 'Q-5-23-0'], ['Z39', 'Z39', 'Q-5-24-0'],
  ['Z00', 'Z99', 'Q-5-19-0'],
  ['E00', 'E90', 'Q-5-44-0'], ['G00', 'G99', 'Q-5-44-0'], ['M00', 'M99', 'Q-5-44-0'],
  ['H00', 'H95', 'Q-5-42-0'], ['L00', 'L99', 'Q-5-42-0'], ['N00', 'N99', 'Q-5-44-0'],
  ['R00', 'R99', 'Q-5-42-0'],
];

// Rawat jalan: prosedur yang menentukan kelompok sendiri (casemix 3), dicek
// sebelum diagnosis. Hanya pemetaan yang jelas; prosedur lain tetap ikut
// kelompok diagnosis. Hemodialisis (39.95) dan dialisis peritoneal (54.98)
// -> N-3-15-0 "Prosedur Dialisis" -- dulu klaim HD rawat jalan (N18.5;39.95)
// jatuh ke Q-5-43-0 dengan tarif sepertiganya.
const PROSEDUR_RAWAT_JALAN = [
  [/^(39\.95|54\.98)$/, 'N-3-15-0'],
];

// Rawat inap: prosedur bedah yang menentukan kelompok sendiri (casemix 1
// bedah, 6 persalinan), dicek SEBELUM diagnosis -- grouper E-Klaim memberi
// sesar O-6-10 walau diagnosis utamanya O42.1 (YETY NOVIATI,
// 0170R0111225V003427: casemix O-6-10-I Rp4.656.700; dulu kita memberi
// W-4-16-II tanpa tarif). Hanya pemetaan yang jelas; urutan = prioritas
// (operasi besar dulu). Prosedur lain tetap ikut kelompok diagnosis.
const PROSEDUR_RAWAT_INAP = [
  [/^74\.(?:[0-4]|9\d?)/, 'O-6-10'], // seksio sesarea
  // Ortopedi -- besar dulu: amputasi, artroplasti, tulang belakang.
  [/^84\.(?:0|1[0-9])/, 'M-1-02'], // amputasi
  [/^81\.(?:0|3)/, 'M-1-07'], // fusi tulang belakang
  [/^(?:03\.0|80\.5)/, 'G-1-30'], // dekompresi kanal / diskektomi
  [/^81\.5[123]/, 'M-1-20'], // artroplasti panggul
  [/^81\.5[4-9]/, 'M-1-04'], // artroplasti lutut/pergelangan kaki
  [/^81\.(?:8|7[3-9])/, 'M-1-05'], // artroplasti bahu/siku/pergelangan tangan
  [kelompokTulang, null], // reduksi/fiksasi/eksternal fiksator/eksisi tulang per lokasi
  [/^78\.6/, 'M-1-40'], // pengangkatan implan (lokasi tak terbaca)
  [/^80\.(?:2[6]|6)/, 'M-1-04'], // artroskopi lutut, meniskektomi
  [/^04\.43/, 'G-1-13'], // carpal tunnel release
  [/^82\./, 'M-1-80'], // jaringan lunak tangan
  [/^83\./, 'M-1-50'], // otot, tendon, fasia
  // Bedah umum / digestif -- kompleks dulu.
  [/^(?:45\.[6-9]|48\.[5-6])/, 'K-1-20'], // reseksi usus halus/kolon/rektum, anastomosis
  [/^47\.[01]/, 'K-1-13'], // apendektomi
  [/^51\.23/, 'B-1-14'], // kolesistektomi laparoskopik
  [/^51\.2[12]/, 'B-1-12'], // kolesistektomi terbuka
  [/^53\.[0-1]/, 'K-1-14'], // hernia inguinal/femoral
  [/^53\.[4-9]/, 'K-1-12'], // hernia lain
  [/^54\.5/, 'K-1-11'], // adhesiolisis
  [/^(?:43\.|44\.)/, 'K-1-30'], // lambung/duodenum
  [/^46\./, 'K-1-10'], // stoma/prosedur usus non kompleks
  [/^(?:54\.1|54\.[0-4]|54\.6)/, 'K-1-40'], // laparotomi eksplorasi, dinding abdomen
  [/^49\.(?:0[1-4]|1|[2-7])/, 'K-1-50'], // anal: abses, fistel, hemoroid
  [/^06\.[2-5]/, 'E-1-20'], // tiroidektomi
  [/^38\.5/, 'I-1-17'], // ligasi/stripping varises
  [/^85\./, 'L-1-50'], // payudara
  [/^86\.[67]/, 'L-1-30'], // tandur kulit / flap (tanpa luka bakar)
  [/^86\.(?:2[1-2]|3|4)/, 'L-1-40'], // debridemen eksisional, eksisi lesi kulit/subkutis
  // Obstetri-ginekologi, THT, mata, urologi.
  [/^68\.(?:[3-79])/, 'W-1-20'], // histerektomi
  [/^60\.2/, 'V-1-14'], // TURP
  [/^(?:55\.|56\.)/, 'N-1-20'], // ginjal & ureter
  [/^57\.(?:[0-8]|9[0-3])/, 'N-1-30'], // kandung kemih (bukan kateter 57.94/57.95)
  [/^58\.(?:[0-6])/, 'N-1-40'], // uretra
  [/^(?:61\.|62\.|63\.)/, 'V-1-13'], // skrotum, testis
  [/^64\.0$/, 'V-1-15'], // sirkumsisi
  [/^64\.[1-9]/, 'V-1-11'], // penis
  [/^13\.(?:[1-6]|7[01])/, 'H-1-30'], // katarak / lensa intraokuler
  [/^28\.[2-6]/, 'U-1-15'], // tonsilektomi/adenoidektomi
  [/^69\.5[12]/, 'W-1-10'], // kuretase aspirasi terminasi
  [/^69\.0/, 'W-1-11'], // dilatasi & kuretase
  [/^66\.(?:[2-3])/, 'W-1-12'], // sterilisasi tuba (tanpa persalinan)
];

// Tulang per lokasi. Digit lokasi 79.x: 1 humerus, 2 radius-ulna, 3 karpal-
// metakarpal, 4 falang tangan, 5 femur, 6 tibia-fibula, 7 tarsal-metatarsal,
// 8 falang kaki, 9 lain. Digit 77.x/78.x berbeda: 1 skapula-klavikula-toraks,
// 2 humerus, 3 radius-ulna, 4 karpal-metakarpal, 5 femur, 6 patela,
// 7 tibia-fibula, 8 tarsal-metatarsal, 9 lain (diperiksa ke kamus ICD-9-CM).
const LOKASI_79 = { 1: 'M-1-80', 2: 'M-1-80', 3: 'M-1-80', 4: 'M-1-80', 5: 'M-1-20', 6: 'M-1-70', 7: 'M-1-30', 8: 'M-1-30', 9: 'M-1-60' };
const LOKASI_78 = { 1: 'M-1-80', 2: 'M-1-80', 3: 'M-1-80', 4: 'M-1-80', 5: 'M-1-20', 6: 'M-1-70', 7: 'M-1-70', 8: 'M-1-30', 9: 'M-1-60' };
function kelompokTulang(kode) {
  let m = /^79\.([0-3])([1-9])$/.exec(kode); // reduksi tertutup/terbuka +/- fiksasi interna
  if (m) return LOKASI_79[m[2]];
  m = /^79\.([6])([1-9])$/.exec(kode); // debridemen fraktur terbuka
  if (m) return LOKASI_79[m[2]];
  m = /^78\.6([1-9])$/.exec(kode); // pengangkatan implan
  if (m) return 'M-1-40';
  m = /^77\.6([1-9])$/.exec(kode); // eksisi lokal lesi tulang
  if (m) return 'M-1-40';
  m = /^78\.[15]([1-9])$/.exec(kode); // fiksator eksterna / fiksasi interna tanpa reduksi
  if (m) return LOKASI_78[m[1]];
  return null;
}
// Persalinan per vaginam: O-6-11 (dengan sterilisasi/kuret), O-6-12 (dengan
// prosedur lain: ekstraksi vakum/forsep, episiotomi), O-6-13 (spontan).
const PROSEDUR_PERSALINAN_VAGINAL = /^(?:72\.|73\.[0-9]|75\.[3-6])/;

// Diagnosis sekunder yang tidak pernah menjadi komorbiditas/komplikasi:
// hasil persalinan (Z37), bayi lahir (Z38), cara persalinan (O80-O84). Casemix
// YETY: O42.1 + Z37.0 + O82.1 -> severity I.
const BUKAN_KOMORBID = /^(?:Z37|Z38|O8[0-4])/;
// Kode yang tidak menaikkan severity (dipelajari dari lembar grouper casemix
// MUSTAKIMAH 0170R0111225V003200: T31.1 + T20.2/T22.2/T23.2/T24.2 + X09.5 + I10
// tetap S-4-16-I): penyebab luar cedera (V01-Y98), dan hipertensi esensial I10.
const BUKAN_KOMORBID_UMUM = /^(?:[VWXY]\d|I10)/;
/** Diagnosis sekunder yang termasuk kelompok yang sama dengan diagnosis utama (lokasi luka bakar untuk T31). */
function satuKelompokCedera(utama, sekunder) {
  const bakar = k => /^T(?:2\d|3[0-2])/.test(k);
  return bakar(utama) && bakar(sekunder);
}

function kelompokProsedurRawatInap(kodeIcd, procedureCodes) {
  const prosedur = procedureCodes.map(p => String(p || '').trim()).filter(Boolean);
  for (const [pola, tetap] of PROSEDUR_RAWAT_INAP) {
    const cocok = p => (typeof pola === 'function' ? pola(p) : pola.test(p));
    const kena = prosedur.find(p => cocok(p));
    if (!kena) continue;
    const kategori = typeof pola === 'function' ? pola(kena) : tetap;
    if (kategori === 'L-1-30' && /^T(?:2\d|3[0-2])/.test(kodeIcd)) return { kategori: 'L-1-20', prosedur: kena }; // tandur kulit luka bakar
    // Debridemen luka bakar tetap kelompok luka bakar medis S-4-16 (lembar grouper casemix MUSTAKIMAH: 86.22 -> S-4-16-I).
    if (kategori === 'L-1-40' && /^86\.2/.test(kena) && /^T(?:2\d|3[0-2])/.test(kodeIcd)) continue;
    if (kategori === 'W-1-12' && /^O/.test(kodeIcd)) return { kategori: 'O-6-11', prosedur: kena };
    if (kategori === 'W-1-11' && /^O0/.test(kodeIcd)) return { kategori: 'W-1-10', prosedur: kena };
    if (kategori === 'W-1-11' && /^O(?:[6-7]|8[0-4])/.test(kodeIcd)) return { kategori: 'O-6-11', prosedur: kena };
    return { kategori, prosedur: kena };
  }
  if (/^O(?:[3-7]|8[0-4])/.test(kodeIcd) || prosedur.some(p => /^73\.59$/.test(p))) {
    const lain = prosedur.find(p => PROSEDUR_PERSALINAN_VAGINAL.test(p) && p !== '73.59');
    if (lain) return { kategori: 'O-6-12', prosedur: lain };
    const spontan = prosedur.find(p => p === '73.59');
    if (spontan) return { kategori: 'O-6-13', prosedur: spontan };
  }
  return null;
}

/** Apakah satu kode ICD-9-CM termasuk tindakan operasi (kelompok prosedur INA-CBG). */
function adalahProsedurBedah(kode) {
  return Boolean(kelompokProsedurRawatInap('Z00', [String(kode || '').trim()]));
}

function cocokAturan(kodeIcd, aturan) {
  for (const [dari, sampai, kategori] of aturan) {
    // Bandingkan sepanjang batas aturan saja: "J189" cocok dengan rentang
    // ['J12','J18'] karena "J18" berada di antaranya.
    const kunciDari = kodeIcd.substring(0, dari.length);
    const kunciSampai = kodeIcd.substring(0, sampai.length);
    if (kunciDari >= dari && kunciSampai <= sampai) return kategori;
  }
  return null;
}

/**
 * Memetakan kode diagnosis dan prosedur ke INA-CBG berdasarkan diagnosis utama.
 *
 * PENTING: Ini heuristik pemetaan rentang ICD-10 -> kategori CMG, BUKAN
 * grouper INA-CBG resmi/tersertifikasi Permenkes. Bedanya dengan versi lama:
 * kode yang dikembalikan DIJAMIN ada di tabel tarif PMK No. 3 Tahun 2023
 * (Regional 1 Kelas D Swasta) -- kalau tidak, hasilnya null. Fungsi ini
 * sebaiknya HANYA dipakai kalau saran AI (suggested_inacbg) tidak tersedia
 * atau terbukti tidak valid -- lihat validasi di aiReviewService.js.
 *
 * @param {Array<string>} diagnosisCodes - Array kode diagnosis ICD-10 (prioritas: urutan pertama adalah primary)
 * @param {Array<string>} procedureCodes - Array kode prosedur ICD-9-CM (opsional, untuk severity rawat inap)
 * @param {string} jenisKlaim - Jenis klaim: 'RAWAT_INAP', 'RAWAT_JALAN'
 * @returns {Object|null} {code, confidence, reasoning} atau null jika tidak bisa memetakan
 */
function groupCodesToInaCBG(diagnosisCodes, procedureCodes = [], jenisKlaim = 'RAWAT_INAP') {
  if (!Array.isArray(diagnosisCodes) || diagnosisCodes.length === 0) {
    return null;
  }

  // Ambil diagnosis utama (kode pertama dari DIAGLIST)
  const primaryDiagnosis = diagnosisCodes[0]?.trim().toUpperCase();
  if (!primaryDiagnosis) return null;
  // Kategori khusus ICD-10-CM (mis. D49) dipetakan ke kategori WHO supaya
  // kode yang belum terpetakan tetap punya kelompok & tarif.
  const kodeIcd = padananGrouper(primaryDiagnosis).replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]\d{2}/.test(kodeIcd)) return null;

  procedureCodes = Array.isArray(procedureCodes) ? procedureCodes : [];

  if (jenisKlaim === 'RAWAT_JALAN') {
    for (const p of procedureCodes) {
      const kodeProsedur = String(p || '').trim();
      const aturan = PROSEDUR_RAWAT_JALAN.find(([pola]) => pola.test(kodeProsedur));
      if (aturan && lookupTarifInacbg(aturan[1])) {
        return {
          code: aturan[1],
          confidence: 0.7,
          reasoning: `Pemetaan dari prosedur ${kodeProsedur} ke kelompok prosedur rawat jalan (tarif tunggal), diagnosis utama ${primaryDiagnosis}.`,
        };
      }
    }
    const kodeRj = cocokAturan(kodeIcd, ATURAN_RAWAT_JALAN);
    if (!kodeRj || !lookupTarifInacbg(kodeRj)) return null;
    return {
      code: kodeRj,
      confidence: 0.5,
      reasoning: `Pemetaan dari diagnosis utama ${primaryDiagnosis} ke kelompok rawat jalan (tarif tunggal), ${diagnosisCodes.length} diagnosis total, ${procedureCodes.length} prosedur.`,
    };
  }

  const bedah = kelompokProsedurRawatInap(kodeIcd, procedureCodes);
  const kategori = bedah ? bedah.kategori : cocokAturan(kodeIcd, ATURAN_RAWAT_INAP);
  if (!kategori) return null;

  // Severity INA-CBG (I/II/III) ditentukan DIAGNOSIS SEKUNDER (komorbiditas/
  // komplikasi), BUKAN prosedur. Dulu prosedur berkode memuat "87"/"89"/"93"/
  // "96" ikut menaikkan severity, sehingga rontgen toraks 87.44 saja membuat
  // I51.7 rawat inap menjadi I-4-24-II Rp4.873.800 padahal grouper E-Klaim
  // casemix memberi I-4-24-I Rp2.116.600 (KHOIRIYAH, 0170R0111225V003293) --
  // menyarankan tarif lebih tinggi tanpa dasar. Ada diagnosis sekunder -> II;
  // III tidak ditebak (butuh komplikasi berat yang tidak bisa disimpulkan dari
  // jumlah kode saja).
  const adaSekunder = diagnosisCodes.slice(1)
    .map(k => String(k || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .some(k => !BUKAN_KOMORBID.test(k) && !BUKAN_KOMORBID_UMUM.test(k) && !satuKelompokCedera(kodeIcd, k));
  const severity = adaSekunder ? 'II' : 'I';
  const confidence = adaSekunder ? 0.55 : 0.5;

  const finalCode = `${kategori}-${severity}`;
  if (!lookupTarifInacbg(finalCode)) return null;

  return {
    code: finalCode,
    berbasis_prosedur: Boolean(bedah),
    confidence: Math.min(confidence, 1.0),
    reasoning: bedah
      ? `Pemetaan dari prosedur ${bedah.prosedur} ke kelompok prosedur rawat inap, diagnosis utama ${primaryDiagnosis}. Severity: ${severity}.`
      : `Pemetaan dari diagnosis utama ${primaryDiagnosis} dengan ${diagnosisCodes.length} diagnosis total, ${procedureCodes.length} prosedur. Severity: ${severity}.`,
  };
}

/**
 * Membandingkan tarif klaim eksisting vs hasil kalkulasi grouping internal
 * (Base INA-CBG + Special CMG Top-Ups) tanpa mengubah record klaim asli.
 *
 * @param {Object} claimRecord - Data klaim yang diekstrak/di-input
 * @returns {Object} Hasil simulasi perbandingan grouping
 */
function simulateGroupingComparison(claimRecord) {
  if (!claimRecord) {
    return {
      status: 'INVALID_INPUT',
      error: 'Data record klaim kosong.'
    };
  }

  const kodeInacbg = (claimRecord.inacbg_code || '').trim().toUpperCase();
  const kelasRawat = claimRecord.kelas_rawat;
  const tarifKlaimEksisting = Number(claimRecord.tarif_inacbg) || 0;

  // 1. Lookup tarif dasar resmi PMK 3/2023
  const resmiInfo = getTarifResmi(kodeInacbg, kelasRawat);
  const tarifBaseResmi = resmiInfo && resmiInfo.tarif !== null ? Number(resmiInfo.tarif) : null;

  // 2. Deteksi Special CMG & Top-Up otomatis
  const activeSpecialCmgs = detectSpecialCmg(claimRecord);
  const totalTopup = calculateTotalTopup(activeSpecialCmgs);

  // 3. Kalkulasi total tarif grouping internal (Base + Special CMG Top-Up)
  const tarifInternalTotal = (tarifBaseResmi !== null ? tarifBaseResmi : 0) + totalTopup;

  // 4. Hitung selisih & match status
  const selisihBase = tarifBaseResmi !== null ? Math.abs(tarifKlaimEksisting - tarifBaseResmi) : null;
  const selisihTotal = Math.abs(tarifKlaimEksisting - tarifInternalTotal);
  const isMatch = tarifKlaimEksisting > 0 && selisihTotal === 0;

  // 5. Rekomendasi & Temuan
  const rekomendasi = [];
  if (!kodeInacbg) {
    rekomendasi.push('Kode INA-CBG belum diisi pada klaim.');
  } else if (!resmiInfo) {
    rekomendasi.push(`Kode INA-CBG ${kodeInacbg} tidak ditemukan pada tabel PMK 3/2023 Regional 1 Kelas D Swasta.`);
  } else if (resmiInfo.tarif === null) {
    rekomendasi.push(`Kode INA-CBG ${kodeInacbg} tidak memiliki tarif yang dijamin untuk kelas rawat ${kelasRawat}.`);
  } else if (selisihBase && selisihBase > 0) {
    rekomendasi.push(`Terdapat selisih tarif dasar sebesar Rp ${selisihBase.toLocaleString('id-ID')} antara tarif klaim vs tarif resmi PMK 3/2023.`);
  }

  if (activeSpecialCmgs.length > 0) {
    rekomendasi.push(`Terdeteksi ${activeSpecialCmgs.length} potensi Special CMG (Top-up Rp ${totalTopup.toLocaleString('id-ID')}).`);
  }

  return {
    kode_inacbg: kodeInacbg,
    kelas_rawat: kelasRawat,
    jenis_klaim: claimRecord.jenis_klaim || 'RAWAT_INAP',
    tarif_klaim_eksisting: tarifKlaimEksisting,
    tarif_base_resmi: tarifBaseResmi,
    special_cmg_active: activeSpecialCmgs,
    total_topup: totalTopup,
    tarif_internal_total: tarifInternalTotal,
    selisih_total: selisihTotal,
    status_match: isMatch,
    rekomendasi: rekomendasi
  };
}

module.exports = {
  adalahProsedurBedah,
  simulateGroupingComparison,
  groupCodesToInaCBG
};
