'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, session, Tray, Menu, dialog, safeStorage, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const { createServer } = require('../server/index');

/** @type {import('electron').BrowserWindow|null} */
let mainWindow = null;
/** @type {import('electron').BrowserWindow|null} */
let ttsHostWindow = null;
/** @type {Awaited<ReturnType<typeof createServer>>|null} */
let serverInstance = null;
/** @type {import('electron').Tray|null} */
let tray = null;
/** Флаг: true только когда пользователь осознанно выбрал полное закрытие (через диалог или трей) —
 *  иначе клик по крестику окна будет каждый раз перехвачен диалогом подтверждения. */
let isQuitting = false;

const isDev = process.env.NODE_ENV === 'development';

function createMainWindow(port) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    frame: false,
    backgroundColor: '#0b0d14',
    show: false,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(`http://127.0.0.1:${port}/index.html`);

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Клик по крестику (или Alt+F4 и т.п.) не должен молча убивать процесс в фоне —
  // спрашиваем у пользователя, что он на самом деле хочет сделать.
  win.on('close', (event) => {
    if (isQuitting) return; // это настоящее закрытие (через трей/диалог) — не перехватываем повторно

    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Закрыть программу', 'Свернуть в трей', 'Отмена'],
      defaultId: 1,
      cancelId: 2,
      title: 'Закрыть NeuroStream Studio?',
      message: 'Вы хотите закрыть программу полностью или свернуть её в трей?',
      detail:
        'При сворачивании в трей приложение продолжит работать в фоне: озвучка, триггеры и алерты для OBS останутся активными.',
      noLink: true,
    });

    if (choice === 0) {
      isQuitting = true;
      app.quit();
    } else if (choice === 1) {
      win.hide();
    }
    // choice === 2 («Отмена») — ничего не делаем, окно остаётся открытым как было
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

/**
 * Значок в системном трее — позволяет свернуть программу так, чтобы она реально
 * продолжала работать в фоне (а не просто "зависала" невидимым процессом), и даёт
 * явный способ полностью выйти из приложения.
 */
function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  tray = new Tray(iconPath);
  tray.setToolTip('NeuroStream Studio');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Открыть NeuroStream Studio',
        click: () => {
          mainWindow?.show();
        },
      },
      {
        label: 'Проверить обновления',
        click: () => {
          if (!app.isPackaged) {
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'info',
              message: 'Проверка обновлений доступна только в собранной программе, не в режиме разработки.',
            });
            return;
          }
          autoUpdater.checkForUpdates().catch((err) => {
            dialog.showMessageBox(mainWindow || undefined, {
              type: 'error',
              message: 'Не удалось проверить обновления',
              detail: err?.message || String(err),
            });
          });
        },
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => mainWindow?.show());
}

/**
 * Скрытое окно, единственная задача которого — держать живым Web Speech API
 * (window.speechSynthesis) для озвучки очереди TTS независимо от того,
 * свёрнута/закрыта ли основная панель управления.
 */
