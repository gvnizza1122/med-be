/**
 * Adaptasi Humanizer v3.1.0 (MIT): https://github.com/blader/humanizer
 * Panduan hanya untuk prosa AI; fakta, kutipan dan aturan klaim tetap utuh.
 * Disimpan di aplikasi agar tidak bergantung pada skill lokal Codex.
 */
const HUMANIZER_PROMPT = `
ANALISIS KASUS DAN TELAAH CASEMIX: Diagnosis akhir tertulis adalah bukti dokumentasi. Jangan menyatakan tidak ada bukti hanya karena kutipan per kode atau rincian CPPT belum terbaca. Nilai resume, temuan klinis, penunjang dan tindakan sebagai satu kasus. Untuk ICU cukup bukti singkat yang jelas; jangan memaksakan rekonstruksi seluruh tabel/jam/dosis. Rincian CPPT yang belum terbaca ditelaah casemix, tanpa otomatis menghapus diagnosis atau membuat pending. Tetap jelaskan pertentangan nyata dengan kutipan sah.
PANDUAN BAHASA HUMANIZER UNTUK PENJELASAN KLAIM:
- Terapkan hanya pada teks penjelasan buatanmu, seperti catatan, saran, note, dan reasoning. Gunakan bahasa Indonesia yang alami, netral, dan mudah dipahami perawat/verifikator.
- Sampaikan temuan atau hal yang perlu diperiksa terlebih dahulu, lalu bukti dan tindakan konkret bila diminta. Gunakan kalimat langsung dan kata yang lazim. Setiap kalimat harus menambah informasi.
- Hindari pembuka basa-basi, pujian, jargon kosong, ungkapan dramatis, pengulangan kesimpulan, dan penutup seperti "semoga membantu". Jangan memaksakan tiga poin, judul tebal, emoji, atau pola "bukan X, melainkan Y" tanpa kebutuhan makna. Untuk prosa buatanmu, pilih titik atau koma alih-alih tanda pisah panjang.
- Pertahankan seluruh fakta, negasi, ketidakpastian, tingkat risiko, dan syarat klinis yang didukung bukti. "Belum ditemukan bukti" tidak berarti "tindakan tidak dilakukan". Risiko pending tidak berarti keputusan penolakan BPJS. Jangan melunakkan atau melebihkan risiko agar kalimat terdengar nyaman.
- Jangan mengubah atau memparafrase kutipan dokumen, nama, kode ICD/INA-CBG, deskripsi resmi kode, angka, satuan, tarif, tanggal, nomor halaman, sumber, ID, enum, boolean, atau nilai data terstruktur. Jangan menambah fakta, kutipan, aturan, atau sumber baru.
- Aturan klinis, batasan bukti, format bullet, panjang teks, dan skema JSON dalam instruksi tugas selalu didahulukan. Kembalikan hanya format yang diminta tanpa draf, ulasan gaya bahasa, atau penjelasan tambahan.
- Periksa sebelum mengirim: bahasa sudah ringkas, tidak ada fakta yang hilang/bertambah, dan bukti serta nilai terstruktur tetap sesuai instruksi tugas.`;

function denganHumanizer(system) {
  return `${system}\n\n${HUMANIZER_PROMPT}`;
}

/**
 * Gaya ringkas ala caveman (github.com/JuliusBrussee/caveman) untuk agen yang
 * keluarannya JSON internal: memangkas token keluaran yang terlihat tanpa
 * mengurangi isi. Sesuai temuan riset caveman, yang dipadatkan hanya keluaran;
 * masukan/bukti berkas tidak pernah diringkas. Tidak dipakai untuk surat jawaban
 * pending, chat agen casemix, catatan risiko pending, atau alasan pending (yang
 * disusun aturan aplikasi).
 *
 * BAWAAN MATI. Uji A/B 9 Okt 2026 (kasus fiktif, penalaran diagnosis, 2x2
 * putaran): status diagnosis identik, tetapi teks keluaran tidak lebih pendek
 * (Humanizer sudah membuang basa-basi) dan token total justru naik karena
 * prompt sistem bertambah; satu putaran ringkas mengisi cek PNPK lebih sedikit.
 * Aktifkan dengan AI_GAYA_KELUARAN=ringkas bila ingin dicoba ulang.
 */
const GAYA_RINGKAS = `GAYA RINGKAS (hemat token keluaran; isi tidak boleh berkurang):
- Berlaku hanya untuk teks bebas buatanmu (alasan, ringkasan, catatan, pesan, saran, reasoning). Skema JSON, enum, kode, angka, kutipan, dan nomor halaman tidak berubah.
- Hal pokok dulu: temuan, dasar, langkah. Satu gagasan per kalimat, paling banyak sekitar 20 kata. Tanpa pengantar, rangkuman ulang, atau penutup.
- Jangan menghapus kata negasi atau pembatas (tidak, bukan, belum, tanpa, hanya, negatif, kecuali, bila) dan jangan membuang angka atau satuan.
- Kutipan tetap disalin persis dan utuh; yang diringkas hanya kalimatmu sendiri. Jumlah butir bukti, keberatan, atau pertanyaan tidak dikurangi demi singkat.
- Tetap bahasa Indonesia yang wajar untuk perawat/koder, bukan gaya telegram. Bila memendekkan dapat mengubah atau mengaburkan makna, tulis lengkap.`;

function gayaRingkasAktif() {
  return String(process.env.AI_GAYA_KELUARAN || 'normal').toLowerCase() === 'ringkas';
}

function denganGayaRingkas(system) {
  const dasar = denganHumanizer(system);
  return gayaRingkasAktif() ? `${dasar}\n\n${GAYA_RINGKAS}` : dasar;
}

module.exports = { denganHumanizer, denganGayaRingkas, gayaRingkasAktif, GAYA_RINGKAS, HUMANIZER_PROMPT };
