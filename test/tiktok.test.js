'use strict';

/**
 * Тесты TikTok-коннектора.
 *
 * Часть 1 — «формат событий»: сообщения собираются штатным кодеком протокола (tiktok-live-proto),
 * проходят полный круг encode → decode и подаются в НАСТОЯЩИЙ метод библиотеки
 * processDecodedData — ровно так, как приходят из сети. Проверяется, что приложение
 * достаёт из них текст, автора, подарок, лайки и зрителей.
 *
 * Часть 2 — «жизненный цикл»: подключение подменено тестовым двойником (сети нет), чтобы
 * проверить логику приложения: дубли соединений, отмену на лету, устаревшие события.
 *
 * Запуск: node test/tiktok.test.js (код выхода 1 при любой ошибке — блокирует релиз в CI).
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');
const { TikTokConnectorService } = require('../src/server/services/tiktokConnector');
const { EventBus } = require('../src/server/services/eventBus');

let passed = 0;
let failed = 0;
const silentLogger = { info() {}, warn() {}, error() {} };
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

function collect(bus) {
  const events = [];
  bus.on('event', (e) => events.push(e));
  return events;
}

// ───────────────────────── Часть 1: настоящие protobuf-сообщения ─────────────────────────

async function formatTests() {
  console.log('\nФормат событий TikTok (настоящий кодек + настоящий processDecodedData)');
  const proto = await import('tiktok-live-proto/v3');
  const blank = (codec) => codec.decode(new Uint8Array(0));
  const wire = (codec, message) => codec.decode(codec.encode(message).finish()); // как по сети

  const mkUser = (o = {}) =>
    Object.assign(blank(proto.User), { id: '111', idStr: '111', nickname: 'Вася', displayId: 'vasya_live' }, o);
  const mkCommon = (o = {}) => Object.assign(blank(proto.CommonMessageData), { msgId: '9001', createTime: '1758000000000' }, o);

  /** Прогоняет сообщение через реальную библиотеку и реальные обработчики приложения. */
  async function feed(type, data) {
    const bus = new EventBus();
    const events = collect(bus);
    const svc = new TikTokConnectorService(bus, silentLogger);
    const conn = new TikTokLiveConnection('probe', {});
    svc.connection = conn;
    svc._attachEventHandlers(conn);
    await conn.processDecodedData({ type, data });
    return { events, svc };
  }

  await step('чат: текст, имя, @handle, id и аватар доходят до шины (раньше терялись)', async () => {
    const avatar = Object.assign(blank(proto.ImageModel), { urlList: ['https://cdn.example/ava.jpg'] });
    const msg = wire(proto.WebcastChatMessage, Object.assign(blank(proto.WebcastChatMessage), {
      common: mkCommon(), user: mkUser({ avatarLarge: avatar }), content: 'Привет, стример!',
    }));
    const { events } = await feed('WebcastChatMessage', msg);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, 'chat');
    assert.equal(e.text, 'Привет, стример!');
    assert.equal(e.author.name, 'Вася');
    assert.equal(e.author.uniqueId, 'vasya_live');
    assert.equal(e.author.id, '111');
    assert.equal(e.author.avatar, 'https://cdn.example/ava.jpg');
    assert.equal(e.id, '9001');
    assert.equal(e.timestamp, 1758000000000);
  });

  await step('автор без ника: имя берётся из @handle, а не «Зритель»', async () => {
    const msg = wire(proto.WebcastChatMessage, Object.assign(blank(proto.WebcastChatMessage), {
      common: mkCommon(), user: mkUser({ nickname: '' }), content: 'hi',
    }));
    const { events } = await feed('WebcastChatMessage', msg);
    assert.equal(events[0].author.name, 'vasya_live');
  });

  await step('подарок: название, стоимость и итог по серии', async () => {
    const gift = Object.assign(blank(proto.Gift), { name: 'Rose', diamondCount: 5, type: 2 });
    const msg = wire(proto.WebcastGiftMessage, Object.assign(blank(proto.WebcastGiftMessage), {
      common: mkCommon({ msgId: '9002' }), user: mkUser(), gift, giftId: '5655', repeatCount: 3, repeatEnd: 0, groupId: '5001',
    }));
    const { events } = await feed('WebcastGiftMessage', msg);
    assert.equal(events.length, 1, 'подарок не-серийного типа публикуется сразу');
    const e = events[0];
    assert.equal(e.giftName, 'Rose');
    assert.equal(e.diamondCount, 5);
    assert.equal(e.repeatCount, 3);
    assert.equal(e.totalDiamonds, 15);
    assert.equal(e.author.name, 'Вася');
  });

  await step('серия подарков (type=1): промежуточные события не публикуются, финальное — да', async () => {
    const mk = (repeatEnd, repeatCount, msgId) => wire(proto.WebcastGiftMessage, Object.assign(blank(proto.WebcastGiftMessage), {
      common: mkCommon({ msgId }), user: mkUser(), gift: Object.assign(blank(proto.Gift), { name: 'Galaxy', diamondCount: 1, type: 1 }),
      repeatCount, repeatEnd, groupId: '5002',
    }));
    const bus = new EventBus();
    const events = collect(bus);
    const svc = new TikTokConnectorService(bus, silentLogger);
    const conn = new TikTokLiveConnection('probe', {});
    svc.connection = conn;
    svc._attachEventHandlers(conn);
    await conn.processDecodedData({ type: 'WebcastGiftMessage', data: mk(0, 1, '7001') });
    await conn.processDecodedData({ type: 'WebcastGiftMessage', data: mk(0, 2, '7002') });
    assert.equal(events.length, 0, 'серия ещё идёт');
    await conn.processDecodedData({ type: 'WebcastGiftMessage', data: mk(1, 7, '7003') });
    assert.equal(events.length, 1);
    assert.equal(events[0].repeatCount, 7);
    assert.equal(events[0].repeatEnd, true);
  });

  await step('лайки: count и total', async () => {
    const msg = wire(proto.WebcastLikeMessage, Object.assign(blank(proto.WebcastLikeMessage), {
      common: mkCommon({ msgId: '9003' }), user: mkUser(), count: 4, total: '120',
    }));
    const { events } = await feed('WebcastLikeMessage', msg);
    assert.equal(events[0].likeCount, 4);
    assert.equal(events[0].totalLikeCount, 120);
  });

  await step('подписчик (follow) и репост (share) различаются по ключу текста', async () => {
    const social = (key, msgId) => wire(proto.WebcastSocialMessage, Object.assign(blank(proto.WebcastSocialMessage), {
      common: mkCommon({ msgId, displayText: Object.assign(blank(proto.MessageCommonText), { key }) }), user: mkUser(),
    }));
    const a = await feed('WebcastSocialMessage', social('pm_main_follow_message_viewer_2', '7011'));
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0].type, 'follow');
    const b = await feed('WebcastSocialMessage', social('pm_mt_guidance_share', '7012'));
    assert.equal(b.events[0].type, 'share');
  });

  await step('платная подписка (subNotify): количество месяцев', async () => {
    const msg = wire(proto.WebcastSubNotifyMessage, Object.assign(blank(proto.WebcastSubNotifyMessage), {
      common: mkCommon({ msgId: '7021' }), user: mkUser(), subMonth: '3',
    }));
    const { events } = await feed('WebcastSubNotifyMessage', msg);
    assert.equal(events[0].type, 'subscribe');
    assert.equal(events[0].subMonth, 3);
  });

  await step('вход в эфир: публикуется; действие «подписка» (3) не дублирует subNotify', async () => {
    const member = (action, msgId) => wire(proto.WebcastMemberMessage, Object.assign(blank(proto.WebcastMemberMessage), {
      common: mkCommon({ msgId }), user: mkUser(), action,
    }));
    const a = await feed('WebcastMemberMessage', member(1, '7031'));
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0].type, 'member');
    const b = await feed('WebcastMemberMessage', member(3, '7032'));
    assert.equal(b.events.length, 0);
  });

  await step('счётчик зрителей обновляется из roomUser (раньше всегда оставался 0)', async () => {
    const msg = wire(proto.WebcastRoomUserSeqMessage, Object.assign(blank(proto.WebcastRoomUserSeqMessage), {
      common: mkCommon({ msgId: '7041' }), total: '42',
    }));
    const { svc } = await feed('WebcastRoomUserSeqMessage', msg);
    assert.equal(svc.viewerCount, 42);
  });

  await step('повторная доставка того же msgId (после переподключения) публикуется один раз', async () => {
    const msg = wire(proto.WebcastChatMessage, Object.assign(blank(proto.WebcastChatMessage), {
      common: mkCommon({ msgId: '7051' }), user: mkUser(), content: 'один раз',
    }));
    const bus = new EventBus();
    const events = collect(bus);
    const svc = new TikTokConnectorService(bus, silentLogger);
    const conn = new TikTokLiveConnection('probe', {});
    svc.connection = conn;
    svc._attachEventHandlers(conn);
    await conn.processDecodedData({ type: 'WebcastChatMessage', data: msg });
    await conn.processDecodedData({ type: 'WebcastChatMessage', data: msg });
    assert.equal(events.length, 1);
  });

  await step('ошибка в подписчике шины не роняет обработку и не пробрасывается в библиотеку', async () => {
    const msg = wire(proto.WebcastChatMessage, Object.assign(blank(proto.WebcastChatMessage), {
      common: mkCommon({ msgId: '7061' }), user: mkUser(), content: 'x',
    }));
    const bus = new EventBus();
    bus.on('event', () => { throw new Error('сломанный подписчик'); });
    const logged = [];
    const svc = new TikTokConnectorService(bus, { ...silentLogger, error: (...a) => logged.push(a) });
    const conn = new TikTokLiveConnection('probe', {});
    svc.connection = conn;
    svc._attachEventHandlers(conn);
    await conn.processDecodedData({ type: 'WebcastChatMessage', data: msg }); // не должно бросить
    assert.equal(logged.length, 1);
  });
}

