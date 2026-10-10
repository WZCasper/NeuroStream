'use strict';

/**
 * Тесты автоозвучки по галочкам и очереди озвучки.
 * Часть 1 — решения по настройкам пресета и логика очереди (без сервера).
 * Часть 2 — настоящий сервер: то же, что делает пользователь — галочки включены, приходят события.
 *
 * Запуск: node test/autospeak.test.js
 */

process.env.NSS_PORT = process.env.NSS_PORT || '47951';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventBus } = require('../src/server/services/eventBus');
const { TTSQueueManager } = require('../src/server/services/ttsQueue');
const { AutoSpeakService, buildSpeech, MAX_SPEECH_CHARS } = require('../src/server/services/autoSpeak');
const { createServer } = require('../src/server/index');

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    failed++;
  }
}

const preset = (o = {}) => ({
  enabled: 1, voice_uri: 'v1', lang: 'ru-RU', rate: 1, pitch: 1, volume: 1,
  read_chat: 1, read_gifts: 1, read_follows: 0, read_subscribes: 1, min_gift_coins: 0,
  chat_template: '{user} говорит: {text}', gift_template: '{user} отправил подарок {gift} x{count}', ...o,
});
const author = { id: '1', name: 'Вася' };
const chat = (text, o = {}) => ({ id: 'c', source: 'tiktok', type: 'chat', author, text, ...o });
const gift = (o = {}) => ({ id: 'g', source: 'tiktok', type: 'gift', author, giftName: 'Rose', diamondCount: 1, repeatCount: 1, ...o });

