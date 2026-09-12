import { api } from './api.js';
import { toast } from './toast.js';
import { socket } from './socket.js';

const MAX_FEED_ITEMS = 60;

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function eventLabel(evt) {
  switch (evt.type) {
    case 'chat':
      return `${evt.author?.name || 'Зритель'}: ${evt.text || ''}`;
    case 'gift':
      return `${evt.author?.name || 'Зритель'} отправил ${evt.giftName || 'подарок'} x${evt.repeatCount || 1} (${evt.diamondCount || 0} монет)`;
    case 'follow':
      return `${evt.author?.name || 'Зритель'} подписался`;
    case 'share':
      return `${evt.author?.name || 'Зритель'} поделился трансляцией`;
    case 'subscribe':
      return `${evt.author?.name || 'Зритель'} оформил подписку`;
    case 'like':
      return `${evt.author?.name || 'Зритель'} — лайки: ${evt.likeCount || 0}`;
    default:
      return JSON.stringify(evt);
  }
}

async function loadSettingsIntoForms() {
  const settings = await api.get('/api/settings');
  const uniqueIdInput = document.getElementById('tiktok-unique-id');
  const signApiKeyInput = document.getElementById('tiktok-sign-key');
  const sessionIdInput = document.getElementById('tiktok-session-id');
  const ttTargetIdcInput = document.getElementById('tiktok-tt-target-idc');
  const autoConnectInput = document.getElementById('tiktok-auto-connect');
  if (settings.tiktokUniqueId) uniqueIdInput.value = settings.tiktokUniqueId;
  if (settings.tiktokSignApiKey) signApiKeyInput.value = settings.tiktokSignApiKey;
  if (settings.tiktokSessionId) sessionIdInput.value = settings.tiktokSessionId;
  if (settings.tiktokTtTargetIdc) ttTargetIdcInput.value = settings.tiktokTtTargetIdc;
  autoConnectInput.checked = settings.tiktokAutoConnect === '1';

  const hostInput = document.getElementById('axelchat-host');
  const portInput = document.getElementById('axelchat-port');
  const axAutoConnectInput = document.getElementById('axelchat-auto-connect');
  hostInput.value = settings.axelchatHost || '127.0.0.1';
  portInput.value = settings.axelchatPort || '8356';
  axAutoConnectInput.checked = settings.axelchatAutoConnect === '1';
}

function bindTikTokForm() {
  const form = document.getElementById('form-tiktok-connect');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const uniqueId = document.getElementById('tiktok-unique-id').value.trim();
    const signApiKey = document.getElementById('tiktok-sign-key').value.trim();
    const sessionId = document.getElementById('tiktok-session-id').value.trim();
    const ttTargetIdc = document.getElementById('tiktok-tt-target-idc').value.trim();
    const autoConnect = document.getElementById('tiktok-auto-connect').checked;
    if (!uniqueId) return toast('Укажите @uniqueId стримера', 'error');
    try {
      await api.post('/api/tiktok/connect', { uniqueId, signApiKey, sessionId, ttTargetIdc, autoConnect });
      toast(`Подключение к @${uniqueId.replace(/^@/, '')} запущено`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-tiktok-disconnect').addEventListener('click', async () => {
    await api.post('/api/tiktok/disconnect');
    toast('TikTok LIVE отключён', 'info');
  });

  document.getElementById('btn-tiktok-check-live').addEventListener('click', async () => {
    const uniqueId = document.getElementById('tiktok-unique-id').value.trim();
    const resultEl = document.getElementById('tiktok-check-live-result');
    if (!uniqueId) return toast('Сначала укажите @uniqueId стримера', 'error');
    resultEl.textContent = 'Проверяю…';
    try {
      const { isLive } = await api.post('/api/tiktok/check-live', { uniqueId });
      resultEl.textContent = isLive
        ? `✅ @${uniqueId.replace(/^@/, '')} сейчас в эфире — можно подключаться`
        : `⛔ @${uniqueId.replace(/^@/, '')} сейчас НЕ в эфире — подключение выдаст ошибку, пока трансляция не начнётся`;
    } catch (err) {
      resultEl.textContent = `Не удалось проверить: ${err.message}`;
    }
  });

  socket.on('tiktok:status', (state) => {
    const el = document.getElementById('tiktok-status-detail');
    const parts = [];
    if (state.message) parts.push(state.message);
    if (state.status === 'connected') {
      parts.push(state.chatReplyAvailable ? '💬 Ответ в чат доступен' : 'ℹ️ Ответ в чат недоступен — не указаны сессионные cookie');
    }
    el.textContent = parts.join(' · ');
  });
}

