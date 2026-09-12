import { api } from './api.js';
import { toast } from './toast.js';

function getVoicesAsync() {
  return new Promise((resolve) => {
    let voices = window.speechSynthesis.getVoices();
    if (voices.length) return resolve(voices);
    window.speechSynthesis.onvoiceschanged = () => {
      voices = window.speechSynthesis.getVoices();
      resolve(voices);
    };
    // Некоторые системы не присылают voiceschanged вовсе — подстрахуемся таймаутом.
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1200);
  });
}

function populateVoiceSelect(select, voices, selectedUri) {
  select.innerHTML =
    '<option value="">— системный голос по умолчанию —</option>' +
    voices
      .map((v) => `<option value="${v.voiceURI}" ${v.voiceURI === selectedUri ? 'selected' : ''}>${v.name} (${v.lang})</option>`)
      .join('');
}

function bindPresetPanel(source, voices) {
  const root = document.querySelector(`[data-preset-panel="${source}"]`);
  const els = {
    enabled: root.querySelector('[data-f="enabled"]'),
    voice: root.querySelector('[data-f="voice_uri"]'),
    rate: root.querySelector('[data-f="rate"]'),
    rateVal: root.querySelector('[data-f="rate_val"]'),
    pitch: root.querySelector('[data-f="pitch"]'),
    pitchVal: root.querySelector('[data-f="pitch_val"]'),
    volume: root.querySelector('[data-f="volume"]'),
    volumeVal: root.querySelector('[data-f="volume_val"]'),
    readChat: root.querySelector('[data-f="read_chat"]'),
    readGifts: root.querySelector('[data-f="read_gifts"]'),
    readFollows: root.querySelector('[data-f="read_follows"]'),
    readSubscribes: root.querySelector('[data-f="read_subscribes"]'),
    minCoins: root.querySelector('[data-f="min_gift_coins"]'),
    chatTemplate: root.querySelector('[data-f="chat_template"]'),
    giftTemplate: root.querySelector('[data-f="gift_template"]'),
    testText: root.querySelector('[data-f="test_text"]'),
  };

  populateVoiceSelect(els.voice, voices, null);

  root.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const payload = {
      enabled: els.enabled.checked,
      voice_uri: els.voice.value || null,
      voice_name: els.voice.selectedOptions[0]?.textContent || null,
      rate: Number(els.rate.value),
      pitch: Number(els.pitch.value),
      volume: Number(els.volume.value),
      read_chat: els.readChat.checked,
      read_gifts: els.readGifts.checked,
      read_follows: els.readFollows.checked,
      read_subscribes: els.readSubscribes.checked,
      min_gift_coins: Number(els.minCoins.value) || 0,
      chat_template: els.chatTemplate.value,
      gift_template: els.giftTemplate.value,
    };
    try {
      await api.put(`/api/tts/presets/${source}`, payload);
      toast(`Настройки озвучки (${source}) сохранены`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  root.querySelector('[data-action="test"]').addEventListener('click', () => {
    const text = els.testText.value.trim() || 'Проверка синтеза речи NeuroStream Studio';
    const utter = new SpeechSynthesisUtterance(text);
    const voice = voices.find((v) => v.voiceURI === els.voice.value);
    if (voice) utter.voice = voice;
    utter.rate = Number(els.rate.value);
    utter.pitch = Number(els.pitch.value);
    utter.volume = Number(els.volume.value);
    window.speechSynthesis.speak(utter);
  });

  [
    [els.rate, els.rateVal],
    [els.pitch, els.pitchVal],
    [els.volume, els.volumeVal],
  ].forEach(([range, out]) => {
    range.addEventListener('input', () => (out.textContent = Number(range.value).toFixed(2)));
  });

  return { root, els };
}

function fillPreset(bound, preset) {
  const { els } = bound;
  els.enabled.checked = !!preset.enabled;
  els.voice.value = preset.voice_uri || '';
  els.rate.value = preset.rate;
  els.rateVal.textContent = Number(preset.rate).toFixed(2);
  els.pitch.value = preset.pitch;
  els.pitchVal.textContent = Number(preset.pitch).toFixed(2);
  els.volume.value = preset.volume;
  els.volumeVal.textContent = Number(preset.volume).toFixed(2);
  els.readChat.checked = !!preset.read_chat;
  els.readGifts.checked = !!preset.read_gifts;
  els.readFollows.checked = !!preset.read_follows;
  els.readSubscribes.checked = !!preset.read_subscribes;
  els.minCoins.value = preset.min_gift_coins || 0;
  els.chatTemplate.value = preset.chat_template || '';
  els.giftTemplate.value = preset.gift_template || '';
}

// ------------------------------ Фильтр ненормативной лексики ------------------------------

function ruleRowHtml(rule) {
  return `
    <tr data-id="${rule.id}">
      <td><code>${escapeHtml(rule.pattern)}</code></td>
      <td>${rule.is_regex ? `regex /${escapeHtml(rule.flags)}/` : 'подстрока'}</td>
      <td>${escapeHtml(rule.replacement)}</td>
      <td><input type="checkbox" data-toggle ${rule.enabled ? 'checked' : ''}></td>
      <td><button class="btn small danger" data-delete>Удалить</button></td>
    </tr>`;
}

async function refreshRules() {
  const rules = await api.get('/api/profanity-rules');
  const tbody = document.getElementById('profanity-tbody');
  tbody.innerHTML = rules.map(ruleRowHtml).join('') || '';
  document.getElementById('profanity-empty').style.display = rules.length ? 'none' : 'block';

  tbody.querySelectorAll('tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-toggle]').addEventListener('change', async (e) => {
      await api.put(`/api/profanity-rules/${id}`, { enabled: e.target.checked });
    });
    tr.querySelector('[data-delete]').addEventListener('click', async () => {
      await api.del(`/api/profanity-rules/${id}`);
      toast('Правило удалено', 'info');
      refreshRules();
    });
  });
}

