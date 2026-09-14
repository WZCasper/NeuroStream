import { socket } from './socket.js';
import { initTheme } from './theme.js';
import { toast } from './toast.js';
import { attachEmojiPickersIn } from './emoji.js';
import { initDashboard } from './dashboard.js';
import { initTriggers } from './triggers.js';
import { initTts } from './tts.js';
import { initIot } from './iot.js';
import { initMedia } from './media.js';
import { initLogsSettings } from './logsSettings.js';

function initWindowControls() {
  const bridge = window.nss;
  if (!bridge) return; // страница может быть открыта в обычном браузере при разработке — тогда просто скрываем поведение
  document.getElementById('btn-minimize')?.addEventListener('click', () => bridge.minimizeWindow());
  document.getElementById('btn-maximize')?.addEventListener('click', () => bridge.toggleMaximizeWindow());
  document.getElementById('btn-close')?.addEventListener('click', () => bridge.closeWindow());

  bridge.getAppVersion().then((v) => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = `v${v}`;
  });
}

function initTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  const panels = document.querySelectorAll('.tab-panel');

  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const target = item.dataset.tab;
      navItems.forEach((n) => n.classList.toggle('active', n === item));
      panels.forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
      window.localStorage.setItem('nss:activeTab', target);
    });
  });

  const saved = window.localStorage.getItem('nss:activeTab');
  const initial = saved && document.getElementById(`tab-${saved}`) ? saved : 'dashboard';
  document.querySelector(`.nav-item[data-tab="${initial}"]`)?.click();
}

function initStatusPills() {
  const tiktokPill = document.getElementById('pill-tiktok');
  const axelchatPill = document.getElementById('pill-axelchat');

  const labels = {
    idle: 'Не подключено',
    connecting: 'Подключение…',
    connected: 'В эфире',
    reconnecting: 'Переподключение…',
    error: 'Ошибка',
    stopped: 'Остановлено',
  };

  function render(pill, prefix, state) {
    if (!pill) return;
    pill.className = `status-pill ${state.status}`;
    const text = labels[state.status] || state.status;
    pill.querySelector('.label').textContent = `${prefix}: ${text}`;
  }

  socket.on('tiktok:status', (state) => render(tiktokPill, 'TikTok', state));
  socket.on('axelchat:status', (state) => render(axelchatPill, 'AxelChat', state));

  socket.on('connect', () => toast('Соединение с локальным сервером установлено', 'success'));
  socket.on('disconnect', () => toast('Потеряно соединение с локальным сервером — переподключение…', 'error'));
}

async function bootstrap() {
  initWindowControls();
  initTabs();
  initStatusPills();
  await initTheme();

  const overlayHint = document.getElementById('overlay-url-hint');
  if (overlayHint) overlayHint.textContent = `${window.location.origin}/overlay.html`;

  initDashboard();
  initTriggers();
  initTts();
  initIot();
  initMedia();
  initLogsSettings();

  attachEmojiPickersIn(document);
}

document.addEventListener('DOMContentLoaded', bootstrap);
