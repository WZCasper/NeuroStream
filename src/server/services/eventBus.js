'use strict';

const { EventEmitter } = require('node:events');

/**
 * NormalizedEvent — единый формат события независимо от источника (TikTok LIVE или AxelChat).
 *
 * @typedef {Object} NormalizedEvent
 * @property {string} id             Уникальный идентификатор события
 * @property {'tiktok'|'axelchat'}   source
 * @property {'chat'|'gift'|'like'|'follow'|'share'|'subscribe'|'member'} type
 * @property {string} platform       Для axelchat — исходная платформа (twitch/youtube/...); для tiktok — 'tiktok'
 * @property {{ id:string, name:string, avatar:?string }} author
 * @property {string} [text]         Текст сообщения (для chat)
 * @property {string} [giftName]     Название подарка (для gift)
 * @property {number} [giftId]
 * @property {number} [diamondCount]
 * @property {number} [repeatCount]
 * @property {boolean} [repeatEnd]
 * @property {number} [likeCount]
 * @property {number} timestamp
 * @property {Object} raw            Необработанные данные события "как есть", для отладки
 */

class EventBus extends EventEmitter {
  /**
   * Публикует нормализованное событие всем подписчикам (движок триггеров, TTS, UI).
   * @param {NormalizedEvent} event
   */
  publish(event) {
    this.emit('event', event);
  }
}

module.exports = { EventBus };
