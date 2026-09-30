/**
 * Penyamaran identitas pasien — SATU pintu untuk SEMUA pemanggilan model.
 *
 * Prinsip: model (Luna, Kimi, apa pun) tidak boleh menerima identitas pasien.
 * Identitas diganti token ([NAMA_1], [KARTU_1], ...) SEBELUM dikirim, lalu
 * dipulihkan ke nilai asli SETELAH jawaban datang. Peta token -> nilai asli
 * hidup hanya di memori satu panggilan (satu objek `buatPenyamar`), tidak
 * pernah ditulis ke DB, log, atau disertakan di pesan error.
 *
 * SIFAT KEAMANAN
 *  1. Deterministik, tanpa AI: pola regex + daftar identitas yang dikenal.
 *  2. Reversibel: nilai yang sama selalu jadi token yang sama dalam satu
 *     panggilan; pulihkan() hanya mengganti token yang DIA sendiri terbitkan
 *     (token asing dari model dibiarkan, tidak diterjemahkan).
 *  3. Berlaku untuk string maupun objek/array bersarang (samarkanObjek).
 *
 * BATAS YANG JUJUR (baca sebelum percaya)
 *  - Yang tertangkap otomatis: nomor kartu BPJS (13 digit), NIK (16 digit),
 *    nomor SEP, nomor telepon/HP Indonesia, nilai di belakang label
 *    "No RM/MRN/Rekam Medis", "Alamat", "Nama (pasien/peserta)", serta gelar
 *    keluarga (Tn./Ny./Sdr./An./By. Ny.) diikuti nama.
 *  - Yang TIDAK tertangkap: nama pasien yang muncul di teks bebas TANPA label
 *    dan TIDAK ada di daftar `dikenal`; alamat tanpa label/tanpa "Jl."; nomor RM
 *    tanpa label; nama keluarga/penanggung jawab yang tidak diberikan. Karena
 *    itu pemanggil WAJIB menyerahkan `dikenal` dari rekam klaim (nama, kartu,
 *    NIK, RM, SEP, alamat, telepon) — nilai itu dicari di seluruh teks, dengan
 *    toleransi spasi/titik/strip antar-digit dan urutan nama terbalik.
 *  - Penyamaran meminimalkan, bukan menjamin nol kebocoran. Tanggal lahir dan
 *    data klinis sengaja TIDAK disamarkan (dibutuhkan model untuk menilai).
 *  - Pecahan nama (kata >= 4 huruf dari nama yang dikenal) ikut disamarkan;
 *    ini bisa mengenai kata biasa yang kebetulan sama dengan nama bagian.
 */

const JENIS = {
  NAMA: 'NAMA',
  KARTU: 'KARTU',
  NIK: 'NIK',
  RM: 'RM',
  ALAMAT: 'ALAMAT',
  TELP: 'TELP',
  SEP: 'SEP',
};

const KATA_BUKAN_NAMA = new Set([
  'pasien', 'bapak', 'ibu', 'nyonya', 'tuan', 'saudara', 'saudari', 'anak',
  'bayi', 'peserta', 'laki', 'perempuan', 'dokter', 'nama', 'lengkap',
]);

// Kata yang menandai label berikutnya pada baris OCR yang menyatu
// ("Nama: BUDI SANTOSO No RM: 123") — penangkap nama berhenti di sini.
const PENANDA_LABEL_BERIKUT = new Set([
  'no', 'nomor', 'nik', 'tgl', 'tanggal', 'umur', 'usia', 'alamat', 'jenis',
  'jk', 'kelamin', 'rm', 'mrn', 'sep', 'kartu', 'telp', 'telepon', 'hp', 'wa',
  'agama', 'pekerjaan', 'status', 'dpjp', 'dokter', 'ruang', 'kelas', 'diagnosa',
  'diagnosis', 'tempat', 'lahir', 'bpjs', 'penjamin', 'cara',
]);

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function digitSaja(s) {
  return String(s == null ? '' : s).replace(/\D/g, '');
}

function kunciNormal(jenis, nilai) {
  const s = String(nilai).trim();
  if ([JENIS.KARTU, JENIS.NIK, JENIS.TELP, JENIS.SEP, JENIS.RM].includes(jenis)) {
    return s.replace(/[\s.\-]/g, '').toUpperCase();
  }
  return s.replace(/\s+/g, ' ').toLowerCase();
}

