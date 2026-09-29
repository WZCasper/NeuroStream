'use strict';

/**
 * Тесты локальной защиты сервера (Host/Origin), единого обработчика ошибок API,
 * устойчивости к кривым сообщениям Socket.io и атомарности записи данных.
 *
 * Запуск: node test/security.test.js
 */

process.env.NSS_PORT = process.env.NSS_PORT || '47960';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/server/index');

let passed = 0;
let failed = 0;

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

const PORT = Number(process.env.NSS_PORT);
const BASE = `http://127.0.0.1:${PORT}`;

/** Запрос с полным контролем над заголовком Host (fetch() его переопределить не даёт). */
function rawRequest({ method = 'GET', pathName, host, origin, body, contentType }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin !== undefined) headers.Origin = origin;
    if (body !== undefined) {
      headers['Content-Type'] = contentType || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathName, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-security-'));
  const server = await createServer({ userDataDir: dir });
  const { repos, triggerEngine, iotService } = server.services;

  console.log('\nЗащита от постороннего Host/Origin (DNS rebinding, CSRF)');

  await step('GET /api/settings с чужим Host отклоняется', async () => {
    const r = await rawRequest({ pathName: '/api/settings', host: 'evil.example' });
    assert.equal(r.status, 403);
    assert.ok(!r.body.includes('tiktok'));
  });

  await step('GET /api/settings со своим Host (без Origin — не браузерный запрос) проходит', async () => {
    const r = await rawRequest({ pathName: '/api/settings', host: `127.0.0.1:${PORT}` });
    assert.equal(r.status, 200);
  });

  await step('POST с чужим Origin отклоняется, даже если Host свой', async () => {
    repos.triggers.create({ name: 'probe', source: 'tiktok', eventType: 'follow', actions: [] });
    const id = repos.triggers.list()[0].id;
    const r = await rawRequest({ method: 'POST', pathName: `/api/triggers/${id}/test`, host: `127.0.0.1:${PORT}`, origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  });

  await step('POST со своим Origin проходит', async () => {
    const id = repos.triggers.list()[0].id;
    const r = await rawRequest({ method: 'POST', pathName: `/api/triggers/${id}/test`, host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` });
    assert.equal(r.status, 200);
  });

  await step('localhost вместо 127.0.0.1 тоже считается «своим»', async () => {
    const r = await rawRequest({ pathName: '/api/settings', host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` });
    assert.equal(r.status, 200);
  });

  await step('Socket.io с чужим Origin не подключается', async () => {
    const result = await new Promise((resolve) => {
      const s = ioClient(BASE, { reconnection: false, extraHeaders: { Origin: 'http://evil.example' }, transports: ['polling'] });
      const timer = setTimeout(() => { s.disconnect(); resolve('нет ответа за 2с'); }, 2000);
      s.on('log:recent', () => { clearTimeout(timer); s.disconnect(); resolve('подключился и получил данные'); });
      s.on('connect_error', (e) => { clearTimeout(timer); resolve(`отклонено: ${e.message}`); });
    });
    assert.ok(result.startsWith('отклонено'), result);
  });

  await step('Socket.io со своим Origin подключается и получает журнал', async () => {
    const result = await new Promise((resolve, reject) => {
      const s = ioClient(BASE, { reconnection: false, extraHeaders: { Origin: BASE }, transports: ['polling'] });
      const timer = setTimeout(() => { s.disconnect(); reject(new Error('нет ответа')); }, 3000);
      s.on('log:recent', (logs) => { clearTimeout(timer); s.disconnect(); resolve(logs); });
      s.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    });
    assert.ok(Array.isArray(result));
  });

  console.log('\nОбработка ошибок API (единый JSON-ответ)');

  await step('несуществующий маршрут /api/** -> JSON 404, не HTML', async () => {
    const r = await fetch(`${BASE}/api/there-is-no-such-route`);
    assert.equal(r.status, 404);
    assert.ok(r.headers.get('content-type').includes('application/json'));
    const body = await r.json();
    assert.ok(body.error);
  });

  await step('некорректный JSON в теле запроса -> понятная ошибка 400, не стектрейс', async () => {
    const r = await fetch(`${BASE}/api/triggers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{не json' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error);
    assert.ok(!body.error.includes('at ')); // в ответе нет фрагментов стектрейса
  });

  await step('нарушение ограничения БД (NOT NULL) -> понятная ошибка, не 500 со стеком', async () => {
    const r = await fetch(`${BASE}/api/triggers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'follow' }), // без обязательного name
    });
    assert.ok(r.status >= 400 && r.status < 500, `ожидался 4xx, получен ${r.status}`);
    const body = await r.json();
    assert.ok(body.error && !body.error.includes('SQLITE'));
  });

  console.log('\nУстойчивость Socket.io к кривым сообщениям (раньше роняли процесс)');

  await step('tts:utteranceEnd без данных не роняет сервер', async () => {
    const s = ioClient(BASE, { reconnection: false });
    await new Promise((resolve) => s.on('connect', resolve));
    s.emit('tts:utteranceEnd');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r = await fetch(`${BASE}/api/settings`);
    assert.equal(r.status, 200);
    s.disconnect();
  });

  await step('client:identify с null не роняет сервер', async () => {
    const s = ioClient(BASE, { reconnection: false });
    await new Promise((resolve) => s.on('connect', resolve));
    s.emit('client:identify', null);
    s.emit('tts:testVoice', null);
    s.emit('client:identify', 'просто строка');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const r = await fetch(`${BASE}/api/settings`);
    assert.equal(r.status, 200);
    s.disconnect();
  });

  console.log('\nАтомарность записи (триггеры и импорт)');

  await step('обновление триггера с некорректным действием не стирает прежние действия', async () => {
    const created = repos.triggers.create({
      name: 'Атомарность', source: 'tiktok', eventType: 'gift',
      actions: [{ actionType: 'tts', config: { template: 'A' } }],
    });
    assert.throws(() => {
      repos.triggers.update(created.id, {
        actions: [{ actionType: null, config: {} }], // action_type NOT NULL — должно откатиться целиком
      });
    });
    const after = repos.triggers.get(created.id);
    assert.equal(after.actions.length, 1);
    assert.equal(after.actions[0].action_type, 'tts');
  });

  await step('импорт с одной некорректной записью не применяется вообще (валидация до записи)', async () => {
    const beforeTriggers = repos.triggers.list().length;
    const r = await fetch(`${BASE}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        triggers: [
          { name: 'Хороший триггер', enabled: true, source: 'tiktok', event_type: 'follow', conditions_json: '{}', actions: [] },
          { name: null, enabled: true, source: 'tiktok', event_type: 'follow', conditions_json: '{}', actions: [] },
        ],
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(repos.triggers.list().length, beforeTriggers, 'ни одна запись не должна была добавиться');
    assert.equal(triggerEngine.triggers.some((t) => t.name === 'Хороший триггер'), false);
  });

  await step('импорт с некорректным устройством (плохой URL) не добавляет частично', async () => {
    const before = iotService.listDevices().length;
    const r = await fetch(`${BASE}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iotDevices: [{ name: 'Лампа', base_url: 'не-url' }] }),
    });
    assert.equal(r.status, 400);
    assert.equal(iotService.listDevices().length, before);
  });

  await step('корректный импорт по-прежнему проходит целиком', async () => {
    const r = await fetch(`${BASE}/api/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        triggers: [{ name: 'ОК триггер', enabled: true, source: 'tiktok', event_type: 'follow', conditions_json: '{}', actions: [] }],
      }),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.summary.triggers, 1);
    assert.ok(triggerEngine.triggers.some((t) => t.name === 'ОК триггер'));
  });

  await server.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Тест аварийно завершился:', err);
  process.exit(1);
});