function createTtsHostWindow(port) {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${port}/tts-host.html`);
  return win;
}

/**
 * Автообновление через GitHub Releases (electron-builder публикует туда latest.yml
 * и установщик при каждой сборке в CI). Загружает обновление в фоне и, когда оно готово,
 * спрашивает пользователя — установить сейчас или при следующем закрытии программы.
 * В режиме разработки (npm run dev) не проверяет — только в собранном .exe.
 */
function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater]', err?.message || err);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    const result = await dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: 'Доступно обновление NeuroStream Studio',
      message: `Обновление до версии ${info.version} загружено и готово к установке.`,
      detail: 'Установить сейчас? Программа перезапустится (это займёт несколько секунд).',
      buttons: ['Установить сейчас', 'Позже (при следующем закрытии)'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    } else {
      autoUpdater.autoInstallOnAppQuit = true;
    }
  });

  // Небольшая задержка, чтобы проверка обновлений не задерживала первый запуск программы.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[autoUpdater] проверка обновлений не удалась:', err?.message || err);
    });
  }, 5000);
}

/**
 * Системные уведомления Windows о критических сбоях подключения. Нужны потому, что во
 * время эфира стример обычно смотрит не в окно программы, а в чат/на камеру — и может
 * не заметить, что связь с TikTok/AxelChat отвалилась.
 *
 * Уведомляем только о переходе "было подключено → сломалось" и о восстановлении связи,
 * чтобы не спамить при каждой промежуточной попытке переподключения.
 */
function setupConnectionNotifications(server) {
  if (!Notification.isSupported()) return;

  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  const wasConnected = { tiktok: false, axelchat: false };

  const notify = (title, body) => {
    new Notification({ title, body, icon: iconPath }).show();
  };

  const watch = (connector, label, key) => {
    connector.on('status', (state) => {
      if (state.status === 'connected') {
        if (!wasConnected[key]) {
          wasConnected[key] = true;
          // О восстановлении сообщаем только если до этого уже был обрыв (не при первом подключении).
          if (state.reconnectCount > 0) notify('NeuroStream Studio', `${label}: связь восстановлена`);
        }
        return;
      }
      const isFailure = state.status === 'error' || state.status === 'reconnecting';
      if (isFailure && wasConnected[key]) {
        wasConnected[key] = false;
        notify('NeuroStream Studio — обрыв связи', `${label}: ${state.message || 'соединение потеряно, идёт переподключение'}`);
      }
    });
  };

  watch(server.services.tiktokConnector, 'TikTok LIVE', 'tiktok');
  watch(server.services.axelChatConnector, 'AxelChat', 'axelchat');
}

async function bootstrap() {
  serverInstance = await createServer({
    userDataDir: app.getPath('userData'),
    electronApp: app,
    safeStorage,
  });

  mainWindow = createMainWindow(serverInstance.port);
  ttsHostWindow = createTtsHostWindow(serverInstance.port);
  createTray();
  setupAutoUpdater();
  setupConnectionNotifications(serverInstance);
}

/**
 * Открывает настоящее окно входа в TikTok (реальная страница tiktok.com/login в отдельном
 * BrowserWindow с изолированной постоянной сессией) и ждёт, пока пользователь войдёт сам —
 * логин/пароль/капча/2FA вводятся пользователем вручную, ничего не автоматизируется и не
 * подделывается. После успешного входа TikTok сам выставляет cookie `sessionid` и
 * `tt-target-idc` — как только оба появляются, они забираются из cookie-хранилища этого
 * окна и возвращаются в приложение (используются только для действия «Ответ в чат»,
 * само чтение чата от них не зависит).
 * @returns {Promise<{ sessionId: string, ttTargetIdc: string }>}
 */
function openTikTokLoginWindow() {
  return new Promise((resolve, reject) => {
    const loginSession = session.fromPartition('persist:tiktok-login');
    const loginWindow = new BrowserWindow({
      width: 480,
      height: 760,
      title: 'Вход в TikTok — NeuroStream Studio',
      parent: mainWindow || undefined,
      webPreferences: {
        session: loginSession,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // По умолчанию Electron добавляет в User-Agent строку вида "Electron/xx.x.x", по которой
    // TikTok (и многие другие сайты) распознают автоматизированный/нестандартный браузер и
    // могут выдавать "Слишком много попыток. Повторите позже" уже на первой попытке входа.
    // Подменяем User-Agent на обычный десктопный Chrome, чтобы окно входа выглядело для
    // TikTok как самый обычный браузер — сам процесс входа при этом никак не автоматизируется.
    const CHROME_UA =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
    loginWindow.webContents.setUserAgent(CHROME_UA);

    let settled = false;
    let pollTimer = null;

    const finishSuccess = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      loginWindow.removeAllListeners('closed');
      loginWindow.close();
      resolve(result);
    };

    const finishFailure = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(pollTimer);
      reject(error);
    };

    const checkCookies = async () => {
      try {
        const cookies = await loginSession.cookies.get({ domain: 'tiktok.com' });
        const sessionCookie = cookies.find((c) => c.name === 'sessionid');
        const targetIdcCookie = cookies.find((c) => c.name === 'tt-target-idc');
        if (sessionCookie && targetIdcCookie) {
          finishSuccess({ sessionId: sessionCookie.value, ttTargetIdc: targetIdcCookie.value });
        }
      } catch {
        // Сессия окна ещё не готова / нет cookie — просто пробуем на следующем тике.
      }
    };

    loginWindow.loadURL('https://www.tiktok.com/login');
    pollTimer = setInterval(checkCookies, 1500);

    loginWindow.on('closed', () => {
      finishFailure(new Error('Окно входа закрыто до завершения авторизации — попробуйте снова и дождитесь полного входа в аккаунт'));
    });
  });
}

// ------------------------------- IPC: управление окном -------------------------------
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximizeToggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('app:getVersion', () => app.getVersion());
ipcMain.handle('app:openExternal', (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('tiktok:loginWithBrowser', async () => {
  try {
    return { ok: true, ...(await openTikTokLoginWindow()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(bootstrap);

app.on('window-all-closed', async () => {
  if (serverInstance) await serverInstance.shutdown();
  app.quit();
});

app.on('before-quit', async (event) => {
  if (serverInstance) {
    event.preventDefault();
    const instance = serverInstance;
    serverInstance = null;

    // Аварийная защита: даже если shutdown() по какой-то непредвиденной причине зависнет,
    // процесс всё равно принудительно завершится через несколько секунд — программа
    // не должна оставаться в диспетчере задач ни при каких обстоятельствах.
    const forceExitTimer = setTimeout(() => {
      app.exit(0);
    }, 5000);
    forceExitTimer.unref?.();

    try {
      await instance.shutdown();
    } catch {
      // даже если корректное закрытие не удалось — всё равно выходим
    } finally {
      clearTimeout(forceExitTimer);
      app.quit();
    }
  }
});
