'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const SOURCES = ['tiktok', 'axelchat'];

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
 * @fires TTSQueueManager#speak { queueId, source, text, voice }
 */
class TTSQueueManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Record<string, Array<{id:string, text:string, voice:object}>>} */
    this.queues = { tiktok: [], axelchat: [] };
    /** @type {Record<string, boolean>} */
    this.speaking = { tiktok: false, axelchat: false };
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
    this.queues[source].push({ id, text, voice });
    this._tryDequeue(source);
    return id;
  }

  /** Очищает очередь источника (например, по кнопке "Пропустить всё" в UI). */
  clear(source) {
    if (!SOURCES.includes(source)) return;
    this.queues[source] = [];
  }

  /**
   * Вызывается, когда tts-host сообщает об окончании воспроизведения
   * (успешном или по ошибке) конкретного элемента очереди.
   */
  markDone(source, id) {
    if (!SOURCES.includes(source)) return;
    // Защита от устаревших/повторных сигналов "конец" не по текущему элементу.
    this.speaking[source] = false;
    this._tryDequeue(source);
  }

  queueLength(source) {
    return this.queues[source]?.length || 0;
  }

  _tryDequeue(source) {
    if (this.speaking[source]) return;
    const next = this.queues[source].shift();
    if (!next) return;
    this.speaking[source] = true;
    this.emit('speak', { source, queueId: next.id, text: next.text, voice: next.voice });
  }
}

module.exports = { TTSQueueManager, TTS_SOURCES: SOURCES };
