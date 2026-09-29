'use strict';

/**
 * Подставляет в шаблон значения из события: {user}, {text}, {gift}, {count}, {coins}, {total}.
 *  {coins} — стоимость одной единицы подарка, {total} — итоговая стоимость с учётом серии.
 * Неизвестные {переменные} остаются как есть.
 */
function renderTemplate(template, event) {
  const coins = event.diamondCount || 0;
  const count = event.repeatCount || 1;
  const vars = {
    user: (event.author && event.author.name) || 'Зритель',
    text: event.text || '',
    gift: event.giftName || '',
    count,
    coins,
    total: event.totalDiamonds !== undefined ? event.totalDiamonds : coins * count,
  };
  return String(template || '{user}: {text}').replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

module.exports = { renderTemplate };
