'use strict';

/**
 * Smoke-тест для CI: поднимает настоящий сервер NeuroStream Studio (без Electron —
 * серверная часть от Electron не зависит), проверяет ключевые API-маршруты и, самое
 * важное, что shutdown() завершается быстро при открытом Socket.io-соединении
 * (регрессионный тест на баг "программа зависает в диспетчере задач при закрытии").
 *
 * Запуск: node test/smoke.test.js
 * Код выхода 0 — всё прошло, 1 — что-то сломано (блокирует релиз в CI).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: ioClient } = require('socket.io-client');
const { createServer } = require('../src/server/index');

const SHUTDOWN_TIMEOUT_MS = 4000;

let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-smoke-'));
  const server = await createServer({ userDataDir });
  const base = `http://127.0.0.1:${server.port}`;

  console.log(`Сервер поднят на ${base}, userDataDir=${userDataDir}\n`);

  await step('GET /index.html -> 200', async () => {
    const r = await fetch(`${base}/index.html`);
    assert.equal(r.status, 200);
  });

  await step('GET /overlay.html -> 200', async () => {
    const r = await fetch(`${base}/overlay.html`);
    assert.equal(r.status, 200);
  });

  await step('GET /tts-host.html -> 200', async () => {
    const r = await fetch(`${base}/tts-host.html`);
    assert.equal(r.status, 200);
  });

  await step('GET /api/settings -> 200 {}', async () => {
    const r = await fetch(`${base}/api/settings`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(typeof body, 'object');
  });

  await step('GET /api/tts/presets -> оба источника созданы по умолчанию', async () => {
    const r = await fetch(`${base}/api/tts/presets`);
    const presets = await r.json();
    const sources = presets.map((p) => p.source).sort();
    assert.deepEqual(sources, ['axelchat', 'tiktok']);
  });

  let createdTriggerId = null;
  await step('POST /api/triggers создаёт триггер', async () => {
    const r = await fetch(`${base}/api/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Smoke test trigger',
        source: 'tiktok',
        eventType: 'gift',
        conditions: {},
        actions: [{ actionType: 'tts', config: {} }],
      }),
    });
    assert.equal(r.status, 201);
    const trigger = await r.json();
    assert.ok(trigger.id);
    createdTriggerId = trigger.id;
  });

  await step('POST /api/triggers/:id/test запускает действия без ошибок', async () => {
    const r = await fetch(`${base}/api/triggers/${createdTriggerId}/test`, { method: 'POST' });
    assert.equal(r.status, 200);
  });

  await step('DELETE /api/triggers/:id удаляет триггер', async () => {
    const r = await fetch(`${base}/api/triggers/${createdTriggerId}`, { method: 'DELETE' });
    assert.equal(r.status, 204);
  });

  await step('GET /api/export возвращает копию БЕЗ чувствительных данных', async () => {
    // Сначала сохраняем "чувствительное" значение
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'cyber-green' }),
    });

    const r = await fetch(`${base}/api/export`);
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.formatVersion, 1);
    assert.equal(data.settings.theme, 'cyber-green');
    assert.equal(data.settings.tiktokSessionId, undefined, 'сессионные cookie не должны попадать в экспорт');
    assert.equal(data.settings.tiktokSignApiKey, undefined, 'ключ подписи не должен попадать в экспорт');
    assert.ok(Array.isArray(data.triggers));
  });

  await step('POST /api/import восстанавливает триггеры и устройства', async () => {
    const payload = {
      formatVersion: 1,
      settings: {},
      triggers: [
        {
          name: 'Импортированный триггер',
          enabled: true,
          source: 'tiktok',
          event_type: 'gift',
          conditions_json: JSON.stringify({ giftName: 'Rose' }),
          cooldown_ms: 1000,
          actions: [{ action_type: 'tts', config_json: JSON.stringify({}) }],
        },
      ],
      iotDevices: [
        { name: 'Тестовая лампа', base_url: 'http://192.168.1.50', health_ping_path: '/ping', health_ping_interval_ms: 15000, health_ping_enabled: 0 },
      ],
      profanityRules: [],
      alertWidgets: [],
      ttsPresets: [],
    };
    const r = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.equal(result.summary.triggers, 1);
    assert.equal(result.summary.iotDevices, 1);

    const triggers = await (await fetch(`${base}/api/triggers`)).json();
    assert.ok(triggers.some((t) => t.name === 'Импортированный триггер'));
  });

  await step('POST /api/tiktok/reconnect без настроенного подключения -> понятная ошибка', async () => {
    const r = await fetch(`${base}/api/tiktok/reconnect`, { method: 'POST' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.error.length > 0);
  });

  await step('Socket.io: клиент подключается и получает начальное состояние', async () => {
    const client = ioClient(base, { reconnection: false });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('нет подключения за 3с')), 3000);
        client.on('connect', () => clearTimeout(timeout));
        client.on('tiktok:status', (state) => {
          assert.equal(state.status, 'idle');
          clearTimeout(timeout);
          resolve();
        });
      });
    } finally {
      client.disconnect();
    }
  });

  // Регрессионный тест на реальный баг: открытое Socket.io-соединение раньше блокировало
  // httpServer.close() навсегда, из-за чего процесс зависал в диспетчере задач.
  await step(`shutdown() завершается быстрее ${SHUTDOWN_TIMEOUT_MS}мс даже с открытым Socket.io-соединением`, async () => {
    const persistentClient = ioClient(base, { reconnection: false });
    await new Promise((resolve) => persistentClient.on('connect', resolve));

    const start = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
    }, SHUTDOWN_TIMEOUT_MS);

    await server.shutdown();
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    if (timedOut) throw new Error(`shutdown() не уложился в ${SHUTDOWN_TIMEOUT_MS}мс — регрессия бага зависания при закрытии!`);
    console.log(`     (заняло ${elapsed}мс)`);
  });

  fs.rmSync(userDataDir, { recursive: true, force: true });

  console.log(`\n${passed} пройдено, ${failed} провалено`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error('Smoke-тест упал с необработанной ошибкой:', err);
  process.exit(1);
});
