import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import { imapManager } from '../index.js';
import { providerProfile } from '../services/imapManager.js';

const router = Router();
router.use(requireAuth);

// Simple in-memory rate limiter: 20 searches per minute per user.
const searchBuckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of searchBuckets) {
    if (now > b.resetAt) searchBuckets.delete(k);
  }
}, 60_000);

function searchLimiter(req, res, next) {
  const key = req.session.userId;
  const now = Date.now();
  const b = searchBuckets.get(key);
  if (!b || now > b.resetAt) {
    searchBuckets.set(key, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (b.count >= 20) {
    res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many search requests. Try again shortly.' });
  }
  b.count++;
  next();
}

// Parse "from:amazon subject:invoice hello world" into structured operators + free-text terms.
// Supports: from: to: subject: has: is: after: before:
// Quoted values: from:"John Smith"
function parseSearchQuery(raw) {
  const ops = {};
  const terms = [];

  const opPattern = /\b(from|to|subject|has|is|after|before):("([^"]*)"|([\S]+))/gi;
  const remaining = raw.replace(opPattern, (_, key, _v, quoted, unquoted) => {
    const k = key.toLowerCase();
    const v = (quoted !== undefined ? quoted : (unquoted || '')).toLowerCase().trim();
    if (v) ops[k] = v;
    return ' ';
  }).trim();

  for (const word of remaining.split(/\s+/)) {
    const w = word.trim();
    if (w) terms.push(w);
  }

  return { ops, terms };
}

// Server-side search timeout — must exceed imapflow's 10s pool overflow so the
// pool has time to hand back a connection before we give up.
const SERVER_SEARCH_TIMEOUT_MS = 12000;

router.get('/', searchLimiter, async (req, res) => {
  const { q, accountId, limit = 50, offset = 0 } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed) return res.json({ messages: [] });
  if (trimmed.length > 500) return res.status(400).json({ error: 'Search query too long' });

  const accountsResult = await query(
    'SELECT id, imap_host, name, email_address, color, server_search_enabled FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccounts = accountsResult.rows;
  const userAccountIds = userAccounts.map(r => r.id);
  if (!userAccountIds.length) return res.json({ messages: [] });

  const targetIds = accountId && userAccountIds.includes(accountId)
    ? [accountId] : userAccountIds;
  const targetAccounts = userAccounts.filter(a => targetIds.includes(a.id));
  const serverSearchAccounts = targetAccounts.filter(a => providerProfile(a).serverSearch);

  const cap = Math.max(1, Math.min(parseInt(limit) || 50, 200));

  // Kick off server-side search immediately so it runs in parallel with the local query.
  // For supported providers (e.g. Gmail X-GM-RAW), searches the provider's own index —
  // no body downloads required, works on all messages regardless of local sync state.
  const remoteSearchPromise = serverSearchAccounts.length
    ? Promise.all(
        serverSearchAccounts.map(acc =>
          Promise.race([
            imapManager.searchServer(acc, trimmed, cap),
            new Promise(resolve => setTimeout(() => resolve([]), SERVER_SEARCH_TIMEOUT_MS)),
          ]).catch(err => {
            console.warn(`Server search error for ${acc.email_address}:`, err.message);
            return [];
          })
        )
      ).then(results => results.flat())
    : Promise.resolve([]);
  const { ops, terms } = parseSearchQuery(trimmed);

  const conditions = [];
  const params = [targetIds];
  let p = 2;

  // ── Operator filters ──────────────────────────────────────────────────────

  if (ops.from) {
    params.push(`%${ops.from}%`);
    conditions.push(`(m.from_email ILIKE $${p} OR m.from_name ILIKE $${p})`);
    p++;
  }

  if (ops.subject) {
    params.push(`%${ops.subject}%`);
    conditions.push(`m.subject ILIKE $${p++}`);
  }

  // to: searches the to/cc address JSON — cast to text covers name and email fields
  if (ops.to) {
    params.push(`%${ops.to}%`);
    conditions.push(`(m.to_addresses::text ILIKE $${p} OR m.cc_addresses::text ILIKE $${p})`);
    p++;
  }

  if (ops.has === 'attachment' || ops.has === 'attachments') {
    conditions.push(`m.has_attachments = true`);
  }

  if (ops.is === 'unread')  conditions.push(`m.is_read = false`);
  if (ops.is === 'read')    conditions.push(`m.is_read = true`);
  if (ops.is === 'starred') conditions.push(`m.is_starred = true`);

  if (ops.after) {
    const d = new Date(ops.after);
    if (!isNaN(d)) { params.push(d.toISOString()); conditions.push(`m.date >= $${p++}`); }
  }
  if (ops.before) {
    const d = new Date(ops.before);
    if (!isNaN(d)) { params.push(d.toISOString()); conditions.push(`m.date < $${p++}`); }
  }

  // ── Free-text terms ───────────────────────────────────────────────────────
  // Each term must match at least one of: from, subject (ILIKE — good for names
  // and partial words), or body content (FTS — good for large text with stemming).
  // AND between all terms: every word must appear somewhere in the email.

  for (const term of terms.slice(0, 10)) {
    if (term.length < 2) continue; // single-char terms are too broad and expensive
    params.push(`%${term}%`); // ILIKE pattern
    const likeIdx = p++;

    params.push(term); // raw term for plainto_tsquery
    const ftsIdx = p++;

    conditions.push(`(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.search_vector @@ plainto_tsquery('english', $${ftsIdx})
      )`);
  }

  const off = Math.max(0, parseInt(offset) || 0);
  params.push(cap);
  params.push(off);

  try {
    // Run local FTS and provider server-side search in parallel
    const localPromise = conditions.length
      ? query(`
          SELECT
            m.id, m.uid, m.folder, m.message_id, m.subject, m.from_name, m.from_email,
            m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
            a.name as account_name, a.email_address as account_email, a.color as account_color
          FROM messages m
          JOIN email_accounts a ON m.account_id = a.id
          WHERE m.account_id = ANY($1)
            AND m.is_deleted = false
            AND ${conditions.join('\n            AND ')}
          ORDER BY m.date DESC
          LIMIT $${p} OFFSET $${p + 1}
        `, params)
      : Promise.resolve({ rows: [] });

    const [localResult, remoteResults] = await Promise.all([localPromise, remoteSearchPromise]);

    // Merge: remote results already present in local results (matched by Message-ID)
    // are omitted to avoid duplicates. Local results take precedence since they have full
    // metadata (id, snippet, etc.) while remote-only rows may have partial data.
    const localMsgIds = new Set(localResult.rows.map(r => r.message_id).filter(Boolean));
    const newFromRemote = remoteResults.filter(r => r.message_id && !localMsgIds.has(r.message_id));

    const messages = [...localResult.rows, ...newFromRemote]
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
      .slice(0, cap);

    res.json({ messages, query: q });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Contact autocomplete — returns up to 10 unique senders matching the query.
// Uses DISTINCT ON (from_email) with ORDER BY date DESC so the most-recently-seen
// display name wins when the same address has appeared under multiple names.
router.get('/contacts', searchLimiter, async (req, res) => {
  const { q } = req.query;
  const trimmed = (q || '').trim();
  if (!trimmed || trimmed.length < 2) return res.json({ contacts: [] });
  if (trimmed.length > 100) return res.status(400).json({ error: 'Query too long' });

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [req.session.userId]
  );
  const userAccountIds = accountsResult.rows.map(r => r.id);
  if (!userAccountIds.length) return res.json({ contacts: [] });

  const pattern = `%${trimmed}%`;

  try {
    const result = await query(`
      SELECT DISTINCT ON (from_email) from_name AS name, from_email AS email
      FROM messages
      WHERE account_id = ANY($1)
        AND is_deleted = false
        AND from_email IS NOT NULL
        AND from_email != ''
        AND (from_email ILIKE $2 OR from_name ILIKE $2)
      ORDER BY from_email, date DESC
      LIMIT 10
    `, [userAccountIds, pattern]);

    res.json({ contacts: result.rows });
  } catch (err) {
    console.error('Contact suggest error:', err);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

export default router;
