'use strict';

/**
 * Тесты коннектора AxelChat на настоящем WebSocket-сервере, имитирующем AxelChat
 * по протоколу (HELLO, SERVER_ALIVE, NEW_MESSAGES_RECEIVED).
 *
 * Запуск: node test/axelchat.test.js
 */

const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { AxelChatConnectorService } = require('../src/server/services/axelChatConnector');
const { EventBus } = require('../src/server/services/eventBus');

const PORT = 18357;
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

/** Ждёт, пока условие станет истинным (до timeoutMs) — вместо «магических» пауз. */
async function waitFor(condition, timeoutMs = 3000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(stepMs);
  }
  return condition();
}

/** Поднимает имитацию AxelChat. alive=false — сервер принимает соединения, но молчит (зависший). */
function startFakeAxelChat({ alive = true, aliveEveryMs = 60 } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
  const sockets = new Set();
  let seen = 0; // сколько соединений сервер принял за всё время
  wss.on('connection', (ws) => {
    seen++;
    sockets.add(ws);
    ws.send(JSON.stringify({ type: 'HELLO', data: { app: { version: 'test' } } }));
    if (alive) ws.timer = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'SERVER_ALIVE' })), aliveEveryMs);
    ws.on('close', () => { clearInterval(ws.timer); sockets.delete(ws); });
  });
  return {
    wss,
    live: () => [...sockets].filter((c) => c.readyState === 1).length,
    total: () => seen,
    send: (type, data) => sockets.forEach((c) => c.readyState === 1 && c.send(JSON.stringify({ type, data }))),
    async stop() {
      sockets.forEach((c) => c.terminate());
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

function makeConnector(over = {}) {
  const bus = new EventBus();
  const events = [];
  bus.on('event', (e) => events.push(e));
  const warns = [];
  const errors = [];
  const logger = { info() {}, warn: (cat, msg) => warns.push(msg), error: (cat, msg) => errors.push(msg) };
  const svc = new AxelChatConnectorService(bus, logger, { aliveTimeoutMs: 250, minReconnectDelayMs: 50, ...over });
  return { svc, bus, events, warns, errors };
}

(async () => {
  console.log('\nКоннектор AxelChat (настоящий WebSocket-сервер)');

  await step('подключается и переходит в статус «connected»', async () => {
    const server = startFakeAxelChat();
    const { svc } = makeConnector();
    svc.start({ port: PORT });
    assert.ok(await waitFor(() => svc.getState().status === 'connected'));
    svc.stop();
    await server.stop();
  });

  await step('три «Переподключить» подряд: ровно 4 соединения за всё время, одно живое, без «мигания» (раньше 1 → 2 → 4 живых)', async () => {
    const server = startFakeAxelChat();
    const { svc } = makeConnector();
    svc.start({ port: PORT });
    await waitFor(() => server.live() === 1);
    for (let i = 0; i < 3; i++) { svc.reconnectNow(); await sleep(150); }
    await sleep(300);
    const seenAfterSettling = server.total();
    await sleep(500); // дольше плановой задержки переподключения: «эхо» от старых сокетов успело бы проявиться
    assert.equal(server.live(), 1);
    assert.equal(server.total(), seenAfterSettling, 'после установки связи новые соединения появляться не должны (нет «мигания»)');
    assert.equal(server.total(), 4, 'старт + три переподключения = ровно 4 соединения');
    assert.equal(svc.getState().status, 'connected');
    svc.stop();
    await server.stop();
  });

  await step('повторный start() не плодит соединения и не вызывает «мигания»', async () => {
    const server = startFakeAxelChat();
    const { svc } = makeConnector();
    svc.start({ port: PORT });
    svc.start({ port: PORT });
    svc.start({ port: PORT });
    await sleep(400);
    const settled = server.total();
    await sleep(500);
    assert.equal(server.live(), 1);
    assert.equal(server.total(), settled, 'новые соединения после установки связи появляться не должны');
    assert.ok(server.total() <= 3);
    svc.stop();
    await server.stop();
  });

  await step('выключенный AxelChat: нет ложных «не отвечает», идут попытки подключения', async () => {
    const { svc, warns } = makeConnector();
    svc.start({ port: PORT }); // сервера нет
    await sleep(1500); // в 6 раз дольше тайм-аута «сторожа»
    assert.equal(warns.filter((m) => m.includes('не отвечает')).length, 0);
    assert.ok(svc.getState().reconnectCount >= 2);
    svc.stop();
  });

  await step('после падения сервера «сторож» не срабатывает, а после возврата связь восстанавливается', async () => {
    let server = startFakeAxelChat();
    const { svc, warns } = makeConnector();
    svc.start({ port: PORT });
    await waitFor(() => svc.getState().status === 'connected');
    await server.stop();
    await sleep(900);
    assert.equal(warns.filter((m) => m.includes('не отвечает')).length, 0);
    server = startFakeAxelChat();
    assert.ok(await waitFor(() => svc.getState().status === 'connected', 4000));
    assert.equal(server.live(), 1);
    svc.stop();
    await server.stop();
  });

  await step('настоящий «сторож»: зависший (молчащий) сервер обнаруживается и соединение пересоздаётся', async () => {
    const server = startFakeAxelChat({ alive: false });
    const { svc, warns } = makeConnector();
    svc.start({ port: PORT });
    await waitFor(() => svc.getState().status === 'connected');
    assert.ok(await waitFor(() => warns.some((m) => m.includes('не отвечает')), 2000), 'должно быть предупреждение');
    assert.ok(await waitFor(() => svc.getState().reconnectCount >= 1, 2000));
    svc.stop();
    await server.stop();
  });

  await step('stop(): соединение закрыто и повторных подключений нет', async () => {
    const server = startFakeAxelChat();
    const { svc } = makeConnector();
    svc.start({ port: PORT });
    await waitFor(() => server.live() === 1);
    svc.stop();
    assert.ok(await waitFor(() => server.live() === 0));
    await sleep(500);
    assert.equal(server.live(), 0);
    assert.equal(svc.getState().status, 'stopped');
    await server.stop();
  });

  await step('сообщения: текст публикуется, повторный id и пустые сообщения — нет', async () => {
    const server = startFakeAxelChat();
    const { svc, events } = makeConnector();
    svc.start({ port: PORT });
    await waitFor(() => server.live() === 1);
    const msg = (id, contents) => ({ id, author: { id: 'u1', name: 'Аня', serviceId: 'youtube' }, contents, publishedAt: '2026-09-19T10:00:00Z' });
    server.send('NEW_MESSAGES_RECEIVED', { messages: [
      msg('m1', [{ type: 'text', data: { text: 'Привет из ютуба' } }]),
      msg('m1', [{ type: 'text', data: { text: 'Привет из ютуба' } }]),
      msg('m2', [{ type: 'image', data: { url: 'x' } }]),
    ] });
    assert.ok(await waitFor(() => events.length >= 1));
    await sleep(100);
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'Привет из ютуба');
    assert.equal(events[0].platform, 'youtube');
    assert.equal(events[0].author.name, 'Аня');
    svc.stop();
    await server.stop();
  });

  await step('падающий подписчик шины не рвёт приём: следующее сообщение обрабатывается', async () => {
    const server = startFakeAxelChat();
    const { svc, bus, errors } = makeConnector();
    let calls = 0;
    bus.on('event', () => { calls++; if (calls === 1) throw new Error('сломанный подписчик'); });
    svc.start({ port: PORT });
    await waitFor(() => server.live() === 1);
    const one = (id) => ({ messages: [{ id, author: { id: 'u', name: 'А' }, contents: [{ type: 'text', data: { text: id } }] }] });
    server.send('NEW_MESSAGES_RECEIVED', one('a1'));
    await sleep(100);
    server.send('NEW_MESSAGES_RECEIVED', one('a2'));
    assert.ok(await waitFor(() => calls === 2));
    assert.equal(errors.length, 1);
    assert.equal(svc.getState().status, 'connected');
    svc.stop();
    await server.stop();
  });

  console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Тест аварийно завершился:', err);
  process.exit(1);
});
