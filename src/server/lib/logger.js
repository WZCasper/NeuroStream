'use strict';

const { EventEmitter } = require('node:events');

/**
 * Логгер приложения. Каждая запись:
 *  1) сохраняется в таблицу logs (видна во вкладке "Logs & Settings" после перезапуска),
 *  2) выводится в консоль (полезно при разработке / npm run dev),
 *  3) рассылается подписчикам в реальном времени (Socket.io в index.js слушает событие 'entry').
 *
 * Ничего не подделывается: если источник ошибки не указан, поле meta будет
 * пустым объектом, а не выдуманными данными.
 */
class Logger extends EventEmitter {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    super();
    this.db = db;
    this._insertStmt = db.prepare(
      'INSERT INTO logs (level, category, message, meta_json) VALUES (?, ?, ?, ?)'
    );
  }

  _write(level, category, message, meta) {
    const metaJson = meta ? JSON.stringify(meta) : null;
    let id = null;
    try {
      const info = this._insertStmt.run(level, category, message, metaJson);
      id = info.lastInsertRowid;
    } catch (err) {
      // Если запись в БД не удалась, не роняем приложение — выводим в консоль как есть.
      // eslint-disable-next-line no-console
      console.error('[logger] failed to persist log entry:', err.message);
    }

    const entry = {
      id,
      level,
      category,
      message,
      meta: meta || null,
      createdAt: new Date().toISOString(),
    };

    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleFn(`[${category}] ${message}`, meta || '');

    this.emit('entry', entry);
    return entry;
  }

  info(category, message, meta) {
    return this._write('info', category, message, meta);
  }

  warn(category, message, meta) {
    return this._write('warn', category, message, meta);
  }

  error(category, message, meta) {
    return this._write('error', category, message, meta);
  }

  /**
   * Возвращает последние N записей журнала (для первичной загрузки вкладки Logs).
   */
  recent(limit = 200, category = null) {
    if (category) {
      return this.db
        .prepare('SELECT * FROM logs WHERE category = ? ORDER BY id DESC LIMIT ?')
        .all(category, limit)
        .reverse();
    }
    return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit).reverse();
  }

  clear() {
    this.db.prepare('DELETE FROM logs').run();
  }
}

module.exports = { Logger };
