'use strict';

const TRIGGER_SOURCES = ['tiktok', 'axelchat', 'any'];
const TRIGGER_EVENTS = ['gift', 'chat_keyword', 'follow', 'share', 'subscribe', 'like', 'member'];
const ACTION_TYPES = ['alert', 'sound', 'http', 'tts', 'chat_reply'];
const MAX_ITEMS = 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Проверяет файл резервной копии ДО изменения базы данных — чтобы битая запись в середине
 * файла не оставила программу в наполовину восстановленном состоянии.
 * @returns {string[]} список понятных человеку ошибок; пустой — файл корректен
 */
function validateImportPayload(data) {
  const errors = [];
  if (!isObject(data)) return ['Файл резервной копии должен содержать JSON-объект'];

  for (const key of ['ttsPresets', 'profanityRules', 'iotDevices', 'alertWidgets', 'triggers']) {
    if (data[key] === undefined) continue;
    if (!Array.isArray(data[key])) errors.push(`Раздел «${key}» должен быть списком`);
    else if (data[key].length > MAX_ITEMS) errors.push(`Раздел «${key}» слишком большой (больше ${MAX_ITEMS} записей)`);
  }
  if (data.settings !== undefined && !isObject(data.settings)) errors.push('Раздел «settings» должен быть объектом');

  const list = (key) => (Array.isArray(data[key]) && data[key].length <= MAX_ITEMS ? data[key] : []);

  if (isObject(data.settings)) {
    for (const [key, value] of Object.entries(data.settings)) {
      const t = typeof value;
      if (value !== null && t !== 'string' && t !== 'number' && t !== 'boolean') {
        errors.push(`Настройка «${key}»: недопустимое значение`);
      }
    }
  }

  list('ttsPresets').forEach((p, i) => {
    if (!isObject(p)) errors.push(`Пресет озвучки №${i + 1}: ожидался объект`);
  });

  list('profanityRules').forEach((r, i) => {
    const n = i + 1;
    if (!isObject(r) || !isNonEmptyString(r.pattern)) {
      errors.push(`Правило фильтра №${n}: не указан шаблон`);
      return;
    }
    if (r.is_regex) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(r.pattern, r.flags || 'giu');
      } catch (err) {
        errors.push(`Правило фильтра №${n}: некорректное регулярное выражение (${err.message})`);
      }
    }
  });

  list('iotDevices').forEach((d, i) => {
    const n = i + 1;
    if (!isObject(d) || !isNonEmptyString(d.name)) {
      errors.push(`Устройство №${n}: не указано название`);
      return;
    }
    let urlOk = false;
    try {
      urlOk = ['http:', 'https:'].includes(new URL(String(d.base_url)).protocol);
    } catch {
      /* urlOk остаётся false */
    }
    if (!urlOk) errors.push(`Устройство «${d.name}»: адрес должен начинаться с http:// или https://`);
  });

  list('alertWidgets').forEach((w, i) => {
    if (!isObject(w) || !isNonEmptyString(w.name)) errors.push(`Виджет алерта №${i + 1}: не указано название`);
  });

  list('triggers').forEach((t, i) => {
    const n = i + 1;
    if (!isObject(t) || !isNonEmptyString(t.name)) {
      errors.push(`Триггер №${n}: не указано название`);
      return;
    }
    if (t.source !== undefined && !TRIGGER_SOURCES.includes(t.source)) errors.push(`Триггер «${t.name}»: неизвестный источник «${t.source}»`);
    if (!TRIGGER_EVENTS.includes(t.event_type)) errors.push(`Триггер «${t.name}»: неизвестный тип события «${t.event_type}»`);
    if (t.actions !== undefined && !Array.isArray(t.actions)) {
      errors.push(`Триггер «${t.name}»: действия должны быть списком`);
      return;
    }
    (t.actions || []).forEach((a, j) => {
      if (!isObject(a) || !ACTION_TYPES.includes(a.action_type)) {
        errors.push(`Триггер «${t.name}», действие №${j + 1}: неизвестный тип «${isObject(a) ? a.action_type : a}»`);
      }
    });
  });

  return errors;
}

module.exports = { validateImportPayload };
