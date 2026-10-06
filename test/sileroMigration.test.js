'use strict';

/**
 * Проверяет два сценария, критичных именно для уже установленных у
 * пользователей версий NeuroStream Studio (а не для свежей установки):
 *
 *  1. На БД, созданной СТАРОЙ схемой (без engine/silero_speaker), миграция
 *     добавляет новые колонки без потери уже сохранённых данных пресета
 *     (голос, скорость, шаблоны и т.д.) и без выбрасывания исключения.
 *  2. repos.ttsPresets.update() корректно обрабатывает как новые запросы
 *     с полем engine='silero', так и старые запросы вообще без этого поля
 *     (например, если пользователь не обновил открытую вкладку в браузере
 *     и фронтенд ещё не прислал engine) - не должно быть ни падения,
 *     ни записи мусора в колонку engine.
 *
 * Важно про закрытие БД на Windows: better-sqlite3 в WAL-режиме держит
 * файл под блокировкой ОС, пока фоновый checkpoint не завершится - сразу
 * после db.close() файл ещё может быть недоступен для нового открытия
 * или удаления (EBUSY), в отличие от Linux, где это почти никогда не
 * всплывает. Поэтому в этом файле: (а) НИ ОДИН тест не закрывает БД и не
 * открывает тот же файл заново тем же процессом - миграция в первом тесте
 * выполняется БЕЗ переоткрытия файла, через ту же функцию runMigrations,
 * что использует приложение; (б) удаление временных каталогов идёт через
 * rmSyncWithRetry() с повторными попытками вместо одного fs.rmSync().
 *
 * Запуск: node test/sileroMigration.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { openDatabase, runMigrations } = require('../src/server/db/database');
const { createRepos } = require('../src/server/db/repos');

let passed = 0;
let failed = 0;

console.log('Миграция БД Silero TTS - тесты\n');

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.stack || err.message}`);
  }
}

/**
 * fs.rmSync с повторными попытками - на Windows удаление папки сразу после
 * db.close() иногда падает с EBUSY/EPERM, пока ОС не освободила файловый
 * хендл SQLite WAL-журнала. На Linux первая попытка почти всегда успешна,
 * ретраи здесь безвредны и ничего не замедляют.
 */
function rmSyncWithRetry(dir, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      // Синхронная пауза маленькая и только на Windows реально нужна -
      // не используем здесь async/await, чтобы не усложнять вызывающий код.
      const until = Date.now() + 100 * (i + 1);
      while (Date.now() < until) { /* короткая синхронная задержка */ }
    }
  }
}

