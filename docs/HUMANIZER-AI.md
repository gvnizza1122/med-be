# Humanizer pada AI eClaim

Panduan bahasa di `src/services/humanizerPromptService.js` diadaptasi dari
[Humanizer v3.1.0](https://github.com/blader/humanizer), berlisensi MIT.
Panduan disimpan dalam aplikasi dan tidak memerlukan instalasi skill Codex di server.

Panduan ditambahkan ke prompt audit klaim, usulan kode cadangan, penilaian
kegawatdaruratan, analisis risiko pending, dan audit field lama. Tujuannya agar
catatan dan penjelasan memakai bahasa Indonesia yang langsung, alami, dan ringkas.
Instruksi tugas tetap menentukan format, bukti, batas panjang, dan aturan klinis.

Kutipan dokumen, kode, deskripsi resmi, angka, tarif, sumber, dan nilai JSON tidak
boleh diubah untuk memperbaiki gaya bahasa. Ketidakpastian, negasi, serta tingkat
risiko harus dipertahankan. Jalur ekstraksi data mentah, pemilihan kode, dan
pemilihan kandidat keputusan pending tidak ditambahkan panduan penulisan prosa.
Hasil model tetap melewati pemeriksaan bukti dan aturan aplikasi yang sudah ada.

Panduan berlaku pada analisis AI berikutnya. Hasil analisis yang sudah tersimpan
tidak ditulis ulang otomatis. Ini adalah instruksi bahasa untuk model, sehingga
kualitas bahasa perlu dinilai dari hasil analisis nyata; pengujian otomatis
memeriksa pengiriman panduan dan perlindungan data pada alur aplikasi.
