'use strict';

const assert = require('assert');
const { buildVoiceOptions } = require('../src/server/lib/voiceOptions');

let passed = 0;
let failed = 0;

console.log('buildVoiceOptions — тесты\n');

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.stack || err.message}`);
  }
}

test('пресет с engine=system возвращает engine system и передаёт voiceURI', () => {
  const result = buildVoiceOptions({
    engine: 'system',
    voice_uri: 'Microsoft Irina Desktop',
    silero_speaker: 'baya',
    lang: 'ru-RU',
    rate: 1.2,
    pitch: 0.9,
    volume: 1,
  });
  assert.strictEqual(result.engine, 'system');
  assert.strictEqual(result.voiceURI, 'Microsoft Irina Desktop');
  assert.strictEqual(result.lang, 'ru-RU');
  assert.strictEqual(result.rate, 1.2);
});

test('пресет с engine=silero возвращает engine silero и sileroSpeaker', () => {
  const result = buildVoiceOptions({
    engine: 'silero',
    voice_uri: null,
    silero_speaker: 'xenia',
    lang: 'ru-RU',
    rate: 1,
    pitch: 1,
    volume: 1,
  });
  assert.strictEqual(result.engine, 'silero');
  assert.strictEqual(result.sileroSpeaker, 'xenia');
});

test('пресет без поля engine (старая строка БД до миграции) откатывается на system', () => {
  const result = buildVoiceOptions({
    voice_uri: 'Microsoft Pavel',
    lang: 'ru-RU',
    rate: 1,
    pitch: 1,
    volume: 1,
  });
  assert.strictEqual(result.engine, 'system');
});

test('пресет с engine=silero, но без silero_speaker — подставляется baya по умолчанию', () => {
  const result = buildVoiceOptions({
    engine: 'silero',
    silero_speaker: null,
    lang: 'ru-RU',
    rate: 1,
    pitch: 1,
    volume: 1,
  });
  assert.strictEqual(result.sileroSpeaker, 'baya');
});

test('некорректное значение engine (не system и не silero) откатывается на system', () => {
  const result = buildVoiceOptions({
    engine: 'что-то-неизвестное',
    lang: 'ru-RU',
    rate: 1,
    pitch: 1,
    volume: 1,
  });
  assert.strictEqual(result.engine, 'system');
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало из ${passed + failed}`);
if (failed > 0) {
  process.exit(1);
}
