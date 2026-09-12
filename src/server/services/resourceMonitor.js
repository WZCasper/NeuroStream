'use strict';

const os = require('node:os');
const { EventEmitter } = require('node:events');

/**
 * ResourceMonitorService — периодически измеряет реальное использование
 * CPU и RAM процессом приложения (через process.cpuUsage() и, если доступно,
 * Electron app.getAppMetrics()) и системой в целом (через модуль os).
 * Никаких приблизительных/случайных чисел — только фактические измерения ОС.
 *
 * @fires ResourceMonitorService#sample  { process: {...}, system: {...} }
 */
class ResourceMonitorService extends EventEmitter {
  /**
   * @param {{ getAppMetrics?: () => any[] }} [electronApp] Передайте `electron.app`
   *   из главного процесса, чтобы получать точные метрики по процессам Electron
   *   (main + renderer + GPU). Необязательно — без него используется только process.cpuUsage().
   * @param {number} [intervalMs]
   */
  constructor(electronApp = null, intervalMs = 2000) {
    super();
    this.electronApp = electronApp;
    this.intervalMs = intervalMs;
    this._timer = null;
    this._lastCpuUsage = process.cpuUsage();
    this._lastSampleTime = process.hrtime.bigint();
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sample(), this.intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _sample() {
    // --- CPU самого процесса Node (главный процесс) ---
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - this._lastSampleTime) / 1e6;
    const usage = process.cpuUsage(this._lastCpuUsage);
    this._lastCpuUsage = process.cpuUsage();
    this._lastSampleTime = now;

    const cpuMs = (usage.user + usage.system) / 1000; // микросекунды -> миллисекунды
    const cpuPercentSingleCore = elapsedMs > 0 ? (cpuMs / elapsedMs) * 100 : 0;
    const cpuCount = os.cpus().length || 1;

    const mem = process.memoryUsage();

    // --- Метрики всех процессов Electron (main/renderer/gpu), если доступно ---
    let electronMetrics = null;
    if (this.electronApp && typeof this.electronApp.getAppMetrics === 'function') {
      try {
        const metrics = this.electronApp.getAppMetrics();
        const totalWorkingSetKb = metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize || 0), 0);
        const totalCpuPercent = metrics.reduce((sum, m) => sum + (m.cpu?.percentCPUUsage || 0), 0);
        electronMetrics = {
          processCount: metrics.length,
          totalMemoryMb: Math.round((totalWorkingSetKb / 1024) * 10) / 10,
          totalCpuPercent: Math.round(totalCpuPercent * 10) / 10,
          byProcess: metrics.map((m) => ({
            type: m.type,
            pid: m.pid,
            cpuPercent: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10,
            memoryMb: Math.round(((m.memory?.workingSetSize || 0) / 1024) * 10) / 10,
          })),
        };
      } catch {
        electronMetrics = null;
      }
    }

    const sample = {
      timestamp: Date.now(),
      process: {
        cpuPercent: Math.round((cpuPercentSingleCore / cpuCount) * 10) / 10, // нормализовано по числу ядер
        rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      },
      electron: electronMetrics,
      system: {
        cpuCount,
        loadAvg1m: os.loadavg()[0],
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMb: Math.round(os.freemem() / 1024 / 1024),
        usedMemPercent: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10,
      },
    };

    this.emit('sample', sample);
  }
}

module.exports = { ResourceMonitorService };
