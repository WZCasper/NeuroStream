'use strict';

/**
 * Сквозные тесты SileroTtsService - реальный дочерний процесс (фейковый
 * движок на Node.js в test/fake_engine.js, повторяющий протокол NDJSON
 * настоящего python-tts/silero_engine.py), без мокания самого
 * child_process. Это сознательный выбор: моки спрятали бы именно те баги
 * (гонки, утечки таймеров, зависшие процессы), ради проверки которых этот
 * модуль и писался.
 *
 * Запускаем фейковый движок как `process.execPath test/fake_engine.js`
 * (через опциональный SileroTtsService.exeArgs) вместо платформенно-
 * зависимой .sh/.cmd обёртки. Это сознательный отказ от промежуточных
 * обёрточных скриптов: более ранняя версия этого теста использовала
 * .sh-скрипт, вызывающий python3 (зависало на windows-2022, т.к. Windows
 * не исполняет .sh через spawn() как POSIX-системы), затем - .cmd-скрипт,
 * вызывающий node (с 2024 года, CVE-2024-27980, Windows требует явного
 * shell:true для spawn() .cmd-файлов, и это тоже оказалось ненадёжно
 * внутри CI). process.execPath - это сам исполняемый файл node.exe/node,
 * обычный бинарник без какого-либо платформенно-специфичного поведения
 * spawn() - поэтому именно он, а не обёртка, передаётся в exePath.
 *
 * Запуск: node test/sileroTts.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SileroTtsService } = require('../src/server/services/sileroTts');

const FAKE_ENGINE_SCRIPT = path.join(__dirname, 'fake_engine.js');

/** Фабрика сервиса с уже подставленными exePath/exeArgs для фейкового движка -
 * чтобы не дублировать process.execPath/[FAKE_ENGINE_SCRIPT] в каждом тесте. */
