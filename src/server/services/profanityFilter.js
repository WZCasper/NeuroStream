'use strict';

/**
 * ProfanityFilterService — применяет настраиваемые правила замены текста
 * (простая подстрока или регулярное выражение) перед отправкой текста в TTS.
 * Правила читаются из таблицы profanity_rules при каждом изменении через API
 * (см. routes/api.js), чтобы не перечитывать базу на каждое сообщение чата.
 */
class ProfanityFilterService {
  /** @param {import('better-sqlite3').Database} db */
  constructor(db) {
    this.db = db;
    this.rules = [];
    this.reload();
  }

  reload() {
    const rows = this.db
      .prepare('SELECT * FROM profanity_rules WHERE enabled = 1 ORDER BY id ASC')
      .all();

    this.rules = rows
      .map((row) => {
        try {
          if (row.is_regex) {
            return { type: 'regex', re: new RegExp(row.pattern, row.flags || 'giu'), replacement: row.replacement };
          }
          // Простая подстрока — экранируем спецсимволы regex и ищем без учёта регистра, глобально.
          const escaped = row.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return { type: 'literal', re: new RegExp(escaped, 'giu'), replacement: row.replacement };
        } catch {
          // Некорректное регулярное выражение от пользователя — пропускаем правило, не роняя приложение.
          return null;
        }
      })
      .filter(Boolean);

    return this.rules.length;
  }

  /**
   * Применяет все активные правила к тексту и возвращает очищенную строку.
   * @param {string} text
   * @returns {string}
   */
  apply(text) {
    if (!text) return text;
    let result = text;
    for (const rule of this.rules) {
      result = result.replace(rule.re, rule.replacement);
    }
    return result;
  }
}

module.exports = { ProfanityFilterService };
