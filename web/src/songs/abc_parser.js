/**
 * Lightweight ABC notation parser (.abc) normalizing into the unified SongModel.
 * Supports T: (title), C: (composer), M: (meter), L: (default note length), Q: (tempo),
 * K: (key), accidentals (^, _, =), octaves (', ,), durations (2, /2, 3/2), rests (z), and bar lines (|).
 */
const LETTER_TO_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parseAbcSong(abcText, fallbackTitle = 'Imported ABC Song') {
  let title = fallbackTitle;
  let composer = 'ABC Notation';
  let bpm = 100;
  let defaultLen = 0.125; // L:1/8
  let timeSigNum = 4;
  let timeSigDen = 4;

  const bodyLines = [];
  for (const rawLine of abcText.split(/\r?\n/)) {
    const line = rawLine.replace(/%.*$/, '').trim();
    if (!line) continue;
    if (/^[A-Za-z]:/.test(line)) {
      const key = line[0];
      const val = line.slice(2).trim();
      if (key === 'T') title = val || title;
      else if (key === 'C') composer = val || composer;
      else if (key === 'M') {
        const m = val.match(/^(\d+)\/(\d+)$/);
        if (m) { timeSigNum = Number(m[1]); timeSigDen = Number(m[2]); }
      } else if (key === 'L') {
        const m = val.match(/^(\d+)\/(\d+)$/);
        if (m) defaultLen = Number(m[1]) / Number(m[2]);
      } else if (key === 'Q') {
        const m = val.match(/(\d+)\s*$/);
        if (m) bpm = Number(m[1]);
      }
    } else {
      bodyLines.push(line);
    }
  }

  const body = bodyLines.join(' ');
  const quarterSec = 60 / bpm;
  const unitSec = defaultLen * 4 * quarterSec;

  const notes = [];
  let cursorSec = 0;
  let measureNum = 1;
  const tokenRe = /(\^{1,2}|_{1,2}|=)?([A-Ga-gz])([',]*)(\d*\/?\d*)|(\|)/g;
  let match;

  while ((match = tokenRe.exec(body)) !== null) {
    if (match[5] === '|') {
      measureNum++;
      continue;
    }
    const acc = match[1] || '';
    const letter = match[2];
    const octMarks = match[3] || '';
    const durStr = match[4] || '';

    let mult = 1;
    if (durStr) {
      if (durStr.includes('/')) {
        const [numStr, denStr] = durStr.split('/');
        const num = numStr ? Number(numStr) : 1;
        const den = denStr ? Number(denStr) : 2;
        if (den > 0) mult = num / den;
      } else {
        mult = Number(durStr) || 1;
      }
    }
    const durSec = Math.max(0.05, unitSec * mult);

    if (letter === 'z') {
      cursorSec += durSec;
      continue;
    }

    const isLower = letter === letter.toLowerCase();
    let octave = isLower ? 5 : 4;
    for (const ch of octMarks) {
      if (ch === "'") octave++;
      else if (ch === ',') octave--;
    }
    let alter = 0;
    if (acc === '^') alter = 1;
    else if (acc === '^^') alter = 2;
    else if (acc === '_') alter = -1;
    else if (acc === '__') alter = -2;

    const midiPitch = (octave + 1) * 12 + LETTER_TO_SEMI[letter.toUpperCase()] + alter;
    notes.push({
      midiPitch,
      startSec: cursorSec,
      durationSec: durSec * 0.9,
      endSec: cursorSec + durSec * 0.9,
      velocity: 0.8,
      trackIndex: 0,
      hand: midiPitch >= 60 ? 'right' : 'left',
      measureNumber: measureNum,
      confidence: 1.0,
    });
    cursorSec += durSec;
  }

  return {
    id: `abc_${Date.now()}`,
    title,
    composer,
    sourceFormat: 'abc',
    bpm: Math.round(bpm),
    timeSignatureNumerator: timeSigNum,
    timeSignatureDenominator: timeSigDen,
    keySignatureFifths: 0,
    tempoMap: [{ tick: 0, timeSec: 0, bpm }],
    notes,
    totalDurationSec: notes.reduce((m, n) => Math.max(m, n.endSec), 0),
  };
}
