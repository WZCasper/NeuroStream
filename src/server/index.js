'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server: SocketIOServer } = require('socket.io');

const { openDatabase, createSettingsRepo } = require('./db/database');
const { createRepos } = require('./db/repos');
const { createSecureSettingsRepo } = require('./lib/secureStore');
const { Logger } = require('./lib/logger');
const { EventBus } = require('./services/eventBus');
const { TikTokConnectorService } = require('./services/tiktokConnector');
const { AxelChatConnectorService } = require('./services/axelChatConnector');
const { ProfanityFilterService } = require('./services/profanityFilter');
const { TTSQueueManager } = require('./services/ttsQueue');
const { IoTService } = require('./services/iotService');
const { MediaLibraryService } = require('./services/mediaLibrary');
const { TriggerEngine } = require('./services/triggerEngine');
const { ResourceMonitorService } = require('./services/resourceMonitor');
const { createApiRouter } = require('./routes/api');

const DEFAULT_PORT = 47823;

// Настройки, которые всегда должны храниться на диске в зашифрованном виде (это фактически
// пароли/токены доступа к аккаунту TikTok) — см. src/server/lib/secureStore.js.
const SENSITIVE_SETTINGS_KEYS = ['tiktokSessionId', 'tiktokTtTargetIdc', 'tiktokSignApiKey'];

/**
 * Поднимает встроенный локальный сервер NeuroStream Studio: базу данных,
 * все фоновые сервисы (TikTok/AxelChat коннекторы, движок триггеров, TTS-очередь,
 * IoT, медиатеку) и HTTP+WebSocket сервер, который одновременно:
 *   - отдаёт статические страницы интерфейса (index.html для панели управления,
 *     overlay.html для OBS Browser Source, tts-host.html для озвучки),
 *   - предоставляет REST API (/api/**) для управления настройками,
 *   - транслирует события в реальном времени через Socket.io.
 *
 * @param {{ userDataDir: string, electronApp?: import('electron').App, safeStorage?: import('electron').safeStorage }} options
 */
