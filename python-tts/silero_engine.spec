# -*- mode: python ; coding: utf-8 -*-
#
# NeuroStream Studio — сборка движка Silero TTS в standalone .exe
# (без необходимости устанавливать Python на машине пользователя).
#
# Собирается командой: pyinstaller silero_engine.spec
# Результат: dist/silero_engine/silero_engine.exe + сопутствующие файлы
# (--onedir, НЕ --onefile — см. обоснование ниже).

import sys

block_cipher = None

a = Analysis(
    ['silero_engine.py'],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=[
        'torch',
        'torch.package',
        'omegaconf',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Эти пакеты PyInstaller иногда пытается утянуть транзитивно из
        # окружения разработки — explicitly исключаем, чтобы не раздувать
        # сборку тем, что рантайму синтеза речи не нужно.
        'matplotlib',
        'notebook',
        'IPython',
        'pytest',
    ],
    noarchive=False,
    cipher=block_cipher,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='silero_engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX-сжатие часто триггерит антивирусы ложноположительно на Windows
    console=True,  # нужен реальный stdin/stdout для протокола NDJSON — без этого окна
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

# --onedir (а не --onefile): --onefile распаковывает себя во временную папку
# при КАЖДОМ запуске — для тяжёлой PyTorch-сборки это секунды лишней
# задержки на старте приложения. --onedir распаковывается один раз при
# установке и запускается мгновенно — это именно то поведение, которое
# нужно для долгоживущего фонового процесса.
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='silero_engine',
)
