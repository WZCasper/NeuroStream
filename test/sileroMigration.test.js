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
 *     и фронтенд ещё не прислал engine) — не должно быть ни падения,
 *     ни записи мусора в колонку engine.
 *
 * Запуск: node test/sileroMigration.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

let passed = 0;
let failed = 0;

console.log('Миграция БД Silero TTS — тесты\n');

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

// Схема ДО этой задачи (точная копия того, что было в schema.sql на коммите
// 37737b0, т.е. последнем опубликованном релизе v1.0.16) — намеренно
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

// ВАЖНО: openDatabase(userDataDir) в src/server/db/database.js всегда создаёт
// файл с ФИКСИРОВАННЫМ именем 'neurostream-studio.db' внутри переданной
// директории — файл со старой схемой должен называться так же, иначе
// openDatabase() откроет другой, новый, пустой файл рядом, и тест будет
// молча проверять не то, что должен.
function makeTempDbWithOldSchema() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  const dbPath = path.join(dir, 'neurostream-studio.db');
  const db = new Database(dbPath);
  db.exec(OLD_SCHEMA);
  return { db, dir };
}

test('миграция на старой БД добавляет engine/silero_speaker без потери данных', () => {
  const { db, dir } = makeTempDbWithOldSchema();
  try {
    // Пользователь уже настроил голос ДО обновления — имитируем это.
    db.prepare(
      `INSERT INTO tts_presets (source, enabled, voice_uri, voice_name, rate, pitch, volume, chat_template)
       VALUES ('tiktok', 1, 'Microsoft Irina Desktop', 'Irina (ru-RU)', 1.3, 0.9, 0.8, 'Пользовательский шаблон {user}')`
    ).run();

    // Подключаем ровно ту же функцию миграции, что использует приложение.
    delete require.cache[require.resolve('../src/server/db/database.js')];
    const { openDatabase } = require('../src/server/db/database');
    db.close();

    // openDatabase сама откроет файл по тому же пути и применит schema.sql
    // (CREATE TABLE IF NOT EXISTS — не тронет существующую таблицу) + миграции.
    const migratedDb = openDatabase(dir);

    const row = migratedDb.prepare("SELECT * FROM tts_presets WHERE source = 'tiktok'").get();

    assert.strictEqual(row.voice_uri, 'Microsoft Irina Desktop', 'старый голос должен сохраниться');
    assert.strictEqual(row.chat_template, 'Пользовательский шаблон {user}', 'старый шаблон должен сохраниться');
    assert.strictEqual(Number(row.rate), 1.3, 'старая скорость должна сохраниться');

    assert.strictEqual(row.engine, 'system', 'новая колонка engine должна получить дефолт system');
    assert.strictEqual(row.silero_speaker, 'baya', 'новая колонка silero_speaker должна получить дефолт baya');

    migratedDb.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repos.ttsPresets.update() принимает engine=silero и валидный speaker', () => {
  delete require.cache[require.resolve('../src/server/db/database.js')];
  delete require.cache[require.resolve('../src/server/db/repos.js')];
  const { openDatabase } = require('../src/server/db/database');
  const { createRepos } = require('../src/server/db/repos');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  try {
    const db = openDatabase(dir);
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

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repos.ttsPresets.update() откатывает некорректный engine на system, не падает', () => {
  delete require.cache[require.resolve('../src/server/db/database.js')];
  delete require.cache[require.resolve('../src/server/db/repos.js')];
  const { openDatabase } = require('../src/server/db/database');
  const { createRepos } = require('../src/server/db/repos');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  try {
    const db = openDatabase(dir);
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

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('repos.ttsPresets.update() без поля engine в запросе не ломается (старый фронтенд)', () => {
  delete require.cache[require.resolve('../src/server/db/database.js')];
  delete require.cache[require.resolve('../src/server/db/repos.js')];
  const { openDatabase } = require('../src/server/db/database');
  const { createRepos } = require('../src/server/db/repos');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-migration-test-'));
  try {
    const db = openDatabase(dir);
    const repos = createRepos(db);
    repos.ttsPresets.ensureDefaults();

    // Имитация запроса от СТАРОГО фронтенда — поля engine вообще нет в теле.
    const updated = repos.ttsPresets.update('tiktok', {
      voice_uri: 'Microsoft Pavel',
      enabled: true,
      rate: 1,
      pitch: 1,
      volume: 1,
    });

    assert.strictEqual(updated.engine, 'system', 'при отсутствии engine должен сохраниться дефолт system');
    assert.strictEqual(updated.voice_uri, 'Microsoft Pavel');

    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало из ${passed + failed}`);
if (failed > 0) {
  process.exit(1);
}
