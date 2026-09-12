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
  const autoConnectInput = document.getElementById('tiktok-auto-connect');
  if (settings.tiktokUniqueId) uniqueIdInput.value = settings.tiktokUniqueId;
  if (settings.tiktokSignApiKey) signApiKeyInput.value = settings.tiktokSignApiKey;
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
    const autoConnect = document.getElementById('tiktok-auto-connect').checked;
    if (!uniqueId) return toast('Укажите @uniqueId стримера', 'error');
    try {
      await api.post('/api/tiktok/connect', { uniqueId, signApiKey, autoConnect });
      toast(`Подключение к @${uniqueId.replace(/^@/, '')} запущено`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-tiktok-disconnect').addEventListener('click', async () => {
    await api.post('/api/tiktok/disconnect');
    toast('TikTok LIVE отключён', 'info');
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
  try {
    await loadSettingsIntoForms();
  } catch (err) {
    toast(`Не удалось загрузить настройки: ${err.message}`, 'error');
  }
}
