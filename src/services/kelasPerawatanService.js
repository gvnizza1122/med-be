// Kelas kamar yang ditempati berbeda dari kelas hak untuk acuan tarif BPJS.
function objek(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (_) { return {}; } }
  return raw && typeof raw === 'object' ? raw : {};
}
function kelasValid(v) { return /^[123]$/.test(String(v ?? '').trim()) ? String(v).trim() : null; }
function bacaKelasSep(teks) {
  const s = String(teks || '');
  const baca = label => {
    const m = new RegExp('(?:kelas|kls\\.?)[ \\t]*' + label + '[ \\t]*:?[ \\t]*(?:kelas[ \\t]*)?([123])\\b', 'i').exec(s);
    return m ? m[1] : null;
  };
  const hasil = { kelas_hak: baca('hak'), kelas_ditempati: baca('rawat') };
  // SEP digital kadang menulis seluruh label kolom terlebih dahulu, baru nilainya.
  // Pasangkan hanya dua label kelas berurutan dan tepat dua nilai kelas di blok itu.
  if (!hasil.kelas_hak || !hasil.kelas_ditempati) {
    const kolom = /(?:kelas|kls\.?)\s*hak\s*\n\s*(?:kelas|kls\.?)\s*rawat\s*\n([\s\S]{0,400})/i.exec(s);
    if (kolom) {
      const blok = kolom[1].split(/\*?saya\s+menyetujui|\n\s*RESUME\s+MEDIS|\n\s*===/i)[0];
      const nilai = [...blok.matchAll(/^\s*:\s*Kelas\s+([123])\s*$/gmi)].map(m => m[1]);
      if (nilai.length === 2) { hasil.kelas_hak ||= nilai[0]; hasil.kelas_ditempati ||= nilai[1]; }
    }
  }
  return hasil;
}
function informasiKelas(record = {}) {
  const raw = objek(record.raw_data);
  const hak = kelasValid(record.KELAS_HAK ?? record.kelas_hak ?? raw.KELAS_HAK);
  const ditempati = kelasValid(record.KELAS_DITEMPATI ?? raw.KELAS_DITEMPATI ?? record.kelas_rawat ?? record.KELAS_RAWAT ?? raw.KELAS_RAWAT);
  return { kelas_hak: hak, kelas_ditempati: ditempati, kelas_tarif: hak || ditempati,
    kelas_hak_belum_terbaca: !hak, naik_kelas: Boolean(hak && ditempati && Number(ditempati) < Number(hak)),
    selisih_biaya_pasien: null,
    catatan: hak && ditempati && hak !== ditempati
      ? 'Acuan tarif BPJS memakai kelas hak. Kelas kamar dicatat terpisah; selisih biaya pasien perlu dasar dan perhitungan tersendiri.'
      : !hak ? 'Kelas hak belum terbaca; acuan sementara memakai kelas rawat yang tersedia.' : 'Acuan tarif memakai kelas hak peserta.' };
}
const kelasTarif = record => informasiKelas(record).kelas_tarif;
module.exports = { bacaKelasSep, informasiKelas, kelasTarif };
