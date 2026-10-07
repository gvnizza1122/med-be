const { normalisasiPenggunaan, estimasiBiaya } = require('../../services/biayaModelService');
test('penalaran sudah termasuk output, tidak dihitung dua kali', () => {
  const usage = normalisasiPenggunaan({ prompt_tokens: 25000, completion_tokens: 5000,
    completion_tokens_details: { reasoning_tokens: 4000 } });
  expect(estimasiBiaya('gpt-6.1-sol', usage).usd).toBeCloseTo(0.1);
  expect(estimasiBiaya('gpt-6-luna', usage).usd).toBeCloseTo(0.005);
});
test('model tak dikenal, penyedia lain, dan penggunaan tidak tersedia tidak dianggap gratis', () => {
  const usage = normalisasiPenggunaan({ prompt_tokens: 100, completion_tokens: 100 });
  expect(estimasiBiaya('x', usage)).toBeNull();
  expect(estimasiBiaya('gpt-6-luna', usage, 'kimi')).toBeNull();
  expect(estimasiBiaya('gpt-6-luna', normalisasiPenggunaan())).toBeNull();
});
test('input panjang memakai pengali tarif resmi', () => {
  const usage = normalisasiPenggunaan({ prompt_tokens: 300000, completion_tokens: 10000 });
  expect(estimasiBiaya('gpt-6.1-sol', usage).usd).toBeCloseTo(1.35);
});
test('cache write yang tidak dilaporkan tetap tidak diketahui, berbeda dari nol terukur',()=>{
  expect(normalisasiPenggunaan({prompt_tokens:100}).cache_write_tokens).toBeNull();
  expect(normalisasiPenggunaan({prompt_tokens:100,prompt_tokens_details:{cache_write_tokens:0}}).cache_write_tokens).toBe(0);
});