function bindAxelChatForm() {
  const form = document.getElementById('form-axelchat-connect');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const host = document.getElementById('axelchat-host').value.trim() || '127.0.0.1';
    const port = Number(document.getElementById('axelchat-port').value) || 8356;
    const autoConnect = document.getElementById('axelchat-auto-connect').checked;
    try {
      await api.post('/api/axelchat/connect', { host, port, autoConnect });
      toast('Подключение к AxelChat запущено', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-axelchat-disconnect').addEventListener('click', async () => {
    await api.post('/api/axelchat/disconnect');
    toast('AxelChat отключён', 'info');
  });

  socket.on('axelchat:status', (state) => {
    const el = document.getElementById('axelchat-status-detail');
    el.textContent = state.message || '';
    if (state.states) renderPlatformStates(state.states);
  });
}

const PLATFORM_LABELS = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  youtubeshorts: 'YouTube Shorts',
  twitch: 'Twitch',
  kick: 'Kick',
  vkvideolive: 'VK Видео Трансляция',
  vkvideo: 'VK Видео',
  trovo: 'Trovo',
  goodgame: 'GoodGame',
  telegram: 'Telegram',
  discord: 'Discord',
  rutube: 'Rutube',
  ok: 'Одноклассники',
  facebook: 'Facebook',
};

const CONNECTION_STATE_LABELS = {
  connected: 'Подключено',
  connecting: 'Подключение…',
  not_connected: 'Не подключено',
  error: 'Ошибка',
};

function renderPlatformStates(states) {
  const table = document.getElementById('platform-states-table');
  const empty = document.getElementById('platform-states-empty');
  const services = (states && states.services) || [];

  if (!services.length) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';

  const tbody = document.getElementById('platform-states-tbody');
  const rows = services
    .filter((s) => s.enabled)
    .map((s) => {
      const label = PLATFORM_LABELS[s.type_id] || s.type_id;
      const stateLabel = CONNECTION_STATE_LABELS[s.connection_state] || s.connection_state;
      const badgeClass = s.connection_state === 'connected' ? 'on' : s.connection_state === 'connecting' ? '' : 'off';
      return `
        <tr>
          <td>${escapeHtml(label)}</td>
          <td><span class="badge ${badgeClass}">${escapeHtml(stateLabel)}</span></td>
          <td>${s.viewersCounterEnabled && s.viewers >= 0 ? s.viewers : '—'}</td>
          <td>${s.followers >= 0 ? s.followers : '—'}</td>
        </tr>`;
    });
  rows.push(`<tr><td><strong>Всего</strong></td><td></td><td><strong>${states.viewers ?? '—'}</strong></td><td></td></tr>`);
  tbody.innerHTML = rows.join('');
}

function bindResourceMonitor() {
  const cpuValue = document.getElementById('stat-cpu-value');
  const cpuMeter = document.getElementById('stat-cpu-meter');
  const ramValue = document.getElementById('stat-ram-value');
  const ramMeter = document.getElementById('stat-ram-meter');
  const sysValue = document.getElementById('stat-sys-value');

  socket.on('resource:sample', (sample) => {
    const cpuPercent = Math.min(100, sample.process.cpuPercent);
    cpuValue.textContent = `${sample.process.cpuPercent.toFixed(1)}%`;
    cpuMeter.style.width = `${cpuPercent}%`;

    ramValue.textContent = `${sample.process.rssMb.toFixed(0)} МБ`;
    const electronMb = sample.electron ? sample.electron.totalMemoryMb : sample.process.rssMb;
    ramMeter.style.width = `${Math.min(100, (electronMb / (sample.system.totalMemMb || 1)) * 100 * 6)}%`;

    sysValue.textContent = `${sample.system.usedMemPercent.toFixed(1)}% ОЗУ системы · ${sample.system.cpuCount} ядер`;
  });
}

function bindEventFeed() {
  const feed = document.getElementById('event-feed');
  socket.on('event:new', (evt) => {
    const row = document.createElement('div');
    row.className = 'event-row';
    row.innerHTML = `
      <span class="tag">${evt.source === 'tiktok' ? 'TikTok' : evt.platform}</span>
      <span>${escapeHtml(eventLabel(evt))}</span>
      <span class="time">${fmtTime(evt.timestamp)}</span>
    `;
    feed.prepend(row);
    while (feed.children.length > MAX_FEED_ITEMS) feed.removeChild(feed.lastChild);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export async function initDashboard() {
  bindTikTokForm();
  bindAxelChatForm();
  bindResourceMonitor();
  bindEventFeed();
  socket.on('axelchat:states', renderPlatformStates);
  try {
    await loadSettingsIntoForms();
  } catch (err) {
    toast(`Не удалось загрузить настройки: ${err.message}`, 'error');
  }
}
