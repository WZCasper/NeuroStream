'use strict';

const { renderTemplate } = require('../lib/template');
const { TTS_SOURCES } = require('./ttsQueue');

// Значения по умолчанию совпадают со схемой БД: если пользователь очистил поле шаблона,
// озвучка не превращается в бессмысленное «Вася: ».
const DEFAULT_CHAT_TEMPLATE = '{user} говорит: {text}';
const DEFAULT_GIFT_TEMPLATE = '{user} отправил подарок {gift} x{count}';
// В пресете нет отдельных шаблонов для подписок, поэтому фразы фиксированы.
const FOLLOW_PHRASE = '{user} подписался на канал';
const SUBSCRIBE_PHRASE = '{user} оформил платную подписку';

// Слишком длинное сообщение заняло бы очередь на минуты; остальное всё равно видно в чате.
const MAX_SPEECH_CHARS = 300;

const isOn = (value) => value === true || Number(value) === 1; // SQLite хранит флаги как 0/1

function totalCoins(event) {
  if (event.totalDiamonds !== undefined) return Number(event.totalDiamonds) || 0;
  return (Number(event.diamondCount) || 0) * (Number(event.repeatCount) || 1);
}

/**
 * Решает по настройкам пресета, нужно ли озвучивать событие, и собирает текст фразы.
 * Чистая функция: не трогает очередь и базу — удобно проверять тестами.
 * @returns {string|null} фраза до фильтра мата или null — озвучивать не нужно
 */
function buildSpeech(event, preset) {
  if (!preset || !isOn(preset.enabled)) return null;

  switch (event.type) {
    case 'chat':
      if (!isOn(preset.read_chat)) return null;
      if (!String(event.text || '').trim()) return null;
      return renderTemplate(preset.chat_template || DEFAULT_CHAT_TEMPLATE, event);

    case 'gift':
      if (!isOn(preset.read_gifts)) return null;
      if (totalCoins(event) < (Number(preset.min_gift_coins) || 0)) return null;
      return renderTemplate(preset.gift_template || DEFAULT_GIFT_TEMPLATE, event);

    case 'follow':
      return isOn(preset.read_follows) ? renderTemplate(FOLLOW_PHRASE, event) : null;

    case 'subscribe':
      return isOn(preset.read_subscribes) ? renderTemplate(SUBSCRIBE_PHRASE, event) : null;

    default:
      return null; // лайки, репосты и входы в эфир не озвучиваются — для них нет галочек
  }
}

/**
 * AutoSpeakService — озвучивает события по галочкам вкладки «Озвучка и чат»
 * («Читать чат», «Читать подарки», «Озвучивать подписчиков/подписки», «Подарки от N монет»).
 *
 * Если для события есть включённый триггер с действием «Озвучка», озвучкой управляет он
 * (у триггера свой шаблон и условия) — сервис в этом случае молчит, чтобы одна и та же
 * фраза не прозвучала дважды.
 */
class AutoSpeakService {
  /**
   * @param {{
   *   eventBus: import('./eventBus').EventBus,
   *   ttsQueue: import('./ttsQueue').TTSQueueManager,
   *   profanityFilter: { apply(text: string): string },
   *   getPreset: (source: string) => object|undefined,
   *   hasTtsTrigger: (event: object) => boolean,
   *   logger: import('../lib/logger').Logger,
   * }} deps
   */
  constructor({ eventBus, ttsQueue, profanityFilter, getPreset, hasTtsTrigger, logger }) {
    this.eventBus = eventBus;
    this.ttsQueue = ttsQueue;
    this.profanityFilter = profanityFilter;
    this.getPreset = getPreset;
    this.hasTtsTrigger = hasTtsTrigger;
    this.logger = logger;

    this._onEvent = (event) => this._handle(event);
    this.eventBus.on('event', this._onEvent);
  }

  destroy() {
    this.eventBus.off('event', this._onEvent);
  }

  _handle(event) {
    try {
      if (!event || !TTS_SOURCES.includes(event.source)) return;

      const preset = this.getPreset(event.source);
      const rendered = buildSpeech(event, preset);
      if (rendered === null) return;
      if (this.hasTtsTrigger(event)) return;

      let speech = String(this.profanityFilter.apply(rendered)).replace(/\s+/g, ' ').trim();
      if (!speech) return;
      if (speech.length > MAX_SPEECH_CHARS) speech = `${speech.slice(0, MAX_SPEECH_CHARS).trimEnd()}…`;

      this.ttsQueue.enqueue(event.source, speech, {
        voiceURI: preset.voice_uri,
        lang: preset.lang,
        rate: preset.rate,
        pitch: preset.pitch,
        volume: preset.volume,
      });
    } catch (err) {
      this.logger.error('tts', `Ошибка автоозвучки: ${err.message}`);
    }
  }
}

module.exports = { AutoSpeakService, buildSpeech, MAX_SPEECH_CHARS };
