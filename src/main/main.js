'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
