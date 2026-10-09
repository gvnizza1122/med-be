/** Konteks AI untuk lembar observasi ICU; OCR sumber tetap utuh. */
function teksUntukAnalisis(page) {
  const teks = String(page?.ocr_text || '');
  if (!/\b(?:icu|iccu|hcu)\b/i.test(teks) || !/observasi|monitoring|balance|pemantauan|grafik/i.test(teks)
    || /resume\s+medis|diagnos[ai]s?\s+(?:utama|sekunder|akhir)|catatan\s+perkembangan|cppt/i.test(teks)) return teks;
  const baris = teks.split(/\r?\n/);
  const keep = new Set();
  for (let i=0;i<baris.length;i++) {
    if (/diagnos|assessment|asesmen|keluhan|kesadaran|gcs|syok|shock|hipoten|perdarahan|hematem|melena|respira|saturasi|spo2|ventilat|intub|ekstub|oksigen|norepi|norad|dopamin|dobut|vasopres|resus|loading|bolus|transfusi|prc|urin|diuresis|tindakan|terapi|diberikan|dilakukan|dipasang|terpasang|tidak|belum|tanpa|rencana|evaluasi|respons/i.test(baris[i]))
      for(let j=Math.max(0,i-1);j<=Math.min(baris.length-1,i+1);j++) keep.add(j);
  }
  if (!keep.size) return teks;
  return 'LEMBAR PEMANTAUAN ICU: cuplikan baris relevan, bukan rekonstruksi tabel/jam. OCR asli disimpan. Rincian CPPT ditelaah casemix; bagian di luar cuplikan tidak dinyatakan tidak ada.\n'+[...keep].sort((a,b)=>a-b).map(i=>baris[i]).join('\n');
}
module.exports={teksUntukAnalisis};
