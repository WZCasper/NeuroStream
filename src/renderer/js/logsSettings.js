import { api } from './api.js';
import { toast } from './toast.js';
import { socket } from './socket.js';

const MAX_VISIBLE_LOGS = 300;
let allLogs = [];
let currentFilter = 'all';

function logLineHtml(entry) {
  const time = new Date(entry.created_at || entry.createdAt).toLocaleTimeString('ru-RU');
  return `<div class="log-line ${entry.level}">[${time}] <span class="cat">${entry.category}</span> — ${escapeHtml(entry.message)}</div>`;
}

function renderLogs() {
  const container = document.getElementById('log-stream');
  const filtered = currentFilter === 'all' ? allLogs : allLogs.filter((l) => l.category === currentFilter);
  container.innerHTML = filtered.slice(-MAX_VISIBLE_LOGS).map(logLineHtml).join('');
  container.scrollTop = container.scrollHeight;
}

function bindLogStream() {
  socket.on('log:recent', (entries) => {
    allLogs = entries;
    renderLogs();
  });
  socket.on('log:entry', (entry) => {
    allLogs.push(entry);
    if (allLogs.length > 2000) allLogs = allLogs.slice(-1000);
    renderLogs();
  });

  document.getElementById('log-filter').addEventListener('change', (e) => {
    currentFilter = e.target.value;
    renderLogs();
  });

  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    if (!window.confirm('Очистить журнал событий?')) return;
    await api.del('/api/logs');
    allLogs = [];
    renderLogs();
    toast('Журнал очищен', 'info');
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function bindBackup() {
  document.getElementById('btn-export-settings').addEventListener('click', async () => {
    try {
      const data = await api.get('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `neurostream-studio-backup-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Резервная копия сохранена', 'success');
    } catch (err) {
      toast(`Не удалось экспортировать: ${err.message}`, 'error');
    }
  });

  const fileInput = document.getElementById('import-settings-file');
  document.getElementById('btn-import-settings').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!window.confirm('Импортировать настройки из файла? Существующие триггеры/виджеты/устройства не будут удалены — новые добавятся рядом.')) return;
      const result = await api.post('/api/import', data);
      const s = result.summary;
      toast(
        `Импортировано: триггеров — ${s.triggers}, виджетов — ${s.alertWidgets}, IoT — ${s.iotDevices}, правил фильтра — ${s.profanityRules}`,
        'success'
      );
    } catch (err) {
      toast(`Не удалось импортировать: ${err.message}`, 'error');
    }
  });
}

export function initLogsSettings() {
  bindLogStream();
  bindBackup();
}
