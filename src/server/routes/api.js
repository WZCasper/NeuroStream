'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const ALLOWED_MEDIA_EXT = new Set(['.webm', '.mp4', '.gif', '.png', '.jpg', '.jpeg', '.mp3', '.wav', '.ogg']);

/**
 * Создаёт Express-роутер со всеми REST-эндпоинтами приложения.
 * Роутер не хранит состояния сам — вся логика делегируется переданным сервисам/репозиториям.
 */
function createApiRouter(ctx) {
  const {
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
  } = ctx;

  const router = express.Router();

  // ============================== Настройки ==============================
  router.get('/settings', (req, res) => {
    res.json(settings.all());
  });

  router.put('/settings', (req, res) => {
    const body = req.body || {};
    for (const [key, value] of Object.entries(body)) {
      settings.set(key, value);
    }
    res.json(settings.all());
  });

  // ============================== TikTok LIVE ==============================
  router.get('/tiktok/status', (req, res) => {
    res.json(tiktokConnector.getState());
  });

  router.post('/tiktok/connect', async (req, res) => {
    const { uniqueId, signApiKey, sessionId, ttTargetIdc, autoConnect } = req.body || {};
    if (!uniqueId || !String(uniqueId).trim()) {
      return res.status(400).json({ error: 'Не указан @uniqueId стримера' });
    }
    settings.set('tiktokUniqueId', uniqueId);
    if (signApiKey !== undefined) settings.set('tiktokSignApiKey', signApiKey);
    if (sessionId !== undefined) settings.set('tiktokSessionId', sessionId);
    if (ttTargetIdc !== undefined) settings.set('tiktokTtTargetIdc', ttTargetIdc);
    settings.set('tiktokAutoConnect', autoConnect ? '1' : '0');

    try {
      await tiktokConnector.start(uniqueId, {
        signApiKey: signApiKey || settings.get('tiktokSignApiKey') || undefined,
        sessionId: sessionId || settings.get('tiktokSessionId') || undefined,
        ttTargetIdc: ttTargetIdc || settings.get('tiktokTtTargetIdc') || undefined,
      });
      res.json(tiktokConnector.getState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/tiktok/disconnect', async (req, res) => {
    settings.set('tiktokAutoConnect', '0');
    await tiktokConnector.stop();
    res.json(tiktokConnector.getState());
  });

  // Быстрая проверка "в эфире ли аккаунт" без установки полного соединения.
  router.post('/tiktok/check-live', async (req, res) => {
    const { uniqueId } = req.body || {};
    if (!uniqueId || !String(uniqueId).trim()) {
      return res.status(400).json({ error: 'Не указан @uniqueId стримера' });
    }
    try {
      const isLive = await tiktokConnector.checkIsLive(uniqueId);
      res.json({ isLive });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ============================== AxelChat ==============================
  router.get('/axelchat/status', (req, res) => {
    res.json(axelChatConnector.getState());
  });

  router.post('/axelchat/connect', (req, res) => {
    const { host, port, autoConnect } = req.body || {};
    if (host) settings.set('axelchatHost', host);
    if (port) settings.set('axelchatPort', String(port));
    settings.set('axelchatAutoConnect', autoConnect ? '1' : '0');
    axelChatConnector.start({ host, port: port ? Number(port) : undefined });
    res.json(axelChatConnector.getState());
  });

  router.post('/axelchat/disconnect', (req, res) => {
    settings.set('axelchatAutoConnect', '0');
    axelChatConnector.stop();
    res.json(axelChatConnector.getState());
  });

  // ============================== TTS-пресеты ==============================
  router.get('/tts/presets', (req, res) => {
    res.json(repos.ttsPresets.getAll());
  });

  router.put('/tts/presets/:source', (req, res) => {
    const { source } = req.params;
    if (source !== 'tiktok' && source !== 'axelchat') {
      return res.status(400).json({ error: 'source должен быть tiktok или axelchat' });
    }
    const updated = repos.ttsPresets.update(source, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Пресет не найден' });
    res.json(updated);
  });

  // ============================== Фильтр ненормативной лексики ==============================
  router.get('/profanity-rules', (req, res) => {
    res.json(repos.profanityRules.list());
  });

  router.post('/profanity-rules', (req, res) => {
    const rule = repos.profanityRules.create(req.body || {});
    profanityFilter.reload();
    res.status(201).json(rule);
  });

  router.put('/profanity-rules/:id', (req, res) => {
    const rule = repos.profanityRules.update(Number(req.params.id), req.body || {});
    if (!rule) return res.status(404).json({ error: 'Правило не найдено' });
    profanityFilter.reload();
    res.json(rule);
  });

  router.delete('/profanity-rules/:id', (req, res) => {
    repos.profanityRules.remove(Number(req.params.id));
    profanityFilter.reload();
    res.status(204).end();
  });

  router.post('/profanity-rules/test', (req, res) => {
    const { text } = req.body || {};
    res.json({ result: profanityFilter.apply(String(text || '')) });
  });

  // ============================== Триггеры ==============================
  router.get('/triggers', (req, res) => {
    res.json(repos.triggers.list());
  });

  router.post('/triggers', (req, res) => {
    const trigger = repos.triggers.create(req.body || {});
    triggerEngine.reload();
    res.status(201).json(trigger);
  });

  router.put('/triggers/:id', (req, res) => {
    const trigger = repos.triggers.update(Number(req.params.id), req.body || {});
    if (!trigger) return res.status(404).json({ error: 'Триггер не найден' });
    triggerEngine.reload();
    res.json(trigger);
  });

  router.delete('/triggers/:id', (req, res) => {
    repos.triggers.remove(Number(req.params.id));
    triggerEngine.reload();
    res.status(204).end();
  });

  // Тестовый запуск триггера — выполняет цепочку действий с синтетическим событием,
  // без проверки условий/cooldown и без необходимости реальной трансляции.
  router.post('/triggers/:id/test', async (req, res) => {
    try {
      await triggerEngine.testTrigger(Number(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============================== IoT-устройства ==============================
  router.get('/iot/devices', (req, res) => {
    res.json(iotService.listDevices());
  });

  router.post('/iot/devices', (req, res) => {
    const { name, baseUrl, healthPingPath, healthPingIntervalMs, healthPingEnabled } = req.body || {};
    if (!name || !baseUrl) return res.status(400).json({ error: 'Укажите название и base URL устройства' });
    const device = iotService.addDevice({ name, baseUrl, healthPingPath, healthPingIntervalMs, healthPingEnabled });
    res.status(201).json(device);
  });

  router.put('/iot/devices/:id', (req, res) => {
    const device = iotService.updateDevice(Number(req.params.id), req.body || {});
    if (!device) return res.status(404).json({ error: 'Устройство не найдено' });
    res.json(device);
  });

  router.delete('/iot/devices/:id', (req, res) => {
    iotService.removeDevice(Number(req.params.id));
    res.status(204).end();
  });

  router.post('/iot/devices/:id/send', async (req, res) => {
    try {
      const result = await iotService.sendRequest(Number(req.params.id), req.body || {});
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ============================== Медиатека ==============================
  //
  // Важно: браузер отправляет имена файлов в оригинальной кодировке (UTF-8), но multer/busboy
  // по умолчанию декодирует их как latin1 (это давно известное поведение библиотеки, а не
  // ошибка конкретного файла) — из-за этого русские (и вообще любые не-ASCII) имена файлов
  // превращались в "иероглифы". Исправляем перекодировкой обратно в правильный UTF-8.
  function fixOriginalFilenameEncoding(name) {
    return Buffer.from(name, 'latin1').toString('utf8');
  }

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, mediaDir),
    filename: (req, file, cb) => {
      const ext = path.extname(fixOriginalFilenameEncoding(file.originalname)).toLowerCase();
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 80 * 1024 * 1024 }, // 80 МБ на файл
    fileFilter: (req, file, cb) => {
      const ext = path.extname(fixOriginalFilenameEncoding(file.originalname)).toLowerCase();
      if (!ALLOWED_MEDIA_EXT.has(ext)) {
        cb(new Error(`Неподдерживаемый тип файла: ${ext}`));
        return;
      }
      cb(null, true);
    },
  });

  router.get('/media', (req, res) => {
    res.json(mediaLibrary.list());
  });

  router.post('/media', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
    const item = mediaLibrary.register({
      filename: req.file.filename,
      originalName: fixOriginalFilenameEncoding(req.file.originalname),
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
    });
    io.emit('media:changed');
    res.status(201).json(item);
  });

  router.delete('/media/:id', (req, res) => {
    const ok = mediaLibrary.remove(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Файл не найден' });
    io.emit('media:changed');
    res.status(204).end();
  });

  // Обработчик ошибок multer (например, неподдерживаемый формат или превышен размер файла).
  router.use((err, req, res, next) => {
    if (err) {
      logger.error('system', `Ошибка загрузки медиафайла: ${err.message}`);
      return res.status(400).json({ error: err.message });
    }
    next();
  });

  // ============================== Виджеты алертов ==============================
  router.get('/alert-widgets', (req, res) => {
    res.json(repos.alertWidgets.list());
  });

  router.post('/alert-widgets', (req, res) => {
    res.status(201).json(repos.alertWidgets.create(req.body || {}));
  });

  router.put('/alert-widgets/:id', (req, res) => {
    const widget = repos.alertWidgets.update(Number(req.params.id), req.body || {});
    if (!widget) return res.status(404).json({ error: 'Виджет не найден' });
    res.json(widget);
  });

  router.delete('/alert-widgets/:id', (req, res) => {
    repos.alertWidgets.remove(Number(req.params.id));
    res.status(204).end();
  });

  // Ручной тест алерта — отправляет событие в overlay так же, как это сделал бы триггер.
  router.post('/alert-widgets/:id/test', (req, res) => {
    const widget = repos.alertWidgets.list().find((w) => w.id === Number(req.params.id));
    if (!widget) return res.status(404).json({ error: 'Виджет не найден' });
    triggerEngine.emit('action', {
      type: 'alert',
      triggerId: null,
      config: { mediaId: widget.media_id, widgetId: widget.id },
      event: { author: { name: 'Тест' }, text: 'Тестовый алерт', type: 'chat', source: 'tiktok' },
    });
    res.json({ ok: true });
  });

  // ============================== Журнал ==============================
  router.get('/logs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    res.json(logger.recent(limit, req.query.category || null));
  });

  router.delete('/logs', (req, res) => {
    logger.clear();
    res.status(204).end();
  });

  return router;
}

module.exports = { createApiRouter };
