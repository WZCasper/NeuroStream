const socket = window.io();

function getVoices() {
  return new Promise((resolve) => {
    let voices = window.speechSynthesis.getVoices();
    if (voices.length) return resolve(voices);
    window.speechSynthesis.onvoiceschanged = () => resolve(window.speechSynthesis.getVoices());
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1500);
  });
}

let voicesPromise = getVoices();

socket.on('tts:speak', async ({ source, queueId, text, voice }) => {
  if (voice?.engine === 'silero' && voice?.audioUrl) {
    speakViaAudioFile({ source, queueId, text, voice });
  } else {
    await speakViaSystemVoice({ source, queueId, text, voice });
  }
});

/**
 * Озвучка через готовый .wav, синтезированный сервером (движок Silero TTS) —
 * сервер уже прислал относительный URL (/tts-cache/...), раздаваемый тем же
 * локальным портом, что и сама эта страница, поэтому вписывается в
 * действующий Content-Security-Policy без изменений (connect-src/script-src
 * 'self' + 127.0.0.1 — см. tts-host.html).
 */
function speakViaAudioFile({ source, queueId, voice }) {
  const audio = new Audio(voice.audioUrl);
  audio.volume = clampNumber(voice.volume, 0, 1, 1);
  // rate у Silero — это скорость ВОСПРОИЗВЕДЕНИЯ уже готового файла (playbackRate),
  // а не параметр синтеза (Silero сам управляет темпом речи при генерации .wav).
  // Небольшой подстраховочный диапазон уже, чем у системных голосов (0.5-2),
  // потому что сильное ускорение/замедление готовой записи звучит гораздо
  // неестественнее, чем изменение параметра rate у живого TTS-движка.
  audio.playbackRate = clampNumber(voice.rate, 0.8, 1.5, 1);

  const finish = () => socket.emit('tts:utteranceEnd', { source, queueId, audioPath: voice.audioPath });
  audio.onended = finish;
  audio.onerror = finish; // не блокируем очередь навсегда, если файл не проигрался

  audio.play().catch(() => finish()); // автозапуск заблокирован браузером и т.п. - не виснем
}

/** Прежний путь озвучки через браузерный Web Speech API - без изменений поведения. */
async function speakViaSystemVoice({ source, queueId, text, voice }) {
  const voices = await voicesPromise;
  const utter = new SpeechSynthesisUtterance(text || '');

  const matchedVoice = voice?.voiceURI ? voices.find((v) => v.voiceURI === voice.voiceURI) : null;
  if (matchedVoice) utter.voice = matchedVoice;
  utter.lang = voice?.lang || 'ru-RU';
  utter.rate = clampNumber(voice?.rate, 0.5, 2, 1);
  utter.pitch = clampNumber(voice?.pitch, 0, 2, 1);
  utter.volume = clampNumber(voice?.volume, 0, 1, 1);

  const finish = () => socket.emit('tts:utteranceEnd', { source, queueId });
  utter.onend = finish;
  utter.onerror = finish; // не блокируем очередь навсегда, если конкретная фраза не озвучилась

  window.speechSynthesis.speak(utter);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
