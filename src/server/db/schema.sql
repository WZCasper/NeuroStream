-- NeuroStream Studio — схема локальной базы данных (SQLite)
-- Все таблицы создаются при первом запуске, если их ещё нет.

PRAGMA foreign_keys = ON;

-- Произвольные настройки приложения в формате "ключ -> значение".
-- Используется для: @uniqueId стримера, ключа Euler Stream (signApiKey),
-- адреса AxelChat, выбранной темы оформления и т.д.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Независимые пресеты озвучки (TTS) для каждого источника чата.
-- source: 'tiktok' или 'axelchat' — у каждого источника свой набор голосов/параметров.
CREATE TABLE IF NOT EXISTS tts_presets (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source           TEXT NOT NULL CHECK (source IN ('tiktok', 'axelchat')),
  enabled          INTEGER NOT NULL DEFAULT 1,
  voice_uri        TEXT,               -- URI голоса из window.speechSynthesis.getVoices()
  voice_name       TEXT,               -- отображаемое имя голоса
  lang             TEXT DEFAULT 'ru-RU',
  rate             REAL NOT NULL DEFAULT 1.0,  -- скорость 0.5 - 2.0
  pitch            REAL NOT NULL DEFAULT 1.0,  -- высота тона 0 - 2.0
  volume           REAL NOT NULL DEFAULT 1.0,  -- громкость 0 - 1.0
  read_chat        INTEGER NOT NULL DEFAULT 1,
  read_gifts       INTEGER NOT NULL DEFAULT 1,
  read_follows     INTEGER NOT NULL DEFAULT 0,
  read_subscribes  INTEGER NOT NULL DEFAULT 1,
  min_gift_coins   INTEGER NOT NULL DEFAULT 0, -- озвучивать подарки дороже N монет
  chat_template    TEXT DEFAULT '{user} говорит: {text}',
  gift_template    TEXT DEFAULT '{user} отправил подарок {gift} x{count}',
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Правила фильтра ненормативной лексики / регулярных выражений.
CREATE TABLE IF NOT EXISTS profanity_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern      TEXT NOT NULL,
  is_regex     INTEGER NOT NULL DEFAULT 0,
  flags        TEXT NOT NULL DEFAULT 'giu',
  replacement  TEXT NOT NULL DEFAULT '***',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Триггеры: "Событие -> набор условий".
CREATE TABLE IF NOT EXISTS triggers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  source             TEXT NOT NULL DEFAULT 'tiktok', -- 'tiktok' | 'axelchat' | 'any'
  event_type         TEXT NOT NULL,                  -- 'gift' | 'chat_keyword' | 'follow' | 'share' | 'subscribe' | 'like'
  conditions_json    TEXT NOT NULL DEFAULT '{}',      -- напр. {"giftId":5655} или {"keyword":"привет","matchMode":"contains"}
  cooldown_ms        INTEGER NOT NULL DEFAULT 0,      -- минимальная пауза между срабатываниями
  last_triggered_at  TEXT,
  order_index        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Действия, выполняемые при срабатывании триггера (может быть несколько, по порядку).
CREATE TABLE IF NOT EXISTS trigger_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id    INTEGER NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  order_index   INTEGER NOT NULL DEFAULT 0,
  action_type   TEXT NOT NULL,             -- 'alert' | 'sound' | 'http' | 'tts'
  config_json   TEXT NOT NULL DEFAULT '{}' -- параметры действия (см. triggerEngine.js)
);

-- IoT-устройства (например ESP32), управляемые по HTTP.
CREATE TABLE IF NOT EXISTS iot_devices (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT NOT NULL,
  base_url                  TEXT NOT NULL,             -- напр. http://192.168.1.50
  health_ping_path          TEXT DEFAULT '/ping',
  health_ping_interval_ms   INTEGER NOT NULL DEFAULT 15000,
  health_ping_enabled       INTEGER NOT NULL DEFAULT 1,
  last_status               TEXT DEFAULT 'unknown',    -- 'online' | 'offline' | 'unknown'
  last_checked_at           TEXT,
  last_latency_ms           INTEGER,
  created_at                TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Загруженные пользователем медиафайлы (.webm, .gif, .mp3, .wav и т.д.)
CREATE TABLE IF NOT EXISTS media_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  filename       TEXT NOT NULL UNIQUE, -- имя файла на диске (в media/)
  original_name  TEXT NOT NULL,
  mime_type      TEXT,
  kind           TEXT,                 -- 'video' | 'audio' | 'image'
  size_bytes     INTEGER,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Виджеты алертов для OBS Browser Source.
CREATE TABLE IF NOT EXISTS alert_widgets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  media_id      INTEGER REFERENCES media_files(id) ON DELETE SET NULL,
  duration_ms   INTEGER NOT NULL DEFAULT 6000,
  custom_css    TEXT DEFAULT '',
  text_template TEXT DEFAULT '{user} — {message}',
  created_at    TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Журнал событий приложения (алерты, ошибки подключения, срабатывания триггеров и т.д.)
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  level       TEXT NOT NULL DEFAULT 'info', -- 'info' | 'warn' | 'error'
  category    TEXT NOT NULL,                -- 'tiktok' | 'axelchat' | 'trigger' | 'tts' | 'iot' | 'system'
  message     TEXT NOT NULL,
  meta_json   TEXT,
  created_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trigger_actions_trigger_id ON trigger_actions (trigger_id);
