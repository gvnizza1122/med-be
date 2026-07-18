const { getDb } = require('./src/database/init');
const { normalizeColumnName } = require('./src/services/fileParser');

async function test() {
  const db = getDb();
  // We need to initialize the db connection since init.js initializes it async?
  // Let's call getDb().initialize() or check init.js
}
