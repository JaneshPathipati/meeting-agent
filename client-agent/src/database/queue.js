// file: client-agent/src/database/queue.js
const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const log = require('electron-log');

let db = null;

function getDb() {
  if (!db) {
    const dbPath = path.join(app.getPath('userData'), 'upload-queue.sqlite');
    db = new Database(dbPath);

    // Create queue table if not exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS upload_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
        attempts INTEGER DEFAULT 0,
        next_retry_at TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    log.info('[Queue] SQLite database initialized', { path: dbPath });
  }
  return db;
}

function enqueue(meetingData) {
  const database = getDb();
  const stmt = database.prepare(
    `INSERT INTO upload_queue (payload, next_retry_at) VALUES (?, datetime('now'))`
  );
  const result = stmt.run(JSON.stringify(meetingData));
  log.info('[Queue] Item enqueued', { id: result.lastInsertRowid });
  return result.lastInsertRowid;
}

function getRetryableItems() {
  const database = getDb();
  const stmt = database.prepare(
    `SELECT * FROM upload_queue
     WHERE status = 'pending'
     AND datetime(next_retry_at) <= datetime('now')
     ORDER BY created_at ASC
     LIMIT 10`
  );
  return stmt.all();
}

function markCompleted(id) {
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE upload_queue SET status = 'completed', updated_at = datetime('now') WHERE id = ?`
  );
  stmt.run(id);
}

function markFailed(id, errorMessage) {
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE upload_queue
     SET status = 'failed', error_message = ?, updated_at = datetime('now')
     WHERE id = ?`
  );
  stmt.run(errorMessage, id);
}

function incrementAttempts(id, nextRetryAt) {
  const database = getDb();
  const stmt = database.prepare(
    `UPDATE upload_queue
     SET attempts = attempts + 1, next_retry_at = ?, updated_at = datetime('now')
     WHERE id = ?`
  );
  stmt.run(nextRetryAt, id);
}

function dequeueAll() {
  const database = getDb();
  const stmt = database.prepare(
    `SELECT * FROM upload_queue WHERE status = 'pending' ORDER BY created_at ASC`
  );
  return stmt.all();
}

function cleanup() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { enqueue, dequeueAll, getRetryableItems, markCompleted, markFailed, incrementAttempts, cleanup };
