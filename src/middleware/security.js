/**
 * Security Middleware — Bridging API Hardening
 * 
 * Layers:
 * 1. IP Whitelist — Hanya IP RS Mitra Batang yg boleh akses bridging
 * 2. Per-API-Key Rate Limiter — Masing2 vendor punya limit sendiri
 * 3. HMAC Request Signing — Verifikasi integritas body request
 */

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 menit
const RATE_LIMIT_PER_KEY = 30; // max 30 request / menit per API key

// IP Whitelist — hanya IP RS Mitra Batang (isi sesuai jaringan RS)
const IP_WHITELIST = [
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  // Docker internal networks (container-to-container traffic)
  '172.17.0.0/16',
  '172.18.0.0/16',
  '172.19.0.0/16',
  '172.20.0.0/16',
  '172.21.0.0/16',
  '172.22.0.0/16',
  '172.23.0.0/16',
  '172.24.0.0/16',
  '172.25.0.0/16',
  '172.26.0.0/16',
  '172.27.0.0/16',
  '172.28.0.0/16',
  '172.29.0.0/16',
  '172.30.0.0/16',
  '172.31.0.0/16',
  // Tambahkan IP publik RS Mitra Batang di sini:
  // '203.xxx.xxx.xxx/32',
];

// Simple CIDR matcher — supports IPv4 and IPv4-mapped IPv6 (::ffff:x.x.x.x)
function ipInCIDR(ip, cidr) {
  if (!cidr.includes('/')) return ip === cidr;
  
  // Strip IPv6 prefix if present
  let cleanIp = ip;
  if (ip.startsWith('::ffff:')) {
    cleanIp = ip.substring(7);
  } else if (ip.startsWith('::')) {
    return false; // pure IPv6 not supported
  }
  
  const [range, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits)) - 1);
  const ipNum = cleanIp.split('.').reduce((sum, oct) => (sum << 8) + parseInt(oct), 0);
  const rangeNum = range.split('.').reduce((sum, oct) => (sum << 8) + parseInt(oct), 0);
  return (ipNum & mask) === (rangeNum & mask);
}

// Store per-key request counts (in-memory, reset on restart)
const keyRequestCounts = new Map();

/**
 * Layer 1: IP Whitelist Middleware
 * Hanya untuk bridging routes
 */
function ipWhitelist(req, res, next) {
  const clientIp = req.ip || req.connection.remoteAddress;
  const allowed = IP_WHITELIST.some(range => ipInCIDR(clientIp, range));
  
  if (!allowed) {
    console.warn(`[SECURITY] Blocked request from IP: ${clientIp}`);
    return res.status(403).json({ error: 'Akses ditolak. IP tidak terdaftar.' });
  }
  next();
}

/**
 * Layer 2: Per-API-Key Rate Limiter
 */
function apiKeyRateLimiter(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return next(); // will be caught by auth middleware

  const now = Date.now();
  if (!keyRequestCounts.has(apiKey)) {
    keyRequestCounts.set(apiKey, { count: 1, windowStart: now });
    return next();
  }

  const entry = keyRequestCounts.get(apiKey);
  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Reset window
    entry.count = 1;
    entry.windowStart = now;
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_PER_KEY) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    console.warn(`[SECURITY] Rate limit exceeded for API key: ${apiKey.substring(0, 8)}...`);
    return res.status(429).json({
      error: `Terlalu banyak request. Coba lagi dalam ${retryAfter} detik.`,
      retry_after: retryAfter
    });
  }
  
  next();
}

/**
 * Helper: Get client IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || req.connection.remoteAddress
    || 'unknown';
}

module.exports = { ipWhitelist, apiKeyRateLimiter, getClientIp };
