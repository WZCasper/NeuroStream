'use strict';

/**
 * Небольшие CRUD-репозитории поверх таблиц, у которых нет отдельного
 * "умного" сервиса (в отличие, например, от IoTService или MediaLibraryService,
 * которые сочетают работу с БД с внешними побочными эффектами).
 *
 * @param {import('better-sqlite3').Database} db
 */
function createRepos(db) {
  // ---------- TTS presets: один активный пресет на источник (tiktok / axelchat) ----------
  const ttsPresets = {
    ensureDefaults() {
      for (const source of ['tiktok', 'axelchat']) {
        const existing = db.prepare('SELECT id FROM tts_presets WHERE source = ?').get(source);
        if (!existing) {
          db.prepare(
            `INSERT INTO tts_presets (source, enabled, lang, rate, pitch, volume, chat_template, gift_template)
             VALUES (?, 1, 'ru-RU', 1.0, 1.0, 1.0, '{user} говорит: {text}', '{user} отправил подарок {gift} x{count}')`
          ).run(source);
        }
      }
    },
    getForSource(source) {
      return db.prepare('SELECT * FROM tts_presets WHERE source = ? ORDER BY id DESC LIMIT 1').get(source);
    },
    getAll() {
      return db.prepare('SELECT * FROM tts_presets ORDER BY source ASC').all();
    },
    update(source, fields) {
      const current = this.getForSource(source);
      if (!current) return null;
      const merged = { ...current, ...fields };
      db.prepare(
        `UPDATE tts_presets SET enabled=?, voice_uri=?, voice_name=?, lang=?, rate=?, pitch=?, volume=?,
           read_chat=?, read_gifts=?, read_follows=?, read_subscribes=?, min_gift_coins=?,
           chat_template=?, gift_template=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`
      ).run(
        merged.enabled ? 1 : 0,
        merged.voice_uri ?? null,
        merged.voice_name ?? null,
        merged.lang ?? 'ru-RU',
        Number(merged.rate) || 1,
        Number(merged.pitch) || 1,
        Number(merged.volume) ?? 1,
        merged.read_chat ? 1 : 0,
        merged.read_gifts ? 1 : 0,
        merged.read_follows ? 1 : 0,
        merged.read_subscribes ? 1 : 0,
        Number(merged.min_gift_coins) || 0,
        merged.chat_template || '{user} говорит: {text}',
        merged.gift_template || '{user} отправил подарок {gift} x{count}',
        current.id
      );
      return this.getForSource(source);
    },
  };

  // ---------- Правила фильтра ненормативной лексики ----------
  const profanityRules = {
    list() {
      return db.prepare('SELECT * FROM profanity_rules ORDER BY id ASC').all();
    },
    create({ pattern, isRegex, flags, replacement, enabled }) {
      const info = db
        .prepare('INSERT INTO profanity_rules (pattern, is_regex, flags, replacement, enabled) VALUES (?,?,?,?,?)')
        .run(pattern, isRegex ? 1 : 0, flags || 'giu', replacement || '***', enabled === false ? 0 : 1);
      return db.prepare('SELECT * FROM profanity_rules WHERE id = ?').get(info.lastInsertRowid);
    },
    update(id, fields) {
      const current = db.prepare('SELECT * FROM profanity_rules WHERE id = ?').get(id);
      if (!current) return null;
      const merged = { ...current, ...fields };
      db.prepare('UPDATE profanity_rules SET pattern=?, is_regex=?, flags=?, replacement=?, enabled=? WHERE id=?').run(
        merged.pattern,
        merged.isRegex !== undefined ? (merged.isRegex ? 1 : 0) : merged.is_regex,
        merged.flags || 'giu',
        merged.replacement,
        merged.enabled !== undefined ? (merged.enabled ? 1 : 0) : merged.enabled,
        id
      );
      return db.prepare('SELECT * FROM profanity_rules WHERE id = ?').get(id);
    },
    remove(id) {
      db.prepare('DELETE FROM profanity_rules WHERE id = ?').run(id);
    },
  };

  // ---------- Триггеры и их цепочки действий ----------
  const triggers = {
    list() {
      const actionsStmt = db.prepare('SELECT * FROM trigger_actions WHERE trigger_id = ? ORDER BY order_index ASC');
      return db
        .prepare('SELECT * FROM triggers ORDER BY order_index ASC, id ASC')
        .all()
        .map((t) => ({ ...t, actions: actionsStmt.all(t.id) }));
    },
    get(id) {
      const trigger = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
      if (!trigger) return null;
      trigger.actions = db.prepare('SELECT * FROM trigger_actions WHERE trigger_id = ? ORDER BY order_index ASC').all(id);
      return trigger;
    },
    create({ name, enabled, source, eventType, conditions, cooldownMs, actions }) {
      const info = db
        .prepare(
          `INSERT INTO triggers (name, enabled, source, event_type, conditions_json, cooldown_ms)
           VALUES (?,?,?,?,?,?)`
        )
        .run(name, enabled === false ? 0 : 1, source || 'tiktok', eventType, JSON.stringify(conditions || {}), cooldownMs || 0);
      const id = info.lastInsertRowid;
      this._replaceActions(id, actions || []);
      return this.get(id);
    },
    update(id, { name, enabled, source, eventType, conditions, cooldownMs, actions }) {
      const current = db.prepare('SELECT * FROM triggers WHERE id = ?').get(id);
      if (!current) return null;
      db.prepare(
        `UPDATE triggers SET name=?, enabled=?, source=?, event_type=?, conditions_json=?, cooldown_ms=? WHERE id=?`
      ).run(
        name ?? current.name,
        enabled !== undefined ? (enabled ? 1 : 0) : current.enabled,
        source ?? current.source,
        eventType ?? current.event_type,
        conditions !== undefined ? JSON.stringify(conditions) : current.conditions_json,
        cooldownMs !== undefined ? cooldownMs : current.cooldown_ms,
        id
      );
      if (actions !== undefined) this._replaceActions(id, actions);
      return this.get(id);
    },
    remove(id) {
      db.prepare('DELETE FROM triggers WHERE id = ?').run(id); // trigger_actions удалятся каскадно (ON DELETE CASCADE)
    },
    _replaceActions(triggerId, actions) {
      db.prepare('DELETE FROM trigger_actions WHERE trigger_id = ?').run(triggerId);
      const insert = db.prepare(
        'INSERT INTO trigger_actions (trigger_id, order_index, action_type, config_json) VALUES (?,?,?,?)'
      );
      actions.forEach((action, index) => {
        insert.run(triggerId, index, action.actionType || action.action_type, JSON.stringify(action.config || {}));
      });
    },
  };

  // ---------- Виджеты алертов ----------
  const alertWidgets = {
    list() {
      return db.prepare('SELECT * FROM alert_widgets ORDER BY id ASC').all();
    },
    create({ name, mediaId, durationMs, customCss, textTemplate }) {
      const info = db
        .prepare(
          'INSERT INTO alert_widgets (name, media_id, duration_ms, custom_css, text_template) VALUES (?,?,?,?,?)'
        )
        .run(name, mediaId || null, durationMs || 6000, customCss || '', textTemplate || '{user} — {message}');
      return db.prepare('SELECT * FROM alert_widgets WHERE id = ?').get(info.lastInsertRowid);
    },
    update(id, fields) {
      const current = db.prepare('SELECT * FROM alert_widgets WHERE id = ?').get(id);
      if (!current) return null;
      const merged = { ...current, ...fields };
      db.prepare('UPDATE alert_widgets SET name=?, media_id=?, duration_ms=?, custom_css=?, text_template=? WHERE id=?').run(
        merged.name,
        merged.mediaId ?? merged.media_id,
        merged.durationMs ?? merged.duration_ms,
        merged.customCss ?? merged.custom_css,
        merged.textTemplate ?? merged.text_template,
        id
      );
      return db.prepare('SELECT * FROM alert_widgets WHERE id = ?').get(id);
    },
    remove(id) {
      db.prepare('DELETE FROM alert_widgets WHERE id = ?').run(id);
    },
  };

  return { ttsPresets, profanityRules, triggers, alertWidgets };
}

module.exports = { createRepos };
