/**
 * Telaah pneumonia ANAK menurut PNPK Pneumonia pada Anak (PP IDAI, UKK
 * Respirologi; ICD-10 J12-J18). Pasien anak tidak dinilai dengan kriteria
 * dewasa (CURB-65/PSI, gram sputum).
 *
 * Isi PNPK yang dipakai:
 *   - Batas napas cepat: 0-<2 bulan >=60, 2-<12 bulan >=50, 1-5 tahun >=40 x/menit.
 *   - Klasifikasi WHO (anak 2 bulan-5 tahun): pneumonia = batuk + napas cepat
 *     tanpa retraksi; berat = + retraksi dinding dada; sangat berat = + tanda
 *     bahaya (tidak mau menetek/minum, kejang, muntah terus-menerus, letargis/
 *     penurunan kesadaran, stridor saat tenang, gizi buruk).
 *   - Kriteria rawat inap -- Bayi: SpO2 <=92%/sianosis; napas >60; distres
 *     napas/apnea intermiten/grunting; tidak mau minum/menetek; keluarga tidak
 *     bisa merawat di rumah. Anak: SpO2 <=92%/sianosis; napas >40; distres
 *     napas/grunting; tanda dehidrasi; keluarga tidak bisa merawat di rumah.
 *   - Foto toraks & kultur darah tidak rutin pada pneumonia tanpa komplikasi;
 *     kultur sputum hanya dipertimbangkan pada remaja.
 *
 * Telaah dokumentasi, bukan diagnosis: tidak mengubah kode dan tidak membuat
 * pending wajib. Nilai yang tidak terbaca tidak dianggap normal.
 */
const VERSI = 'pnpk-idai-pneumonia-anak-2026-10-08.2';
const isi = (p) => String(p?.ocr_text ?? p?.text ?? '');
const DX_PNEUMONIA = /^J1[2-8]/;
const TEKS_PNEUMONIA = /\b(?:pneumonia|bronko\s*pneumonia|bronchopneumonia|brpn|bp)\b/i;

