/** Gaya ringkas ala caveman: bawaan mati; bila aktif hanya menambah aturan keluaran, Humanizer tetap ada. */
const { denganGayaRingkas, GAYA_RINGKAS, HUMANIZER_PROMPT } = require('../../services/humanizerPromptService');

afterEach(() => { delete process.env.AI_GAYA_KELUARAN; });

test('bawaan: hanya Humanizer, tanpa gaya ringkas', () => {
  const s = denganGayaRingkas('TUGAS');
  expect(s).toContain(HUMANIZER_PROMPT);
  expect(s).not.toContain(GAYA_RINGKAS);
});

test('AI_GAYA_KELUARAN=ringkas menambah aturan ringkas yang menjaga negasi, angka, dan kutipan', () => {
  process.env.AI_GAYA_KELUARAN = 'ringkas';
  const s = denganGayaRingkas('TUGAS');
  expect(s.startsWith('TUGAS')).toBe(true);
  expect(s).toContain(HUMANIZER_PROMPT);
  expect(s).toContain(GAYA_RINGKAS);
  expect(GAYA_RINGKAS).toMatch(/negasi/);
  expect(GAYA_RINGKAS).toMatch(/Kutipan tetap disalin persis/);
  expect(GAYA_RINGKAS).toMatch(/tidak dikurangi/);
});

test('surat jawaban pending dan chat agen casemix tidak memakai gaya ringkas', () => {
  const fs = require('fs');
  for (const f of ['draftJawabanPendingService.js', 'agenCasemixInteraktifService.js', 'putusanPendingService.js'])
    expect(fs.readFileSync(require.resolve(`../../services/${f}`), 'utf8')).not.toMatch(/denganGayaRingkas/);
});
