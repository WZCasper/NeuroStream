'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { createServer } = require('../server/index');

/** @type {import('electron').BrowserWindow|null} */
let mainWindow = null;
/** @type {import('electron').BrowserWindow|null} */
let ttsHostWindow = null;
/** @type {Awaited<ReturnType<typeof createServer>>|null} */
let serverInstance = null;

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

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
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

async function bootstrap() {
  serverInstance = await createServer({
    userDataDir: app.getPath('userData'),
    electronApp: app,
  });

  mainWindow = createMainWindow(serverInstance.port);
  ttsHostWindow = createTtsHostWindow(serverInstance.port);
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
    await instance.shutdown();
    app.quit();
  }
});
