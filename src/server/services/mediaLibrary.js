'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KIND_BY_EXT = {
  '.webm': 'video',
  '.mp4': 'video',
  '.gif': 'image',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.mp3': 'audio',
  '.wav': 'audio',
  '.ogg': 'audio',
};

function kindForExt(ext) {
  return KIND_BY_EXT[ext.toLowerCase()] || 'other';
}

/**
 * MediaLibraryService — хранит загруженные файлы для алертов
 * (видео/gif/изображения и звуки) на диске в папке userData/media
 * и ведёт их учёт в таблице media_files. Сам приём файлов (multipart/form-data)
 * выполняется через multer в routes/api.js; сюда попадают уже сохранённые файлы.
 */
class MediaLibraryService {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {string} mediaDir Абсолютный путь к папке хранения файлов
   */
  constructor(db, mediaDir) {
    this.db = db;
    this.mediaDir = mediaDir;
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  list() {
    return this.db.prepare('SELECT * FROM media_files ORDER BY created_at DESC').all();
  }

  get(id) {
    return this.db.prepare('SELECT * FROM media_files WHERE id = ?').get(id);
  }

  /**
   * Регистрирует уже сохранённый на диск файл (после multer) в базе данных.
   */
  register({ filename, originalName, mimeType, sizeBytes }) {
    const ext = path.extname(filename);
    const info = this.db
      .prepare(
        `INSERT INTO media_files (filename, original_name, mime_type, kind, size_bytes)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(filename, originalName, mimeType || null, kindForExt(ext), sizeBytes || null);
    return this.get(info.lastInsertRowid);
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return false;
    const filePath = path.join(this.mediaDir, item.filename);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // файл уже мог быть удалён вручную — не считаем это критичной ошибкой
    }
    this.db.prepare('DELETE FROM media_files WHERE id = ?').run(id);
    return true;
  }

  absolutePath(filename) {
    return path.join(this.mediaDir, filename);
  }
}

module.exports = { MediaLibraryService, kindForExt };
