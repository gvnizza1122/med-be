/** PTD: 1 rawat inap, 2 rawat jalan. Tidak mengambil jenis dari hasil CBG. */
function normalJenis(v) {
  const s = String(v ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['1', 'RI', 'RITL', 'RAWAT_INAP'].includes(s)) return 'RAWAT_INAP';
  if (['2', 'RJ', 'RJTL', 'RAWAT_JALAN'].includes(s)) return 'RAWAT_JALAN';
  return null;
}
function jenisLayanan(record = {}) {
  const raw = record._rawData || {};
  const ptd = String(raw.PTD ?? record.PTD ?? record.ptd ?? '').trim();
  const eksplisit = record.jenis_klaim || record.JENIS_KLAIM || record.jenis_rawat || record.JENIS_RAWAT;
  const jenisEksplisit = normalJenis(eksplisit);
  if (ptd && !['1', '2'].includes(ptd)) return { jenis: null, masalah: 'PTD harus 1 (rawat inap) atau 2 (rawat jalan).' };
  if (ptd && jenisEksplisit && normalJenis(ptd) !== jenisEksplisit) return { jenis: null, masalah: 'PTD berbeda dengan jenis layanan tertulis.' };
  if (eksplisit && !jenisEksplisit) return { jenis: null, masalah: 'Jenis layanan tertulis tidak dikenali.' };
  return { jenis: normalJenis(ptd) || jenisEksplisit, sumber: ptd ? 'PTD' : jenisEksplisit ? 'jenis_layanan_tertulis' : null };
}
/** Kategori dari dokumen perawatan, bukan pilihan upload atau hasil grouper. */
function deteksiJenisDariHalaman(pages = []) {
  const bukti=[];
  for(const p of pages) {
    if(p.is_lembar_grouper)continue;
    const text=String(p.ocr_text??p.text_full??p.text??'').replace(/\r/g,'');
    const halaman=p.page_number??p.page_num??null;
    const tambah=(value,source,priority,kutipan)=>bukti.push({value,source,priority,page_number:halaman,kutipan});
    const pola=/(?:jns\.?\s*rawat|jenis\s*(?:rawat|pelayanan|perawatan))\s*[:=]\s*(?:[12]\s*[-–.]?\s*)?(rawat\s+inap|rawat\s+jalan)\b/gi;
    for(const m of text.matchAll(pola))tambah(/inap/i.test(m[1])?'RAWAT_INAP':'RAWAT_JALAN','jenis_pelayanan_sep',3,m[0]);
    const ri=/(?:resume\s*medis\s*(?:pasien\s*)?rawat\s*inap|ringkasan\s+pasien\s+pulang|resume\s+pasien\s+pulang)/i.exec(text);
    if(ri)tambah('RAWAT_INAP','resume_rawat_inap',2,ri[0]);
    const spri=/(?:surat\s*(?:perintah|pengantar)\s*(?:untuk\s*)?rawat\s*inap|surat\s+permintaan\s+rawat\s*inap|\bSPRI\b)/i.exec(text);
    if(spri)tambah('RAWAT_INAP','surat_perintah_rawat_inap',1,spri[0]);
    const rj=/resume\s*medis\s*(?:rj\b|rawat\s*jalan)/i.exec(text);
    if(rj)tambah('RAWAT_JALAN','resume_rawat_jalan',2,rj[0]);
    const igd=/(?:triage\s+igd|triase\s+igd|resume\s*medis\s*igd|instalasi\s+gawat\s+darurat|klinik\s*:\s*ugd\b)/i.exec(text);
    if(igd)tambah('RAWAT_JALAN','kunjungan_igd',0,igd[0]);
  }
  const kuat=bukti.filter(b=>b.priority>0);
  const konflik=new Set(kuat.map(b=>b.value)).size>1;
  const kandidat=[...bukti].sort((a,b)=>b.priority-a.priority)[0];
  return {value:konflik?null:kandidat?.value||null,source:konflik?'dokumen_berbeda':kandidat?.source||'belum_teridentifikasi',
    confident:!!kandidat&&!konflik,konflik,bukti:bukti.map(({priority,...b})=>b)};
}
module.exports = { jenisLayanan, normalJenis,deteksiJenisDariHalaman };
