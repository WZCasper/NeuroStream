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
const { SileroTtsService, VALID_SPEAKERS: SILERO_VALID_SPEAKERS } = require('./services/sileroTts');
const { IoTService } = require('./services/iotService');
const { MediaLibraryService } = require('./services/mediaLibrary');
const { TriggerEngine } = require('./services/triggerEngine');
const { AutoSpeakService } = require('./services/autoSpeak');
const { ResourceMonitorService } = require('./services/resourceMonitor');
const { createApiRouter } = require('./routes/api');
const { createLocalGuard } = require('./lib/localGuard');
const { createApiErrorHandler } = require('./lib/httpErrors');

const DEFAULT_PORT = 47823;

/**
 * Определяет путь к ресурсам движка Silero TTS (exe-помощник + файл модели),
 * упакованным в установщик через electron-builder → extraResources (см.
 * package.json). В собранном приложении они лежат рядом с остальными
 * extraResources (process.resourcesPath), в режиме разработки — прямо в
 * репозитории (python-tts/dist/...).
 *
 * process.resourcesPath существует ТОЛЬКО когда процесс запущен внутри
 * Electron. Если сервер запущен отдельно (npm run server:only — такой
 * сценарий в проекте есть и используется, например, для автотестов),
 * process.resourcesPath undefined — тогда всегда используется путь
 * разработки, даже если NODE_ENV не выставлен в 'development' явно.
 */
