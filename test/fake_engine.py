#!/usr/bin/env python3
"""
Фейковая реализация протокола silero_engine.py для сквозных тестов
sileroTts.js — без реального PyTorch, повторяет ТОЛЬКО контракт NDJSON.
Поведение управляется переменной окружения FAKE_ENGINE_MODE:
  normal      — обычная работа, отвечает ok:true мгновенно
  slow        — отвечает на один конкретный id с задержкой (тест таймаута)
  fail_start  — никогда не шлёт ready:true (тест таймаута запуска)
  crash_after_ready — завершается сразу после ready (тест аварийного выхода)
"""
import json
import os
import sys
import time

mode = os.environ.get('FAKE_ENGINE_MODE', 'normal')

if mode == 'fail_start':
    time.sleep(999)  # никогда не ответит — тест сам оборвёт процесс по таймеру
    sys.exit(0)

print(json.dumps({"ready": True, "speakers": ["aidar", "baya", "kseniya", "xenia", "eugene", "random"]}), flush=True)

if mode == 'crash_after_ready':
    sys.exit(1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)

    if mode == 'slow' and req.get('text') == '__SLOW__':
        time.sleep(999)
        continue

    if req.get('text') == '__FAIL__':
        print(json.dumps({"id": req["id"], "ok": False, "error": "Искусственная ошибка теста"}), flush=True)
        continue

    print(json.dumps({
        "id": req["id"],
        "ok": True,
        "path": f"/tmp/fake-{req['id']}.wav",
        "duration_ms": 42,
    }), flush=True)
