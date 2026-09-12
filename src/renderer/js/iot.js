import { api } from './api.js';
import { toast } from './toast.js';
import { socket } from './socket.js';

let editingId = null;
let devicesCache = [];

function statusDotHtml(status) {
  const cls = status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'unknown';
  return `<span class="iot-status-dot ${cls}"></span>`;
}

function deviceRowHtml(d) {
  return `
    <tr data-id="${d.id}">
      <td>${statusDotHtml(d.last_status)}<span data-status-text>${d.last_status === 'online' ? 'Онлайн' : d.last_status === 'offline' ? 'Офлайн' : 'Неизвестно'}</span></td>
      <td>${escapeHtml(d.name)}</td>
      <td><code>${escapeHtml(d.base_url)}</code></td>
      <td>${escapeHtml(d.health_ping_path)}</td>
      <td><span data-latency>${d.last_latency_ms != null ? d.last_latency_ms + ' мс' : '—'}</span></td>
      <td class="row wrap">
        <button class="btn small" data-test>Тест GET /</button>
        <button class="btn small" data-edit>Изменить</button>
        <button class="btn small danger" data-delete>Удалить</button>
      </td>
    </tr>`;
}

async function refreshList() {
  devicesCache = await api.get('/api/iot/devices');
  const tbody = document.getElementById('iot-tbody');

  if (!devicesCache.length) {
    tbody.innerHTML = '';
    document.getElementById('iot-empty').style.display = 'block';
    return;
  }
  document.getElementById('iot-empty').style.display = 'none';
  tbody.innerHTML = devicesCache.map(deviceRowHtml).join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const device = devicesCache.find((d) => d.id === id);

    tr.querySelector('[data-test]').addEventListener('click', async () => {
      try {
        const result = await api.post(`/api/iot/devices/${id}/send`, { method: 'GET', path: '/' });
        toast(`Ответ устройства "${device.name}": HTTP ${result.status}`, result.ok ? 'success' : 'error');
      } catch (err) {
        toast(`Устройство "${device.name}" не отвечает: ${err.message}`, 'error');
      }
    });
    tr.querySelector('[data-edit]').addEventListener('click', () => openForm(device));
    tr.querySelector('[data-delete]').addEventListener('click', async () => {
      if (!window.confirm(`Удалить устройство «${device.name}»?`)) return;
      await api.del(`/api/iot/devices/${id}`);
      toast('Устройство удалено', 'info');
      refreshList();
    });
  });
}

function openForm(device = null) {
  editingId = device ? device.id : null;
  document.getElementById('iot-form').style.display = 'block';
  document.getElementById('iot-form-title').textContent = device ? `Изменить устройство: ${device.name}` : 'Новое IoT-устройство';
  document.getElementById('iot-name').value = device?.name || '';
  document.getElementById('iot-base-url').value = device?.base_url || 'http://192.168.1.';
  document.getElementById('iot-ping-path').value = device?.health_ping_path || '/ping';
  document.getElementById('iot-ping-interval').value = device?.health_ping_interval_ms || 15000;
  document.getElementById('iot-ping-enabled').checked = device ? !!device.health_ping_enabled : true;
}

function closeForm() {
  document.getElementById('iot-form').style.display = 'none';
  editingId = null;
}

async function saveDevice(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('iot-name').value.trim(),
    baseUrl: document.getElementById('iot-base-url').value.trim(),
    healthPingPath: document.getElementById('iot-ping-path').value.trim() || '/ping',
    healthPingIntervalMs: Number(document.getElementById('iot-ping-interval').value) || 15000,
    healthPingEnabled: document.getElementById('iot-ping-enabled').checked,
  };
  if (!payload.name || !payload.baseUrl) return toast('Укажите название и адрес устройства', 'error');

  try {
    if (editingId) {
      await api.put(`/api/iot/devices/${editingId}`, payload);
      toast('Устройство обновлено', 'success');
    } else {
      await api.post('/api/iot/devices', payload);
      toast('Устройство добавлено', 'success');
    }
    closeForm();
    refreshList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function bindLiveStatus() {
  socket.on('iot:status', ({ id, status, latencyMs }) => {
    const tr = document.querySelector(`#iot-tbody tr[data-id="${id}"]`);
    if (!tr) return;
    const dot = tr.querySelector('.iot-status-dot');
    dot.className = `iot-status-dot ${status}`;
    tr.querySelector('[data-status-text]').textContent = status === 'online' ? 'Онлайн' : 'Офлайн';
    tr.querySelector('[data-latency]').textContent = latencyMs != null ? `${latencyMs} мс` : '—';
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export async function initIot() {
  document.getElementById('btn-new-iot-device').addEventListener('click', () => openForm(null));
  document.getElementById('btn-cancel-iot-form').addEventListener('click', closeForm);
  document.getElementById('iot-form').addEventListener('submit', saveDevice);
  bindLiveStatus();
  try {
    await refreshList();
  } catch (err) {
    toast(`Не удалось загрузить устройства: ${err.message}`, 'error');
  }
}