function resolveSileroPaths() {
  const isPackaged = typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0;

  // В собранном приложении exe-помощник и модель лежат рядом друг с другом
  // внутри resourcesPath/silero (см. package.json → build.extraResources).
  // В режиме разработки exe берётся из результата локальной сборки
  // PyInstaller (python-tts/dist/silero_engine/), а модель — прямо из
  // репозитория (python-tts/model/), т.к. модель в репозиторий коммитится
  // отдельно от PyInstaller-сборки и не обязана лежать внутри dist/.
  const exeBase = isPackaged
    ? path.join(process.resourcesPath, 'silero')
    : path.join(__dirname, '..', '..', 'python-tts', 'dist', 'silero_engine');
  const modelBase = isPackaged
    ? path.join(process.resourcesPath, 'silero', 'model')
    : path.join(__dirname, '..', '..', 'python-tts', 'model');

  return {
    exePath: path.join(exeBase, process.platform === 'win32' ? 'silero_engine.exe' : 'silero_engine'),
    modelPath: path.join(modelBase, 'v4_ru.pt'),
  };
}

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

  const sileroPaths = resolveSileroPaths();
  const sileroTts = new SileroTtsService({
    exePath: sileroPaths.exePath,
    modelPath: sileroPaths.modelPath,
    outputDir: path.join(userDataDir, 'tts-cache'),
    log: (level, message) => {
      // debug-уровень из Python-процесса (сырые stderr-строки) не льём в журнал
      // приложения, который видит пользователь — он на русском и про бизнес-события,
      // а не про внутреннюю диагностику Python. Для диагностики разработчика это
      // всё равно попадает в консоль через console.error ниже.
      if (level === 'debug') return;
      const logFn = level === 'error' ? logger.error : logger.warn;
      logFn.call(logger, 'tts', message);
    },
  });
  // Запуск — в фоне, не блокируя старт остального сервера: загрузка модели
  // PyTorch может занять до минуты, а TikTok-подключение, UI и всё остальное
  // не должны ждать её готовности. Если движок не поднимется (например, у
  // пользователя повреждён установщик или антивирус заблокировал exe) —
  // пользователь просто не увидит голоса Silero в выпадающем списке и
  // получит понятную ошибку при попытке их выбрать, остальная программа
  // продолжит работать как обычно.
  sileroTts.start().then(
    () => io.emit('tts:sileroStatus', sileroTts.getStatus()),
    (err) => {
      logger.warn('tts', `Озвучка Silero TTS недоступна: ${err.message}`);
      io.emit('tts:sileroStatus', sileroTts.getStatus());
    }
  );

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

  const autoSpeak = new AutoSpeakService({
    eventBus,
    ttsQueue,
    profanityFilter,
    getPreset: (source) => repos.ttsPresets.getForSource(source),
    hasTtsTrigger: (event) => triggerEngine.hasTtsTriggerFor(event),
    logger,
  });

  // localGuard проверяет, что запрос пришёл именно на наш локальный порт (заголовок Host) и,
  // если это запрос из браузерной страницы, что страница — наша же (заголовок Origin).
  // Без этого любой открытый в браузере посторонний сайт мог бы читать настройки (включая
  // сессию TikTok), запускать триггеры и слушать журнал через сокет — см. src/server/lib/localGuard.js.
  const localGuard = createLocalGuard();

  const app = express();
  app.use(localGuard.middleware);
  app.use(express.json({ limit: '2mb' }));

  const staticRendererDir = path.join(__dirname, '..', 'renderer');
  app.use(express.static(staticRendererDir));
  app.use('/media', express.static(mediaDir));
  // Синтезированные Silero-фразы — та же папка, что передана в SileroTtsService
  // как outputDir. Раздаётся тем же localGuard-защищённым сервером (CSP у
  // tts-host.html разрешает connect-src/script-src только 'self' и
  // 127.0.0.1 — свой же порт, без стороннего хоста), поэтому проигрывание
  // через <audio src="/tts-cache/...wav"> укладывается в существующую CSP
  // без изменений.
  app.use('/tts-cache', express.static(path.join(userDataDir, 'tts-cache')));

  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    // Порт наш собственный (127.0.0.1), но без allowRequest чужой сайт в браузере пользователя
    // тоже мог бы открыть сюда WebSocket-соединение и слушать чат/журнал — allowRequest это отсекает.
    cors: { origin: '*' },
    allowRequest: (req, callback) => localGuard.allowRequest(req, callback),
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
      sileroTts,
      io,
    })
  );

  // Единый обработчик ошибок API: всегда JSON, полный текст ошибки — только в журнал программы.
  app.use(createApiErrorHandler(logger));

  // ---------------- Socket.io: реальное время ----------------
  const overlaySocketIds = new Set();
  const broadcastOverlayCount = () => io.emit('overlay:connectionCount', overlaySocketIds.size);

  // Оборачивает обработчик входящего события сокета: приводит payload к объекту (клиент может
  // прислать undefined/null/строку/что угодно — это не должно ронять сервер) и ловит исключения
  // внутри обработчика, чтобы одно кривое сообщение не обрывало соединение остальным клиентам.
  const safeOn = (socket, event, handler) => {
    socket.on(event, (payload) => {
      try {
        handler(payload && typeof payload === 'object' ? payload : {});
      } catch (err) {
        logger.error('system', `Ошибка обработки события сокета «${event}»: ${err.message}`);
      }
    });
  };

  io.on('connection', (socket) => {
    // При подключении сразу отправляем текущее состояние, чтобы UI не ждал следующего события.
    socket.emit('tiktok:status', tiktokConnector.getState());
    socket.emit('axelchat:status', axelChatConnector.getState());
    socket.emit('tts:sileroStatus', sileroTts.getStatus());
    if (axelChatConnector.lastStates) socket.emit('axelchat:states', axelChatConnector.lastStates);
    socket.emit('log:recent', logger.recent(200));
    socket.emit('iot:devices', iotService.listDevices());
    socket.emit('overlay:connectionCount', overlaySocketIds.size);

    // Страница overlay.html (OBS Browser Source / TikTok LIVE Studio Link Source) сообщает
    // о себе явно — это позволяет панели управления показать честный статус "подключено",
    // а не предполагать, что где-то там всё работает.
    safeOn(socket, 'client:identify', ({ type }) => {
      if (type === 'overlay') {
        overlaySocketIds.add(socket.id);
        broadcastOverlayCount();
      }
    });

    socket.on('disconnect', () => {
      if (overlaySocketIds.delete(socket.id)) broadcastOverlayCount();
    });

    safeOn(socket, 'tts:utteranceEnd', ({ source, queueId, audioPath }) => {
      ttsQueue.markDone(source, queueId);
      // Файл .wav, синтезированный Silero для этой фразы, больше не нужен —
      // tts-host.js прислал его путь обратно вместе с подтверждением конца
      // воспроизведения (см. правки tts-host.js). Для системных голосов
      // audioPath просто отсутствует, и удалять нечего.
      if (audioPath) sileroTts.deleteAudioFile(audioPath);
    });

    safeOn(socket, 'tts:testVoice', async ({ source, text, voice }) => {
      // Позволяет вкладке TTS & Chat проверить голос, минуя очередь конкретного источника.
      // Используем тот же resolveSpeakCommand(), что и обычная очередь, — чтобы «Тест»
      // реально проверял то же самое, что прозвучит в бою (включая синтез через Silero,
      // если выбран этот движок), а не отдельную упрощённую логику.
      const resolved = await resolveSpeakCommand({ source: `test-${source}`, queueId: 'test', text, voice });
      socket.emit('tts:speak', resolved);
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

  // Записи в журнал о проблемах очереди — не чаще раза в 10 секунд, чтобы при потоке
  // сообщений сам журнал не превратился в спам.
  let lastTtsWarnAt = 0;
  const warnTtsThrottled = (message) => {
    if (Date.now() - lastTtsWarnAt < 10000) return;
    lastTtsWarnAt = Date.now();
    logger.warn('tts', message);
  };
  ttsQueue.on('dropped', ({ source, count }) =>
    warnTtsThrottled(`Очередь озвучки «${source}» переполнена — отброшены самые старые сообщения (${count})`)
  );
  ttsQueue.on('timeout', ({ source }) =>
    warnTtsThrottled(`Озвучка «${source}»: окно озвучки не сообщило об окончании фразы — очередь продолжена`)
  );

  /**
   * Готовит команду 'tts:speak' к отправке в tts-host.js. Для voice.engine
   * === 'silero' синтезирует фразу через SileroTtsService и подставляет
   * audioUrl вместо текста для браузерного speechSynthesis; для всех
   * остальных случаев (включая отсутствие поля engine — пресеты по
   * умолчанию и старые сохранённые записи) возвращает команду как есть —
   * tts-host.js продолжает использовать Web Speech API, ничего не меняется
   * в уже рабочем пути для системных голосов.
   *
   * Если Silero выбран, но синтез не удался (движок ещё грузится, упал,
   * битый текст и т.п.) — ПАДАТЬ ОЧЕРЕДЬ ОЗВУЧКИ НЕЛЬЗЯ: откатываемся на
   * системный голос той же команды и помечаем явным предупреждением в
   * журнале, чтобы пользователь понимал, почему звучит «не тот» голос, а
   * не терял фразу молча.
   */
  async function resolveSpeakCommand(cmd) {
    const voice = cmd.voice || {};
    if (voice.engine !== 'silero') return cmd;

    try {
      const { path: audioPath } = await sileroTts.synthesize(cmd.text, voice.sileroSpeaker);
      // tts-host.js обращается к серверу по тому же origin (127.0.0.1:порт), поэтому
      // относительного пути достаточно — и он не зависит от конкретного занятого порта.
      const fileName = path.basename(audioPath);
      return {
        ...cmd,
        voice: { ...voice, audioUrl: `/tts-cache/${encodeURIComponent(fileName)}`, audioPath },
      };
    } catch (err) {
      warnTtsThrottled(`Озвучка Silero недоступна (${err.message}) — временно используется системный голос`);
      return { ...cmd, voice: { ...voice, engine: 'system' } };
    }
  }

  ttsQueue.on('speak', (cmd) => {
    resolveSpeakCommand(cmd)
      .then((resolved) => io.emit('tts:speak', resolved))
      .catch((err) => {
        // resolveSpeakCommand сама ловит ошибки синтеза и откатывается на system — сюда
        // попадание означает что-то совсем неожиданное (например, ошибка в самой функции).
        // Фраза всё равно не должна зависнуть в очереди молча — отправляем как есть.
        logger.error('tts', `Непредвиденная ошибка подготовки озвучки: ${err.message}`);
        io.emit('tts:speak', cmd);
      });
  });

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
  localGuard.setPort(port); // до этого момента localGuard отклонял всё — это безопасное поведение по умолчанию
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
      sileroTts,
      iotService,
      tiktokConnector,
      axelChatConnector,
      resourceMonitor,
      triggerEngine,
      autoSpeak,
    },
    async shutdown() {
      resourceMonitor.stop();
      iotService.stopAll();
      await tiktokConnector.stop();
      axelChatConnector.stop();
      triggerEngine.destroy();
      autoSpeak.destroy();
      ttsQueue.destroy();
      await sileroTts.shutdown();
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
