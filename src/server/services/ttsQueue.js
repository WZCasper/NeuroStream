'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const SOURCES = ['tiktok', 'axelchat'];

// Если чат «взорвался», озвучивать 500 накопившихся сообщений бессмысленно: самые старые
// уже неактуальны. Держим ограниченную очередь и отбрасываем старейшие.
const DEFAULT_MAX_QUEUE_LENGTH = 50;

// «Сторож» на случай, когда окно озвучки так и не сообщило об окончании (закрыто, упал
// синтезатор, голос не загрузился). Без него очередь замирала навсегда.
const BASE_TIMEOUT_MS = 15000;
const PER_CHAR_TIMEOUT_MS = 120;
const MAX_TIMEOUT_MS = 60000;
const defaultTimeoutForText = (text) =>
  Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + String(text || '').length * PER_CHAR_TIMEOUT_MS);

/**
 * TTSQueueManager — держит по одной независимой очереди озвучки на каждый
 * источник (TikTok чат и AxelChat), чтобы сообщения не накладывались друг
 * на друга и не терялись при массовом потоке сообщений/подарков.
 *
 * Реальный синтез речи выполняется НЕ здесь (в главном/серверном процессе
 * нет доступа к аудио-API), а в скрытой странице рендерера
 * (src/renderer/tts-host.html) через браузерный Web Speech API
 * (window.speechSynthesis). Эта служба лишь решает, ЧТО и КОГДА озвучивать,
 * и публикует событие 'speak', на которое подписывается index.js, пересылая
 * команду в tts-host через Socket.io. Когда воспроизведение заканчивается,
 * tts-host сообщает об этом обратно (событие 'utteranceEnd' через сокет),
 * что приводит к вызову markDone() и запуску следующего элемента очереди.
 *
 * @fires TTSQueueManager#speak   { queueId, source, text, voice }
 * @fires TTSQueueManager#dropped { source, count }   — из-за переполнения отброшены самые старые
 * @fires TTSQueueManager#timeout { source, queueId } — окно озвучки не сообщило об окончании
 */
class TTSQueueManager extends EventEmitter {
  /**
   * @param {{ maxQueueLength?: number, timeoutForText?: (text: string) => number }} [options]
   */
  constructor(options = {}) {
    super();
    this.maxQueueLength = options.maxQueueLength || DEFAULT_MAX_QUEUE_LENGTH;
    this._timeoutForText = options.timeoutForText || defaultTimeoutForText;
    /** @type {Record<string, Array<{id:string, text:string, voice:object}>>} */
    this.queues = { tiktok: [], axelchat: [] };
    /** @type {Record<string, boolean>} */
    this.speaking = { tiktok: false, axelchat: false };
    /** Что сейчас озвучивается: { id, timer } */
    this.current = { tiktok: null, axelchat: null };
  }

  /**
   * Добавляет текст в очередь озвучки указанного источника.
   * @param {'tiktok'|'axelchat'} source
   * @param {string} text            Уже отфильтрованный (profanityFilter) текст
   * @param {object} voice           { voiceURI, lang, rate, pitch, volume }
   * @returns {string} id поставленного в очередь элемента
   */
  enqueue(source, text, voice) {
    if (!SOURCES.includes(source)) throw new Error(`Неизвестный источник TTS: ${source}`);
    const id = crypto.randomUUID();
    const queue = this.queues[source];
    queue.push({ id, text, voice });

    if (queue.length > this.maxQueueLength) {
      const dropped = queue.splice(0, queue.length - this.maxQueueLength);
      this.emit('dropped', { source, count: dropped.length });
    }
    this._tryDequeue(source);
    return id;
  }

  /** Очищает очередь источника (например, по кнопке "Пропустить всё" в UI). */
  clear(source) {
    if (!SOURCES.includes(source)) return;
    this.queues[source] = [];
  }

  /** Останавливает таймеры (при завершении программы). */
  destroy() {
    for (const source of SOURCES) this._finishCurrent(source);
  }

  /**
   * Вызывается, когда tts-host сообщает об окончании воспроизведения
   * (успешном или по ошибке) конкретного элемента очереди.
   * Сигнал по другому элементу (устаревший или повторный) игнорируется —
   * иначе он преждевременно прервал бы озвучку следующего сообщения.
   */
  markDone(source, id) {
    if (!SOURCES.includes(source)) return;
    const current = this.current[source];
    if (!current) return;
    if (id !== undefined && id !== null && current.id !== id) return;
    this._finishCurrent(source);
    this._tryDequeue(source);
  }

  queueLength(source) {
    return this.queues[source]?.length || 0;
  }

  _finishCurrent(source) {
    const current = this.current[source];
    if (current && current.timer) clearTimeout(current.timer);
    this.current[source] = null;
    this.speaking[source] = false;
  }

  _tryDequeue(source) {
    if (this.speaking[source]) return;
    const next = this.queues[source].shift();
    if (!next) return;

    this.speaking[source] = true;
    const timer = setTimeout(() => {
      if (!this.current[source] || this.current[source].id !== next.id) return;
      this.emit('timeout', { source, queueId: next.id });
      this._finishCurrent(source);
      this._tryDequeue(source);
    }, this._timeoutForText(next.text));
    if (timer.unref) timer.unref(); // сторож не должен удерживать процесс от завершения
    this.current[source] = { id: next.id, timer };

    this.emit('speak', { source, queueId: next.id, text: next.text, voice: next.voice });
  }
}

module.exports = { TTSQueueManager, TTS_SOURCES: SOURCES };
