let db = null;
let usingMemory = false;
let mem = { tickets: new Map(), meta: new Map(), logs: [] };

try {
  const Database = require('better-sqlite3');
  const path = require('path');
  db = new Database(path.join(__dirname, 'data.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    channel_id TEXT PRIMARY KEY,
    user_id TEXT,
    created_at INTEGER,
    ticket_number INTEGER
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER,
    type TEXT,
    guild_id TEXT,
    channel_id TEXT,
    user_id TEXT,
    title TEXT,
    payload TEXT
  );
  `);
} catch (e) {
  usingMemory = true;
  // Continue in memory; print one-time hint
  try { console.warn('better-sqlite3 not installed. Falling back to in-memory storage. Run: npm i better-sqlite3'); } catch(_) {}
}

// Helpers
function getTicketCounter() {
  if (usingMemory) return Number(mem.meta.get('ticket_counter') || 1);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('ticket_counter');
  return row ? Number(row.value) : 1;
}

function setTicketCounter(n) {
  if (usingMemory) { mem.meta.set('ticket_counter', String(n)); return; }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('ticket_counter', String(n));
}

function saveTicket({ channelId, userId, createdAt, ticketNumber }) {
  if (usingMemory) { mem.tickets.set(channelId, { channel_id: channelId, user_id: userId, created_at: createdAt, ticket_number: ticketNumber }); return; }
  db.prepare('INSERT OR REPLACE INTO tickets (channel_id, user_id, created_at, ticket_number) VALUES (?, ?, ?, ?)')
    .run(channelId, userId, createdAt, ticketNumber);
}

function deleteTicket(channelId) {
  if (usingMemory) { mem.tickets.delete(channelId); return; }
  db.prepare('DELETE FROM tickets WHERE channel_id = ?').run(channelId);
}

function getTicketByChannel(channelId) {
  if (usingMemory) return mem.tickets.get(channelId) || null;
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId) || null;
}

function saveLog({ ts = Date.now(), type, guildId, channelId, userId, title, payload }) {
  if (usingMemory) { mem.logs.push({ ts, type, guildId, channelId, userId, title, payload }); return; }
  const json = payload ? JSON.stringify(payload) : null;
  db.prepare('INSERT INTO logs (ts, type, guild_id, channel_id, user_id, title, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ts, type || null, guildId || null, channelId || null, userId || null, title || null, json);
}

module.exports = {
  db,
  getTicketCounter,
  setTicketCounter,
  saveTicket,
  deleteTicket,
  getTicketByChannel,
  saveLog
};


