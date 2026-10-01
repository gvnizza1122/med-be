# Tinjauan diagnosis berdasarkan kasus

Analisis AI berikutnya menambahkan `tinjauan_diagnosis` ke hasil review. Tab Saran AI
memiliki tombol **Tinjau sesuai kasus** untuk memeriksa berkas lama tanpa Baca Ulang.
Pratinjau memakai halaman OCR tersimpan dan tidak menulis diagnosis, prosedur,
tarif, atau putusan pending ke record. Pratinjau tersedia selama sesi halaman;
hasil analisis baru mengikuti penyimpanan review yang sudah ada.

Kandidat berasal dari kode klaim dan saran tervalidasi kamus. Dukungan kandidat
wajib memiliki kutipan diagnosis di resume medis (termasuk rawat jalan/IGD).
Model membandingkannya dengan anamnesis, pemeriksaan dan penunjang seluruh berkas.
Ia harus menilai setiap kandidat, mengembalikan alasan serta kutipan nyata, dan
memilih hanya kandidat yang didukung. Kutipan palsu, kandidat hilang, kode baru,
atau rekomendasi tanpa diagnosis resume ditolak oleh server.

Tinjauan dijalankan sebelum pemilihan alasan pending. Penilai pending menerima
kandidat diagnosis beserta alasan dan kutipannya sebagai konteks pendukung,
tetap memilih alasan dari daftar pemeriksaan aplikasi. Jumlah diagnosis dan
kebutuhan klarifikasi urutan utama tidak otomatis menjadi alasan pending baru.
Alasan wajib dan aturan pada data klaim yang belum direvisi tetap berlaku.

Saran dapat memprioritaskan satu diagnosis atau keduanya. Bila kedua diagnosis
didukung, aturan kombinasi yang sudah tersedia diterapkan setelah penilaian.
Jika bukti/urutan diagnosis belum jelas, kode tetap ditampilkan sebagai kandidat;
penggabungan dan perkiraan tarif saran ditahan. Diagnosis dokter dan tanda risiko
pada data klaim tetap memerlukan keputusan koder.

Ketiadaan rontgen bukan bukti otomatis bahwa pneumonia tidak ada. NICE menjelaskan
diagnosis klinis pneumonia dapat dibuat oleh tenaga kesehatan berdasarkan gejala
dan tanda meski tanpa foto toraks. Ini konteks klinis untuk prompt, bukan aturan
penerimaan klaim BPJS: [NICE NG250](https://www.nice.org.uk/guidance/ng250/chapter/Recommendations).
Penetapan kondisi utama mengikuti dokumentasi dokter dan alasan pelayanan,
sebagaimana prinsip morbidity coding dalam
[ICD-10 Volume 2 WHO](https://icd.who.int/browse10/Content/statichtml/ICD10Volume2_en_2010.pdf).

Pengujian memakai kasus sintetis untuk pilihan PPOK saja, pneumonia saja, keduanya,
klarifikasi, kutipan rekaan, kode baru, serta endpoint tanpa penulisan record.
Pengujian ini memeriksa perlindungan alur aplikasi, bukan mengukur akurasi klinis model.
