import { query } from './db.js';

// Fire-and-forget audit log write. Never throws — a logging failure must
// not block or crash authentication flows.
export function logAuthEvent(eventType, { username = null, userId = null, ip, success }) {
  query(
    `INSERT INTO auth_events (event_type, username, user_id, ip, success)
     VALUES ($1, $2, $3, $4, $5)`,
    [eventType, username || null, userId || null, ip || null, success]
  ).catch(err => console.error('[auth] Failed to log event:', err.message));
}