async function unitTests() {
  console.log('\nРешения автоозвучки (buildSpeech)');

  await step('чат озвучивается по шаблону пресета', () => {
    assert.equal(buildSpeech(chat('Привет!'), preset()), 'Вася говорит: Привет!');
  });
  await step('пресет выключен целиком — тишина', () => {
    assert.equal(buildSpeech(chat('Привет!'), preset({ enabled: 0 })), null);
  });
  await step('галочка «Читать чат» снята — тишина', () => {
    assert.equal(buildSpeech(chat('Привет!'), preset({ read_chat: 0 })), null);
  });
  await step('пустое сообщение (только пробелы) не озвучивается', () => {
    assert.equal(buildSpeech(chat('   '), preset()), null);
  });
  await step('очищенный шаблон чата не превращается в «Вася: »', () => {
    assert.equal(buildSpeech(chat('Привет!'), preset({ chat_template: '' })), 'Вася говорит: Привет!');
  });
  await step('подарок дешевле порога — тишина; серия набирает порог суммой', () => {
    const p = preset({ min_gift_coins: 10 });
    assert.equal(buildSpeech(gift({ diamondCount: 1, repeatCount: 1 }), p), null);
    assert.equal(buildSpeech(gift({ diamondCount: 1, repeatCount: 10, totalDiamonds: 10 }), p), 'Вася отправил подарок Rose x10');
  });
  await step('галочка «Читать подарки» снята — тишина', () => {
    assert.equal(buildSpeech(gift(), preset({ read_gifts: 0 })), null);
  });
  await step('подписчики: по умолчанию выключены, включаются галочкой', () => {
    assert.equal(buildSpeech({ type: 'follow', author }, preset()), null);
    assert.equal(buildSpeech({ type: 'follow', author }, preset({ read_follows: 1 })), 'Вася подписался на канал');
  });
  await step('платные подписки: включены по умолчанию, отключаются галочкой', () => {
    assert.equal(buildSpeech({ type: 'subscribe', author }, preset()), 'Вася оформил платную подписку');
    assert.equal(buildSpeech({ type: 'subscribe', author }, preset({ read_subscribes: 0 })), null);
  });
  await step('лайки, репосты и входы не озвучиваются', () => {
    for (const type of ['like', 'share', 'member']) assert.equal(buildSpeech({ type, author }, preset()), null);
  });
  await step('нет пресета — тишина, без исключения', () => {
    assert.equal(buildSpeech(chat('x'), undefined), null);
  });

  console.log('\nСервис автоозвучки (AutoSpeakService)');
  const make = (over = {}) => {
    const eventBus = new EventBus();
    const spoken = [];
    const ttsQueue = { enqueue: (source, text, voice) => spoken.push({ source, text, voice }) };
    const errors = [];
    const svc = new AutoSpeakService({
      eventBus, ttsQueue,
      profanityFilter: { apply: (t) => t.replace(/плохо/g, '***') },
      getPreset: () => preset(),
      hasTtsTrigger: () => false,
      logger: { error: (...a) => errors.push(a), info() {}, warn() {} },
      ...over,
    });
    return { eventBus, spoken, errors, svc };
  };

  await step('озвучивает событие и передаёт голос из пресета', () => {
    const { eventBus, spoken } = make();
    eventBus.publish(chat('Привет'));
    assert.equal(spoken.length, 1);
    // voice теперь всегда включает engine/sileroSpeaker (см. buildVoiceOptions
    // в src/server/lib/voiceOptions.js, добавлено для поддержки Silero TTS) —
    // preset() в этом файле не задаёт engine/silero_speaker, поэтому ожидаем
    // дефолты ('system'/'baya'), которые buildVoiceOptions подставляет сама.
    assert.deepEqual(spoken[0].voice, {
      engine: 'system',
      voiceURI: 'v1',
      sileroSpeaker: 'baya',
      lang: 'ru-RU',
      rate: 1,
      pitch: 1,
      volume: 1,
    });
  });
  await step('фильтр мата применяется', () => {
    const { eventBus, spoken } = make();
    eventBus.publish(chat('это плохо'));
    assert.equal(spoken[0].text, 'Вася говорит: это ***');
  });
  await step('если событием управляет триггер с озвучкой — автоозвучка молчит', () => {
    const { eventBus, spoken } = make({ hasTtsTrigger: () => true });
    eventBus.publish(chat('Привет'));
    assert.equal(spoken.length, 0);
  });
  await step('слишком длинное сообщение обрезается', () => {
    const { eventBus, spoken } = make();
    eventBus.publish(chat('а'.repeat(5000)));
    assert.ok(spoken[0].text.length <= MAX_SPEECH_CHARS + 1, `длина ${spoken[0].text.length}`);
    assert.ok(spoken[0].text.endsWith('…'));
  });
  await step('неизвестный источник игнорируется', () => {
    const { eventBus, spoken } = make();
    eventBus.publish(chat('x', { source: 'whatever' }));
    assert.equal(spoken.length, 0);
  });
  await step('ошибка внутри не роняет шину и попадает в журнал', () => {
    const { eventBus, errors } = make({ getPreset: () => { throw new Error('база недоступна'); } });
    eventBus.publish(chat('x'));
    assert.equal(errors.length, 1);
  });
  await step('destroy() отписывает сервис', () => {
    const { eventBus, spoken, svc } = make();
    svc.destroy();
    eventBus.publish(chat('x'));
    assert.equal(spoken.length, 0);
  });

  console.log('\nОчередь озвучки (TTSQueueManager)');
  await step('ограничение длины: самые старые отбрасываются, об этом сообщается', () => {
    const q = new TTSQueueManager({ maxQueueLength: 3 });
    const dropped = [];
    q.on('dropped', (d) => dropped.push(d));
    for (let i = 0; i < 7; i++) q.enqueue('tiktok', `m${i}`, {}); // m0 сразу уходит в озвучку, остальные 6 ждут
    assert.equal(q.queueLength('tiktok'), 3);
    assert.deepEqual(q.queues.tiktok.map((x) => x.text), ['m4', 'm5', 'm6'], 'остались самые свежие');
    assert.equal(dropped.reduce((n, d) => n + d.count, 0), 3);
    q.destroy();
  });
  await step('устаревший сигнал «конец» не прерывает текущую фразу', () => {
    const q = new TTSQueueManager();
    const spoken = [];
    q.on('speak', (c) => spoken.push(c));
    q.enqueue('tiktok', 'A', {});
    q.enqueue('tiktok', 'B', {});
    q.markDone('tiktok', 'чужой-id');
    assert.equal(spoken.length, 1, 'B не должно начаться');
    q.markDone('tiktok', spoken[0].queueId);
    assert.equal(spoken.length, 2);
    assert.equal(spoken[1].text, 'B');
    q.destroy();
  });
  await step('повторный сигнал «конец» по уже завершённой фразе игнорируется', () => {
    const q = new TTSQueueManager();
    const spoken = [];
    q.on('speak', (c) => spoken.push(c));
    q.enqueue('tiktok', 'A', {});
    q.enqueue('tiktok', 'B', {});
    q.enqueue('tiktok', 'C', {});
    const idA = spoken[0].queueId;
    q.markDone('tiktok', idA);
    q.markDone('tiktok', idA); // дубль
    assert.equal(spoken.length, 2, 'C не должно начаться из-за дубля');
    q.destroy();
  });
  await step('сигнал без id по-прежнему принимается (обратная совместимость)', () => {
    const q = new TTSQueueManager();
    const spoken = [];
    q.on('speak', (c) => spoken.push(c));
    q.enqueue('tiktok', 'A', {});
    q.enqueue('tiktok', 'B', {});
    q.markDone('tiktok');
    assert.equal(spoken.length, 2);
    q.destroy();
  });
  await step('«сторож»: если окно озвучки молчит, очередь не замирает', async () => {
    const q = new TTSQueueManager({ timeoutForText: () => 30 });
    const spoken = [];
    const timeouts = [];
    q.on('speak', (c) => spoken.push(c));
    q.on('timeout', (t) => timeouts.push(t));
    q.enqueue('tiktok', 'A', {});
    q.enqueue('tiktok', 'B', {});
    await sleep(120);
    assert.ok(timeouts.length >= 1);
    assert.equal(spoken[1].text, 'B');
    q.destroy();
  });
  await step('destroy() останавливает «сторожа»', async () => {
    const q = new TTSQueueManager({ timeoutForText: () => 30 });
    const timeouts = [];
    q.on('timeout', (t) => timeouts.push(t));
    q.enqueue('tiktok', 'A', {});
    q.destroy();
    await sleep(80);
    assert.equal(timeouts.length, 0);
  });
  await step('очереди источников независимы', () => {
    const q = new TTSQueueManager();
    const spoken = [];
    q.on('speak', (c) => spoken.push(c.source));
    q.enqueue('tiktok', 'A', {});
    q.enqueue('axelchat', 'B', {});
    assert.deepEqual(spoken.sort(), ['axelchat', 'tiktok']);
    q.destroy();
  });
}

