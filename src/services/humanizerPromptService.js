/**
 * Adaptasi Humanizer v3.1.0 (MIT): https://github.com/blader/humanizer
 * Panduan hanya untuk prosa AI; fakta, kutipan dan aturan klaim tetap utuh.
 * Disimpan di aplikasi agar tidak bergantung pada skill lokal Codex.
 */
const HUMANIZER_PROMPT = `PANDUAN BAHASA HUMANIZER UNTUK PENJELASAN KLAIM:
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

module.exports = { denganHumanizer };
