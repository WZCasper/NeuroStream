import { api } from './api.js';
import { toast } from './toast.js';

const EVENT_TYPE_LABELS = {
  gift: 'Донат (подарок)',
  chat_keyword: 'Ключевое слово в чате',
  follow: 'Подписка на канал (follow)',
  share: 'Поделились трансляцией',
  subscribe: 'Оформлена подписка (sub)',
  like: 'Лайки',
};

const ACTION_TYPE_LABELS = {
  alert: 'Визуальный алерт',
  sound: 'Звуковой файл',
  http: 'HTTP-запрос / IoT',
  tts: 'Озвучка (TTS)',
  chat_reply: 'Ответ в чат (только TikTok)',
};

let editingId = null; // null = создание нового триггера
let mediaCache = [];
let devicesCache = [];
let widgetsCache = [];

function conditionsFieldsHtml(eventType, conditions = {}) {
  switch (eventType) {
    case 'gift':
      return `
        <div class="field"><label>Название подарка (необязательно)</label>
          <input type="text" data-cond="giftName" value="${escapeAttr(conditions.giftName || '')}" placeholder="например, Rose"></div>
        <div class="field"><label>Минимум монет (необязательно)</label>
          <input type="number" min="0" data-cond="minCoins" value="${conditions.minCoins ?? ''}"></div>`;
    case 'chat_keyword':
      return `
        <div class="field"><label>Ключевое слово</label>
          <input type="text" data-cond="keyword" value="${escapeAttr(conditions.keyword || '')}" required></div>
        <div class="field"><label>Режим сравнения</label>
          <select data-cond="matchMode">
            <option value="contains" ${conditions.matchMode !== 'exact' && conditions.matchMode !== 'startsWith' ? 'selected' : ''}>Содержит</option>
            <option value="startsWith" ${conditions.matchMode === 'startsWith' ? 'selected' : ''}>Начинается с</option>
            <option value="exact" ${conditions.matchMode === 'exact' ? 'selected' : ''}>Точное совпадение</option>
          </select></div>
        <label class="checkbox-row"><input type="checkbox" data-cond="caseSensitive" ${conditions.caseSensitive ? 'checked' : ''}> Учитывать регистр</label>`;
    case 'like':
      return `
        <div class="field"><label>Минимум лайков (необязательно)</label>
          <input type="number" min="0" data-cond="minLikeCount" value="${conditions.minLikeCount ?? ''}"></div>`;
    default:
      return `<p class="hint">Для этого типа события дополнительные условия не требуются.</p>`;
  }
}

function actionConfigFieldsHtml(actionType, config = {}) {
  switch (actionType) {
    case 'alert': {
      const options = widgetsCache
        .map((w) => `<option value="${w.id}" ${Number(config.widgetId) === w.id ? 'selected' : ''}>${escapeAttr(w.name)}</option>`)
        .join('');
      return `<select data-action-cfg="widgetId"><option value="">— выберите виджет из Media Library —</option>${options}</select>`;
    }
    case 'sound': {
      const options = mediaCache
        .filter((m) => m.kind === 'audio')
        .map((m) => `<option value="${m.id}" ${Number(config.mediaId) === m.id ? 'selected' : ''}>${escapeAttr(m.original_name)}</option>`)
        .join('');
      return `<select data-action-cfg="mediaId"><option value="">— выберите звуковой файл —</option>${options}</select>`;
    }
    case 'http': {
      const deviceOptions = devicesCache
        .map((d) => `<option value="${d.id}" ${Number(config.deviceId) === d.id ? 'selected' : ''}>${escapeAttr(d.name)}</option>`)
        .join('');
      return `
        <select data-action-cfg="deviceId"><option value="">— выберите устройство —</option>${deviceOptions}</select>
        <select data-action-cfg="method">
          <option value="GET" ${config.method !== 'POST' ? 'selected' : ''}>GET</option>
          <option value="POST" ${config.method === 'POST' ? 'selected' : ''}>POST</option>
        </select>
        <input type="text" data-action-cfg="path" value="${escapeAttr(config.path || '/')}" placeholder="/relay/on">
        <textarea data-action-cfg="body" placeholder='{"state":"on"} (необязательно, для POST)'>${escapeAttr(typeof config.body === 'string' ? config.body : JSON.stringify(config.body || {}))}</textarea>`;
    }
    case 'tts':
      return `<textarea data-action-cfg="template" placeholder="Оставьте пустым, чтобы использовать шаблон по умолчанию из вкладки TTS & Chat">${escapeAttr(config.template || '')}</textarea>`;
    case 'chat_reply':
      return `<textarea data-action-cfg="text" placeholder="Например: Спасибо, {user}, за {gift}! Работает только для TikTok и только если указаны сессионные cookie на вкладке Главная.">${escapeAttr(config.text || '')}</textarea>`;
    default:
      return '';
  }
}

