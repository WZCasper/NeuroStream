// Простой, но полезный пикер эмодзи — как быстрая панель в Telegram: набор популярных
// эмодзи, клик вставляет символ в текущую позицию курсора в поле.

const EMOJI_SET = [
  '😀', '😂', '😍', '🥰', '😎', '🤩', '🥳', '😭', '😱', '🤔',
  '👍', '👏', '🙌', '🤝', '💪', '🔥', '⭐', '✨', '🎉', '🎊',
  '❤️', '💜', '💙', '💚', '💛', '🧡', '🖤', '💯', '⚡', '🌟',
  '🎁', '🏆', '🥇', '🎮', '🎤', '🎵', '🔔', '📢', '💬', '👑',
  '🚀', '💎', '🍀', '🌈', '☕', '🍕', '🐱', '🐶', '🦄', '👋',
  '✅', '❌', '⚠️', '❓', '❗', '💤', '👀', '🙏', '😅', '😉',
];

/**
 * Добавляет кнопку-эмодзи рядом с полем ввода и всплывающую панель выбора.
 * Оборачивает исходный элемент в контейнер .emoji-field-row (без потери id/атрибутов поля).
 * @param {HTMLInputElement|HTMLTextAreaElement} field
 */
export function attachEmojiPicker(field) {
  if (!field || field.dataset.emojiAttached) return;
  field.dataset.emojiAttached = '1';

  const row = document.createElement('div');
  row.className = 'emoji-field-row';
  row.style.position = 'relative';
  field.parentNode.insertBefore(row, field);
  row.appendChild(field);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'emoji-btn';
  btn.title = 'Вставить эмодзи';
  btn.textContent = '🙂';

  const picker = document.createElement('div');
  picker.className = 'emoji-picker';
  EMOJI_SET.forEach((emoji) => {
    const em = document.createElement('button');
    em.type = 'button';
    em.textContent = emoji;
    em.addEventListener('click', () => {
      insertAtCursor(field, emoji);
      picker.classList.remove('open');
    });
    picker.appendChild(em);
  });

  row.appendChild(btn);
  row.appendChild(picker);
  picker.style.top = '100%';
  picker.style.right = '0';
  picker.style.marginTop = '4px';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.emoji-picker.open').forEach((p) => {
      if (p !== picker) p.classList.remove('open');
    });
    picker.classList.toggle('open');
  });

  document.addEventListener('click', (e) => {
    if (!row.contains(e.target)) picker.classList.remove('open');
  });
}

function insertAtCursor(field, text) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = field.value.slice(0, start) + text + field.value.slice(end);
  const newPos = start + text.length;
  field.focus();
  field.setSelectionRange(newPos, newPos);
  // Уведомляем возможные слушатели 'input' (например, живой предпросмотр), что значение изменилось.
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Быстро навешивает пикер на все поля с data-emoji="1" на странице (вызывать после отрисовки формы). */
export function attachEmojiPickersIn(container) {
  (container || document).querySelectorAll('[data-emoji="1"]').forEach(attachEmojiPicker);
}
