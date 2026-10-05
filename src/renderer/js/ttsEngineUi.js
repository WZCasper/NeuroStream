// Чистые функции логики переключения движка озвучки (Системный/Silero) на
// вкладке «Озвучка и чат» — вынесены из tts.js в отдельный модуль без
// зависимостей от socket.io/api/toast специально для того, чтобы их можно
// было покрыть автотестами с jsdom, не поднимая полноценное Socket.io-
// соединение (см. test/ttsEngineUi.test.js).

/**
 * Короткая человекочитаемая подпись статуса движка Silero — используется
 * под выпадающим списком «Движок озвучки» в обеих панелях (TikTok и
 * AxelChat), т.к. движок общий на всё приложение, а не отдельный на каждый
 * источник.
 * @param {{status?: string, lastError?: string}} status
 * @returns {{text: string, className: 'success'|'warn'|'error'}}
 */
export function sileroStatusLabel(status) {
  switch (status?.status) {
    case 'ready':
      return { text: '✅ Silero TTS готов к работе', className: 'success' };
    case 'starting':
      return { text: '⏳ Silero TTS загружается, обычно это занимает до минуты…', className: 'warn' };
    case 'error':
      return {
        text: `⚠ Silero TTS недоступен${status.lastError ? `: ${status.lastError}` : ''}. Будет использован системный голос.`,
        className: 'error',
      };
    default:
      return { text: '⚠ Silero TTS ещё не запущен', className: 'warn' };
  }
}

/**
 * Показывает панель выбора голоса для текущего движка (системный/Silero) и
 * прячет вторую — у обоих источников (TikTok/AxelChat) логика одинаковая.
 * @param {ParentNode} root корневой элемент панели пресета (data-preset-panel)
 * @param {'system'|'silero'} engine
 */
export function updateEnginePanels(root, engine) {
  root.querySelectorAll('[data-engine-panel]').forEach((panel) => {
    panel.style.display = panel.dataset.enginePanel === engine ? '' : 'none';
  });
}
