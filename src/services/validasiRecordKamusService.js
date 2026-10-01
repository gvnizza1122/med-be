const { validateRecord } = require('./ruleEngine');
const { galatKamusRecord } = require('./validasiKamusService');

// Keabsahan kamus berlaku juga ketika rule format dinonaktifkan.
async function validasiRecordDenganKamus(db, record, rules) {
  const errors = validateRecord(record, rules);
  return [...errors, ...await galatKamusRecord(db, record, errors)];
}

module.exports = { validasiRecordDenganKamus };