async function createServer({ userDataDir, electronApp = null, safeStorage = null }) {
  const db = openDatabase(userDataDir);
  const rawSettings = createSettingsRepo(db);
  const logger = new Logger(db);
  const settings = createSecureSettingsRepo(rawSettings, safeStorage, SENSITIVE_SETTINGS_KEYS, {
    warn: (msg) => logger.warn('system', msg),
  });
  const migratedCount = settings.migrateLegacyPlaintext();
  if (migratedCount > 0) logger.info('system', `Зашифровано ${migratedCount} ранее незашифрованных настроек (сессия TikTok)`);

  const repos = createRepos(db);
  repos.ttsPresets.ensureDefaults();

  const eventBus = new EventBus();
  const mediaDir = path.join(userDataDir, 'media');
  const mediaLibrary = new MediaLibraryService(db, mediaDir);
  const profanityFilter = new ProfanityFilterService(db);
  const ttsQueue = new TTSQueueManager();
  const iotService = new IoTService(db, logger);
  const tiktokConnector = new TikTokConnectorService(eventBus, logger);
  const axelChatConnector = new AxelChatConnectorService(eventBus, logger);
  const resourceMonitor = new ResourceMonitorService(electronApp, 2000);

  const triggerEngine = new TriggerEngine(
    db,
    eventBus,
    ttsQueue,
    profanityFilter,
    iotService,
    logger,
    (source) => repos.ttsPresets.getForSource(source),
    tiktokConnector
  );

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const staticRendererDir = path.join(__dirname, '..', 'renderer');
  app.use(express.static(staticRendererDir));
  app.use('/media', express.static(mediaDir));

  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*' }, // сервер слушает только localhost, поэтому открытый CORS безопасен
  });

  app.use(
    '/api',
    createApiRouter({
      db,
      settings,
      repos,
      logger,
      mediaLibrary,
      mediaDir,
      profanityFilter,
      iotService,
      tiktokConnector,
      axelChatConnector,
      triggerEngine,
      io,
    })
  );

  // ---------------- Socket.io: реальное время ----------------
  const overlaySocketIds = new Set();
  const broadcastOverlayCount = () => io.emit('overlay:connectionCount', overlaySocketIds.size);

  io.on('connection', (socket) => {
    // При подключении сразу отправляем текущее состояние, чтобы UI не ждал следующего события.
    socket.emit('tiktok:status', tiktokConnector.getState());
    socket.emit('axelchat:status', axelChatConnector.getState());
    if (axelChatConnector.lastStates) socket.emit('axelchat:states', axelChatConnector.lastStates);
    socket.emit('log:recent', logger.recent(200));
    socket.emit('iot:devices', iotService.listDevices());
    socket.emit('overlay:connectionCount', overlaySocketIds.size);

    // Страница overlay.html (OBS Browser Source / TikTok LIVE Studio Link Source) сообщает
    // о себе явно — это позволяет панели управления показать честный статус "подключено",
    // а не предполагать, что где-то там всё работает.
    socket.on('client:identify', ({ type } = {}) => {
      if (type === 'overlay') {
        overlaySocketIds.add(socket.id);
        broadcastOverlayCount();
      }
    });

    socket.on('disconnect', () => {
      if (overlaySocketIds.delete(socket.id)) broadcastOverlayCount();
    });

    socket.on('tts:utteranceEnd', ({ source, queueId }) => {
      ttsQueue.markDone(source, queueId);
    });

    socket.on('tts:testVoice', ({ source, text, voice }) => {
      // Позволяет вкладке TTS & Chat проверить голос, минуя очередь конкретного источника.
      socket.emit('tts:speak', { source: `test-${source}`, queueId: 'test', text, voice });
    });
  });

  logger.on('entry', (entry) => io.emit('log:entry', entry));

  tiktokConnector.on('status', (state) => io.emit('tiktok:status', state));
  axelChatConnector.on('status', (state) => io.emit('axelchat:status', state));
  axelChatConnector.on('platformStates', (states) => io.emit('axelchat:states', states));
  iotService.on('deviceStatus', (state) => io.emit('iot:status', state));

  eventBus.on('event', (event) => io.emit('event:new', event));

  triggerEngine.on('matched', (info) => io.emit('trigger:matched', info));
  triggerEngine.on('action', (action) => {
    if (action.type === 'alert') io.emit('overlay:alert', action);
    if (action.type === 'sound') io.emit('overlay:sound', action);
  });

  ttsQueue.on('speak', (cmd) => io.emit('tts:speak', cmd));

  resourceMonitor.on('sample', (sample) => io.emit('resource:sample', sample));
  resourceMonitor.start();

  iotService.startAll();

  // ---------------- Автоочистка старого журнала (чтобы не рос бесконечно на долгих стримах) ----------------
  const LOG_RETENTION_DAYS = 30;
  const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // раз в сутки
  function cleanupOldLogs() {
    const info = db.prepare("DELETE FROM logs WHERE created_at < datetime('now', ?)").run(`-${LOG_RETENTION_DAYS} days`);
    if (info.changes > 0) logger.info('system', `Автоочистка журнала: удалено ${info.changes} записей старше ${LOG_RETENTION_DAYS} дней`);
  }
  cleanupOldLogs();
  const logCleanupTimer = setInterval(cleanupOldLogs, LOG_CLEANUP_INTERVAL_MS);
  logCleanupTimer.unref?.();

  // ---------------- Автозапуск подключений, если ранее настроены ----------------
  const savedTikTokUsername = settings.get('tiktokUniqueId');
  if (savedTikTokUsername && settings.get('tiktokAutoConnect') === '1') {
    tiktokConnector.start(savedTikTokUsername, {
      signApiKey: settings.get('tiktokSignApiKey') || undefined,
      sessionId: settings.get('tiktokSessionId') || undefined,
      ttTargetIdc: settings.get('tiktokTtTargetIdc') || undefined,
    });
  }
  if (settings.get('axelchatAutoConnect') === '1') {
    axelChatConnector.start({
      host: settings.get('axelchatHost') || undefined,
      port: settings.get('axelchatPort') ? Number(settings.get('axelchatPort')) : undefined,
    });
  }

  const port = await listenOnFreePort(httpServer, Number(process.env.NSS_PORT) || DEFAULT_PORT);
  logger.info('system', `NeuroStream Studio сервер запущен на порту ${port}`);

  return {
    app,
    httpServer,
    io,
    port,
    db,
    services: {
      settings,
      repos,
      logger,
      eventBus,
      mediaLibrary,
      profanityFilter,
      ttsQueue,
      iotService,
      tiktokConnector,
      axelChatConnector,
      resourceMonitor,
      triggerEngine,
    },
    async shutdown() {
      resourceMonitor.stop();
      iotService.stopAll();
      await tiktokConnector.stop();
      axelChatConnector.stop();
      triggerEngine.destroy();
      // io.close() отключает все Socket.io-соединения (окна Electron держат их постоянно
      // открытыми) и только после этого закрывает сам httpServer — обычный httpServer.close()
      // без этого зависает навсегда, ожидая закрытия соединений, которые сами никогда не закроются.
      await new Promise((resolve) => io.close(resolve));
      db.close();
    },
  };
}

/** Пытается занять предпочитаемый порт; при занятости перебирает следующие 10 портов. */
function listenOnFreePort(httpServer, preferredPort, attemptsLeft = 10) {
  return new Promise((resolve, reject) => {
    const tryPort = (port, remaining) => {
      httpServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && remaining > 0) {
          tryPort(port + 1, remaining - 1);
        } else {
          reject(err);
        }
      });
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeAllListeners('error');
        resolve(port);
      });
    };
    tryPort(preferredPort, attemptsLeft);
  });
}

module.exports = { createServer };
