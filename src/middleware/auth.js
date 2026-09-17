const jwt = require('jsonwebtoken');
const { getDb } = require('../database/init');

const JWT_SECRET = process.env.JWT_SECRET || 'eclaim-secret';


async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan. Silakan login.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const db = getDb();
    const user = await db.prepare('SELECT id, email, full_name, role, hospital_code, is_active FROM users WHERE id = ?').get(decoded.userId);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User tidak ditemukan atau tidak aktif.' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired. Silakan login ulang.' });
    }
    return res.status(401).json({ error: 'Token tidak valid.' });
  }
}

// Hierarki role — 'superadmin' otomatis punya semua izin 'admin' TANPA perlu
// menulis authorize('admin', 'superadmin') di setiap route. Kebalikannya
// TIDAK berlaku (admin tidak otomatis dapat izin superadmin) — dipakai
// khusus buat Manajemen User (authorize('superadmin') saja, admin biasa
// sengaja dikecualikan dari situ).
const ROLE_INHERITANCE = { superadmin: ['admin'] };

/**
 * Middleware factory: Check if user has required role(s)
 * @param  {...string} roles - Allowed roles
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Autentikasi diperlukan.' });
    }
    const effectiveRoles = [req.user.role, ...(ROLE_INHERITANCE[req.user.role] || [])];
    if (!effectiveRoles.some(r => roles.includes(r))) {
      return res.status(403).json({
        error: `Akses ditolak. Role '${req.user.role}' tidak memiliki izin untuk aksi ini.`
      });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
