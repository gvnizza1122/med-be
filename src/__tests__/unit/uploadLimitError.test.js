const handle = require('../../middleware/uploadLimitError');
test.each([
  ['/api/v1/claim-files/upload-pdf-antre', 'LIMIT_UNEXPECTED_FILE', 'maksimal 300'],
  ['/api/v1/claim-files/upload-pdf-batch?x=1', 'LIMIT_UNEXPECTED_FILE', 'maksimal 300'],
  ['/api/v1/claim-files/upload-pdf-antre', 'LIMIT_FILE_SIZE', '70MB'],
  ['/api/v1/claim-files/upload-pdf', 'LIMIT_FILE_SIZE', '20MB'],
  ['/api/v1/claim-files/upload', 'LIMIT_FILE_SIZE', '10MB'],
])('penolakan %s %s menampilkan batas yang sesuai', (originalUrl, code, expected) => {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  handle({ code }, { originalUrl }, res, jest.fn());
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json.mock.calls[0][0].error).toContain(expected);
});
test('gangguan lain tetap diteruskan ke penanganan error utama', () => {
  const error = Error('lain'); const next = jest.fn();
  handle(error, { path: '/api/v1/claim-files/upload-pdf-antre' }, {}, next);
  expect(next).toHaveBeenCalledWith(error);
});
