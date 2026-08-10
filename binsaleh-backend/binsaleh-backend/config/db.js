// config/db.js
// MongoDB se connect karne wala function.
// server.js isay call karega app start hote hi.

const mongoose = require('mongoose');
const dns = require('dns');
const { promisify } = require('util');

const resolveSrv = promisify(dns.resolveSrv);
const resolveTxt = promisify(dns.resolveTxt);

// Regex to parse mongodb+srv:// URIs
const SRV_URI_RE = /^mongodb\+srv:\/\/(.+?)@(.+?)\/(.+?)(\?.*)?$/;

/**
 * Resolve SRV + TXT records for an Atlas cluster and return a direct replica-set URI.
 *
 * Some networks (e.g. UniFi routers) block the Node.js / MongoDB driver's internal
 * DNS SRV lookups. By resolving SRV + TXT records ourselves via Google DNS
 * (8.8.8.8) and building a plain 'mongodb://' replica-set URI, we bypass that block.
 *
 * Returns null if the URI isn't SRV-based or resolution fails.
 */
// Set Google DNS globally so MongoDB driver's SRV resolution works on restricted networks.
// Keep original servers as fallback in case Google DNS is also unreachable.
try {
  const originalServers = dns.getServers();
  dns.setServers(['8.8.8.8', '8.8.4.4', ...originalServers]);
} catch (e) {
  console.warn('⚠️ Could not set DNS servers:', e.message);
}

/**
 * Build a direct 'mongodb://' replica-set URI from the SRV URI.
 * This is a belt-and-suspenders approach: even though the global DNS setting
 * above usually fixes SRV resolution for the MongoDB driver, this provides
 * a fallback for environments where the driver's internal SRV handling still
 * fails despite correct DNS servers.
 */
async function buildDirectUri(originalUri) {
  if (!originalUri || !originalUri.startsWith('mongodb+srv://')) return null;

  const m = originalUri.match(SRV_URI_RE);
  if (!m) return null;

  const credentials = m[1];
  const srvHost = m[2];
  const database = m[3];
  const rawParams = m[4] || '';

  // 1. Resolve SRV records to get shard hostnames:port
  let srvAddresses;
  try {
    srvAddresses = await resolveSrv('_mongodb._tcp.' + srvHost);
  } catch (e) {
    console.warn('⚠️ [fallback] SRV resolution failed:', e.message);
    return null;
  }
  if (!srvAddresses || !srvAddresses.length) return null;

  const hosts = srvAddresses
    .filter(a => a.name && a.port)
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map(a => a.name + ':' + a.port)
    .join(',');

  if (!hosts) return null;

  // 2. Try to resolve TXT record to get the replicaSet name
  let replicaSet = '';
  try {
    const txtRecords = await resolveTxt('_mongodb._tcp.' + srvHost);
    if (txtRecords && txtRecords.length) {
      for (const record of txtRecords) {
        const txt = Array.isArray(record) ? record.join('') : record;
        const rsMatch = txt.match(/replicaSet=([^&\s]+)/i);
        if (rsMatch) {
          replicaSet = rsMatch[1];
          break;
        }
      }
    }
  } catch (e) {
    // TXT resolution is optional — proceed without replicaSet
  }

  // 3. Build the direct URI with required Atlas params.
  // authSource=admin is REQUIRED: Atlas's TXT record for this cluster includes
  // "authSource=admin", and the DB user authenticates against the admin DB.
  // Omitting it (or using the path database) causes "bad auth" on the
  // SRV-bypass path (verified against Atlas).
  const queryStr = rawParams.startsWith('?') ? rawParams.slice(1) : rawParams;
  const queryParams = new URLSearchParams(queryStr);
  queryParams.set('ssl', 'true');
  queryParams.set('authSource', 'admin');
  if (replicaSet) {
    queryParams.set('replicaSet', replicaSet);
  }

  const directUri = 'mongodb://' + credentials + '@' + hosts + '/' + database + '?' + queryParams.toString();
  console.log('🔧 Built direct replica-set URI (SRV bypass fallback)' + (replicaSet ? ' [replicaSet: ' + replicaSet + ']' : ''));
  return directUri;
}

// Vercel serverless: cache the Mongoose connection on the global object so warm
// instances reuse the same connection across function invocations instead of
// opening (and exhausting) a new pool on every cold start. On Render/local this
// is harmless — the promise is simply resolved once per process.
let cached = global.__mongoConnection;
if (!cached) {
  cached = global.__mongoConnection = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = (async () => {
      const originalUri = process.env.MONGO_URI;
      let uriToUse = originalUri;

      // Try to build a direct (non-SRV) URI by resolving SRV ourselves
      // This is a fallback in case the global DNS fix doesn't help
      const directUri = await buildDirectUri(originalUri);
      if (directUri) {
        uriToUse = directUri;
      }

      // Connect with generous timeouts (direct connection can be slower).
      // bufferTimeoutMS is raised so buffered queries survive the longer
      // cold-start connect window on serverless (Vercel) deployments.
      const conn = await mongoose.connect(uriToUse, {
        serverSelectionTimeoutMS: 20000,
        connectTimeoutMS: 20000,
        socketTimeoutMS: 45000,
        bufferTimeoutMS: 45000
      });
      console.log(`✅ MongoDB connected: ${conn.connection.host}`);
      return conn;
    })();
  }

  try {
    cached.conn = await cached.promise;
  } catch (err) {
    // Reset the cached promise so the next invocation can retry.
    cached.promise = null;
    throw err;
  }
  return cached.conn;
}

module.exports = connectDB;