function actionRowHtml(action, index) {
  return `
    <div class="action-row" data-index="${index}">
      <span class="handle">⠿</span>
      <select data-action-type>
        ${Object.entries(ACTION_TYPE_LABELS).map(([k, label]) => `<option value="${k}" ${action.action_type === k ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <div class="action-config row wrap" style="flex:1">${actionConfigFieldsHtml(action.action_type || 'alert', action.config)}</div>
      <button type="button" class="btn small ghost" data-move-up title="Выше">↑</button>
      <button type="button" class="btn small ghost" data-move-down title="Ниже">↓</button>
      <button type="button" class="btn small danger" data-remove-action title="Удалить">✕</button>
    </div>`;
}

function renderActionChain(container, actions) {
  container.innerHTML = actions.map(actionRowHtml).join('') || '<p class="hint">Действий пока нет — добавьте первое ниже.</p>';

  container.querySelectorAll('[data-action-type]').forEach((sel, i) => {
    sel.addEventListener('change', () => {
      actions[i].action_type = sel.value;
      actions[i].config = {};
      renderActionChain(container, actions);
    });
  });
  container.querySelectorAll('[data-remove-action]').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      actions.splice(i, 1);
      renderActionChain(container, actions);
    });
  });
  container.querySelectorAll('[data-move-up]').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (i === 0) return;
      [actions[i - 1], actions[i]] = [actions[i], actions[i - 1]];
      renderActionChain(container, actions);
    });
  });
  container.querySelectorAll('[data-move-down]').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (i === actions.length - 1) return;
      [actions[i + 1], actions[i]] = [actions[i], actions[i + 1]];
      renderActionChain(container, actions);
    });
  });
}

function collectActionConfig(row, actionType) {
  const config = {};
  row.querySelectorAll('[data-action-cfg]').forEach((el) => {
    const key = el.dataset.actionCfg;
    config[key] = el.value;
  });
  if (actionType === 'http') {
    if (config.body) {
      try {
        config.body = JSON.parse(config.body);
      } catch {
        /* оставляем как обычную строку, если это не JSON */
      }
    }
    if (config.deviceId) config.deviceId = Number(config.deviceId);
  }
  if ((actionType === 'alert' || actionType === 'sound') && (config.mediaId || config.widgetId)) {
    if (config.mediaId) config.mediaId = Number(config.mediaId);
    if (config.widgetId) config.widgetId = Number(config.widgetId);
  }
  return config;
}

async function openForm(trigger = null) {
  editingId = trigger ? trigger.id : null;
  [mediaCache, devicesCache, widgetsCache] = await Promise.all([
    api.get('/api/media'),
    api.get('/api/iot/devices'),
    api.get('/api/alert-widgets'),
  ]);

  const formEl = document.getElementById('trigger-form');
  formEl.style.display = 'block';
  document.getElementById('trigger-form-title').textContent = trigger ? `Изменить триггер: ${trigger.name}` : 'Новый триггер';

  document.getElementById('trigger-name').value = trigger?.name || '';
  document.getElementById('trigger-source').value = trigger?.source || 'tiktok';
  document.getElementById('trigger-event-type').value = trigger?.event_type || 'gift';
  document.getElementById('trigger-cooldown').value = trigger?.cooldown_ms ?? 0;

  const conditions = trigger?.conditions_json ? JSON.parse(trigger.conditions_json) : {};
  const condContainer = document.getElementById('trigger-conditions');
  condContainer.innerHTML = conditionsFieldsHtml(document.getElementById('trigger-event-type').value, conditions);

  document.getElementById('trigger-event-type').onchange = (e) => {
    condContainer.innerHTML = conditionsFieldsHtml(e.target.value, {});
  };

  const actions = trigger?.actions?.map((a) => ({ action_type: a.action_type, config: JSON.parse(a.config_json || '{}') })) || [];
  const chainContainer = document.getElementById('trigger-action-chain');
  renderActionChain(chainContainer, actions);

  document.getElementById('btn-add-action').onclick = () => {
    actions.push({ action_type: 'alert', config: {} });
    renderActionChain(chainContainer, actions);
  };

  formEl.onsubmit = async (e) => {
    e.preventDefault();
    await saveTrigger(actions, condContainer);
  };
}

function closeForm() {
  document.getElementById('trigger-form').style.display = 'none';
  editingId = null;
}

async function saveTrigger(actions, condContainer) {
  const name = document.getElementById('trigger-name').value.trim();
  if (!name) return toast('Укажите название триггера', 'error');

  const eventType = document.getElementById('trigger-event-type').value;
  const conditions = {};
  condContainer.querySelectorAll('[data-cond]').forEach((el) => {
    const key = el.dataset.cond;
    if (el.type === 'checkbox') conditions[key] = el.checked;
    else if (el.value !== '') conditions[key] = el.type === 'number' ? Number(el.value) : el.value;
  });

  const chainContainer = document.getElementById('trigger-action-chain');
  const actionRows = Array.from(chainContainer.querySelectorAll('.action-row'));
  const preparedActions = actionRows.map((row, i) => {
    const actionType = row.querySelector('[data-action-type]').value;
    return { actionType, config: collectActionConfig(row, actionType) };
  });

  const payload = {
    name,
    source: document.getElementById('trigger-source').value,
    eventType,
    conditions,
    cooldownMs: Number(document.getElementById('trigger-cooldown').value) || 0,
    actions: preparedActions,
  };

  try {
    if (editingId) {
      await api.put(`/api/triggers/${editingId}`, payload);
      toast('Триггер обновлён', 'success');
    } else {
      await api.post('/api/triggers', payload);
      toast('Триггер создан', 'success');
    }
    closeForm();
    await refreshList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function summarizeConditions(trigger) {
  const c = JSON.parse(trigger.conditions_json || '{}');
  if (trigger.event_type === 'gift') return [c.giftName && `подарок: ${c.giftName}`, c.minCoins && `от ${c.minCoins} монет`].filter(Boolean).join(', ') || 'любой подарок';
  if (trigger.event_type === 'chat_keyword') return `«${c.keyword || '?'}» (${c.matchMode || 'contains'})`;
  if (trigger.event_type === 'like') return c.minLikeCount ? `от ${c.minLikeCount} лайков` : 'любые лайки';
  return '—';
}

async function refreshList() {
  const triggers = await api.get('/api/triggers');
  const tbody = document.getElementById('triggers-tbody');

  if (!triggers.length) {
    tbody.innerHTML = '';
    document.getElementById('triggers-empty').style.display = 'block';
    return;
  }
  document.getElementById('triggers-empty').style.display = 'none';

  tbody.innerHTML = triggers
    .map(
      (t) => `
      <tr data-id="${t.id}">
        <td><label class="checkbox-row"><input type="checkbox" data-toggle-enabled ${t.enabled ? 'checked' : ''}></label></td>
        <td>${escapeHtml(t.name)}</td>
        <td>${t.source}</td>
        <td>${EVENT_TYPE_LABELS[t.event_type] || t.event_type}</td>
        <td>${escapeHtml(summarizeConditions(t))}</td>
        <td>${t.actions.map((a) => ACTION_TYPE_LABELS[a.action_type] || a.action_type).join(' → ') || '—'}</td>
        <td class="row">
          <button class="btn small" data-edit>Изменить</button>
          <button class="btn small danger" data-delete>Удалить</button>
        </td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const trigger = triggers.find((t) => t.id === id);

    tr.querySelector('[data-toggle-enabled]').addEventListener('change', async (e) => {
      await api.put(`/api/triggers/${id}`, { enabled: e.target.checked });
    });
    tr.querySelector('[data-edit]').addEventListener('click', () => openForm(trigger));
    tr.querySelector('[data-delete]').addEventListener('click', async () => {
      if (!window.confirm(`Удалить триггер «${trigger.name}»?`)) return;
      await api.del(`/api/triggers/${id}`);
      toast('Триггер удалён', 'info');
      refreshList();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str ?? '').replace(/"/g, '&quot;');
}

export async function initTriggers() {
  document.getElementById('btn-new-trigger').addEventListener('click', () => openForm(null));
  document.getElementById('btn-cancel-trigger-form').addEventListener('click', closeForm);
  try {
    await refreshList();
  } catch (err) {
    toast(`Не удалось загрузить триггеры: ${err.message}`, 'error');
  }
}