// ───────────────────────── Часть 2: жизненный цикл соединений ─────────────────────────

/**
 * Тестовый двойник TikTokLiveConnection. Повторяет поведение, подтверждённое по исходникам
 * библиотеки: на каждое подключение — новый объект; disconnect() закрывает сокет и ПОСЛЕ
 * этого эмитит 'disconnected'.
 */
function makeFactory({ connectDelayMs = 20 } = {}) {
  const instances = [];
  class FakeConnection extends EventEmitter {
    constructor(uniqueId, options) {
      super();
      this.uniqueId = uniqueId;
      this.options = options;
      this.live = false;
      this.connectCalls = 0;
      instances.push(this);
    }
    async connect() {
      this.connectCalls++;
      await sleep(connectDelayMs);
      this.live = true;
      return { roomId: `room-${instances.indexOf(this)}` };
    }
    async disconnect() {
      if (!this.live) return;
      await sleep(5);
      this.live = false;
      this.emit(ControlEvent.DISCONNECTED, { code: 1000 });
    }
  }
  return {
    instances,
    live: () => instances.filter((i) => i.live).length,
    createConnection: (id, opts) => new FakeConnection(id, opts),
  };
}

async function lifecycleTests() {
  console.log('\nЖизненный цикл соединения (двойник библиотеки, без сети)');
  const mk = (factoryOpts) => {
    const factory = makeFactory(factoryOpts);
    const bus = new EventBus();
    const events = collect(bus);
    const svc = new TikTokConnectorService(bus, silentLogger, { createConnection: factory.createConnection, minReconnectDelayMs: 30 });
    return { factory, bus, events, svc };
  };

  await step('повторное «Подключиться» оставляет ровно одно живое соединение', async () => {
    const { factory, svc } = mk();
    await svc.start('streamer');
    await svc.start('streamer');
    await sleep(100);
    assert.equal(factory.live(), 1);
    assert.equal(factory.instances.length, 2);
    await svc.stop();
  });

  await step('«Переподключить» не оставляет лишнего соединения', async () => {
    const { factory, svc } = mk();
    await svc.start('streamer');
    await svc.reconnectNow();
    await sleep(200); // дольше плановой задержки — «эхо» от закрытия старого соединения не должно создать ещё одно
    assert.equal(factory.live(), 1);
    assert.equal(factory.instances.length, 2);
    await svc.stop();
  });

  await step('«Остановить» посреди подключения: соединение закрывается, живых нет', async () => {
    const { factory, svc } = mk({ connectDelayMs: 100 });
    const starting = svc.start('streamer');
    await sleep(20);
    await svc.stop();
    await starting;
    await sleep(200);
    assert.equal(factory.live(), 0);
    assert.equal(svc.getState().status, 'stopped');
  });

  await step('повторный запуск посреди подключения: живо только последнее соединение', async () => {
    const { factory, svc } = mk({ connectDelayMs: 80 });
    const first = svc.start('streamer');
    await sleep(20);
    const second = svc.start('streamer');
    await Promise.all([first, second]);
    await sleep(150);
    assert.equal(factory.live(), 1);
    assert.equal(svc.connection, factory.instances[factory.instances.length - 1]);
    await svc.stop();
  });

  await step('обрыв связи: переподключение создаёт новое соединение, старое не остаётся живым', async () => {
    const { factory, svc } = mk();
    await svc.start('streamer');
    const first = factory.instances[0];
    first.live = false;
    first.emit(ControlEvent.DISCONNECTED, { code: 1006 });
    await sleep(200);
    assert.equal(factory.instances.length, 2);
    assert.equal(factory.live(), 1);
    assert.equal(svc.getState().status, 'connected');
    await svc.stop();
  });

  await step('события закрытого соединения игнорируются (не попадают в шину)', async () => {
    const { factory, events, svc } = mk();
    await svc.start('streamer');
    const old = factory.instances[0];
    await svc.reconnectNow();
    old.emit(WebcastEvent.CHAT, { content: 'призрак', common: { msgId: 'ghost' }, user: {} });
    assert.equal(events.length, 0);
    await svc.stop();
  });

  await step('после остановки таймер переподключения не срабатывает', async () => {
    const { factory, svc } = mk();
    await svc.start('streamer');
    factory.instances[0].live = false;
    factory.instances[0].emit(ControlEvent.DISCONNECTED, {});
    await svc.stop();
    await sleep(150);
    assert.equal(factory.instances.length, 1);
    assert.equal(factory.live(), 0);
  });

  await step('стартовый пакет истории не обрабатывается (processInitialData: false)', async () => {
    const { factory, svc } = mk();
    await svc.start('streamer');
    assert.equal(factory.instances[0].options.processInitialData, false);
    await svc.stop();
  });
}

(async () => {
  await formatTests();
  await lifecycleTests();
  console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Тест аварийно завершился:', err);
  process.exit(1);
});
