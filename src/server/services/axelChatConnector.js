'use strict';

const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8356;
const MIN_RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30000;
const ALIVE_TIMEOUT_MS = 20000; // AxelChat присылает SERVER_ALIVE регулярно; если долго тишина — считаем связь потерянной

/**
 * Извлекает читаемый текст из массива "contents" сообщения AxelChat.
 * Формат contents описан в docs.md AxelChat: элементы вида
 * { type: 'text' | 'image' | 'hyperlink' | 'html', data: {...} }.
 * Мы озвучиваем только текстовые и гиперссылочные фрагменты, собирая их в одну строку.
 */
function extractText(contents) {
  if (!Array.isArray(contents)) return '';
  return contents
    .map((part) => {
      if (!part || !part.data) return '';
      if (part.type === 'text') return part.data.text || '';
      if (part.type === 'hyperlink') return part.data.text || part.data.url || '';
      return ''; // изображения/произвольный html не озвучиваем
    })
    .join('')
    .trim();
}

/**
 * AxelChatConnectorService — подключается к локальному WebSocket-серверу AxelChat
 * (см. https://github.com/3dproger/AxelChat/blob/main/docs.md) и публикует
 * агрегированные сообщения с Twitch/YouTube/VK и других поддерживаемых
 * AxelChat платформ в общую шину событий.
 *
 * AxelChat должен быть запущен на том же компьютере (или в локальной сети)
 * с включённым разделом Settings -> Developers -> WebSocket server.
 */
class AxelChatConnectorService extends EventEmitter {
  /**
   * @param {import('./eventBus').EventBus} eventBus
   * @param {import('../lib/logger').Logger} logger
   */
  constructor(eventBus, logger) {
    super();
    this.eventBus = eventBus;
    this.logger = logger;

    this.host = DEFAULT_HOST;
    this.port = DEFAULT_PORT;
    this.status = 'idle';
    this.ws = null;
    this._stopped = true;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._aliveTimer = null;
    this._seenMessageIds = new Set(); // защита от повторной публикации отредактированных сообщений
  }

  getState() {
    return { status: this.status, host: this.host, port: this.port };
  }

  _setStatus(status, extra = {}) {
    this.status = status;
    this.emit('status', { ...this.getState(), ...extra });
  }

  /**
   * @param {{ host?: string, port?: number }} [options]
   */
  start(options = {}) {
    this._stopped = false;
    this.host = options.host || DEFAULT_HOST;
    this.port = options.port || DEFAULT_PORT;
    this._reconnectAttempt = 0;
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._aliveTimer) clearInterval(this._aliveTimer);
    this._reconnectTimer = null;
    this._aliveTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // сокет уже мог быть закрыт
      }
    }
    this._setStatus('stopped');
  }

  _connect() {
    if (this._stopped) return;
    this._setStatus(this._reconnectAttempt > 0 ? 'reconnecting' : 'connecting');

    const url = `ws://${this.host}:${this.port}`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this._handleFailure(err);
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      this._reconnectAttempt = 0;
      this._setStatus('connected');
      this.logger.info('axelchat', `Подключено к AxelChat (${url})`);
      this._resetAliveWatchdog();
    });

    socket.on('message', (raw) => {
      this._resetAliveWatchdog();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // не JSON — игнорируем
      }
      this._handleMessage(msg);
    });

    socket.on('close', () => {
      if (this._stopped) return;
      this.logger.warn('axelchat', 'Соединение с AxelChat разорвано');
      this._setStatus('reconnecting');
      this._scheduleReconnect();
    });

    socket.on('error', (err) => {
      // 'error' обычно сопровождается 'close' — здесь только логируем причину.
      this.logger.warn('axelchat', `AxelChat недоступен: ${err.message}`);
    });
  }

  _handleFailure(err) {
    this.logger.warn('axelchat', `Не удалось подключиться к AxelChat: ${err.message}`);
    this._setStatus('error', { message: err.message });
    this._scheduleReconnect();
  }

  _resetAliveWatchdog() {
    if (this._aliveTimer) clearInterval(this._aliveTimer);
    this._aliveTimer = setInterval(() => {
      this.logger.warn('axelchat', 'AxelChat не отвечает (нет SERVER_ALIVE) — переподключение');
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch {
          /* игнорируем */
        }
      }
    }, ALIVE_TIMEOUT_MS);
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    this._reconnectAttempt += 1;
    const delay = Math.min(
      MIN_RECONNECT_DELAY_MS * 2 ** (this._reconnectAttempt - 1),
      MAX_RECONNECT_DELAY_MS
    );
    this._reconnectTimer = setTimeout(() => {
      if (!this._stopped) this._connect();
    }, delay);
  }

  /**
   * Обрабатывает входящее сообщение протокола AxelChat.
   * Типы описаны в docs.md: HELLO, SERVER_ALIVE, STATES_CHANGED,
   * NEW_MESSAGES_RECEIVED, MESSAGES_CHANGED, CLEAR_MESSAGES.
   */
  _handleMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'HELLO': {
        const appInfo = msg.data && msg.data.app;
        this.logger.info('axelchat', 'Получено приветствие от AxelChat', {
          version: appInfo ? appInfo.version : undefined,
        });
        break;
      }
      case 'SERVER_ALIVE':
        // просто подтверждает, что соединение живо — watchdog уже сброшен выше
        break;
      case 'STATES_CHANGED':
        this.emit('platformStates', msg.data);
        break;
      case 'NEW_MESSAGES_RECEIVED':
      case 'MESSAGES_CHANGED':
        this._publishMessages(msg.data && msg.data.messages);
        break;
      case 'CLEAR_MESSAGES':
        this._seenMessageIds.clear();
        this.emit('cleared');
        break;
      default:
        // Новые типы сообщений в будущих версиях AxelChat — молча игнорируем.
        break;
    }
  }

  _publishMessages(messages) {
    if (!Array.isArray(messages)) return;
    for (const m of messages) {
      if (!m || m.deleted) continue;
      const id = m.id || `axc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      if (this._seenMessageIds.has(id)) continue; // уже озвучено/обработано ранее
      this._seenMessageIds.add(id);
      if (this._seenMessageIds.size > 5000) {
        // ограничиваем рост множества, не давая ему течь в длинных стримах
        this._seenMessageIds = new Set(Array.from(this._seenMessageIds).slice(-2000));
      }

      const text = extractText(m.contents);
      if (!text) continue; // сообщение без текста (например, только стикер) — не озвучиваем

      this.eventBus.publish({
        id,
        source: 'axelchat',
        type: 'chat',
        platform: (m.author && m.author.serviceId) || 'unknown',
        author: {
          id: (m.author && m.author.id) || 'unknown',
          name: (m.author && m.author.name) || 'Зритель',
          avatar: (m.author && m.author.avatar) || null,
        },
        text,
        timestamp: m.publishedAt ? Date.parse(m.publishedAt) || Date.now() : Date.now(),
        raw: m,
      });
    }
  }
}

module.exports = { AxelChatConnectorService };
