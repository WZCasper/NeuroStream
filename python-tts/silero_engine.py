"""
NeuroStream Studio — движок синтеза речи на базе Silero TTS (v4_ru).

Запускается как ДОЛГОЖИВУЩИЙ дочерний процесс из Node.js (см.
src/server/services/sileroTts.js). Модель PyTorch загружается один раз при
старте — это главная причина, почему процесс не перезапускается на каждую
фразу: загрузка модели занимает заметное время, а сам синтез после неё —
доли секунды на CPU.

Протокол общения — построчный JSON через stdin/stdout (NDJSON), без
дополнительного HTTP-порта:

  Запрос  (строка в stdin):
    {"id": "<uuid>", "text": "Привет, мир", "speaker": "baya", "sample_rate": 48000}

  Успешный ответ (строка в stdout):
    {"id": "<uuid>", "ok": true, "path": "C:\\...\\tts-cache\\<uuid>.wav", "duration_ms": 1234}

  Ответ с ошибкой (строка в stdout):
    {"id": "<uuid>", "ok": false, "error": "текст ошибки на русском"}

  Служебное сообщение о готовности движка (отправляется один раз после
  успешной загрузки модели, id отсутствует):
    {"ready": true, "speakers": ["aidar", "baya", "kseniya", "xenia", "eugene", "random"]}

Все диагностические сообщения (прогресс загрузки, предупреждения) пишутся
в stderr, а не в stdout — stdout зарезервирован ИСКЛЮЧИТЕЛЬНО под протокол
NDJSON, иначе Node-сторона не сможет надёжно парсить ответы.
"""

import json
import os
import sys
import time
import traceback
import uuid

# --- Константы -------------------------------------------------------------

SAMPLE_RATE_DEFAULT = 48000
ALLOWED_SAMPLE_RATES = (8000, 24000, 48000)
VALID_SPEAKERS = ("aidar", "baya", "kseniya", "xenia", "eugene", "random")
MAX_TEXT_LENGTH = 2000  # защита от случайно огромного текста из триггера/шаблона

# Путь к локально сохранённой модели передаётся явно через переменную
# окружения NSS_SILERO_MODEL_PATH (в собранном .exe это файл внутри
# extraResources — см. package.json и build-windows.yml). Если переменная
# не задана, используем путь по умолчанию рядом со скриптом — удобно для
# локальной разработки без сборки.
MODEL_PATH = os.environ.get(
    "NSS_SILERO_MODEL_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "model", "v4_ru.pt"),
)

# Куда складывать синтезированные .wav. Node-сторона передаёт этот путь сама
# (обычно userData/tts-cache) через NSS_SILERO_OUTPUT_DIR, чтобы файлы жили
# рядом с остальными данными пользователя и чистились по тем же правилам.
OUTPUT_DIR = os.environ.get(
    "NSS_SILERO_OUTPUT_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts-cache"),
)


def log(message):
    """Диагностика — только в stderr, никогда в stdout (см. докстринг модуля)."""
    print(f"[silero_engine] {message}", file=sys.stderr, flush=True)


def write_response(payload):
    """Единственная точка записи в stdout — одна строка JSON + перевод строки."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_model():
    """
    Загружает модель Silero v4_ru из локального файла (НЕ скачивает её —
    на машине пользователя интернета для этого может не быть, модель уже
    зашита в установщик на этапе сборки CI).
    """
    import torch

    if not os.path.isfile(MODEL_PATH):
        raise RuntimeError(
            f"Файл модели Silero не найден по пути: {MODEL_PATH}. "
            "Модель должна быть упакована в установщик (extraResources) "
            "на этапе сборки — см. .github/workflows/build-windows.yml."
        )

    log(f"Загрузка модели из {MODEL_PATH} ...")
    t0 = time.time()

    torch.set_num_threads(max(1, os.cpu_count() or 1))

    # Формат v4-моделей — torch.package, а не обычный state_dict.
    model = torch.package.PackageImporter(MODEL_PATH).load_pickle("tts_models", "model")
    device = torch.device("cpu")
    model.to(device)

    log(f"Модель загружена за {time.time() - t0:.1f} с")
    return model, device


def synthesize(model, device, text, speaker, sample_rate):
    """
    Синтезирует речь и возвращает путь к сохранённому .wav-файлу.
    Поднимает исключение с понятным текстом при некорректных входных данных —
    вызывающий код (handle_request) ловит его и формирует ответ ok:false.
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("Пустой текст для озвучки")
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"Текст слишком длинный ({len(text)} символов, максимум {MAX_TEXT_LENGTH})")

    speaker = speaker if speaker in VALID_SPEAKERS else "baya"
    sample_rate = sample_rate if sample_rate in ALLOWED_SAMPLE_RATES else SAMPLE_RATE_DEFAULT

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    filename = f"{uuid.uuid4().hex}.wav"
    out_path = os.path.join(OUTPUT_DIR, filename)

    # put_accent/put_yo — автоматическая расстановка ударений и буквы "ё",
    # для русского языка это именно то, что отличает Silero по качеству
    # от обычных системных голосов (их модель явно это поддерживает для ru).
    model.save_wav(
        text=text,
        speaker=speaker,
        sample_rate=sample_rate,
        audio_path=out_path,
        put_accent=True,
        put_yo=True,
    )

    return out_path


def handle_request(model, device, request):
    request_id = request.get("id")
    try:
        text = request.get("text", "")
        speaker = request.get("speaker", "baya")
        sample_rate = int(request.get("sample_rate") or SAMPLE_RATE_DEFAULT)

        t0 = time.time()
        out_path = synthesize(model, device, text, speaker, sample_rate)
        duration_ms = int((time.time() - t0) * 1000)

        write_response({"id": request_id, "ok": True, "path": out_path, "duration_ms": duration_ms})
    except Exception as exc:  # noqa: BLE001 — сознательно широкий перехват: любая ошибка
        # синтеза ОДНОЙ фразы не должна убивать долгоживущий процесс целиком.
        log(f"Ошибка синтеза (id={request_id}): {exc}\n{traceback.format_exc()}")
        write_response({"id": request_id, "ok": False, "error": str(exc)})


def main():
    log("Запуск движка Silero TTS...")
    try:
        model, device = load_model()
    except Exception as exc:  # noqa: BLE001
        # Если модель вообще не загрузилась — процесс бесполезен, сообщаем об
        # этом на stdout одним финальным сообщением и завершаемся с кодом 1,
        # чтобы Node-сторона могла отличить "не запустился" от "упал на лету".
        log(f"Не удалось загрузить модель: {exc}\n{traceback.format_exc()}")
        write_response({"ready": False, "error": str(exc)})
        sys.exit(1)

    write_response({"ready": True, "speakers": list(VALID_SPEAKERS)})
    log("Движок готов, ожидание запросов на stdin...")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"Некорректный JSON во входной строке, пропущена: {exc}")
            continue
        handle_request(model, device, request)

    log("stdin закрыт — завершение процесса")


if __name__ == "__main__":
    main()