// Regex yang cocok dengan deretan digit yang boleh disisipi spasi/titik/strip.
function polaDigitLonggar(digit) {
  return digit.split('').map(escapeRegExp).join('[\\s.\\-]?');
}

const TANPA_HURUF_DI_SEKITAR = (inti) => `(?<![A-Za-z0-9])(?:${inti})(?![A-Za-z0-9])`;

function ambilKata(teks) {
  return String(teks).split(/(\s+)/);
}

/**
 * Buat penyamar untuk SATU panggilan model.
 * @param {object} [dikenal] identitas dari rekam klaim:
 *   { nama: string|string[], nomor_kartu, nik, no_rm, sep, alamat, telepon,
 *     lainnya: string[] }  (semua opsional; nilai kosong diabaikan)
 */
function buatPenyamar(dikenal = {}) {
  const peta = new Map();      // token -> nilai asli (yang pertama terlihat)
  const balik = new Map();     // `${jenis}|${kunci}` -> token
  const cacah = {};            // jenis -> urutan

  function tokenUntuk(jenis, nilai) {
    const asli = String(nilai).trim();
    const kunci = `${jenis}|${kunciNormal(jenis, asli)}`;
    if (balik.has(kunci)) return balik.get(kunci);
    cacah[jenis] = (cacah[jenis] || 0) + 1;
    const token = `[${jenis}_${cacah[jenis]}]`;
    balik.set(kunci, token);
    peta.set(token, asli);
    return token;
  }

  // ---- identitas dikenal -> daftar aturan (pola, jenis, nilaiBaku) ----
  const aturanDikenal = [];
  const daftar = (v) => (Array.isArray(v) ? v : [v]).filter((x) => x != null && String(x).trim() !== '');

  for (const nama of daftar(dikenal.nama)) {
    const bersih = String(nama).trim().replace(/\s+/g, ' ');
    const kata = bersih.split(' ').filter(Boolean);
    const varian = new Set([bersih]);
    if (kata.length === 2) varian.add(`${kata[1]}, ${kata[0]}`);
    if (kata.length >= 2) varian.add(`${kata[kata.length - 1]}, ${kata.slice(0, -1).join(' ')}`);
    for (const v of varian) {
      aturanDikenal.push({ jenis: JENIS.NAMA, nilai: bersih, panjang: v.length,
        pola: new RegExp(TANPA_HURUF_DI_SEKITAR(escapeRegExp(v).replace(/ /g, '\\s+')), 'gi') });
    }
    for (const k of kata) {
      const inti = k.replace(/[^A-Za-z]/g, '');
      if (inti.length >= 4 && !KATA_BUKAN_NAMA.has(inti.toLowerCase())) {
        aturanDikenal.push({ jenis: JENIS.NAMA, nilai: bersih, panjang: inti.length,
          pola: new RegExp(TANPA_HURUF_DI_SEKITAR(escapeRegExp(inti)), 'gi') });
      }
    }
  }
  const digitDikenal = [
    [JENIS.KARTU, dikenal.nomor_kartu],
    [JENIS.NIK, dikenal.nik],
    [JENIS.SEP, dikenal.sep],
    [JENIS.RM, dikenal.no_rm],
    [JENIS.TELP, dikenal.telepon],
  ];
  for (const [jenis, nilai] of digitDikenal) {
    for (const v of daftar(nilai)) {
      const s = String(v).trim();
      const d = digitSaja(s);
      // SEP memuat huruf: cocokkan literal. Lainnya: digit longgar (min 5 digit
      // supaya nilai pendek/tak bermakna tidak menyapu seluruh teks).
      if (jenis === JENIS.SEP || d.length !== s.replace(/[\s.\-]/g, '').length) {
        if (s.length < 4) continue;
        aturanDikenal.push({ jenis, nilai: s, panjang: s.length,
          pola: new RegExp(TANPA_HURUF_DI_SEKITAR(escapeRegExp(s)), 'gi') });
      } else {
        if (d.length < 5) continue;
        aturanDikenal.push({ jenis, nilai: s, panjang: d.length + 100,
          pola: new RegExp(`(?<!\\d)${polaDigitLonggar(d)}(?!\\d)`, 'g') });
      }
    }
  }
  for (const v of daftar(dikenal.alamat)) {
    const s = String(v).trim().replace(/\s+/g, ' ');
    if (s.length < 5) continue;
    aturanDikenal.push({ jenis: JENIS.ALAMAT, nilai: s, panjang: s.length + 1000,
      pola: new RegExp(escapeRegExp(s).replace(/ /g, '\\s+'), 'gi') });
  }
  for (const v of daftar(dikenal.lainnya)) {
    const s = String(v).trim();
    if (s.length < 4) continue;
    aturanDikenal.push({ jenis: JENIS.NAMA, nilai: s, panjang: s.length,
      pola: new RegExp(TANPA_HURUF_DI_SEKITAR(escapeRegExp(s).replace(/ /g, '\\s+')), 'gi') });
  }
  // Yang terpanjang lebih dulu supaya "Budi Santoso" tidak tercacah jadi dua token.
  aturanDikenal.sort((a, b) => b.panjang - a.panjang);

  // Tanda "sudah disamarkan" supaya pola berikutnya tidak menyentuh token.
  const RE_TOKEN = /\[(?:NAMA|KARTU|NIK|RM|ALAMAT|TELP|SEP)_\d+\]/;

  function samarkan(teks) {
    if (teks == null) return teks;
    let s = String(teks);
    if (s === '') return s;

    // 1. identitas yang DIKENAL dari rekam klaim (paling andal)
    for (const a of aturanDikenal) {
      s = s.replace(a.pola, () => tokenUntuk(a.jenis, a.nilai));
    }

    // 2. SEP berformat (mis. 0123R0010725V000123)
    s = s.replace(/(?<![A-Za-z0-9])\d{4,10}[A-Z]\d{5,8}[A-Z]\d{5,8}(?![A-Za-z0-9])/g,
      (m) => tokenUntuk(JENIS.SEP, m));
    // "No. SEP : xxxx"
    s = s.replace(/(\b(?:no\.?|nomor)\s*SEP\s*[:=]?\s*)([A-Za-z0-9]{8,})/gi,
      (_, awal, nilai) => awal + tokenUntuk(JENIS.SEP, nilai));

    // 3. NIK 16 digit dulu, baru kartu 13 digit (urutan penting)
    s = s.replace(/(?<![\dA-Za-z])\d{16}(?![\dA-Za-z])/g, (m) => tokenUntuk(JENIS.NIK, m));
    s = s.replace(/(?<![\dA-Za-z])\d{13}(?![\dA-Za-z])/g, (m) => tokenUntuk(JENIS.KARTU, m));

    // 4. telepon / HP Indonesia
    s = s.replace(/(?<![\dA-Za-z])(?:\+62|62|0)[\s-]?8\d{1,3}[\s-]?\d{3,4}[\s-]?\d{2,5}(?![\dA-Za-z])/g,
      (m) => (digitSaja(m).length >= 9 && digitSaja(m).length <= 15 ? tokenUntuk(JENIS.TELP, m) : m));
    s = s.replace(/(\b(?:telp|telepon|tlp|hp|wa|no\.?\s*hp)\.?\s*[:=]?\s*)(\(?0\d{1,3}\)?[\s-]?\d{5,8}(?:[\s-]?\d{2,4})?)/gi,
      (_, awal, nilai) => awal + tokenUntuk(JENIS.TELP, nilai));

    // 5. No RM berlabel
    s = s.replace(/(\b(?:no\.?\s*rm|no\.?\s*rekam\s*medis|nomor\s*rekam\s*medis|no\.?\s*mrn|mrn|rm)\s*[:=.]?\s*)((?=[A-Za-z0-9.\-]*\d)[A-Za-z0-9][A-Za-z0-9.\-]{3,})/gi,
      (m, awal, nilai) => (RE_TOKEN.test(nilai) ? m : awal + tokenUntuk(JENIS.RM, nilai)));

    // 6. Alamat: berlabel (sampai akhir baris) atau berawalan Jl./Jalan/Gg.
    s = s.replace(/(\balamat(?:\s+lengkap|\s+pasien|\s+domisili)?\s*[:=]\s*)([^\n\r]+)/gi,
      (m, awal, nilai) => (RE_TOKEN.test(nilai) && nilai.trim().match(/^\[ALAMAT_\d+\]$/) ? m : awal + tokenUntuk(JENIS.ALAMAT, nilai.trim())));
    s = s.replace(/(?<![A-Za-z])(?:Jl\.?|Jalan|Gg\.?|Gang)\s+[A-Za-z0-9][^\n\r]*/g,
      (m) => (m.includes('[ALAMAT_') ? m : tokenUntuk(JENIS.ALAMAT, m.trim())));

    // 7. Nama berlabel ("Nama Pasien: ...", bukan "Nama Dokter")
    s = s.replace(/((?<!dokter\s)(?<!dpjp\s)(?<!obat\s)(?<!tindakan\s)\bnama(?:\s+pasien|\s+peserta|\s+lengkap)?\s*[:=]\s*)([^\n\r]+)/gi,
      (m, awal, sisa) => {
        const potong = potongNama(sisa);
        if (!potong.nama) return m;
        return awal + tokenUntuk(JENIS.NAMA, potong.nama) + potong.sisa;
      });
    // 8. Gelar keluarga + nama: "Tn. Budi Santoso", "By. Ny. Siti Aminah"
    s = s.replace(/\b((?:By\.?\s*)?(?:Tn|Ny|Nn|Sdr|Sdri|An)\.?\s+)([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,3})/g,
      (m, gelar, nama) => (/^\[/.test(nama) ? m : gelar + tokenUntuk(JENIS.NAMA, nama)));

    return s;
  }

  function samarkanObjek(nilai) {
    if (typeof nilai === 'string') return samarkan(nilai);
    if (Array.isArray(nilai)) return nilai.map(samarkanObjek);
    if (nilai && typeof nilai === 'object') {
      const hasil = {};
      for (const [k, v] of Object.entries(nilai)) hasil[k] = samarkanObjek(v);
      return hasil;
    }
    return nilai;
  }

  function pulihkan(teks) {
    if (typeof teks !== 'string' || peta.size === 0) return teks;
    return teks.replace(/\[(NAMA|KARTU|NIK|RM|ALAMAT|TELP|SEP)_(\d+)\]/gi,
      (m, j, n) => {
        const token = `[${j.toUpperCase()}_${n}]`;
        return peta.has(token) ? peta.get(token) : m;
      });
  }

  function pulihkanObjek(nilai) {
    if (typeof nilai === 'string') return pulihkan(nilai);
    if (Array.isArray(nilai)) return nilai.map(pulihkanObjek);
    if (nilai && typeof nilai === 'object') {
      const hasil = {};
      for (const [k, v] of Object.entries(nilai)) hasil[k] = pulihkanObjek(v);
      return hasil;
    }
    return nilai;
  }

  return {
    samarkan,
    samarkanObjek,
    pulihkan,
    pulihkanObjek,
    jumlahToken: () => peta.size,
    // Hanya ringkasan jenis -> jumlah; nilai asli tidak pernah keluar dari objek ini.
    ringkasan: () => ({ ...cacah }),
  };
}

// Ambil nama dari sisa baris setelah label; berhenti di label berikutnya/angka.
function potongNama(sisa) {
  const bagian = ambilKata(sisa);
  const ambil = [];
  let kata = 0;
  let i = 0;
  for (; i < bagian.length; i++) {
    const b = bagian[i];
    if (/^\s+$/.test(b)) { if (ambil.length) ambil.push(b); continue; }
    if (b === '') continue;
    const inti = b.replace(/[^A-Za-z]/g, '').toLowerCase();
    if (/\d/.test(b) || /:$/.test(b) || (kata > 0 && PENANDA_LABEL_BERIKUT.has(inti)) || kata >= 6) break;
    if (!/[A-Za-z]/.test(b)) break;
    ambil.push(b);
    kata++;
  }
  while (ambil.length && /^\s+$/.test(ambil[ambil.length - 1])) ambil.pop();
  const nama = ambil.join('').trim().replace(/[,.;]+$/, '');
  const dipakai = ambil.join('').length;
  const asal = bagian.join('');
  // pertahankan spasi awal yang ikut terpotong
  const awalSpasi = asal.match(/^\s*/)[0].length;
  return { nama, sisa: asal.slice(awalSpasi + dipakai) };
}

/** Sekali-pakai: samarkan satu teks/objek, kembalikan {teks, pulihkan}. */
function samarkanSekali(nilai, dikenal) {
  const p = buatPenyamar(dikenal);
  return { hasil: p.samarkanObjek(nilai), pulihkan: p.pulihkanObjek, penyamar: p };
}

module.exports = { buatPenyamar, samarkanSekali, JENIS };
