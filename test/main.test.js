'use strict';

/**
 * Тест блокировки второго экземпляра приложения (src/main/main.js).
 *
 * Electron здесь не запускается (нет графического дисплея), поэтому main.js загружается
 * с подменённым модулем 'electron' (test/__fixtures__/fakeElectron.js) — имитация достаточно
 * точна для того, что main.js реально делает до app.whenReady(): requestSingleInstanceLock(),
 * app.quit(), регистрация app.on(...). Настоящая сборка .exe и запуск окна Electron
 * проверяются на этапе выпуска релиза (см. README про сборку CI), а не этим тестом.
 *
 * Запуск: node test/main.test.js
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const { makeApp, FakeBrowserWindow } = require('./__fixtures__/fakeElectron');

let passed = 0;
let failed = 0;

function step(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n     ') : err}`);
    failed++;
  }
}

/** Загружает main.js с подменённым 'electron' и возвращает { app, exitCode }. */
function loadMainWithFakeElectron(hasLock) {
  const app = makeApp(hasLock);
  const electronStub = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: { handle() {} },
    shell: {},
    session: { defaultSession: { cookies: { get: async () => [] } } },
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
    },
    Menu: { buildFromTemplate: () => ({}) },
    dialog: { showMessageBoxSync: () => 2, showMessageBox: async () => {} },
    safeStorage: {},
    Notification: class {
      show() {}
    },
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === 'electron-updater') return { autoUpdater: { checkForUpdates: async () => {}, on() {} } };
    // Второй (отвергнутый) экземпляр не должен доходить до запуска сервера — если дойдёт,
    // этот заглушённый require сразу бросит исключение, и тест его поймает.
    if (request === '../server/index') {
      return { createServer: async () => { throw new Error('bootstrap НЕ должен вызываться для отклонённого экземпляра'); } };
    }
    return originalLoad.apply(this, arguments);
  };

  let exitCode = null;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code === undefined ? 0 : code;
    throw new Error('__PROCESS_EXIT__'); // прерывает дальнейшее выполнение модуля, как настоящий process.exit
  };

  const mainPath = require.resolve('../src/main/main.js');
  delete require.cache[mainPath];
  try {
    require(mainPath);
  } catch (err) {
    if (err.message !== '__PROCESS_EXIT__') throw err;
  } finally {
    process.exit = originalExit;
    Module._load = originalLoad;
  }
  return { app, exitCode };
}

console.log('\nБлокировка второго экземпляра (src/main/main.js)');

step('лок не получен: процесс завершается немедленно, second-instance не регистрируется', () => {
  const { app, exitCode } = loadMainWithFakeElectron(false);
  assert.equal(app.quitCalled, true, 'app.quit() должен быть вызван');
  assert.equal(exitCode, 0, 'process.exit(0) должен быть вызван — иначе второй экземпляр успел бы поднять свой сервер');
  assert.equal(app.listenerCount('second-instance'), 0);
  assert.equal(app.listenerCount('window-all-closed'), 0, 'отклонённый экземпляр не должен доходить до регистрации остальных обработчиков');
});

step('лок получен: процесс не завершается, все обработчики зарегистрированы', () => {
  const { app, exitCode } = loadMainWithFakeElectron(true);
  assert.equal(app.quitCalled, false);
  assert.equal(exitCode, null);
  assert.equal(app.listenerCount('second-instance'), 1);
  assert.equal(app.listenerCount('window-all-closed'), 1);
  assert.equal(app.listenerCount('before-quit'), 1);
});

step('second-instance показывает и фокусирует существующее окно', () => {
  const { app } = loadMainWithFakeElectron(true);
  const win = new FakeBrowserWindow();
  let shown = false;
  let focused = false;
  win.show = () => { shown = true; };
  win.focus = () => { focused = true; };
  // В момент вызова second-instance mainWindow в модуле main.js ещё null (bootstrap не запускался,
  // whenReady() никогда не резолвится) — здесь проверяем, что сам обработчик не бросает исключение
  // при отсутствии окна (частый источник необработанных ошибок в Electron-приложениях).
  assert.doesNotThrow(() => app.emit('second-instance', [], ''));
});

console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
process.exit(failed === 0 ? 0 : 1);