// Схема ДО этой задачи (точная копия того, что было в schema.sql на коммите
// 37737b0, т.е. последнем опубликованном релизе v1.0.16) - намеренно
// захардкожена здесь, а не прочитана из текущего schema.sql: тест должен
// проверять миграцию СУЩЕСТВУЮЩИХ баз именно со старой структурой, вне
// зависимости от того, что станет с schema.sql дальше.
const OLD_SCHEMA = `
CREATE TABLE tts_presets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source           TEXT NOT NULL CHECK (source IN ('tiktok', 'axelchat')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  voice_uri        TEXT,
  voice_name       TEXT,
  lang             TEXT DEFAULT 'ru-RU',
  rate             REAL NOT NULL DEFAULT 1.0,
  pitch            REAL NOT NULL DEFAULT 1.0,
  volume           REAL NOT NULL DEFAULT 1.0,
  read_chat        INTEGER NOT NULL DEFAULT 1,
  read_gifts       INTEGER NOT NULL DEFAULT 1,
  read_follows     INTEGER NOT NULL DEFAULT 0,
  read_subscribes  INTEGER NOT NULL DEFAULT 1,
  min_gift_coins   INTEGER NOT NULL DEFAULT 0,
  chat_template    TEXT DEFAULT '{user} говорит: {text}',
  gift_template    TEXT DEFAULT '{user} отправил подарок {gift} x{count}',
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

test('миграция на старой БД добавляет engine/silero_speaker без потери данных', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  const dbPath = path.join(dir, 'neurostream-studio.db');
  // ВАЖНО: открываем файл ОДИН раз за весь тест - не закрываем и не
  // переоткрываем тем же процессом (см. докстринг файла про Windows EBUSY).
  const db = new Database(dbPath);
  try {
    db.exec(OLD_SCHEMA);

    // Пользователь уже настроил голос ДО обновления - имитируем это.
    db.prepare(
      `INSERT INTO tts_presets (source, enabled, voice_uri, voice_name, rate, pitch, volume, chat_template)
       VALUES ('tiktok', 1, 'Microsoft Irina Desktop', 'Irina (ru-RU)', 1.3, 0.9, 0.8, 'Пользовательский шаблон {user}')`
    ).run();

    // Реальный openDatabase() сначала накатывает ПОЛНЫЙ schema.sql (который
    // создаёт отсутствующие таблицы через CREATE TABLE IF NOT EXISTS, включая
    // alert_widgets - её нет в нарочно урезанной OLD_SCHEMA выше) и только
    // потом runMigrations() - повторяем эту же последовательность, иначе
    // runMigrations() упадёт на ALTER TABLE alert_widgets, которой ещё нет.
    const schemaPath = path.join(__dirname, '..', 'src', 'server', 'db', 'schema.sql');
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
    runMigrations(db);

    const row = db.prepare("SELECT * FROM tts_presets WHERE source = 'tiktok'").get();

    assert.strictEqual(row.voice_uri, 'Microsoft Irina Desktop', 'старый голос должен сохраниться');
    assert.strictEqual(row.chat_template, 'Пользовательский шаблон {user}', 'старый шаблон должен сохраниться');
    assert.strictEqual(Number(row.rate), 1.3, 'старая скорость должна сохраниться');

    assert.strictEqual(row.engine, 'system', 'новая колонка engine должна получить дефолт system');
    assert.strictEqual(row.silero_speaker, 'baya', 'новая колонка silero_speaker должна получить дефолт baya');
  } finally {
    db.close();
    rmSyncWithRetry(dir);
  }
});

test('repos.ttsPresets.update() принимает engine=silero и валидный speaker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  const db = openDatabase(dir);
  try {
    const repos = createRepos(db);
    repos.ttsPresets.ensureDefaults();

    const updated = repos.ttsPresets.update('tiktok', {
      engine: 'silero',
      silero_speaker: 'xenia',
      enabled: true,
      rate: 1,
      pitch: 1,
      volume: 1,
    });

    assert.strictEqual(updated.engine, 'silero');
    assert.strictEqual(updated.silero_speaker, 'xenia');
  } finally {
    db.close();
    rmSyncWithRetry(dir);
  }
});

test('repos.ttsPresets.update() откатывает некорректный engine на system, не падает', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  const db = openDatabase(dir);
  try {
    const repos = createRepos(db);
    repos.ttsPresets.ensureDefaults();

    const updated = repos.ttsPresets.update('tiktok', {
      engine: 'что-то-левое-и-некорректное',
      silero_speaker: 'тоже-мусор',
      enabled: true,
      rate: 1,
      pitch: 1,
      volume: 1,
    });

    assert.strictEqual(updated.engine, 'system', 'некорректный engine должен откатиться на system');
    assert.strictEqual(updated.silero_speaker, 'baya', 'некорректный speaker должен откатиться на baya');
  } finally {
    db.close();
    rmSyncWithRetry(dir);
  }
});

test('repos.ttsPresets.update() без поля engine в запросе не ломается (старый фронтенд)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  const db = openDatabase(dir);
  try {
    const repos = createRepos(db);
    repos.ttsPresets.ensureDefaults();

    // Имитация запроса от СТАРОГО фронтенда - поля engine вообще нет в теле.
    const updated = repos.ttsPresets.update('tiktok', {
      voice_uri: 'Microsoft Pavel',
      enabled: true,
      rate: 1,
      pitch: 1,
      volume: 1,
    });

    assert.strictEqual(updated.engine, 'system', 'при отсутствии engine должен сохраниться дефолт system');
    assert.strictEqual(updated.voice_uri, 'Microsoft Pavel');
  } finally {
    db.close();
    rmSyncWithRetry(dir);
  }
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало из ${passed + failed}`);
if (failed > 0) {
  process.exit(1);
}
