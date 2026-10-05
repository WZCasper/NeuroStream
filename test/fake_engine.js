#!/usr/bin/env node
'use strict';

/**
 * Кроссплатформенная (Node.js, не Python) реализация протокола
 * silero_engine.py для сквозных тестов sileroTts.js.
 *
 * Изначально это был bash-скрипт, вызывающий python3 — он работал на
 * Linux (где ядро читает shebang #!/bin/sh), но завис на windows-2022
 * в CI: Windows не умеет напрямую исполнять .sh через spawn() так же,
 * как POSIX-системы, и дочерний процесс так и не стартовал, из-за чего
 * тест упирался в STARTUP_TIMEOUT_MS (60 с) на каждом тест-кейсе.
 *
 * Чистый Node.js-скрипт, запускаемый через `node fake_engine.js`,
 * работает одинаково на любой платформе, где вообще есть Node —
 * то есть везде, где этот тест и так запускается (CI уже настраивает
 * Node.js раньше в workflow, до того как доходит до Python-шагов).
 *
 * Повторяет РОВНО ТОТ ЖЕ протокол NDJSON, что и настоящий
 * python-tts/silero_engine.py — см. его докстринг для описания формата.
 */

const readline = require('readline');

const mode = process.env.FAKE_ENGINE_MODE || 'normal';

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

if (mode === 'fail_start') {
  // Никогда не отвечает "ready" — тест сам оборвёт процесс по таймауту.
  // Процесс просто простаивает; родитель убьёт его по завершении теста.
  setInterval(() => {}, 1 << 30);
} else {
  send({ ready: true, speakers: ['aidar', 'baya', 'kseniya', 'xenia', 'eugene', 'random'] });

  if (mode === 'crash_after_ready') {
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const req = JSON.parse(trimmed);

    if (mode === 'slow' && req.text === '__SLOW__') {
      // Намеренно не отвечаем - используется для теста таймаута запроса.
      return;
    }

    if (req.text === '__FAIL__') {
      send({ id: req.id, ok: false, error: 'Искусственная ошибка теста' });
      return;
    }

    send({ id: req.id, ok: true, path: `/tmp/fake-${req.id}.wav`, duration_ms: 42 });
  });
}