function bindProfanityForm() {
  const form = document.getElementById('form-profanity-rule');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pattern = document.getElementById('rule-pattern').value.trim();
    if (!pattern) return toast('Укажите слово или регулярное выражение', 'error');
    const isRegex = document.getElementById('rule-is-regex').checked;
    const replacement = document.getElementById('rule-replacement').value || '***';
    const flags = document.getElementById('rule-flags').value || 'giu';
    try {
      await api.post('/api/profanity-rules', { pattern, isRegex, replacement, flags });
      form.reset();
      document.getElementById('rule-replacement').value = '***';
      document.getElementById('rule-flags').value = 'giu';
      toast('Правило добавлено', 'success');
      refreshRules();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  document.getElementById('btn-test-filter').addEventListener('click', async () => {
    const text = document.getElementById('filter-test-input').value;
    const { result } = await api.post('/api/profanity-rules/test', { text });
    document.getElementById('filter-test-output').textContent = result;
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export async function initTts() {
  const voices = await getVoicesAsync();
  const tiktokPanel = bindPresetPanel('tiktok', voices);
  const axelchatPanel = bindPresetPanel('axelchat', voices);

  try {
    const presets = await api.get('/api/tts/presets');
    const tiktokPreset = presets.find((p) => p.source === 'tiktok');
    const axelchatPreset = presets.find((p) => p.source === 'axelchat');
    if (tiktokPreset) fillPreset(tiktokPanel, tiktokPreset);
    if (axelchatPreset) fillPreset(axelchatPanel, axelchatPreset);
  } catch (err) {
    toast(`Не удалось загрузить пресеты TTS: ${err.message}`, 'error');
  }

  bindProfanityForm();
  try {
    await refreshRules();
  } catch (err) {
    toast(`Не удалось загрузить правила фильтра: ${err.message}`, 'error');
  }
}
