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
});

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
