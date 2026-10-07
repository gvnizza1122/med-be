const fs=require('fs'),os=require('os'),path=require('path');
const mockRun=jest.fn(async()=>({success:true,pages:[{page_num:1,text_full:'Diagnosis dokter dan tindakan'}]}));
jest.mock('../../services/workerThreadPool',()=>({createWorkerPool:()=>({run:mockRun,shutdown:async()=>{}})}));
const {classifyPdfPages,shutdownClassifyPool}=require('../../services/pdfPageClassifier');
let dir,file;
beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),'classify-cache-'));file=path.join(dir,'sample.pdf');fs.writeFileSync(file,'simulasi');mockRun.mockClear();});
afterEach(async()=>{await shutdownClassifyPool();fs.rmSync(dir,{recursive:true,force:true});});
test('10 pembacaan bersamaan hanya satu pekerjaan; mutasi hasil tidak mengubah cache',async()=>{
  const values=await Promise.all(Array.from({length:10},()=>classifyPdfPages(file)));
  expect(mockRun).toHaveBeenCalledTimes(1);values[0].pages[0].text_full='diubah pemanggil';
  expect((await classifyPdfPages(file)).pages[0].text_full).toBe('Diagnosis dokter dan tindakan');
});
test('perubahan file membatalkan cache; kegagalan pembacaan tidak disimpan',async()=>{
  await classifyPdfPages(file);fs.writeFileSync(file,'simulasi dengan isi baru');await classifyPdfPages(file);
  expect(mockRun).toHaveBeenCalledTimes(2);
  await shutdownClassifyPool();mockRun.mockResolvedValueOnce({success:false,pages:[]});
  await classifyPdfPages(file);await classifyPdfPages(file);expect(mockRun).toHaveBeenCalledTimes(4);
});
