import { api } from './api.js';

export const THEMES = [
  { id: 'electric-blue', label: 'Electric Blue' },
  { id: 'neon-purple', label: 'Neon Purple' },
  { id: 'cyber-green', label: 'Cyber Green' },
  { id: 'crimson-dark', label: 'Crimson Dark' },
];

const STORAGE_KEY = 'nss:theme';

export function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  document.querySelectorAll('.theme-swatch').forEach((el) => {
    el.classList.toggle('active', el.dataset.swatch === themeId);
  });
}

/** Мгновенно применяет сохранённую локально тему (до ответа сервера), чтобы не было "мигания". */
export function applyStoredThemeInstantly() {
  const cached = window.localStorage.getItem(STORAGE_KEY);
  applyTheme(cached || 'electric-blue');
}

export async function initTheme() {
  applyStoredThemeInstantly();
  try {
    const settings = await api.get('/api/settings');
    const theme = settings.theme || 'electric-blue';
    applyTheme(theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // сервер ещё не готов ответить — уже применена локально сохранённая тема
  }

  document.querySelectorAll('.theme-swatch').forEach((el) => {
    el.addEventListener('click', async () => {
      const themeId = el.dataset.swatch;
      applyTheme(themeId);
      window.localStorage.setItem(STORAGE_KEY, themeId);
      try {
        await api.put('/api/settings', { theme: themeId });
      } catch {
        // не критично — тема уже применена визуально и сохранена локально
      }
    });
  });
}
