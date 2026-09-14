'use strict';

const { EventEmitter } = require('node:events');

/**
 * TriggerEngine — слушает нормализованные события из eventBus, сопоставляет
 * их с включёнными триггерами пользователя (таблицы triggers/trigger_actions)
 * и выполняет цепочку действий по порядку (order_index) для каждого совпавшего триггера.
 *
 * Типы событий триггера (event_type): 'gift' | 'chat_keyword' | 'follow' | 'share' | 'subscribe' | 'like'
 * Типы действий (action_type):        'alert' | 'sound' | 'http' | 'tts' | 'chat_reply'
 *
 * Внешние побочные эффекты (алерт в OBS, IoT-запрос, озвучка, ответ в чат) не выполняются
 * напрямую в обход соответствующих сервисов — движок делегирует их
 * TTSQueueManager, IoTService и TikTokConnectorService (для ответа в чат), а для alert/sound
 * публикует событие 'action', на которое подписывается index.js и пересылает команду
 * в OBS Browser Source через Socket.io.
 *
 * @fires TriggerEngine#action { type: 'alert'|'sound', triggerId, config }
 * @fires TriggerEngine#matched { triggerId, triggerName, event }
 */
class TriggerEngine extends EventEmitter {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {import('./eventBus').EventBus} eventBus
   * @param {import('./ttsQueue').TTSQueueManager} ttsQueue
   * @param {import('./profanityFilter').ProfanityFilterService} profanityFilter
   * @param {import('./iotService').IoTService} iotService
   * @param {import('../lib/logger').Logger} logger
   * @param {() => object} getTtsPresetForSource  Функция, возвращающая активный пресет озвучки для source
   * @param {import('./tiktokConnector').TikTokConnectorService} tiktokConnector  Нужен для действия "Ответ в чат"
   */
  constructor(db, eventBus, ttsQueue, profanityFilter, iotService, logger, getTtsPresetForSource, tiktokConnector) {
    super();
    this.db = db;
    this.eventBus = eventBus;
    this.ttsQueue = ttsQueue;
    this.profanityFilter = profanityFilter;
    this.iotService = iotService;
    this.logger = logger;
    this.getTtsPresetForSource = getTtsPresetForSource;
    this.tiktokConnector = tiktokConnector;

    this.triggers = [];
    this.reload();

    this._onEvent = (event) => this._handleEvent(event);
    this.eventBus.on('event', this._onEvent);
  }

  destroy() {
    this.eventBus.off('event', this._onEvent);
  }

  /**
   * Запускает цепочку действий триггера "как есть", без проверки условий и cooldown —
   * для кнопки «Тест» в интерфейсе, чтобы можно было посмотреть, как сработает триггер,
   * не дожидаясь реального события на трансляции (и не обязательно даже подключаясь к ней).
   * @param {number} triggerId
   */
  async testTrigger(triggerId) {
    const trigger = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(triggerId);
    if (!trigger) throw new Error(`Триггер #${triggerId} не найден`);
    trigger.actions = this.db
      .prepare('SELECT * FROM trigger_actions WHERE trigger_id = ? ORDER BY order_index ASC')
      .all(triggerId)
      .map((a) => ({ ...a, config: safeParseJSON(a.config_json, {}) }));

    const testEvent = buildSyntheticEvent(trigger);
    this.logger.info('trigger', `Тестовый запуск триггера "${trigger.name}"`);
    await this._runActions(trigger, testEvent);
  }

  /** Перечитывает триггеры и их действия из базы данных (вызывать после любого изменения через API). */
  reload() {
    const triggerRows = this.db.prepare('SELECT * FROM triggers WHERE enabled = 1 ORDER BY order_index ASC, id ASC').all();
    const actionsStmt = this.db.prepare('SELECT * FROM trigger_actions WHERE trigger_id = ? ORDER BY order_index ASC');

    this.triggers = triggerRows.map((t) => ({
      ...t,
      conditions: safeParseJSON(t.conditions_json, {}),
      actions: actionsStmt.all(t.id).map((a) => ({ ...a, config: safeParseJSON(a.config_json, {}) })),
    }));

    return this.triggers.length;
  }

  async _handleEvent(event) {
    for (const trigger of this.triggers) {
      if (!this._sourceMatches(trigger, event)) continue;
      if (!this._eventTypeMatches(trigger, event)) continue;
      if (!this._conditionsMatch(trigger, event)) continue;
      if (this._isOnCooldown(trigger)) continue;

      this._markTriggered(trigger);
      this.emit('matched', { triggerId: trigger.id, triggerName: trigger.name, event });
      this.logger.info('trigger', `Сработал триггер "${trigger.name}"`, {
        eventType: event.type,
        source: event.source,
        author: event.author?.name,
      });

      // eslint-disable-next-line no-await-in-loop
      await this._runActions(trigger, event);
    }
  }

  _sourceMatches(trigger, event) {
    return trigger.source === 'any' || trigger.source === event.source;
  }

  _eventTypeMatches(trigger, event) {
    if (trigger.event_type === 'chat_keyword') return event.type === 'chat';
    return trigger.event_type === event.type;
  }