function makeService(opts = {}) {
  return new SileroTtsService({
    exePath: process.execPath,
    exeArgs: [FAKE_ENGINE_SCRIPT],
    modelPath: '/fake/model.pt',
    outputDir: '/tmp/fake-out',
    log: () => {},
    ...opts,
  });
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.stack || err.message}`);
  }
}

async function main() {
  console.log('SileroTtsService - сквозные тесты\n');

  await test('запуск процесса и переход в статус ready', async () => {
    const svc = makeService();
    await svc.start();
    assert.strictEqual(svc.getStatus().status, 'ready');
    assert.deepStrictEqual(
      svc.getStatus().availableSpeakers,
      ['aidar', 'baya', 'kseniya', 'xenia', 'eugene', 'random']
    );
    await svc.shutdown();
    assert.strictEqual(svc.getStatus().status, 'stopped');
  });

  await test('повторный start() во время готовности не плодит процессы', async () => {
    const svc = makeService();
    await svc.start();
    const pidBefore = svc.process.pid;
    await svc.start(); // повторный вызов - не должен создать новый процесс
    assert.strictEqual(svc.process.pid, pidBefore, 'PID процесса не должен измениться');
    await svc.shutdown();
  });

  await test('успешный синтез возвращает path и durationMs', async () => {
    const svc = makeService();
    await svc.start();
    const result = await svc.synthesize('Привет, мир', 'baya');
    assert.ok(result.path.endsWith('.wav'));
    assert.strictEqual(typeof result.durationMs, 'number');
    await svc.shutdown();
  });

  await test('параллельные запросы корректно сопоставляются по id (нет гонки)', async () => {
    const svc = makeService();
    await svc.start();
    const results = await Promise.all([
      svc.synthesize('Фраза один', 'aidar'),
      svc.synthesize('Фраза два', 'baya'),
      svc.synthesize('Фраза три', 'kseniya'),
      svc.synthesize('Фраза четыре', 'xenia'),
      svc.synthesize('Фраза пять', 'eugene'),
    ]);
    assert.strictEqual(results.length, 5);
    results.forEach((r) => assert.ok(r.path.endsWith('.wav')));
    await svc.shutdown();
  });

  await test('ошибка синтеза одной фразы не ломает последующие запросы', async () => {
    const svc = makeService();
    await svc.start();

    await assert.rejects(
      () => svc.synthesize('__FAIL__', 'baya'),
      /Искусственная ошибка теста/
    );

    // Процесс должен остаться живым и отвечать на следующий запрос.
    const ok = await svc.synthesize('Следующая фраза после ошибки', 'baya');
    assert.ok(ok.path.endsWith('.wav'));

    await svc.shutdown();
  });

  await test('synthesize() до start() отклоняется понятной ошибкой, не висит', async () => {
    const svc = makeService();
    await assert.rejects(
      () => svc.synthesize('Текст', 'baya'),
      /недоступен/
    );
  });

  await test('shutdown() без запущенного процесса не падает', async () => {
    const svc = makeService();
    await svc.shutdown(); // не было start() - должен просто резолвиться
    assert.strictEqual(svc.getStatus().status, 'stopped');
  });

  await test('shutdown() действительно завершает процесс (нет утечки, как в прошлом баге)', async () => {
    const svc = makeService();
    await svc.start();
    const pid = svc.process.pid;
    await svc.shutdown();

    // Проверяем, что процесс с этим PID действительно не существует -
    // сигнал 0 не убивает процесс, только проверяет его существование.
    let stillAlive = true;
    try {
      process.kill(pid, 0);
    } catch (err) {
      stillAlive = false; // ESRCH - процесса нет, это и есть желаемый результат
    }
    assert.strictEqual(stillAlive, false, 'Процесс должен быть завершён после shutdown()');
  });

  await test('start() с несуществующим exePath (ENOENT) переходит в status=error, не висит', async () => {
    const svc = makeService({ exePath: '/несуществующий/путь/к/silero_engine.exe', exeArgs: [] });

    await assert.rejects(() => svc.start(), /Процесс Silero TTS завершился с ошибкой|ENOENT/);
    assert.strictEqual(svc.getStatus().status, 'error');
  });

  await test(
    'shutdown() после неудачного ENOENT-старта завершается быстро, не висит ' +
    '(регрессионный тест: именно эта комбинация зависала весь npm test на CI)',
    async () => {
      const svc = makeService({ exePath: '/несуществующий/путь/к/silero_engine.exe', exeArgs: [] });

      await assert.rejects(() => svc.start()); // ENOENT - start() должен отклониться

      // Если регрессия вернётся, shutdown() зависнет на неопределённое время -
      // оборачиваем в жёсткий таймаут теста, а не полагаемся только на
      // собственный внутренний таймаут SileroTtsService (SHUTDOWN_GRACE_MS*2),
      // чтобы при регрессии тест падал с понятной ошибкой за секунды, а не
      // вешал весь npm test на CI на неопределённое время, как уже было.
      const HARD_TEST_TIMEOUT_MS = 10_000;
      await Promise.race([
        svc.shutdown(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(
              `РЕГРЕССИЯ: shutdown() после ENOENT-старта не завершился за ${HARD_TEST_TIMEOUT_MS / 1000} с`
            )),
            HARD_TEST_TIMEOUT_MS
          )
        ),
      ]);

      assert.strictEqual(svc.getStatus().status, 'stopped');
    }
  );

  await test('крах процесса после ready отклоняет ожидающие запросы, не висит вечно', async () => {
    const svc = makeService();
    await svc.start();

    // Убиваем процесс напрямую, как будто он неожиданно упал в бою.
    svc.process.kill('SIGKILL');

    // Небольшая пауза, чтобы событие 'exit' успело обработаться.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.strictEqual(svc.getStatus().status, 'stopped');
    await assert.rejects(() => svc.synthesize('Текст', 'baya'), /недоступен/);
  });

  await test('deleteAudioFile() удаляет реальный файл с диска', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-silero-test-'));
    const svc = makeService({ outputDir: dir });
    const filePath = path.join(dir, 'test-audio.wav');
    fs.writeFileSync(filePath, 'fake wav content');
    assert.ok(fs.existsSync(filePath));

    svc.deleteAudioFile(filePath);
    // unlink асинхронный - даём event loop такт на завершение.
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(fs.existsSync(filePath), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('deleteAudioFile() на несуществующем файле не падает и не бросает', async () => {
    const svc = makeService();
    // Не должно бросить исключение - тест провалится сам, если бросит.
    svc.deleteAudioFile('/tmp/nss-test-does-not-exist-12345.wav');
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  await test('cleanupStaleFiles() удаляет .wav файлы, оставшиеся с прошлого запуска', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-silero-test-'));
    fs.writeFileSync(path.join(dir, 'old1.wav'), 'leftover');
    fs.writeFileSync(path.join(dir, 'old2.wav'), 'leftover');
    fs.writeFileSync(path.join(dir, 'not-audio.txt'), 'should stay'); // не .wav - не должен удаляться

    const svc = makeService({ outputDir: dir });
    svc.cleanupStaleFiles();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(fs.existsSync(path.join(dir, 'old1.wav')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'old2.wav')), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'not-audio.txt')), true, 'не-.wav файлы трогать не должны');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('start() создаёт outputDir, если его ещё нет, и чистит его от старых файлов', async () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-silero-test-'));
    const outputDir = path.join(parentDir, 'tts-cache'); // намеренно НЕ создаём заранее

    const svc = makeService({ outputDir });
    assert.strictEqual(fs.existsSync(outputDir), false, 'папка не должна существовать до start()');

    await svc.start();
    assert.strictEqual(fs.existsSync(outputDir), true, 'start() должен создать папку');

    await svc.shutdown();
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  console.log(`\nИтого: ${passed} прошло, ${failed} упало из ${passed + failed}`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Неперехваченная ошибка в тестах:', err);
  process.exit(1);
});
