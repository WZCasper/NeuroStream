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

  // Принудительное переподключение по кнопке — не дожидаясь автоматического таймера.
  router.post('/tiktok/reconnect', async (req, res) => {
    try {
      await tiktokConnector.reconnectNow();
      res.json(tiktokConnector.getState());
    } catch (err) {
      res.status(400).json({ error: err.message });
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

  router.post('/axelchat/reconnect', (req, res) => {
    axelChatConnector.reconnectNow();
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

  // ============================== Экспорт / импорт настроек ==============================
  // Резервная копия конфигурации (триггеры, виджеты, пресеты TTS, IoT-устройства, фильтр слов,
  // общие настройки) в один JSON-файл. Сессионные cookie TikTok и ключ подписи сознательно
  // НЕ экспортируются — это чувствительные данные уровня пароля, их нельзя класть в файл,
  // который может быть скопирован/переслан. Медиафайлы (сами видео/gif/mp3) тоже не входят
  // в экспорт — только ссылки на них у виджетов; при переносе на другой компьютер их нужно
  // будет загрузить заново в Медиатеку.
  const NON_EXPORTABLE_SETTINGS = new Set(['tiktokSessionId', 'tiktokTtTargetIdc', 'tiktokSignApiKey']);

  router.get('/export', (req, res) => {
    const allSettings = settings.all();
    const exportableSettings = {};
    for (const [key, value] of Object.entries(allSettings)) {
      if (!NON_EXPORTABLE_SETTINGS.has(key)) exportableSettings[key] = value;
    }

    res.json({
      exportedAt: new Date().toISOString(),
      formatVersion: 1,
      settings: exportableSettings,
      ttsPresets: repos.ttsPresets.getAll(),
      profanityRules: repos.profanityRules.list(),
      triggers: repos.triggers.list(),
      iotDevices: iotService.listDevices(),
      alertWidgets: repos.alertWidgets.list(),
    });
  });

  router.post('/import', (req, res) => {
    const data = req.body || {};
    const summary = { settings: 0, ttsPresets: 0, profanityRules: 0, triggers: 0, iotDevices: 0, alertWidgets: 0 };

    try {
      if (data.settings && typeof data.settings === 'object') {
        for (const [key, value] of Object.entries(data.settings)) {
          if (NON_EXPORTABLE_SETTINGS.has(key)) continue; // на всякий случай, если файл был отредактирован вручную
          settings.set(key, value);
          summary.settings++;
        }
      }
      if (Array.isArray(data.ttsPresets)) {
        for (const preset of data.ttsPresets) {
          if (preset.source === 'tiktok' || preset.source === 'axelchat') {
            repos.ttsPresets.update(preset.source, preset);
            summary.ttsPresets++;
          }
        }
      }
      if (Array.isArray(data.profanityRules)) {
        for (const rule of data.profanityRules) {
          repos.profanityRules.create({
            pattern: rule.pattern,
            isRegex: !!rule.is_regex,
            flags: rule.flags,
            replacement: rule.replacement,
            enabled: rule.enabled !== 0,
          });
          summary.profanityRules++;
        }
      }
      if (Array.isArray(data.iotDevices)) {
        for (const device of data.iotDevices) {
          iotService.addDevice({
            name: device.name,
            baseUrl: device.base_url,
            healthPingPath: device.health_ping_path,
            healthPingIntervalMs: device.health_ping_interval_ms,
            healthPingEnabled: !!device.health_ping_enabled,
          });
          summary.iotDevices++;
        }
      }
      if (Array.isArray(data.alertWidgets)) {
        for (const widget of data.alertWidgets) {
          repos.alertWidgets.create({
            name: widget.name,
            mediaId: null, // ссылки на медиафайлы не переносятся — файлов нет на этом компьютере
            durationMs: widget.duration_ms,
            customCss: widget.custom_css,
            textTemplate: widget.text_template,
          });
          summary.alertWidgets++;
        }
      }
      if (Array.isArray(data.triggers)) {
        for (const trigger of data.triggers) {
          repos.triggers.create({
            name: trigger.name,
            enabled: !!trigger.enabled,
            source: trigger.source,
            eventType: trigger.event_type,
            conditions: safeJsonParse(trigger.conditions_json),
            cooldownMs: trigger.cooldown_ms,
            actions: (trigger.actions || []).map((a) => ({
              actionType: a.action_type,
              config: safeJsonParse(a.config_json),
            })),
          });
          summary.triggers++;
        }
      }

      profanityFilter.reload();
      triggerEngine.reload();
      logger.info('system', 'Импортирована резервная копия настроек', summary);
      res.json({ ok: true, summary });
    } catch (err) {
      res.status(400).json({ error: `Ошибка импорта: ${err.message}` });
    }
  });

  return router;
}

function safeJsonParse(str) {
  if (!str) return {};
  if (typeof str === 'object') return str; // уже объект (например, если пришло не из БД, а напрямую из JSON-файла экспорта)
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

module.exports = { createApiRouter };