  _conditionsMatch(trigger, event) {
    const c = trigger.conditions || {};

    switch (trigger.event_type) {
      case 'gift': {
        if (c.giftId !== undefined && Number(event.giftId) !== Number(c.giftId)) return false;
        if (c.giftName && String(event.giftName || '').toLowerCase() !== String(c.giftName).toLowerCase()) return false;
        if (c.minCoins && (event.diamondCount || 0) < Number(c.minCoins)) return false;
        return true;
      }
      case 'chat_keyword': {
        if (!c.keyword) return false;
        const haystack = c.caseSensitive ? event.text || '' : (event.text || '').toLowerCase();
        const needle = c.caseSensitive ? c.keyword : String(c.keyword).toLowerCase();
        const mode = c.matchMode || 'contains';
        if (mode === 'exact') return haystack.trim() === needle.trim();
        if (mode === 'startsWith') return haystack.startsWith(needle);
        return haystack.includes(needle);
      }
      case 'like': {
        if (c.minLikeCount && (event.likeCount || 0) < Number(c.minLikeCount)) return false;
        return true;
      }
      default:
        return true; // follow / share / subscribe / member — обычно без доп. условий
    }
  }

  _isOnCooldown(trigger) {
    if (!trigger.cooldown_ms || !trigger.last_triggered_at) return false;
    const last = Date.parse(trigger.last_triggered_at);
    if (Number.isNaN(last)) return false;
    return Date.now() - last < trigger.cooldown_ms;
  }

  _markTriggered(trigger) {
    trigger.last_triggered_at = new Date().toISOString();
    this.db.prepare('UPDATE triggers SET last_triggered_at = ? WHERE id = ?').run(trigger.last_triggered_at, trigger.id);
  }

  async _runActions(trigger, event) {
    for (const action of trigger.actions) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._runAction(trigger, action, event);
      } catch (err) {
        this.logger.error('trigger', `Ошибка выполнения действия "${action.action_type}" триггера "${trigger.name}": ${err.message}`);
      }
    }
  }

  async _runAction(trigger, action, event) {
    switch (action.action_type) {
      case 'alert':
        this.emit('action', { type: 'alert', triggerId: trigger.id, config: action.config, event });
        break;

      case 'sound':
        this.emit('action', { type: 'sound', triggerId: trigger.id, config: action.config, event });
        break;

      case 'http': {
        const cfg = action.config || {};
        if (cfg.deviceId) {
          await this.iotService.sendRequest(cfg.deviceId, {
            method: cfg.method || 'GET',
            path: cfg.path || '/',
            body: cfg.body,
            headers: cfg.headers,
          });
        } else if (cfg.url) {
          // Прямой URL без привязки к сохранённому устройству
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 6000);
          try {
            await fetch(cfg.url, {
              method: cfg.method || 'GET',
              headers: cfg.headers,
              body: cfg.body ? (typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body)) : undefined,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeout);
          }
        }
        break;
      }

      case 'tts': {
        const preset = this.getTtsPresetForSource(event.source);
        if (!preset || !preset.enabled) break;
        const template = action.config?.template || (event.type === 'gift' ? preset.gift_template : preset.chat_template);
        const rendered = renderTemplate(template, event);
        const filtered = this.profanityFilter.apply(rendered);
        this.ttsQueue.enqueue(event.source, filtered, {
          voiceURI: preset.voice_uri,
          lang: preset.lang,
          rate: preset.rate,
          pitch: preset.pitch,
          volume: preset.volume,
        });
        break;
      }

      case 'chat_reply': {
        // Отправка текстового ответа обратно в чат трансляции (не озвучка, а именно
        // текстовое сообщение от лица подключённого аккаунта). Сейчас реализовано
        // только для TikTok — у него есть подтверждённый рабочий метод отправки
        // сообщений (sendMessage), но он требует авторизованной сессии (см. настройки
        // на вкладке Главная). Для платформ, подключённых через AxelChat, отправка
        // сообщений пока не поддерживается — у AxelChat нет для этого документированного API.
        const cfg = action.config || {};
        const template = cfg.text || '{user}, спасибо!';
        const rendered = this.profanityFilter.apply(renderTemplate(template, event));

        if (event.source !== 'tiktok') {
          this.logger.warn(
            'trigger',
            `Действие "Ответ в чат" пропущено: источник "${event.source}" пока не поддерживает отправку сообщений (только TikTok с авторизованной сессией)`
          );
          break;
        }
        try {
          await this.tiktokConnector.sendMessage(rendered);
        } catch (err) {
          this.logger.error('trigger', `Не удалось отправить ответ в чат TikTok: ${err.message}`);
        }
        break;
      }

      default:
        this.logger.warn('trigger', `Неизвестный тип действия: ${action.action_type}`);
    }
  }
}

function renderTemplate(template, event) {
  const vars = {
    user: event.author?.name || 'Зритель',
    text: event.text || '',
    gift: event.giftName || '',
    count: event.repeatCount || 1,
    coins: event.diamondCount || 0,
  };
  return String(template || '{user}: {text}').replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

/**
 * Строит правдоподобное тестовое событие для кнопки «Тест» триггера — чтобы шаблоны
 * ({user}, {gift}, {text}…) отрендерились осмысленно, даже когда реального события ещё не было.
 */
function buildSyntheticEvent(trigger) {
  const source = trigger.source === 'any' ? 'tiktok' : trigger.source;
  const base = {
    id: `test-${Date.now()}`,
    source,
    platform: source,
    author: { id: 'test', name: 'Тестовый Зритель' },
    timestamp: Date.now(),
    raw: { test: true },
  };
  switch (trigger.event_type) {
    case 'gift':
      return { ...base, type: 'gift', giftName: 'Rose', giftId: 5655, diamondCount: 100, repeatCount: 1, repeatEnd: true };
    case 'chat_keyword':
      return { ...base, type: 'chat', text: 'Это тестовое сообщение для проверки триггера' };
    case 'like':
      return { ...base, type: 'like', likeCount: 50 };
    default:
      return { ...base, type: trigger.event_type };
  }
}

function safeParseJSON(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

module.exports = { TriggerEngine };
