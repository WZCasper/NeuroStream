'use strict';

const { EventEmitter } = require('node:events');
const {
  TikTokLiveConnection,
  WebcastEvent,
  ControlEvent,
  AlreadyConnectedError,
  AlreadyConnectingError,
  UserOfflineError,
  ConnectTimeoutError,
  SignatureRateLimitError,
  SignatureMissingTokensError,
  PremiumFeatureError,
  InvalidUniqueIdError,
  AuthenticatedWebSocketConnectionError,
  SignAPIError,
} = require('tiktok-live-connector');

const MIN_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;
const SEEN_IDS_LIMIT = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Нормализация событий TikTok.
//
// Библиотека tiktok-live-connector v2 отдаёт события в «сыром» виде protobuf v3:
//   чат:    data.content, data.user.{idStr,displayId,nickname,avatarLarge}, data.common.{msgId,createTime}
//   подарок: data.gift.{name,diamondCount,type}, data.repeatCount, data.repeatEnd, data.groupId
//   лайк:   data.count (в этом сообщении), data.total (всего в трансляции)
//   зрители: data.total (онлайн; поле №3 — то же, что раньше называлось viewerCount)
// Документированные в README «плоские» названия (comment, viewerCount, likeCount, giftDetails…)
// тоже принимаются как запасные, чтобы обновление библиотеки не ломало приложение молча.
// ─────────────────────────────────────────────────────────────────────────────

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** Первое непустое текстовое значение. */
function firstText(...values) {
  for (const v of values) {
    const t = text(v);
    if (t) return t;
  }
  return '';
}

/** Первый непустой идентификатор (пустая строка и «0» — это «нет значения» в protobuf). */
function firstId(...values) {
  for (const v of values) {
    const t = text(v);
    if (t && t !== '0') return t;
  }
  return '';
}

