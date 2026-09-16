'use strict';

const ENC_PREFIX = 'enc1:';

/**
 * Оборачивает обычный settingsRepo (ключ->значение поверх SQLite) так, чтобы указанный
 * список "чувствительных" ключей автоматически шифровался на диске через Electron
 * safeStorage (на Windows — DPAPI, привязано к учётной записи пользователя ОС) и
 * прозрачно расшифровывался при чтении. Остальные ключи проходят как есть, без изменений.
 *
 * Дизайн специально принимает `safeStorage` параметром (а не делает `require('electron')`
 * внутри), чтобы модуль можно было протестировать в обычном Node.js с поддельным
 * safeStorage — сам объект `electron.safeStorage` доступен только внутри настоящего
 * процесса Electron.
 *
 * @param {ReturnType<import('../db/database').createSettingsRepo>} rawSettings
 * @param {{ isEncryptionAvailable: () => boolean, encryptString: (s: string) => Buffer, decryptString: (b: Buffer) => string }} safeStorage
 * @param {string[]} sensitiveKeys
 * @param {{ warn?: (msg: string) => void }} [logger]
 */
function createSecureSettingsRepo(rawSettings, safeStorage, sensitiveKeys, logger = {}) {
  const sensitive = new Set(sensitiveKeys);

  function encryptValue(value) {
    if (value === null || value === undefined || value === '') return value;
    if (!safeStorage || !safeStorage.isEncryptionAvailable || !safeStorage.isEncryptionAvailable()) {
      // На системе недоступно шифрование ОС (крайне маловероятно на Windows) — сохраняем как
      // есть, чтобы функциональность не сломалась, но явно предупреждаем в журнале.
      logger.warn?.('Шифрование настроек недоступно на этой системе (safeStorage) — конфиденциальные значения сохраняются без шифрования');
      return value;
    }
    const encrypted = safeStorage.encryptString(String(value));
    return ENC_PREFIX + Buffer.from(encrypted).toString('base64');
  }

  function decryptValue(stored) {
    if (stored === null || stored === undefined) return stored;
    if (!stored.startsWith(ENC_PREFIX)) return stored; // старое значение до внедрения шифрования, ещё не переписано
    if (!safeStorage || !safeStorage.isEncryptionAvailable || !safeStorage.isEncryptionAvailable()) return null;
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
      return safeStorage.decryptString(buf);
    } catch {
      return null; // повреждённое или созданное на другой машине/учётной записи значение
    }
  }

  return {
    ...rawSettings,
    get(key, fallback = null) {
      const raw = rawSettings.get(key, null);
      if (raw === null) return fallback;
      if (!sensitive.has(key)) return raw;
      const decrypted = decryptValue(raw);
      return decrypted === null ? fallback : decrypted;
    },
    set(key, value) {
      if (!sensitive.has(key)) return rawSettings.set(key, value);
      rawSettings.set(key, encryptValue(value));
    },
    all() {
      const everything = rawSettings.all();
      for (const key of Object.keys(everything)) {
        if (sensitive.has(key)) {
          const decrypted = decryptValue(everything[key]);
          everything[key] = decrypted === null ? '' : decrypted;
        }
      }
      return everything;
    },
    /**
     * Разово переписывает уже существующие чувствительные значения, сохранённые ДО внедрения
     * шифрования (простым текстом), в зашифрованном виде — вызывается один раз при старте.
     */
    migrateLegacyPlaintext() {
      let migrated = 0;
      for (const key of sensitive) {
        const raw = rawSettings.get(key, null);
        if (raw && !raw.startsWith(ENC_PREFIX)) {
          rawSettings.set(key, encryptValue(raw));
          migrated++;
        }
      }
      return migrated;
    },
  };
}

module.exports = { createSecureSettingsRepo, ENC_PREFIX };
