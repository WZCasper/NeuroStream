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
  AuthenticatedWebSocketConnectionError,
  SignAPIError,
} = require('tiktok-live-connector');

const MIN_RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 60000;

function pickAuthor(data) {
  return {
    id: String(data.userId || data.uniqueId || 'unknown'),
    name: data.nickname || data.uniqueId || 'Зритель',
    uniqueId: data.uniqueId || null,
    avatar: data.profilePictureUrl || null,
  };
}

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
   */
  constructor(eventBus, logger) {
    super();
    this.eventBus = eventBus;
    this.logger = logger;

    /** @type {InstanceType<typeof TikTokLiveConnection>|null} */
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
    this.lastErrorMessage = null; // человекочитаемая причина последнего статуса — показывается в UI
  }

  getState() {
    return {
      status: this.status,
      message: this.lastErrorMessage,
      uniqueId: this.uniqueId,
      roomId: this.roomId,
      viewerCount: this.viewerCount,
      chatReplyAvailable: this.hasAuthenticatedSession(),
    };
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    if (extra.message !== undefined) this.lastErrorMessage = extra.message;
    if (status === 'connected') this.lastErrorMessage = null;
    this.emit('status', { ...this.getState(), ...extra });
  }

  /**
   * Запускает подключение к TikTok LIVE указанного пользователя.
   * @param {string} uniqueId  @username стримера (с "@" или без)
   * @param {{ signApiKey?: string, sessionId?: string, ttTargetIdc?: string }} [options]
   */
  async start(uniqueId, options = {}) {
    this._stopped = false;
    this.uniqueId = uniqueId.replace(/^@/, '').trim();
    this.signApiKey = options.signApiKey || null;
    this.sessionId = options.sessionId || null;
    this.ttTargetIdc = options.ttTargetIdc || null;
    this._reconnectAttempt = 0;
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
    const probe = new TikTokLiveConnection(cleanId, {
      fetchRoomInfoOnConnect: false,
      processInitialData: false,
    });
    return probe.fetchIsLive();
  }

  /** Останавливает подключение и отменяет запланированные переподключения. */
  async stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch {
        // соединение уже могло быть закрыто — это не ошибка
      }
    }
    this._setStatus('stopped', { message: null });
  }

  async _connectOnce() {
    if (!this.uniqueId) return;

    this._setStatus(this._reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    const connectionOptions = {
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: true,
      processInitialData: true,
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

    this.connection = new TikTokLiveConnection(this.uniqueId, connectionOptions);
    this._attachEventHandlers(this.connection);

    try {
      const state = await this.connection.connect();
      this.roomId = state.roomId || null;
      this._reconnectAttempt = 0;
      this._setStatus('connected');
      this.logger.info('tiktok', `Подключено к трансляции @${this.uniqueId}`, {
        roomId: this.roomId,
        chatReplyAvailable: this.hasAuthenticatedSession(),
      });
    } catch (err) {
      this._handleConnectError(err);
    }
  }

  _handleConnectError(err) {
    let message = err && err.message ? err.message : String(err);
    let category = 'error';

    if (err instanceof UserOfflineError) {
      message = `Стример @${this.uniqueId} сейчас не в эфире`;
      category = 'warn';
    } else if (err instanceof SignatureRateLimitError) {
      message = 'Превышен лимит запросов к серверу подписи (Euler Stream). Рекомендуется указать signApiKey в настройках.';
    } else if (err instanceof ConnectTimeoutError) {
      message = 'Время ожидания подключения истекло';
    } else if (err instanceof AuthenticatedWebSocketConnectionError) {
      message = 'Ошибка авторизованного WebSocket-соединения';
    } else if (err instanceof SignAPIError) {
      message = 'Ошибка сервера подписи TikTok (Sign API)';
    } else if (err instanceof AlreadyConnectedError || err instanceof AlreadyConnectingError) {
      // Безопасно игнорируем — соединение уже в процессе установки.
      return;
    }

    this.logger[category === 'warn' ? 'warn' : 'error']('tiktok', message, {
      uniqueId: this.uniqueId,
    });
    this._setStatus('error', { message });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this._reconnectAttempt += 1;
    const delay = Math.min(
      MIN_RECONNECT_DELAY_MS * 2 ** (this._reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS
    );
    this.logger.info('tiktok', `Повторное подключение через ${Math.round(delay / 1000)} с (попытка ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(() => {
      if (!this._stopped) this._connectOnce();
    }, delay);
  }

  _attachEventHandlers(connection) {
    connection.on(ControlEvent.DISCONNECTED, () => {
      if (this._stopped) return;
      this.logger.warn('tiktok', 'Соединение с TikTok LIVE разорвано');
      this._setStatus('reconnecting');
      this._scheduleReconnect();
    });

    connection.on(ControlEvent.ERROR, (err) => {
      this.logger.error('tiktok', 'Ошибка соединения TikTok LIVE', {
        message: err && err.message ? err.message : String(err),
      });
    });

    connection.on(WebcastEvent.STREAM_END, (actionId) => {
      const reason = actionId === 4 ? 'стрим завершён модератором платформы' : 'стрим завершён стримером';
      this.logger.info('tiktok', `Трансляция окончена (${reason})`);
    });

    connection.on(WebcastEvent.ROOM_USER, (data) => {
      if (typeof data.viewerCount === 'number') {
        this.viewerCount = data.viewerCount;
        this.emit('status', { ...this.getState() });
      }
    });

    connection.on(WebcastEvent.CHAT, (data) => {
      this.eventBus.publish({
        id: data.msgId || `tt-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        source: 'tiktok',
        type: 'chat',
        platform: 'tiktok',
        author: pickAuthor(data),
        text: data.comment || '',
        timestamp: Number(data.createTime) || Date.now(),
        raw: data,
      });
    });

    connection.on(WebcastEvent.GIFT, (data) => {
      // Для повторяющихся подарков (streak) публикуем только финальное событие,
      // чтобы не переозвучивать один и тот же подарок много раз подряд.
      if (data.giftType === 1 && !data.repeatEnd) return;

      this.eventBus.publish({
        id: `tt-gift-${data.msgId || Date.now()}-${data.groupId || ''}`,
        source: 'tiktok',
        type: 'gift',
        platform: 'tiktok',
        author: pickAuthor(data),
        giftName: data.giftName || 'подарок',
        giftId: data.giftId,
        diamondCount: data.diamondCount || 0,
        repeatCount: data.repeatCount || 1,
        repeatEnd: !!data.repeatEnd,
        timestamp: Number(data.createTime) || Date.now(),
        raw: data,
      });
    });

    connection.on(WebcastEvent.LIKE, (data) => {
      this.eventBus.publish({
        id: `tt-like-${data.msgId || Date.now()}`,
        source: 'tiktok',
        type: 'like',
        platform: 'tiktok',
        author: pickAuthor(data),
        likeCount: data.likeCount || 0,
        timestamp: Date.now(),
        raw: data,
      });
    });

    connection.on(WebcastEvent.FOLLOW, (data) => {
      this.eventBus.publish({
        id: `tt-follow-${data.msgId || Date.now()}`,
        source: 'tiktok',
        type: 'follow',
        platform: 'tiktok',
        author: pickAuthor(data),
        timestamp: Date.now(),
        raw: data,
      });
    });

    connection.on(WebcastEvent.SHARE, (data) => {
      this.eventBus.publish({
        id: `tt-share-${data.msgId || Date.now()}`,
        source: 'tiktok',
        type: 'share',
        platform: 'tiktok',
        author: pickAuthor(data),
        timestamp: Date.now(),
        raw: data,
      });
    });

    connection.on(WebcastEvent.SUB_NOTIFY, (data) => {
      this.eventBus.publish({
        id: `tt-sub-${data.msgId || Date.now()}`,
        source: 'tiktok',
        type: 'subscribe',
        platform: 'tiktok',
        author: pickAuthor(data),
        timestamp: Date.now(),
        raw: data,
      });
    });

    connection.on(WebcastEvent.MEMBER, (data) => {
      this.eventBus.publish({
        id: `tt-member-${data.msgId || Date.now()}`,
        source: 'tiktok',
        type: 'member',
        platform: 'tiktok',
        author: pickAuthor(data),
        timestamp: Date.now(),
        raw: data,
      });
    });
  }
}

module.exports = { TikTokConnectorService };