/** Первое конечное число из списка (0 — допустимое значение). */
function firstNumber(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function firstImageUrl(...images) {
  for (const img of images) {
    const url = img && Array.isArray(img.urlList) ? img.urlList[0] : null;
    if (url) return String(url);
  }
  return null;
}

function messageId(data) {
  return firstId(data && data.common && data.common.msgId, data && data.msgId);
}

/** Время события в мс: TikTok присылает либо мс, либо секунды. */
function eventTime(data) {
  const raw = firstNumber(data && data.common && data.common.createTime, data && data.createTime);
  if (raw > 1e12) return raw;
  if (raw > 1e9) return raw * 1000;
  return Date.now();
}

function pickAuthor(data) {
  const u = (data && data.user) || {};
  const uniqueId = firstText(u.displayId, u.uniqueId, data && data.uniqueId);
  const nickname = firstText(u.nickname, data && data.nickname);
  return {
    id: firstId(u.idStr, u.id, u.userId, data && data.userId) || uniqueId || 'unknown',
    name: nickname || uniqueId || 'Зритель',
    uniqueId: uniqueId || null,
    avatar: firstImageUrl(u.avatarLarge, u.avatarMedium, u.avatarThumb) || (data && data.profilePictureUrl) || null,
  };
}

function makeId(prefix, data) {
  return `${prefix}-${messageId(data) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}`;
}

function baseEvent(type, data, id) {
  return {
    id,
    source: 'tiktok',
    type,
    platform: 'tiktok',
    author: pickAuthor(data),
    timestamp: eventTime(data),
    raw: data,
  };
}

/** Чат. Возвращает событие для шины или null, если сообщение пустое. */
function normalizeChat(data) {
  const body = firstText(data.content, data.comment);
  return { ...baseEvent('chat', data, messageId(data) || makeId('tt-chat', data)), text: body };
}

/**
 * Подарок. Для «серийных» подарков (type === 1) TikTok шлёт промежуточные события с
 * растущим repeatCount и одно финальное с repeatEnd — публикуем только финальное,
 * иначе один подарок озвучится и покажется много раз подряд.
 * @returns {object|null} null — если это промежуточное событие серии
 */
function normalizeGift(data) {
  const g = data.gift || data.giftDetails || {};
  const giftType = firstNumber(g.type, g.giftType, data.giftType);
  const repeatEnd = Boolean(Number(data.repeatEnd));
  if (giftType === 1 && !repeatEnd) return null;

  const diamondCount = firstNumber(g.diamondCount, data.diamondCount);
  const repeatCount = Math.max(1, firstNumber(data.repeatCount, 1));
  return {
    ...baseEvent('gift', data, `tt-gift-${messageId(data) || Date.now()}-${text(data.groupId)}`),
    giftName: firstText(g.name, g.giftName, data.giftName, g.describe) || 'подарок',
    giftId: firstId(data.giftId, g.id) || null,
    diamondCount, // стоимость одной единицы подарка
    repeatCount,
    totalDiamonds: diamondCount * repeatCount, // итоговая стоимость с учётом серии
    repeatEnd,
  };
}

function normalizeLike(data) {
  return {
    ...baseEvent('like', data, makeId('tt-like', data)),
    likeCount: firstNumber(data.count, data.likeCount),
    totalLikeCount: firstNumber(data.total, data.totalLikeCount),
  };
}

function normalizeSimple(type, data) {
  return baseEvent(type, data, makeId(`tt-${type}`, data));
}

function normalizeSubscribe(data) {
  return { ...normalizeSimple('subscribe', data), subMonth: firstNumber(data.subMonth) };
}

/** Онлайн зрителей из сообщения roomUser; null — если числа в сообщении нет. */
function normalizeViewerCount(data) {
  const n = firstNumber(data.viewerCount, data.total);
  return Number.isFinite(n) && n >= 0 && (data.viewerCount !== undefined || data.total !== undefined) ? n : null;
}

// MemberMessageAction в схеме TikTok: 1 — вход в трансляцию, 3 — подписка (её отдельно даёт SUB_NOTIFY).
const MEMBER_ACTION_SUBSCRIBED = 3;

/**
 * TikTokConnectorService — управляет подключением к TikTok LIVE конкретного
 * стримера (@uniqueId), автоматически переподключается при обрыве и
 * публикует нормализованные события в общую шину событий (eventBus).
 *
 * Публикуемые статусы (событие 'status'): 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'stopped'
 */
class TikTokConnectorService extends EventEmitter {
  /**
   * @param {import('./eventBus').EventBus} eventBus
   * @param {import('../lib/logger').Logger} logger
   * @param {{ createConnection?: (uniqueId: string, options: object) => any, minReconnectDelayMs?: number }} [deps]
   *        createConnection — фабрика соединений; по умолчанию настоящий TikTokLiveConnection.
   *        Нужна, чтобы жизненный цикл можно было проверять автотестами без сети.
   */
  constructor(eventBus, logger, deps = {}) {
    super();
    this.eventBus = eventBus;
    this.logger = logger;
    this._minReconnectDelayMs = deps.minReconnectDelayMs || MIN_RECONNECT_DELAY_MS;
    this._createConnection = deps.createConnection || ((id, opts) => new TikTokLiveConnection(id, opts));

    /** @type {any|null} */
    this.connection = null;
    this.uniqueId = null;
    this.signApiKey = null;
    this.sessionId = null;
    this.ttTargetIdc = null;
    this.status = 'idle';
    this.roomId = null;
    this.viewerCount = 0;
    this._stopped = true;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    // «Эпоха» растёт при каждом start/stop/reconnectNow. Долгая операция подключения, начатая в
    // прошлой эпохе, после завершения видит несовпадение и сама закрывает своё соединение —
    // поэтому повторное нажатие кнопок больше не оставляет второе живое соединение.
    this._epoch = 0;
    this._seenIds = new Set(); // id уже обработанных сообщений (защита от повторов при переподключении)
    this.lastErrorMessage = null; // человекочитаемая причина последнего статуса — показывается в UI
    this.connectedSince = null; // время последнего успешного подключения — для отображения "давно ли на связи"
    this.reconnectCountThisSession = 0; // сколько раз переподключались с момента запуска программы — индикатор качества связи
  }

  getState() {
    return {
      status: this.status,
      message: this.lastErrorMessage,
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      viewerCount: this.viewerCount,
      chatReplyAvailable: this.hasAuthenticatedSession(),
      connectedSince: this.connectedSince,
      reconnectCount: this.reconnectCountThisSession,
    };
  }

  /** Принудительное переподключение по кнопке в интерфейсе — не дожидаясь автоматического таймера. */
  async reconnectNow() {
    if (!this.uniqueId) throw new Error('Сначала укажите @uniqueId и подключитесь хотя бы раз');
    this._stopped = false;
    this._resetTimers();
    this._reconnectAttempt = 0;
    await this._connectOnce();
  }

  /** Новая эпоха: отменяет отложенное переподключение и делает недействительными все текущие операции. */
  _resetTimers() {
    this._epoch += 1;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Гасит соединение: снимает наши обработчики ДО закрытия (библиотека после disconnect()
   * эмитит 'disconnected', и без этого мы бы сами запустили лишнее переподключение),
   * затем закрывает сокет. Ошибки закрытия не критичны и не должны становиться
   * необработанными отказами промиса.
   */
  async _dropConnection(connection) {
    if (!connection) return;
    connection.removeAllListeners();
    connection.on(ControlEvent.ERROR, () => {}); // EventEmitter бросает исключение на 'error' без слушателей
    try {
      await connection.disconnect();
    } catch {
      /* уже закрыто — это не ошибка */
    }
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    if (extra.message !== undefined) this.lastErrorMessage = extra.message;
    if (status === 'connected') this.lastErrorMessage = null;
    this.emit('status', { ...this.getState(), ...extra });
  }

  /**
   * Запускает подключение к TikTok LIVE указанного пользователя.
   * Повторный вызов безопасен: предыдущее соединение закрывается, живым остаётся ровно одно.
   * @param {string} uniqueId  @username стримера (с "@" или без)
   * @param {{ signApiKey?: string, sessionId?: string, ttTargetIdc?: string }} [options]
   */
  async start(uniqueId, options = {}) {
    this._stopped = false;
    this.uniqueId = uniqueId.replace(/^@/, '').trim();
    this.signApiKey = options.signApiKey || null;
    this.sessionId = options.sessionId || null;
    this.ttTargetIdc = options.ttTargetIdc || null;
    this._resetTimers();
    this._reconnectAttempt = 0;
    this.reconnectCountThisSession = 0;
    await this._connectOnce();
  }

  /** Есть ли сохранённая авторизованная сессия — от неё зависит доступность отправки сообщений в чат. */
  hasAuthenticatedSession() {
    return Boolean(this.sessionId && this.ttTargetIdc);
  }

  /**
   * Отправляет текстовое сообщение в чат текущей трансляции от имени авторизованного аккаунта.
   * Требует, чтобы при подключении были указаны sessionId и ttTargetIdc (сессионные cookie
   * из браузера, где выполнен вход в тот же TikTok-аккаунт, которым будет отправляться сообщение).
   * @param {string} text
   */
  async sendMessage(text) {
    if (!this.connection || this.status !== 'connected') {
      throw new Error('Нет активного подключения к TikTok LIVE');
    }
    if (!this.hasAuthenticatedSession()) {
      throw new Error(
        'Не указаны сессионные cookie TikTok (sessionId и ttTargetIdc) — без них отправка сообщений в чат недоступна, только чтение'
      );
    }
    try {
      const result = await this.connection.sendMessage(text);
      this.logger.info('tiktok', `Отправлено сообщение в чат: «${text}»`);
      return result;
    } catch (err) {
      this.logger.error('tiktok', `Не удалось отправить сообщение в чат: ${err.message}`);
      throw err;
    }
  }

  /**
   * Быстрая проверка «идёт ли сейчас трансляция», без установки полного соединения —
   * один HTTP-запрос вместо полного WebSocket-хэндшейка. Полезно для мгновенной диагностики
   * перед подключением: если аккаунт не в эфире, connect() всё равно завершится ошибкой
   * UserOfflineError, но эта проверка даёт ответ быстрее и не трогает основное соединение.
   * @param {string} uniqueId
   * @returns {Promise<boolean>}
   */
  async checkIsLive(uniqueId) {
    const cleanId = uniqueId.replace(/^@/, '').trim();
    const probe = this._createConnection(cleanId, {
      fetchRoomInfoOnConnect: false,
      processInitialData: false,
    });
    return probe.fetchIsLive();
  }

  /** Останавливает подключение и отменяет запланированные переподключения. */
  async stop() {
    this._stopped = true;
    this._resetTimers();
    const connection = this.connection;
    this.connection = null;
    this.connectedSince = null;
    this._setStatus('stopped', { message: null });
    await this._dropConnection(connection);
  }

  async _connectOnce() {
    if (!this.uniqueId || this._stopped) return;
    const epoch = this._epoch;

    this._setStatus(this._reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    // Сначала гасим предыдущее соединение (если есть) — только потом создаём новое.
    const previous = this.connection;
    this.connection = null;
    await this._dropConnection(previous);
    if (epoch !== this._epoch) return; // пока закрывали, пользователь нажал «Остановить» или «Переподключить»

    const connectionOptions = {
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: true,
      // Стартовый пакет — это уже прошедшие сообщения комнаты. На каждом переподключении они
      // приходили бы заново как «новые» и озвучивались/запускали триггеры повторно.
      processInitialData: false,
    };
    if (this.signApiKey) {
      connectionOptions.signApiKey = this.signApiKey;
    }
    if (this.hasAuthenticatedSession()) {
      // Cookie нужны для отправки сообщений (sendMessage) через обычные HTTP-запросы.
      // authenticateWs сюда намеренно НЕ передаём: чтение чата остаётся в обычном
      // публичном режиме и не зависит от валидности сессии — если cookie устареют,
      // сломается только отправка сообщений, а не всё подключение целиком.
      connectionOptions.session = {
        cookie: {
          type: 'cookie',
          value: {
            sessionId: this.sessionId,
            ttTargetIdc: this.ttTargetIdc,
          },
        },
      };
    }

    const connection = this._createConnection(this.uniqueId, connectionOptions);
    this.connection = connection;
    this._attachEventHandlers(connection);

    try {
      const state = await connection.connect();
      if (epoch !== this._epoch || this.connection !== connection) {
        // Пока шло подключение, его отменили (стоп/повторный запуск) — закрываем это соединение.
        await this._dropConnection(connection);
        return;
      }
      this.roomId = (state && state.roomId) || null;
      this._reconnectAttempt = 0;
      this.connectedSince = new Date().toISOString();
      this._setStatus('connected');
      this.logger.info('tiktok', `Подключено к трансляции @${this.uniqueId}`, {
        roomId: this.roomId,
        chatReplyAvailable: this.hasAuthenticatedSession(),
      });
    } catch (err) {
      if (epoch !== this._epoch || this.connection !== connection) {
        await this._dropConnection(connection);
        return;
      }
      this._handleConnectError(err);
    }
  }

  _handleConnectError(err) {
    const original = err && err.message ? err.message : String(err);
    let message = original;
    let category = 'error';

    if (err instanceof UserOfflineError) {
      message = `Стример @${this.uniqueId} сейчас не в эфире`;
      category = 'warn';
    } else if (err instanceof InvalidUniqueIdError) {
      message = `Некорректный @uniqueId: «${this.uniqueId}» — проверьте написание`;
    } else if (err instanceof SignatureRateLimitError) {
      message = `Превышен лимит запросов к серверу подписи (Euler Stream). Укажите signApiKey в настройках. [${original}]`;
    } else if (err instanceof SignatureMissingTokensError) {
      message = `Сервер подписи вернул неполные данные (SignatureMissingTokensError) — обычно означает, что TikTok/Euler Stream временно поменяли формат ответа, либо использованный signApiKey недействителен. [${original}]`;
    } else if (err instanceof PremiumFeatureError) {
      message = `Эта операция требует платного тарифа Euler Stream (PremiumFeatureError) — проверьте тариф вашего signApiKey на eulerstream.com. [${original}]`;
    } else if (err instanceof ConnectTimeoutError) {
      message = `Время ожидания подключения истекло — возможна блокировка сети/антивирусом или недоступность серверов TikTok. [${original}]`;
    } else if (err instanceof AuthenticatedWebSocketConnectionError) {
      message = `Ошибка авторизованного WebSocket-соединения (проверьте сессионные cookie). [${original}]`;
    } else if (err instanceof SignAPIError) {
      message = `Ошибка сервера подписи TikTok (Sign API): ${original}`;
    } else if (err instanceof AlreadyConnectedError || err instanceof AlreadyConnectingError) {
      // Безопасно игнорируем — соединение уже в процессе установки.
      return;
    }

    this.logger[category === 'warn' ? 'warn' : 'error']('tiktok', message, {
      uniqueId: this.uniqueId,
      errorClass: err && err.constructor ? err.constructor.name : typeof err,
    });
    this._setStatus('error', { message });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectAttempt += 1;
    this.reconnectCountThisSession += 1;
    this.connectedSince = null;
    const delay = Math.min(
      this._minReconnectDelayMs * 2 ** (this._reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS
    );
    this.logger.info('tiktok', `Повторное подключение через ${Math.round(delay / 1000)} с (попытка ${this._reconnectAttempt})`);
    const epoch = this._epoch;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._stopped || epoch !== this._epoch) return;
      this._connectOnce().catch((err) => {
        this.logger.error('tiktok', 'Сбой при повторном подключении', { message: err && err.message });
      });
    }, delay);
  }

  /** true, если такое сообщение уже обрабатывалось (по id из TikTok). */
  _isDuplicate(id) {
    if (this._seenIds.has(id)) return true;
    this._seenIds.add(id);
    if (this._seenIds.size > SEEN_IDS_LIMIT) {
      this._seenIds.delete(this._seenIds.values().next().value); // Set хранит порядок вставки — удаляем самый старый
    }
    return false;
  }

  /**
   * Публикует событие в шину. Если TikTok прислал настоящий id сообщения (msgId), повторная
   * доставка того же сообщения (например, после переподключения) отбрасывается.
   * Сообщения без id не дедуплицируются — иначе можно потерять разные события.
   */
  _publish(event, data) {
    const msgId = messageId(data);
    if (msgId && this._isDuplicate(`${event.type}:${msgId}:${text(data.groupId)}`)) return;
    this.eventBus.publish(event);
  }

  _attachEventHandlers(connection) {
    // Каждый обработчик: (1) игнорирует события устаревшего соединения, (2) не даёт исключению
    // в подписчиках шины (озвучка, триггеры) оборвать обработку сообщений самой библиотеки.
    const on = (eventName, handler) => {
      connection.on(eventName, (data) => {
        if (connection !== this.connection) return;
        try {
          handler(data || {});
        } catch (err) {
          this.logger.error('tiktok', `Ошибка обработки события «${eventName}»`, { message: err && err.message });
        }
      });
    };

    on(ControlEvent.DISCONNECTED, () => {
      if (this._stopped) return;
      this.logger.warn('tiktok', 'Соединение с TikTok LIVE разорвано');
      this._setStatus('reconnecting');
      this._scheduleReconnect();
    });

    on(ControlEvent.ERROR, (err) => {
      this.logger.error('tiktok', 'Ошибка соединения TikTok LIVE', {
        message: err && err.message ? err.message : String(err),
      });
    });

    on(WebcastEvent.STREAM_END, (actionId) => {
      const reason = actionId === 4 ? 'стрим завершён модератором платформы' : 'стрим завершён стримером';
      this.logger.info('tiktok', `Трансляция окончена (${reason})`);
    });

    on(WebcastEvent.ROOM_USER, (data) => {
      const count = normalizeViewerCount(data);
      if (count !== null) {
        this.viewerCount = count;
        this.emit('status', { ...this.getState() });
      }
    });

    on(WebcastEvent.CHAT, (data) => this._publish(normalizeChat(data), data));

    on(WebcastEvent.GIFT, (data) => {
      const event = normalizeGift(data);
      if (event) this._publish(event, data);
    });

    on(WebcastEvent.LIKE, (data) => this._publish(normalizeLike(data), data));
    on(WebcastEvent.FOLLOW, (data) => this._publish(normalizeSimple('follow', data), data));
    on(WebcastEvent.SHARE, (data) => this._publish(normalizeSimple('share', data), data));
    on(WebcastEvent.SUB_NOTIFY, (data) => this._publish(normalizeSubscribe(data), data));

    on(WebcastEvent.MEMBER, (data) => {
      if (Number(data.action) === MEMBER_ACTION_SUBSCRIBED) return; // подписку публикует SUB_NOTIFY
      this._publish(normalizeSimple('member', data), data);
    });
  }
}

module.exports = {
  TikTokConnectorService,
  // Экспортируются для автотестов на настоящих protobuf-сообщениях.
  normalizers: { pickAuthor, normalizeChat, normalizeGift, normalizeLike, normalizeSimple, normalizeSubscribe, normalizeViewerCount },
};
