/** Audit lokal read-only: tidak memanggil AI, OCR, atau menulis data klaim. */
'use strict';
const { getDb, closeDb } = require('../../src/database/init');
const { nilaiKelengkapanAnalisis } = require('../../src/services/kelengkapanAnalisisService');
const { validateQuotation } = require('../../src/services/aiReviewService');
const obj = x => { try { return typeof x === 'string' ? JSON.parse(x) || {} : x || {}; } catch { return {}; } };
const num = x => Number(x) || 0;
const count = xs => xs.reduce((a, k) => { a[k] = (a[k] || 0) + 1; return a; }, {});
const round = (x, places=2) => Math.round(x * 10**places) / 10**places;
const wib = x => x ? new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Jakarta', dateStyle:'short', timeStyle:'short' }).format(new Date(x)) : null;
global.fetch = () => { throw new Error('Panggilan jaringan dinonaktifkan selama audit'); };

async function audit(hospital = '3371084') {
  const db = getDb();
  return db.transaction(async tx => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const records = await tx.all(`SELECT cr.*, cf.file_name, cf.created_at AS upload_time,
      cf.diarsipkan_pada, cf.ai_total_tokens AS file_tokens, cf.status AS file_status
      FROM claim_records cr JOIN claim_files cf ON cf.id=cr.file_id
      WHERE cf.hospital_code=? ORDER BY cf.created_at, cr.row_number, cr.id`, [hospital]);
    const pages = await tx.all(`SELECT o.record_id,o.page_number,o.ocr_text FROM ocr_results o
      JOIN claim_records cr ON cr.id=o.record_id JOIN claim_files cf ON cf.id=cr.file_id
      WHERE cf.hospital_code=? ORDER BY o.record_id,o.page_number`, [hospital]);
    const calls = await tx.all(`SELECT tugas,penyedia,model,effort,waktu,ok,record_id,hospital_code,
      prompt_tokens,completion_tokens,total_tokens,cached_tokens,reasoning_tokens,estimasi_idr,estimasi_usd
      FROM catatan_panggilan_model WHERE hospital_code=? OR hospital_code IS NULL ORDER BY waktu`, [hospital]);
    const stages = await tx.all(`SELECT s.record_id,s.stage_key,s.status FROM claim_reading_stages s
      JOIN claim_records cr ON cr.id=s.record_id JOIN claim_files cf ON cf.id=cr.file_id WHERE cf.hospital_code=?`, [hospital]);
    const uploads = await tx.all(`SELECT status,record_id,jumlah_halaman FROM proses_unggah WHERE hospital_code=? ORDER BY dibuat`,[hospital]);
    const own = calls.filter(c => c.hospital_code === hospital);
    const aggregate = list => {
      const measured = list.filter(c=>num(c.total_tokens)>0).length;
      const priced = list.filter(c=>c.estimasi_idr!==null).length;
      return ({ calls:list.length, failed:list.filter(c=>c.ok===false).length,
      measured_calls:list.filter(c=>num(c.total_tokens)>0).length,
      unmeasured_calls:list.filter(c=>!(num(c.total_tokens)>0)).length,
      priced_calls:list.filter(c=>c.estimasi_idr!==null).length,
      input_tokens:measured ? list.reduce((a,c)=>a+num(c.prompt_tokens),0) : null,
      output_tokens:measured ? list.reduce((a,c)=>a+num(c.completion_tokens),0) : null,
      total_tokens:measured ? list.reduce((a,c)=>a+num(c.total_tokens),0) : null,
      cached_tokens:measured ? list.reduce((a,c)=>a+num(c.cached_tokens),0) : null,
      reasoning_tokens:measured ? list.reduce((a,c)=>a+num(c.reasoning_tokens),0) : null,
      estimated_idr:priced ? round(list.reduce((a,c)=>a+num(c.estimasi_idr),0)) : null,
      estimated_usd:priced ? round(list.reduce((a,c)=>a+num(c.estimasi_usd),0),6) : null });
    };
    const rows = records.map((r,i) => {
      const ai=obj(r.ai_review), evidence=pages.filter(p=>p.record_id===r.id), rs=calls.filter(c=>c.record_id===r.id && c.hospital_code===hospital);
      const completeness=nilaiKelengkapanAnalisis(ai,{evidencePool:evidence,wajibTahap:/\.pdf$/i.test(r.file_name)});
      const proposed=(ai.suggested_codes||[]).filter(s=>s?.quotation && s?.page_number);
      const codeEvidence=(ai.code_evidence||[]).filter(s=>s?.found && s?.quotation && s?.page_number);
      const quoteCheck=list=>({ checked:list.length, matched:list.filter(s=>validateQuotation(s.quotation,Number(s.page_number),evidence)).length });
      const fileLabel=(r.file_name.match(/V\d+\.pdf$/i)||[])[0] || `PDF ${String(i+1).padStart(2,'0')}`;
      return {file:fileLabel,index:i+1,record_id:r.id,result_url:`http://localhost:3000/results/${r.file_id}`,uploaded_wib:wib(r.upload_time),
        archived:Boolean(r.diarsipkan_pada),file_status:r.file_status,review_generated_at:ai.generated_at||null,
        usage:aggregate(rs),legacy_file_tokens:num(r.file_tokens),latest_review_tokens:num(ai.tokens_used),
        analysis:{status:completeness.status,reasons:completeness.alasan.map(x=>x.kode),
          readable_pages:evidence.filter(p=>String(p.ocr_text||'').trim()).length,
          empty_pages:evidence.filter(p=>!String(p.ocr_text||'').trim()).length,
          expected_pages:uploads.filter(x=>x.record_id===r.id).at(-1)?.jumlah_halaman||null,
          reading_stages:stages.filter(s=>s.record_id===r.id && s.status==='selesai').length,
          diagnosis_review:ai.tinjauan_diagnosis?.status||'belum_tersedia',
          diagnosis_reasoning:ai.penalaran_diagnosis?.status||'belum_tersedia',
          advanced_review:ai.pemeriksaan_lanjutan?.status||'belum_tersedia',
          pending_assessment:ai.putusan_pending?.status||'belum_tersedia',
          critical_score:ai.analisis_kritis?.skor_keyakinan??null,
          critical_high:(ai.analisis_kritis?.temuan||[]).filter(t=>t.keparahan==='tinggi').length,
          code_evidence:quoteCheck(codeEvidence),proposed_quotes:quoteCheck(proposed)}};
    });
    const summarize = list => ({records:list.length, completeness:count(list.map(r=>r.analysis.status)),
      reasons:count(list.flatMap(r=>r.analysis.reasons)), pending_assessment:count(list.map(r=>r.analysis.pending_assessment)),
      advanced_review:count(list.map(r=>r.analysis.advanced_review)),
      files_with_six_reading_stages:list.filter(r=>r.analysis.reading_stages===6).length,
      files_without_readable_pages:list.filter(r=>!r.analysis.readable_pages).length,
      files_with_unmatched_proposed_quotes:list.filter(r=>r.analysis.proposed_quotes.matched<r.analysis.proposed_quotes.checked).length,
      files_with_unmatched_code_evidence:list.filter(r=>r.analysis.code_evidence.matched<r.analysis.code_evidence.checked).length,
      stored_review_tokens:list.reduce((a,r)=>a+r.latest_review_tokens,0), usage:aggregate(own.filter(c=>list.some(r=>r.record_id===c.record_id)))});
    const tasks=[...new Set(own.map(c=>c.tugas))].map(task=>({task,...aggregate(own.filter(c=>c.tugas===task))}));
    const days=[...new Set(own.map(c=>wib(c.waktu)?.slice(0,10)))].map(day=>({day,...aggregate(own.filter(c=>wib(c.waktu)?.slice(0,10)===day))}));
    const idSet=new Set(records.map(r=>r.id));
    return {audited_at:new Date().toISOString(),hospital_scope: hospital, range_utc:{first:own[0]?.waktu,last:own.at(-1)?.waktu},
      usage_total:aggregate(own),usage_existing_files:aggregate(own.filter(c=>idSet.has(c.record_id))),
      usage_record_deleted:aggregate(own.filter(c=>c.record_id && !idSet.has(c.record_id))),
      usage_no_record:aggregate(own.filter(c=>!c.record_id)),usage_no_hospital:aggregate(calls.filter(c=>!c.hospital_code)),
      tasks,days,uploads:count(uploads.map(x=>x.status)), active:summarize(rows.filter(r=>!r.archived)),
      archived:summarize(rows.filter(r=>r.archived)),files:rows,
      limitations:['Pemakaian lama yang tidak mengandung token tidak dihitung sebagai nol biaya.',
        'Biaya memakai estimasi aplikasi yang tersimpan; bukan tagihan penyedia.',
        'Token per berkas bersifat kumulatif untuk panggilan yang dapat dihubungkan, termasuk pemeriksaan ulang.',
        'Kelengkapan tahap dan kecocokan kutipan bukan ukuran akurasi diagnosis atau bukti penerimaan BPJS.',
        'Token cache adalah bagian token input; token penalaran adalah bagian token output, tidak dijumlahkan ulang.',
        'Audit tidak mengirim dokumen ke penyedia AI dan tidak memproses ulang unggahan.']};
  });
}
if(require.main===module) audit(process.argv[2]).then(result=>console.log(JSON.stringify(result,null,2))).catch(e=>{ console.error(e.message);process.exitCode=1; }).finally(()=>closeDb());
module.exports={audit};
