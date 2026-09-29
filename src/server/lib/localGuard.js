'use strict';

/**
 * Защита локального сервера от обращений с посторонних сайтов.
 *
 * Сервер слушает только 127.0.0.1, но браузер пользователя может быть использован как «мост»:
 *  1. DNS rebinding — чужой сайт получает свой домен, указывающий на 127.0.0.1, и читает
 *     наши данные (включая сессию TikTok) как «свой». Признак: заголовок Host не наш.
 *  2. CSRF / чужие WebSocket — страница на другом сайте шлёт запросы на наш порт.
 *     Признак: заголовок Origin не наш (браузер всегда ставит его на POST и WebSocket).
 *
 * Разрешено только то, что пришло на 127.0.0.1:<порт> или localhost:<порт>. Запросы без Origin
 * (сама программа, OBS, curl) разрешены — Origin есть только у запросов из браузерных страниц.
 * Пока порт не известен, всё отклоняется (безопасное поведение по умолчанию).
 */
function createLocalGuard() {
  let port = null;

  const hostAllowed = (host) => {
    if (port === null || typeof host !== 'string') return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };

  const originAllowed = (origin) => {
    if (origin === undefined) return true;
    if (port === null || typeof origin !== 'string') return false;
    const o = origin.toLowerCase();
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  };

  /** @returns {string|null} причина отказа или null, если обращение разрешено */
  const rejectionReason = (headers) => {
    if (!hostAllowed(headers.host)) return 'Недопустимый адрес обращения (Host)';
    if (!originAllowed(headers.origin)) return 'Обращение с постороннего сайта запрещено (Origin)';
    return null;
  };

  return {
    setPort(value) {
      port = value;
    },
    /** Express-middleware: ставится ПЕРЕД статикой и API. */
    middleware(req, res, next) {
      const reason = rejectionReason(req.headers);
      if (reason) return res.status(403).json({ error: reason });
      return next();
    },
    /** Для опции allowRequest у Socket.io. */
    allowRequest(req, callback) {
      callback(null, rejectionReason(req.headers) === null);
    },
    rejectionReason,
  };
}

module.exports = { createLocalGuard };
