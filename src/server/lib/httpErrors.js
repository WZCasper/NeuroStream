'use strict';

/** Ответ на несуществующий маршрут API — JSON, а не HTML-страница. */
function apiNotFound(req, res) {
  res.status(404).json({ error: `Маршрут API не найден: ${req.method} ${String(req.originalUrl).split('?')[0]}` });
}

const CONSTRAINT_MESSAGES = {
  SQLITE_CONSTRAINT_NOTNULL: (err) => {
    const m = /NOT NULL constraint failed: (?:\w+\.)?(\w+)/.exec(err.message || '');
    return `Не заполнено обязательное поле${m ? ` «${m[1]}»` : ''}`;
  },
  SQLITE_CONSTRAINT_UNIQUE: () => 'Такая запись уже существует',
  SQLITE_CONSTRAINT_CHECK: () => 'Недопустимое значение поля',
  SQLITE_CONSTRAINT_FOREIGNKEY: () => 'Связанная запись не найдена',
};

/** Превращает исключение в понятный человеку статус и текст, не раскрывая внутренности (пути, SQL, стек). */
function describeError(err) {
  if (err && err.type === 'entity.parse.failed') return { status: 400, message: 'Некорректный JSON в теле запроса' };
  if (err && err.type === 'entity.too.large') return { status: 413, message: 'Слишком большой запрос' };
  if (err && err.code === 'LIMIT_FILE_SIZE') return { status: 413, message: 'Файл слишком большой' };

  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    const make = CONSTRAINT_MESSAGES[err.code];
    return {
      status: err.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400,
      message: make ? make(err) : 'Нарушено ограничение данных',
    };
  }

  const status = err && (err.status || err.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) return { status, message: 'Некорректный запрос' };

  return { status: 500, message: 'Внутренняя ошибка сервера — подробности в журнале программы' };
}

/** Единый обработчик ошибок для /api: всегда JSON, полные детали — только в журнал. */
function createApiErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (!String(req.path).startsWith('/api')) return next(err);

    const { status, message } = describeError(err);
    if (status >= 500) {
      logger.error('system', `Ошибка API ${req.method} ${req.path}: ${err && err.message}`, {
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : undefined,
      });
    }
    return res.status(status).json({ error: message });
  };
}

module.exports = { apiNotFound, createApiErrorHandler, describeError };
