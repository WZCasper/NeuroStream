'use strict';

/**
 * NeuroStream Studio — управление движком Silero TTS (Python-процесс,
 * упакованный через PyInstaller в silero_engine.exe).
 *
 * Процесс запускается ОДИН РАЗ при старте приложения и живёт в фоне —
 * перезапуск на каждую фразу означал бы повторную загрузку PyTorch-модели
 * при каждом сообщении в чате, что недопустимо медленно для стрима.
 *
 * Протокол: NDJSON через stdin/stdout дочернего процесса (см.
 * python-tts/silero_engine.py — там тот же контракт описан подробно).
 *
 * Публичный API:
 *   const silero = new SileroTtsService({ exePath, modelPath, outputDir, log });
 *   await silero.start();                      // поднимает процесс, ждёт "ready"
 *   const { path, durationMs } = await silero.synthesize(text, speaker);
 *   silero.getStatus();                         // 'starting' | 'ready' | 'error' | 'stopped'
 *   await silero.shutdown();                    // корректно останавливает процесс
 *
 * Модуль НЕ знает ничего про Electron/очередь TTS — это чистый адаптер
 * к внешнему процессу, используется из ttsQueue.js/index.js.
 */

const { spawn } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VALID_SPEAKERS = ['aidar', 'baya', 'kseniya', 'xenia', 'eugene', 'random'];
const DEFAULT_SAMPLE_RATE = 48000;

// Сколько ждём ответа "ready" от процесса при старте, прежде чем считать
// запуск неудавшимся. Загрузка модели PyTorch на CPU — не мгновенная
// операция, особенно на слабом железе, поэтому таймаут щедрый.
const STARTUP_TIMEOUT_MS = 60_000;

// Сколько ждём ответа на отдельный запрос синтеза, прежде чем считать его
// повисшим и отклонить с ошибкой (не блокируя всю очередь TTS навсегда).
const REQUEST_TIMEOUT_MS = 15_000;

// Сколько ждём после SIGTERM, прежде чем принудительно убить процесс —
// защита от того самого бага "процесс остаётся в диспетчере задач",
// который уже однажды чинили для httpServer/socket.io в этом проекте.
const SHUTDOWN_GRACE_MS = 3_000;

class SileroTtsService {
  /**
   * @param {object} opts
   * @param {string} opts.exePath    Путь к silero_engine.exe
   * @param {string} opts.modelPath  Путь к файлу модели v4_ru.pt
   * @param {string} opts.outputDir  Куда класть синтезированные .wav
   * @param {(level: string, message: string) => void} [opts.log] Коллбек логирования
   */
  constructor(opts) {
    if (!opts || !opts.exePath || !opts.modelPath || !opts.outputDir) {
      throw new Error('SileroTtsService: обязательны exePath, modelPath, outputDir');
    }

    this.exePath = opts.exePath;
    this.modelPath = opts.modelPath;
    this.outputDir = opts.outputDir;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};

    this.process = null;
    this.rl = null;
    this.status = 'stopped';
    this.availableSpeakers = VALID_SPEAKERS.slice();
    this.lastError = null;

    // Карта id-запроса -> { resolve, reject, timer } для сопоставления
    // ответов NDJSON с ожидающими промисами.
    this.pendingRequests = new Map();

