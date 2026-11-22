const CACHE_NAME = 'pianotutor-v2';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './src/app.js',
  './src/dsp/fft.js',
  './src/dsp/biquad.js',
  './src/dsp/yin.js',
  './src/dsp/onset_tracker.js',
  './src/dsp/polyphonic_estimator.js',
  './src/dsp/audio_engine.js',
  './src/songs/midi_parser.js',
  './src/songs/musicxml_parser.js',
  './src/songs/abc_parser.js',
  './src/songs/builtin_lessons.js',
  './src/tutor/tutor_engine.js',
  './src/storage/progress_store.js',
  './src/audio/synth_preview.js',
  './src/ui/piano_layout.js',
  './src/ui/falling_notes.js',
  './src/ui/piano_keyboard.js',
  './src/ui/spectrum_canvas.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
