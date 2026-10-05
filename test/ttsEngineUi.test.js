'use strict';

/**
 * Проверяет updateEnginePanels()/sileroStatusLabel() против РЕАЛЬНОГО DOM
 * (jsdom), построенного из того же набора data-атрибутов, что фактически
 * лежит в src/renderer/index.html — не моканый DOM, а структура,
 * синхронизированная с разметкой вкладки «Озвучка и чат».
 *
 * Запуск: node test/ttsEngineUi.test.js
 */

const assert = require('assert');
const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;

console.log('ttsEngineUi — тесты\n');

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  OK   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.stack || err.message}`);
  }
}

// Фрагмент идентичен по набору data-атрибутов тому, что добавлен в
// src/renderer/index.html для панели TikTok (структура одинакова и для
// AxelChat — проверять оба избыточно, логика общая и не зависит от source).
const PANEL_HTML = `
  <div class="card" data-preset-panel="tiktok">
    <div class="field">
      <label>Движок озвучки</label>
      <select data-f="engine">
        <option value="system">Системный голос Windows</option>
        <option value="silero">Silero TTS</option>
      </select>
      <div class="hint" data-engine-status></div>
    </div>
    <div class="field" data-engine-panel="system"><label>Голос</label><select data-f="voice_uri"></select></div>
    <div class="field" data-engine-panel="silero">
      <label>Голос Silero</label>
      <select data-f="silero_speaker">
        <option value="baya">Бая</option>
      </select>
    </div>
  </div>
`;

function setupDom() {
  const dom = new JSDOM(`<!doctype html><html><body>${PANEL_HTML}</body></html>`);
  return dom.window.document.querySelector('[data-preset-panel="tiktok"]');
}

// Загружаем ttsEngineUi.js через динамический require после регистрации
// jsdom-совместимого окружения не требуется — модуль работает с переданным
// root (ParentNode), не обращается к глобальному window/document напрямую,
// поэтому обычный require в Node-окружении с jsdom-узлами работает штатно.
const { sileroStatusLabel, updateEnginePanels } = (() => {
  // ttsEngineUi.js — ES-модуль (export), а этот тестовый файл — CommonJS
  // (require), как и остальные тесты проекта (test/*.test.js). Читаем файл
  // и оборачиваем в CommonJS на лету, чтобы не менять общий стиль тестов
  // всего проекта ради одного файла.
  const fs = require('fs');
  const path = require('path');
  const Module = require('module');
  const filePath = path.join(__dirname, '../src/renderer/js/ttsEngineUi.js');
  const source = fs.readFileSync(filePath, 'utf8');
  const EXPORT_COUNT_EXPECTED = 2; // sileroStatusLabel + updateEnginePanels
  const matchCount = (source.match(/export function/g) || []).length;
  if (matchCount !== EXPORT_COUNT_EXPECTED) {
    throw new Error(
      `ttsEngineUi.js: ожидалось ${EXPORT_COUNT_EXPECTED} экспортируемых функции через ` +
      `"export function", найдено ${matchCount}. Тест транслирует ES-модуль в CommonJS ` +
      'простой заменой текста — при изменении способа экспорта в файле (например, на ' +
      '"export default" или "export const") эту трансляцию нужно обновить, иначе тест ' +
      'будет молча проверять не тот код.'
    );
  }
  const cjsSource = source.replace(/export function/g, 'function') + '\nmodule.exports = { sileroStatusLabel, updateEnginePanels };';
  const m = new Module(filePath);
  m._compile(cjsSource, filePath);
  return m.exports;
})();

test('updateEnginePanels("system") показывает системную панель, прячет Silero', () => {
  const root = setupDom();
  updateEnginePanels(root, 'system');
  const systemPanel = root.querySelector('[data-engine-panel="system"]');
  const sileroPanel = root.querySelector('[data-engine-panel="silero"]');
  assert.strictEqual(systemPanel.style.display, '', 'системная панель должна быть видима (display не none)');
  assert.strictEqual(sileroPanel.style.display, 'none', 'панель Silero должна быть скрыта');
});

test('updateEnginePanels("silero") показывает панель Silero, прячет системную', () => {
  const root = setupDom();
  updateEnginePanels(root, 'silero');
  const systemPanel = root.querySelector('[data-engine-panel="system"]');
  const sileroPanel = root.querySelector('[data-engine-panel="silero"]');
  assert.strictEqual(sileroPanel.style.display, '', 'панель Silero должна быть видима');
  assert.strictEqual(systemPanel.style.display, 'none', 'системная панель должна быть скрыта');
});

test('переключение engine туда-обратно корректно меняет видимость оба раза', () => {
  const root = setupDom();
  updateEnginePanels(root, 'silero');
  updateEnginePanels(root, 'system');
  const systemPanel = root.querySelector('[data-engine-panel="system"]');
  const sileroPanel = root.querySelector('[data-engine-panel="silero"]');
  assert.strictEqual(systemPanel.style.display, '');
  assert.strictEqual(sileroPanel.style.display, 'none');
});

test('sileroStatusLabel для status=ready возвращает success', () => {
  const { text, className } = sileroStatusLabel({ status: 'ready' });
  assert.strictEqual(className, 'success');
  assert.ok(text.includes('готов'));
});

test('sileroStatusLabel для status=starting возвращает warn', () => {
  const { className } = sileroStatusLabel({ status: 'starting' });
  assert.strictEqual(className, 'warn');
});

test('sileroStatusLabel для status=error включает lastError в текст', () => {
  const { text, className } = sileroStatusLabel({ status: 'error', lastError: 'Файл модели не найден' });
  assert.strictEqual(className, 'error');
  assert.ok(text.includes('Файл модели не найден'), 'текст ошибки должен попасть в подпись');
});

test('sileroStatusLabel для неизвестного/пустого статуса не бросает исключение', () => {
  const r1 = sileroStatusLabel(undefined);
  const r2 = sileroStatusLabel({});
  const r3 = sileroStatusLabel({ status: 'что-то-незнакомое' });
  assert.strictEqual(r1.className, 'warn');
  assert.strictEqual(r2.className, 'warn');
  assert.strictEqual(r3.className, 'warn');
});

console.log(`\nИтого: ${passed} прошло, ${failed} упало из ${passed + failed}`);
if (failed > 0) {
  process.exit(1);
}