    // Промис, который резолвится/реджектится при получении стартового
    // сообщения {"ready": true/false, ...} — используется внутри start().
    this._readyWaiter = null;
  }

  /**
   * Запускает дочерний процесс и дожидается сообщения о готовности модели.
   * Безопасно вызывать повторно — если процесс уже запущен/запускается,
   * просто вернёт тот же промис готовности, а не породит второй процесс.
   */
  start() {
    if (this.status === 'ready') {
      return Promise.resolve();
    }
    if (this._startPromise) {
      return this._startPromise;
    }

    this.status = 'starting';
    this.lastError = null;

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
    this.cleanupStaleFiles();

    this._startPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        this._startPromise = null;
        if (err) {
          this.status = 'error';
          this.lastError = err.message;
          reject(err);
        } else {
          this.status = 'ready';
          resolve();
        }
      };

      const startupTimer = setTimeout(() => {
        settle(new Error(
          `Движок Silero TTS не ответил за ${STARTUP_TIMEOUT_MS / 1000} с. ` +
          'Возможные причины: повреждённый файл модели, нехватка памяти, ' +
          'антивирус заблокировал silero_engine.exe.'
        ));
      }, STARTUP_TIMEOUT_MS);

      let child;
      try {
        child = spawn(this.exePath, [], {
          env: {
            ...process.env,
            NSS_SILERO_MODEL_PATH: this.modelPath,
            NSS_SILERO_OUTPUT_DIR: this.outputDir,
          },
          windowsHide: true,
        });
      } catch (spawnErr) {
        settle(new Error(`Не удалось запустить silero_engine.exe: ${spawnErr.message}`));
        return;
      }

      this.process = child;

      child.on('error', (err) => {
        this.log('error', `Ошибка процесса Silero TTS: ${err.message}`);
        settle(new Error(`Процесс Silero TTS завершился с ошибкой: ${err.message}`));
        this._rejectAllPending(new Error('Процесс озвучки Silero неожиданно завершился'));
      });

      child.on('exit', (code, signal) => {
        this.log(
          'warn',
          `Процесс Silero TTS завершился (код=${code}, сигнал=${signal})`
        );
        const wasReady = this.status === 'ready';
        this.status = 'stopped';
        this.process = null;
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        settle(new Error(`Процесс Silero TTS завершился раньше, чем сообщил о готовности (код ${code})`));
        this._rejectAllPending(new Error('Процесс озвучки Silero неожиданно завершился'));

        // Если процесс упал ПОСЛЕ того как уже был готов (а не на старте) —
        // это не ошибка запуска, а обрыв во время работы. Поднимать
        // автоматический перезапуск здесь намеренно НЕ делаем: решение,
        // перезапускать ли автоматически или показать пользователю статус
        // "озвучка Silero недоступна", — на уровне вызывающего кода
        // (index.js), у него есть контекст всего приложения и индикаторы UI.
        if (wasReady) {
          this.lastError = `Процесс озвучки неожиданно остановился (код ${code})`;
        }
      });

      child.stderr.on('data', (chunk) => {
        // Диагностические сообщения Python-скрипта — пишем в лог приложения,
        // но НЕ пытаемся парсить как протокол (протокол только в stdout).
        const text = chunk.toString('utf8').trim();
        if (text) this.log('debug', `[silero stderr] ${text}`);
      });

      this.rl = readline.createInterface({ input: child.stdout });
      this.rl.on('line', (line) => this._handleLine(line, settle));
    });

    return this._startPromise;
  }

  _handleLine(line, settleStart) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      this.log('warn', `Нераспознанная строка от процесса Silero TTS (не JSON): ${trimmed.slice(0, 200)}`);
      return;
    }

    // Стартовое сообщение о готовности модели (без поля id).
    if (Object.prototype.hasOwnProperty.call(msg, 'ready')) {
      if (msg.ready) {
        if (Array.isArray(msg.speakers) && msg.speakers.length > 0) {
          this.availableSpeakers = msg.speakers;
        }
        if (settleStart) settleStart(null);
      } else {
        if (settleStart) settleStart(new Error(msg.error || 'Не удалось загрузить модель Silero'));
      }
      return;
    }

    // Ответ на конкретный запрос синтеза.
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      // Ответ пришёл после таймаута запроса (уже отклонён) — просто игнорируем.
      return;
    }
    this.pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.ok) {
      pending.resolve({ path: msg.path, durationMs: msg.duration_ms });
    } else {
      pending.reject(new Error(msg.error || 'Неизвестная ошибка синтеза Silero TTS'));
    }
  }

  _rejectAllPending(err) {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  /**
   * Синтезирует фразу и возвращает путь к готовому .wav-файлу.
   * @param {string} text
   * @param {string} speaker один из VALID_SPEAKERS (некорректное значение
   *   безопасно заменяется на 'baya' уже на стороне Python-скрипта)
   * @param {number} [sampleRate]
   * @returns {Promise<{ path: string, durationMs: number }>}
   */
  synthesize(text, speaker, sampleRate = DEFAULT_SAMPLE_RATE) {
    if (this.status !== 'ready' || !this.process) {
      return Promise.reject(new Error(
        `Движок Silero TTS недоступен (текущий статус: ${this.status}). ` +
        (this.lastError ? `Причина: ${this.lastError}` : '')
      ));
    }

    const id = crypto.randomUUID();
    const request = { id, text, speaker, sample_rate: sampleRate };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Синтез речи Silero TTS не ответил за ${REQUEST_TIMEOUT_MS / 1000} с`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Не удалось отправить запрос движку Silero TTS: ${err.message}`));
      }
    });
  }

  getStatus() {
    return {
      status: this.status,
      lastError: this.lastError,
      availableSpeakers: this.availableSpeakers,
    };
  }

  /**
   * Удаляет .wav-файл после того, как он точно больше не нужен (либо
   * подтверждено воспроизведён — tts-host сообщил об окончании, либо
   * озвучка была пропущена/прервана). Ошибка удаления (например, файл
   * уже удалён) не должна ничего ломать — это просто уборка за собой,
   * а не часть критичной логики воспроизведения.
   */
  deleteAudioFile(filePath) {
    if (!filePath) return;
    fs.unlink(filePath, (err) => {
      if (err && err.code !== 'ENOENT') {
        this.log('warn', `Не удалось удалить временный файл озвучки ${filePath}: ${err.message}`);
      }
    });
  }

  /**
   * Подчищает папку outputDir от файлов, оставшихся с прошлого запуска
   * (например, приложение было закрыто через "Завершить процесс" в
   * диспетчере задач, минуя normal shutdown). Вызывается один раз при
   * старте сервиса — НЕ периодически, обычная озвучка удаляет файлы сама
   * сразу после воспроизведения через deleteAudioFile().
   */
  cleanupStaleFiles() {
    fs.readdir(this.outputDir, (err, files) => {
      if (err) {
        if (err.code !== 'ENOENT') {
          this.log('warn', `Не удалось прочитать папку кэша озвучки для очистки: ${err.message}`);
        }
        return;
      }
      for (const file of files) {
        if (!file.endsWith('.wav')) continue;
        this.deleteAudioFile(path.join(this.outputDir, file));
      }
    });
  }

  /**
   * Корректно останавливает процесс: сперва закрывает stdin (сигнал
   * Python-скрипту естественно завершить цикл чтения — см. `for line in
   * sys.stdin` в silero_engine.py), затем SIGTERM, и если процесс не
   * завершился за SHUTDOWN_GRACE_MS — принудительный kill(). Тот же подход
   * "мягко, потом жёстко", что уже применялся для http-сервера/socket.io
   * в этом проекте, чтобы процесс не завис в диспетчере задач.
   */
  shutdown() {
    if (!this.process) {
      this.status = 'stopped';
      return Promise.resolve();
    }

    const child = this.process;

    return new Promise((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.status = 'stopped';
        this.process = null;
        if (this.rl) {
          this.rl.close();
          this.rl = null;
        }
        this._rejectAllPending(new Error('Приложение завершает работу'));
        resolve();
      };

      child.once('exit', finish);

      try {
        child.stdin.end();
        child.kill('SIGTERM');
      } catch (err) {
        this.log('warn', `Ошибка при остановке процесса Silero TTS: ${err.message}`);
      }

      setTimeout(() => {
        if (!resolved && this.process) {
          this.log('warn', 'Процесс Silero TTS не завершился штатно, принудительное завершение');
          try {
            child.kill('SIGKILL');
          } catch (err) {
            this.log('error', `Не удалось принудительно завершить процесс Silero TTS: ${err.message}`);
          }
        }
      }, SHUTDOWN_GRACE_MS);
    });
  }
}

module.exports = { SileroTtsService, VALID_SPEAKERS, DEFAULT_SAMPLE_RATE };
