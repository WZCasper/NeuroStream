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

export function initLogsSettings() {
  bindLogStream();
}
