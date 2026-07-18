const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');

/**
 * Log an audit event to the database
 */
async function logAudit({ userId, userEmail, action, resourceType, resourceId, details, ipAddress, userAgent }) {
  try {
    const db = getDb();
    await db.prepare(`
      INSERT INTO audit_logs (id, user_id, user_email, action, resource_type, resource_id, details, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      userId || null,
      userEmail || null,
      action,
      resourceType || null,
      resourceId || null,
      details ? JSON.stringify(details) : null,
      ipAddress || null,
      userAgent || null
    );
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

/**
 * Create audit logger middleware - automatically logs API requests
 */
function auditMiddleware(action, resourceType) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      if (res.statusCode < 400) {
        logAudit({
          userId: req.user?.id,
          userEmail: req.user?.email,
          action,
          resourceType,
          resourceId: req.params?.id || data?.id,
          details: { method: req.method, path: req.path },
          ipAddress: req.ip,
          userAgent: req.get('User-Agent')
        });
      }
      return originalJson(data);
    };
    next();
  };
}

module.exports = { logAudit, auditMiddleware };
