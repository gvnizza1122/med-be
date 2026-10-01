const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/init');
const { authenticate } = require('../middleware/auth');
const { logAudit } = require('../services/auditService');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'eclaim-secret';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'eclaim-refresh-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username dan password wajib diisi.' });
    }

    const db = getDb();
    // Select hanya kolom yang diperlukan untuk login (bukan SELECT *)
    // Ini reduce network transfer dan potential index scan optimization
    const user = await db.prepare(
      'SELECT id, email, username, password_hash, full_name, is_active, role, hospital_code FROM users WHERE username = ? OR email = ?'
    ).get(username, username);

    if (!user) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    if (!user.is_active) {
      return res.status(401).json({ error: 'Akun tidak aktif. Hubungi administrator.' });
    }

    // Use async comparison jika perlu kecepatan di production
    // compareSync memblock event loop saat salt rounds tinggi
    const validPassword = await new Promise((resolve) => {
      // Non-blocking password check dengan timeout
      const timeout = setTimeout(() => resolve(false), 5000);
      bcrypt.compare(password, user.password_hash, (err, match) => {
        clearTimeout(timeout);
        resolve(!err && match);
      });
    });

    if (!validPassword) {
      return res.status(401).json({ error: 'Username atau password salah.' });
    }

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const refreshToken = jwt.sign(
      { userId: user.id },
      JWT_REFRESH_SECRET,
      { expiresIn: JWT_REFRESH_EXPIRES_IN }
    );

    // Async background: don't block login response on DB writes
    db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?").run(user.id).catch(err => {
      console.error('Failed to update last_login:', err.message);
    });

    logAudit({
      userId: user.id,
      userEmail: user.email,
      action: 'login',
      resourceType: 'auth',
      ipAddress: req.ip,
      userAgent: req.get('User-Agent')
    }).catch(err => {
      console.error('Failed to log audit:', err.message);
    });

    res.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        hospital_code: user.hospital_code
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
});


router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token diperlukan.' });
    }

    const decoded = jwt.verify(refresh_token, JWT_REFRESH_SECRET);
    const db = getDb();
    const user = await db.prepare('SELECT id, email, role FROM users WHERE id = ? AND is_active = 1').get(decoded.userId);

    if (!user) {
      return res.status(401).json({ error: 'User tidak ditemukan.' });
    }

    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({ access_token: accessToken, expires_in: 3600 });
  } catch (err) {
    res.status(401).json({ error: 'Refresh token tidak valid.' });
  }
});


router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