async function serverTests() {
  console.log('\nНастоящий сервер: галочки включены, приходят события');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-autospeak-'));
  const server = await createServer({ userDataDir: dir });
  const { eventBus, ttsQueue, repos, triggerEngine } = server.services;

  const spoken = [];
  ttsQueue.on('speak', (cmd) => {
    spoken.push(cmd.text);
    setImmediate(() => ttsQueue.markDone(cmd.source, cmd.queueId)); // «окно озвучки» сразу закончило
  });
  const emit = (event) => eventBus.publish({ id: `t${Math.random()}`, source: 'tiktok', platform: 'tiktok', author, timestamp: Date.now(), raw: {}, ...event });
  const reset = () => { spoken.length = 0; };

  try {
    await step('без триггеров чат озвучивается автоматически (исходная жалоба пользователя)', async () => {
      reset();
      emit({ type: 'chat', text: 'Привет, стример!' });
      await sleep(50);
      assert.deepEqual(spoken, ['Вася говорит: Привет, стример!']);
    });

    await step('снятая галочка «Читать чат» реально отключает озвучку', async () => {
      repos.ttsPresets.update('tiktok', { read_chat: 0 });
      reset();
      emit({ type: 'chat', text: 'Молчим' });
      await sleep(50);
      assert.deepEqual(spoken, []);
      repos.ttsPresets.update('tiktok', { read_chat: 1 });
    });

    await step('порог «от N монет» работает по сумме серии', async () => {
      repos.ttsPresets.update('tiktok', { min_gift_coins: 10 });
      reset();
      emit({ type: 'gift', giftName: 'Rose', diamondCount: 1, repeatCount: 1, totalDiamonds: 1, repeatEnd: true });
      emit({ type: 'gift', giftName: 'Rose', diamondCount: 1, repeatCount: 10, totalDiamonds: 10, repeatEnd: true });
      await sleep(80);
      assert.deepEqual(spoken, ['Вася отправил подарок Rose x10']);
      repos.ttsPresets.update('tiktok', { min_gift_coins: 0 });
    });

    await step('триггер с озвучкой управляет своим событием: фраза звучит один раз, остальной чат — автоозвучкой', async () => {
      repos.triggers.create({
        name: 'Озвучить «привет»', source: 'tiktok', eventType: 'chat_keyword', conditions: { keyword: 'привет' },
        actions: [{ actionType: 'tts', config: { template: 'Триггер: {text}' } }],
      });
      triggerEngine.reload();
      reset();
      emit({ type: 'chat', text: 'привет всем' });
      emit({ type: 'chat', text: 'как дела' });
      await sleep(120);
      assert.deepEqual(spoken.sort(), ['Вася говорит: как дела', 'Триггер: привет всем'].sort());
    });

    await step('выключенный пресет AxelChat не влияет на TikTok (у каждого источника свой пресет)', async () => {
      repos.ttsPresets.update('axelchat', { enabled: 0 });
      reset();
      emit({ source: 'axelchat', platform: 'youtube', type: 'chat', text: 'из ютуба' });
      emit({ type: 'chat', text: 'из тиктока' });
      await sleep(80);
      assert.deepEqual(spoken.filter((t) => t.includes('из ')), ['Вася говорит: из тиктока']);
    });

    await step('shutdown() по-прежнему быстрый', async () => {
      const t0 = Date.now();
      await server.shutdown();
      assert.ok(Date.now() - t0 < 4000);
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ }
  }
}

(async () => {
  await unitTests();
  await serverTests();
  console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Тест аварийно завершился:', err);
  process.exit(1);
});
