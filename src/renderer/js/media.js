import { api, uploadFile } from './api.js';
import { toast } from './toast.js';
import { socket } from './socket.js';

const ACCEPTED_EXT = ['.webm', '.mp4', '.gif', '.png', '.jpg', '.jpeg', '.mp3', '.wav', '.ogg'];

let mediaCache = [];
let editingWidgetId = null;

// ------------------------------------- Медиатека -------------------------------------

function mediaPreviewHtml(item) {
  const url = `/media/${item.filename}`;
  if (item.kind === 'video') return `<video src="${url}" muted loop autoplay playsinline></video>`;
  if (item.kind === 'image') return `<img src="${url}" alt="">`;
  if (item.kind === 'audio') return `<audio src="${url}" controls style="width:100%"></audio>`;
  return `<span class="hint">${item.mime_type || 'файл'}</span>`;
}

function mediaTileHtml(item) {
  return `
    <div class="media-tile" data-id="${item.id}">
      <div class="preview">${mediaPreviewHtml(item)}</div>
      <div class="meta">
        <span class="name" title="${escapeAttr(item.original_name)}">${escapeHtml(item.original_name)}</span>
        <button class="btn small danger" data-delete-media>✕</button>
      </div>
    </div>`;
}

async function refreshMediaGrid() {
  mediaCache = await api.get('/api/media');
  const grid = document.getElementById('media-grid');
  grid.innerHTML = mediaCache.map(mediaTileHtml).join('');
  document.getElementById('media-empty').style.display = mediaCache.length ? 'none' : 'block';

  grid.querySelectorAll('[data-delete-media]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const tile = e.target.closest('.media-tile');
      const id = Number(tile.dataset.id);
      if (!window.confirm('Удалить файл из медиатеки?')) return;
      await api.del(`/api/media/${id}`);
      toast('Файл удалён', 'info');
    });
  });

  populateWidgetMediaSelect();
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED_EXT.includes(ext)) {
      toast(`Формат ${ext} не поддерживается`, 'error');
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await uploadFile('/api/media', file);
    } catch (err) {
      toast(`Не удалось загрузить "${file.name}": ${err.message}`, 'error');
    }
  }
  toast('Загрузка медиатеки завершена', 'success');
}

function bindDropzone() {
  const zone = document.getElementById('media-dropzone');
  const input = document.getElementById('media-file-input');

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) handleFiles(input.files);
    input.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    })
  );
  zone.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
  });
}

// ------------------------------------- Виджеты алертов -------------------------------------

function populateWidgetMediaSelect() {
  const select = document.getElementById('widget-media');
  const current = select.value;
  select.innerHTML =
    '<option value="">— без медиафайла —</option>' +
    mediaCache.map((m) => `<option value="${m.id}">${escapeHtml(m.original_name)}</option>`).join('');
  if (current) select.value = current;
}

function widgetRowHtml(w) {
  return `
    <tr data-id="${w.id}">
      <td>${escapeHtml(w.name)}</td>
      <td>${w.duration_ms} мс</td>
      <td><code>${escapeHtml(w.text_template)}</code></td>
      <td class="row wrap">
        <button class="btn small" data-test-widget>Тест</button>
        <button class="btn small" data-edit-widget>Изменить</button>
        <button class="btn small danger" data-delete-widget>Удалить</button>
      </td>
    </tr>`;
}

async function refreshWidgets() {
  const widgets = await api.get('/api/alert-widgets');
  const tbody = document.getElementById('widgets-tbody');
  tbody.innerHTML = widgets.map(widgetRowHtml).join('');
  document.getElementById('widgets-empty').style.display = widgets.length ? 'none' : 'block';

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const widget = widgets.find((w) => w.id === id);
    tr.querySelector('[data-test-widget]').addEventListener('click', async () => {
      await api.post(`/api/alert-widgets/${id}/test`);
      toast('Тестовый алерт отправлен в OBS Browser Source', 'success');
    });
    tr.querySelector('[data-edit-widget]').addEventListener('click', () => openWidgetForm(widget));
    tr.querySelector('[data-delete-widget]').addEventListener('click', async () => {
      if (!window.confirm(`Удалить виджет «${widget.name}»?`)) return;
      await api.del(`/api/alert-widgets/${id}`);
      toast('Виджет удалён', 'info');
      refreshWidgets();
    });
  });
}

function openWidgetForm(widget = null) {
  editingWidgetId = widget ? widget.id : null;
  document.getElementById('widget-form').style.display = 'block';
  document.getElementById('widget-form-title').textContent = widget ? `Изменить виджет: ${widget.name}` : 'Новый виджет алерта';
  document.getElementById('widget-name').value = widget?.name || '';
  populateWidgetMediaSelect();
  document.getElementById('widget-media').value = widget?.media_id || '';
  document.getElementById('widget-duration').value = widget?.duration_ms || 6000;
  document.getElementById('widget-template').value = widget?.text_template || '{user} — {message}';
  document.getElementById('widget-css').value = widget?.custom_css || '';
}

function closeWidgetForm() {
  document.getElementById('widget-form').style.display = 'none';
  editingWidgetId = null;
}

async function saveWidget(e) {
  e.preventDefault();
  const payload = {
    name: document.getElementById('widget-name').value.trim(),
    mediaId: Number(document.getElementById('widget-media').value) || null,
    durationMs: Number(document.getElementById('widget-duration').value) || 6000,
    textTemplate: document.getElementById('widget-template').value,
    customCss: document.getElementById('widget-css').value,
  };
  if (!payload.name) return toast('Укажите название виджета', 'error');

  try {
    if (editingWidgetId) await api.put(`/api/alert-widgets/${editingWidgetId}`, payload);
    else await api.post('/api/alert-widgets', payload);
    toast('Виджет сохранён', 'success');
    closeWidgetForm();
    refreshWidgets();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}

export async function initMedia() {
  bindDropzone();
  document.getElementById('btn-new-widget').addEventListener('click', () => openWidgetForm(null));
  document.getElementById('btn-cancel-widget-form').addEventListener('click', closeWidgetForm);
  document.getElementById('widget-form').addEventListener('submit', saveWidget);

  socket.on('media:changed', refreshMediaGrid);

  try {
    await refreshMediaGrid();
    await refreshWidgets();
  } catch (err) {
    toast(`Не удалось загрузить медиатеку: ${err.message}`, 'error');
  }
}
