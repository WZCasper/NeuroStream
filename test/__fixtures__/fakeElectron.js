'use strict';

/**
 * Минимальная имитация Electron App API — используется тестом test/main.test.js.
 * Реализует только то, что src/main/main.js реально вызывает верхнеуровнево, до
 * app.whenReady(): requestSingleInstanceLock(), app.on('second-instance'/'window-all-closed'
 * /'before-quit'), app.quit(). Задача — проверить порядок и условность вызовов в самом
 * main.js (в частности, блокировку второго экземпляра), а не воспроизвести поведение Electron.
 */
const { EventEmitter } = require('node:events');

function makeApp(hasLock) {
  const app = new EventEmitter();
  app.isPackaged = false;
  app.quitCalled = false;
  app.requestSingleInstanceLock = () => hasLock;
  app.quit = () => {
    app.quitCalled = true;
    app.emit('quit');
  };
  app.getPath = () => '/tmp/fake-userdata';
  app.whenReady = () => new Promise(() => {}); // намеренно никогда не резолвится — bootstrap() не должен вызываться
  app.setLoginItemSettings = () => {};
  return app;
}

class FakeBrowserWindow extends EventEmitter {
  loadURL() {}
  once() {}
  show() {}
  focus() {}
  isMinimized() {
    return false;
  }
  restore() {}
}

module.exports = { makeApp, FakeBrowserWindow };
