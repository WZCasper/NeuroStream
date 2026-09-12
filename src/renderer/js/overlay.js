const socket = window.io();

const root = document.getElementById('alert-root');
const mediaSlot = root.querySelector('.alert-media-slot');
const textEl = root.querySelector('.alert-text');
const customCssEl = document.getElementById('custom-widget-css');

let mediaById = new Map();
let widgetsById = new Map();
let queue = [];
let showing = false;

async function refreshCaches() {
  try {
    const [media, widgets] = await Promise.all([
      fetch('/api/media').then((r) => r.json()),
      fetch('/api/alert-widgets').then((r) => r.json()),
    ]);
    mediaById = new Map(media.map((m) => [m.id, m]));
    widgetsById = new Map(widgets.map((w) => [w.id, w]));
  } catch {
    // сервер мог быть временно недоступен — при следующем алерте попробуем снова
  }
}

function renderMediaTag(mediaItem) {
  if (!mediaItem) return '';
  const url = `/media/${mediaItem.filename}`;
  if (mediaItem.kind === 'video') return `<video class="alert-media" src="${url}" autoplay muted playsinline></video>`;
  if (mediaItem.kind === 'image') return `<img class="alert-media" src="${url}" alt="">`;
  return '';
}

function renderText(template, event) {
  const message =
    event.type === 'chat'
      ? event.text || ''
      : event.type === 'gift'
      ? `${event.giftName || 'подарок'} x${event.repeatCount || 1}`
      : event.type;
  const vars = { user: event.author?.name || 'Зритель', message, text: event.text || '' };
  return String(template || '{user} — {message}').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? escapeHtml(String(vars[k])) : m));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function showNext() {
  if (showing) return;
  const item = queue.shift();
  if (!item) return;
  showing = true;

  const widget = item.config?.widgetId ? widgetsById.get(Number(item.config.widgetId)) : null;
  const media = widget ? mediaById.get(widget.media_id) : item.config?.mediaId ? mediaById.get(Number(item.config.mediaId)) : null;
  const template = widget?.text_template || '{user} — {message}';
  const durationMs = widget?.duration_ms || 6000;

  customCssEl.textContent = widget?.custom_css || '';
  mediaSlot.innerHTML = renderMediaTag(media);
  textEl.innerHTML = renderText(template, item.event || {});

  requestAnimationFrame(() => root.classList.add('visible'));

  setTimeout(() => {
    root.classList.remove('visible');
    setTimeout(() => {
      mediaSlot.innerHTML = '';
      textEl.textContent = '';
      showing = false;
      showNext();
    }, 400);
  }, durationMs);
}

socket.on('overlay:alert', async (payload) => {
  if (!mediaById.size && !widgetsById.size) await refreshCaches();
  queue.push(payload);
  showNext();
});

socket.on('overlay:sound', async (payload) => {
  const mediaId = Number(payload.config?.mediaId);
  if (!mediaId) return;
  if (!mediaById.has(mediaId)) await refreshCaches();
  const media = mediaById.get(mediaId);
  if (!media) return;
  const audio = new Audio(`/media/${media.filename}`);
  audio.play().catch(() => {
    /* автовоспроизведение могло быть заблокировано — источник должен быть активирован в OBS */
  });
});

socket.on('media:changed', refreshCaches);

refreshCaches();
