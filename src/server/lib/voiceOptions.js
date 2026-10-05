'use strict';

/**
 * Собирает объект voice для TTSQueueManager.enqueue() из строки пресета
 * (таблица tts_presets). Общая логика для autoSpeak.js и triggerEngine.js —
 * раньше оба места дублировали один и тот же набор полей по отдельности,
 * из-за чего добавление движка Silero потребовало бы правки в двух местах
 * с риском разойтись (например, если бы кто-то обновил только одно из них).
 *
 * @param {object} preset строка из tts_presets (enabled, engine, voice_uri,
 *   silero_speaker, lang, rate, pitch, volume, ...)
 * @returns {{engine: string, voiceURI: ?string, sileroSpeaker: ?string,
 *   lang: string, rate: number, pitch: number, volume: number}}
 */
function buildVoiceOptions(preset) {
  // engine в БД по умолчанию 'system' (см. миграцию в database.js и schema.sql),
  // но на случай совсем старой строки, прочитанной до применения миграции
  // в этом же процессе — что теоретически возможно только при прямом обращении
  // к БД в обход repos.js — всё равно явно подстраховываемся дефолтом.
  const engine = preset.engine === 'silero' ? 'silero' : 'system';

  return {
    engine,
    voiceURI: preset.voice_uri,
    sileroSpeaker: preset.silero_speaker || 'baya',
    lang: preset.lang,
    rate: preset.rate,
    pitch: preset.pitch,
    volume: preset.volume,
  };
}

module.exports = { buildVoiceOptions };
