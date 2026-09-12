'use strict';

const { EventEmitter } = require('node:events');

const PING_TIMEOUT_MS = 4000;
const REQUEST_TIMEOUT_MS = 6000;

/**
 * IoTService — управляет внешними устройствами (например, ESP32) через
 * обычные HTTP-запросы и следит за их доступностью с помощью регулярного
 * health-ping (GET на настраиваемый путь), обновляя статус 🟢/🔴 в базе
 * данных и рассылая изменения статуса через события 'deviceStatus'.
 *
 * Никакой эмуляции устройств: если устройство недоступно, статус
 * становится 'offline' по факту неуспешного запроса, а не подделывается.
 */
class IoTService extends EventEmitter {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {import('../lib/logger').Logger} logger
   */
  constructor(db, logger) {
    super();
    this.db = db;
    this.logger = logger;
    /** @type {Map<number, ReturnType<typeof setInterval>>} */
    this._pingTimers = new Map();
  }

  listDevices() {
    return this.db.prepare('SELECT * FROM iot_devices ORDER BY id ASC').all();
  }

  getDevice(id) {
    return this.db.prepare('SELECT * FROM iot_devices WHERE id = ?').get(id);
  }

  addDevice({ name, baseUrl, healthPingPath, healthPingIntervalMs, healthPingEnabled }) {
    const info = this.db
      .prepare(
        `INSERT INTO iot_devices (name, base_url, health_ping_path, health_ping_interval_ms, health_ping_enabled)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(name, baseUrl, healthPingPath || '/ping', healthPingIntervalMs || 15000, healthPingEnabled ? 1 : 0);
    const device = this.getDevice(info.lastInsertRowid);
    if (device.health_ping_enabled) this._startPinging(device);
    return device;
  }

  updateDevice(id, fields) {
    const device = this.getDevice(id);
    if (!device) return null;
    const merged = { ...device, ...fields };
    this.db
      .prepare(
        `UPDATE iot_devices SET name=?, base_url=?, health_ping_path=?, health_ping_interval_ms=?, health_ping_enabled=? WHERE id=?`
      )
      .run(
        merged.name,
        merged.base_url ?? merged.baseUrl,
        merged.health_ping_path ?? merged.healthPingPath,
        merged.health_ping_interval_ms ?? merged.healthPingIntervalMs,
        (merged.health_ping_enabled ?? merged.healthPingEnabled) ? 1 : 0,
        id
      );
    this._stopPinging(id);
    const updated = this.getDevice(id);
    if (updated.health_ping_enabled) this._startPinging(updated);
    return updated;
  }

  removeDevice(id) {
    this._stopPinging(id);
    this.db.prepare('DELETE FROM iot_devices WHERE id = ?').run(id);
  }

  /** Запускает health-ping для всех устройств с включённым пингом (вызывается при старте сервера). */
  startAll() {
    for (const device of this.listDevices()) {
      if (device.health_ping_enabled) this._startPinging(device);
    }
  }

  stopAll() {
    for (const id of Array.from(this._pingTimers.keys())) this._stopPinging(id);
  }

  _startPinging(device) {
    this._stopPinging(device.id);
    const timer = setInterval(() => this._pingOnce(device.id), device.health_ping_interval_ms || 15000);
    timer.unref?.();
    this._pingTimers.set(device.id, timer);
    this._pingOnce(device.id); // сразу выполняем первую проверку, не дожидаясь интервала
  }

  _stopPinging(id) {
    const t = this._pingTimers.get(id);
    if (t) clearInterval(t);
    this._pingTimers.delete(id);
  }

  async _pingOnce(id) {
    const device = this.getDevice(id);
    if (!device) return;

    const url = joinUrl(device.base_url, device.health_ping_path || '/ping');
    const startedAt = Date.now();
    let status = 'offline';
    let latencyMs = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timeout);
      latencyMs = Date.now() - startedAt;
      status = res.ok ? 'online' : 'offline';
    } catch {
      status = 'offline';
      latencyMs = null;
    }

    this.db
      .prepare('UPDATE iot_devices SET last_status=?, last_checked_at=?, last_latency_ms=? WHERE id=?')
      .run(status, new Date().toISOString(), latencyMs, id);

    this.emit('deviceStatus', { id, status, latencyMs, checkedAt: new Date().toISOString() });
  }

  /**
   * Отправляет запрос устройству — действие триггера "Управление IoT-устройствами".
   * @param {number} deviceId
   * @param {{ method?: 'GET'|'POST', path?: string, body?: any, headers?: Record<string,string> }} request
   */
  async sendRequest(deviceId, request = {}) {
    const device = this.getDevice(deviceId);
    if (!device) throw new Error(`Устройство #${deviceId} не найдено`);

    const method = (request.method || 'GET').toUpperCase();
    const url = joinUrl(device.base_url, request.path || '/');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const init = { method, signal: controller.signal, headers: request.headers || {} };
      if (method === 'POST' && request.body !== undefined) {
        init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
        init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      }
      const res = await fetch(url, init);
      this.logger.info('iot', `${method} ${url} -> ${res.status}`, { deviceId });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      this.logger.error('iot', `Ошибка запроса к устройству "${device.name}": ${err.message}`, { deviceId, url });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return `${b}/${p}`;
}

module.exports = { IoTService };