// Penanda penyangkalan di sekitar temuan: "retraksi (-)", "tidak ada retraksi", "tanpa dehidrasi".
const NEGASI_SESUDAH = /^\s*(?:\(\s*-\s*\)|-(?!\s*\d)|:\s*-|\s*negatif|disangkal|\s*tidak\s+ada|\s*\(?\s*neg)/i;
const NEGASI_SEBELUM = /\b(?:tidak\s+(?:ada|didapatkan|ditemukan|tampak)|tanpa|bukan|disangkal|tdk)\s*$/i;

function cariTanda(pages, pola, maks = 4) {
  const out = [];
  for (const p of pages) {
    const teks = isi(p);
    const re = new RegExp(pola.source, pola.flags.includes('g') ? pola.flags : `${pola.flags}g`);
    for (const m of teks.matchAll(re)) {
      const sebelum = teks.slice(Math.max(0, m.index - 30), m.index);
      const sesudah = teks.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (NEGASI_SEBELUM.test(sebelum) || NEGASI_SESUDAH.test(sesudah)) continue;
      const awal = teks.lastIndexOf('\n', m.index) + 1;
      const akhir = teks.indexOf('\n', m.index);
      const line = teks.slice(awal, akhir < 0 ? undefined : akhir);
      if (/\b(?:suspek|susp|suspect|rencana|riwayat|disangkal)\b/i.test(line)) continue;
      out.push({ page_number: p.page_number || null, kutipan: teks.slice(awal, akhir < 0 ? undefined : akhir).trim().slice(0, 220) });
      if (out.length >= maks) return out;
    }
  }
  return out;
}

/** RR dan SpO2 dari tulisan langsung ("RR : 30 x/mnt", "SpO2 : 97%") dan tabel tanda vital. */
function bacaVital(pages) {
  const rr = [], spo2 = [];
  const tambah = (arr, nilai, p, kutipan) => {
    if (Number.isFinite(nilai)) arr.push({ nilai, page_number: p.page_number || null, kutipan: String(kutipan).trim().slice(0, 200) });
  };
  for (const p of pages) {
    const baris = isi(p).split(/\r?\n/);
    baris.forEach((b, i) => {
      for (const m of b.matchAll(/\b(?:RR|R\.R|respirasi|resp(?:iration)?\s*rate|frek(?:uensi)?\s+nap(?:as|fas)|nafas|napas)\s*[:=]?\s*(\d{2,3})\s*(?:x|kali)\b/gi)) {
        const n = Number(m[1]); if (n >= 8 && n <= 120) tambah(rr, n, p, b);
      }
      for (const m of b.matchAll(/\b(?:SpO2|SpO₂|SaO2|saturasi(?:\s+oksigen)?|sat\.?)\s*[:=]?\s*(\d{2,3})\s*%/gi)) {
        const n = Number(m[1]); if (n >= 40 && n <= 100) tambah(spo2, n, p, b);
      }
      // Tabel: "Vital Sign TD Heart Rate RR Temp SpO2" lalu baris nilai.
      // Baris nilai bisa terpisah dari judul oleh baris label (mis. "VITAL SIGN"); ambil baris bernilai x/mnt terdekat.
      const nilaiTabel = baris.slice(i + 1, i + 4).find(x => /\d{1,3}\s*x\s*\/\s*m/i.test(x));
      if (/\bRR\b/.test(b) && /(?:heart\s*rate|\bHR\b|nadi)/i.test(b) && nilaiTabel) {
        const nilai = nilaiTabel;
        const perMenit = [...nilai.matchAll(/(\d{1,3})\s*x\s*\/\s*m/gi)].map(m => Number(m[1]));
        const kolom = [...b.matchAll(/heart\s*rate|\bHR\b|\bnadi\b|\bRR\b/gi)].map(m => m[0].toUpperCase());
        const iRr = kolom.indexOf('RR');
        if (iRr >= 0 && perMenit.length === kolom.length) tambah(rr, perMenit[iRr], p, `${b.trim()} | ${nilai.trim()}`);
        const persen = /(\d{2,3})\s*%/.exec(nilai);
        if (persen && /spo2|saturasi/i.test(b)) tambah(spo2, Number(persen[1]), p, `${b.trim()} | ${nilai.trim()}`);
      }
    });
  }
  return { rr, spo2 };
}

function usiaBulan(record = {}) { return require('./usiaPasienService').resolveUsia(record).bulan; }

function batasNapasCepat(bulan) {
  if (bulan === null) return null;
  if (bulan < 2) return { ambang: 60, kelompok: '0-<2 bulan' };
  if (bulan < 12) return { ambang: 50, kelompok: '2-<12 bulan' };
  if (bulan <= 60) return { ambang: 40, kelompok: '1-5 tahun (sampai 60 bulan)' };
  return null; // PNPK tidak memberi batas napas cepat di atas 5 tahun
}

/**
 * @param {{record?:object, dx?:string[], pages?:Array, jenisKlaim?:string}} masukan
 * @returns {null | object} null bila bukan pneumonia anak.
 */
function nilaiPneumoniaAnak({ record = {}, dx = [], pages = [], jenisKlaim } = {}) {
  const usia = require('./usiaPasienService').resolveUsia(record);
  const bulan = usia.bulan;
  if (usia.tahun === null || usia.tahun >= 18) return null;
  const kodeDx = dx.map(k => String(k || '').trim().toUpperCase());
  const halaman = (Array.isArray(pages) ? pages : []).filter(p => !require('./lembarGrouperService').isLembarGrouper(isi(p)))
    .filter(p => !['rincian_biaya','resep','sep','spri'].includes(require('./pdfPageClassifier').classifyPageDocumentType(isi(p))));
  if (!kodeDx.some(k => DX_PNEUMONIA.test(k))) return null;

  const bayi = usia.tahun < 1;
  const batas = batasNapasCepat(bulan);
  const { rr, spo2 } = bacaVital(halaman);
  const rrMaks = rr.length ? rr.reduce((a, b) => (b.nilai > a.nilai ? b : a)) : null;
  const spo2Min = spo2.length ? spo2.reduce((a, b) => (b.nilai < a.nilai ? b : a)) : null;
  const ambangRawat = bayi ? 60 : 40;

  const retraksi = cariTanda(halaman, /\bretraksi(?:\s+(?:subkostal|interkostal|dinding\s+dada|epigastri\w*))?\b|tarikan\s+dinding\s+dada/i);
  const distres = cariTanda(halaman, /\bgrunting\b|\bdistres\w*\s+(?:napas|nafas|pernapasan|pernafasan|respirasi)\b|\bnapas\s+cuping\s+hidung\b|\bapnea\b/i);
  const sianosis = cariTanda(halaman, /\bsianosis\b|\bcyanosis\b/i);
  const dehidrasi = cariTanda(halaman, /\bdehidrasi\b(?!\s*(?:\(\s*-|-|tidak))/i);
  const tidakMinum = cariTanda(halaman, /\b(?:tidak|tdk)\s+mau\s+(?:minum|menetek|menyusu)\b|\bmalas\s+(?:minum|menetek|menyusu)\b|\bsulit\s+(?:minum|menetek)\b/i);
  const keluarga = cariTanda(halaman, /\bkeluarga\s+(?:tidak|tdk)\s+(?:dapat|bisa|mampu)\s+merawat\b/i);
  const bahaya = cariTanda(halaman, /\b(?:kejang|letargi\w*|penurunan\s+kesadaran|stridor\s+(?:saat\s+)?tenang|muntah\s+terus(?:[- ]?menerus)?|gizi\s+buruk)\b/i);

  const ada = (b) => b.length > 0;
  const kriteria = [
    { id: 'spo2', nama: 'Saturasi oksigen <=92% atau sianosis',
      status: (spo2Min && spo2Min.nilai <= 92) || ada(sianosis) ? 'terpenuhi' : spo2.length ? 'tidak_terpenuhi' : 'tidak_terbaca',
      bukti: [...(spo2Min ? [spo2Min] : []), ...sianosis] },
    { id: 'napas', nama: `Frekuensi napas >${ambangRawat} x/menit`,
      status: rrMaks ? (rrMaks.nilai > ambangRawat ? 'terpenuhi' : 'tidak_terpenuhi') : 'tidak_terbaca', bukti: rrMaks ? [rrMaks] : [] },
    { id: 'distres', nama: bayi ? 'Distres pernapasan, apnea intermiten, atau grunting' : 'Distres pernapasan atau grunting',
      status: ada(distres) ? 'terpenuhi' : 'tidak_ditemukan', bukti: distres },
    bayi
      ? { id: 'tidak_minum', nama: 'Tidak mau minum/menetek', status: ada(tidakMinum) ? 'terpenuhi' : 'tidak_ditemukan', bukti: tidakMinum }
      : { id: 'dehidrasi', nama: 'Tanda dehidrasi', status: ada(dehidrasi) ? 'terpenuhi' : 'tidak_ditemukan', bukti: dehidrasi },
    { id: 'keluarga', nama: 'Keluarga tidak bisa merawat di rumah', status: ada(keluarga) ? 'terpenuhi' : 'tidak_ditemukan', bukti: keluarga },
  ];
  const terpenuhi = kriteria.filter(k => k.status === 'terpenuhi');

  // Tanda klinis hanya dukungan dokumentasi, bukan penetapan diagnosis.
  const napasCepat = batas && rrMaks ? rrMaks.nilai >= batas.ambang : null;
  const batuk = cariTanda(halaman, /\bbatuk\b/i);
  let klasifikasi = null;
  if (batas && batuk.length) {
    if (bulan < 2) {
      const retraksiBerat = retraksi.some(e => /interkostal|retraksi.*berat/i.test(e.kutipan));
      if ((rrMaks && rrMaks.nilai > 60) || retraksiBerat) klasifikasi = ada(bahaya) || ada(tidakMinum) ? 'pneumonia_sangat_berat' : 'pneumonia_berat';
      else klasifikasi = 'tanda_klinis_belum_terdokumentasi';
    } else if (napasCepat && ada(retraksi)) klasifikasi = ada(bahaya) || ada(tidakMinum) ? 'pneumonia_sangat_berat' : 'pneumonia_berat';
    else if (napasCepat) klasifikasi = 'pneumonia';
    else klasifikasi = 'tanda_klinis_belum_terdokumentasi';
  }

  const rawatInap = String(jenisKlaim || record.jenis_klaim || record.JENIS_KLAIM || '').toUpperCase() === 'RAWAT_INAP';
  const vitalTerbaca = rr.length > 0 || spo2.length > 0;
  const catatan = [];
  if (batas && rrMaks && !napasCepat) catatan.push(`Napas cepat usia ${batas.kelompok} (>=${batas.ambang} x/menit) belum terdokumentasi: RR tertinggi ${rrMaks.nilai} x/menit (hal. ${rrMaks.page_number}).`);
  if (rawatInap && vitalTerbaca && !terpenuhi.length) catatan.push('Belum ada kriteria rawat inap PNPK IDAI yang terdokumentasi.');
  if (bulan === null) catatan.push('Usia dalam bulan belum terkonfirmasi; ambang napas cepat menurut subkelompok bayi belum dinilai.');
  if (rawatInap && !vitalTerbaca) catatan.push('RR/SpO2 tidak terbaca; periksa catatan IGD/triase asli.');

  return {
    versi: VERSI,
    usia,
    halaman_sumber: [3,4,5,6,7,8,10,12],
    status_penilaian: terpenuhi.length ? 'indikasi_rawat_terdukung' : vitalTerbaca ? 'perlu_telaah' : 'belum_dapat_dinilai',
    sumber: 'PNPK Pneumonia pada Anak, PP IDAI (UKK Respirologi)',
    usia_bulan: bulan,
    kelompok: bayi ? 'bayi' : 'anak',
    batas_napas_cepat: batas,
    rr_tertinggi: rrMaks,
    spo2_terendah: spo2Min,
    napas_cepat: napasCepat,
    retraksi, tanda_bahaya: bahaya,
    klasifikasi_who: klasifikasi,
    kriteria_rawat_inap: kriteria,
    rawat_inap_terdukung: terpenuhi.length > 0,
    vital_terbaca: vitalTerbaca,
    perlu_telaah: rawatInap && terpenuhi.length === 0,
    catatan,
    catatan_keandalan: 'Telaah dokumentasi terhadap PNPK IDAI; tidak mengganti diagnosis atau kode dan bukan keputusan BPJS. Gram sputum dan CURB-65/PSI tidak diterapkan pada anak.',
  };
}

module.exports = { nilaiPneumoniaAnak, bacaVital, usiaBulan, batasNapasCepat, VERSI };
