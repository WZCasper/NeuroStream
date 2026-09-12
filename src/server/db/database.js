'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

/**
 * Открывает (или создаёт) файл базы данных SQLite по указанному пути,
 * применяет схему (schema.sql) и включает WAL-режим для надёжности
 * при параллельной записи логов и настроек.
 *
 * @param {string} userDataDir Папка, в которой хранится файл базы данных
 *                              (в Electron — app.getPath('userData')).
 * @returns {import('better-sqlite3').Database}
 */
function openDatabase(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const dbPath = path.join(userDataDir, 'neurostream-studio.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  return db;
}

/**
 * Небольшой репозиторий поверх таблицы settings (ключ -> значение).
 * Значения всегда хранятся как строки; сложные значения сериализуются в JSON
 * вызывающей стороной при необходимости.
 */
function createSettingsRepo(db) {
  const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setStmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const allStmt = db.prepare('SELECT key, value FROM settings');
  const delStmt = db.prepare('DELETE FROM settings WHERE key = ?');

  return {
    get(key, fallback = null) {
      const row = getStmt.get(key);
      return row ? row.value : fallback;
    },
    set(key, value) {
      setStmt.run(key, value === null || value === undefined ? null : String(value));
    },
    getJSON(key, fallback = null) {
      const raw = this.get(key, null);
      if (raw === null) return fallback;
      try {
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    setJSON(key, value) {
      this.set(key, JSON.stringify(value));
    },
    all() {
      const rows = allStmt.all();
      const out = {};
      for (const row of rows) out[row.key] = row.value;
      return out;
    },
    delete(key) {
      delStmt.run(key);
    },
  };
}

module.exports = { openDatabase, createSettingsRepo };
