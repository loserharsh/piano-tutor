import { midiToNoteName } from '../dsp/yin.js';

export function isBlackKey(midi) {
  const pc = midi % 12;
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

/**
 * Shared pixel-exact white & black key layout for both FallingNotesRenderer and PianoKeyboardRenderer.
 */
export function computePianoLayout(minMidi, maxMidi, totalWidth) {
  let whiteCount = 0;
  for (let m = minMidi; m <= maxMidi; m++) {
    if (!isBlackKey(m)) whiteCount++;
  }
  const whiteKeyWidth = whiteCount > 0 ? totalWidth / whiteCount : totalWidth;
  const blackKeyWidth = whiteKeyWidth * 0.62;

  const blackOffsets = { 1: -0.06, 3: 0.06, 6: -0.08, 8: 0.0, 10: 0.08 };

  const keys = new Map();
  const whiteKeys = [];
  const blackKeys = [];

  let whiteIdx = 0;
  for (let m = minMidi; m <= maxMidi; m++) {
    if (!isBlackKey(m)) {
      const geom = { midi: m, isBlack: false, left: whiteIdx * whiteKeyWidth, width: whiteKeyWidth, label: midiToNoteName(m) };
      keys.set(m, geom);
      whiteKeys.push(geom);
      whiteIdx++;
    } else {
      const pc = m % 12;
      const boundaryX = whiteIdx * whiteKeyWidth;
      const centerX = boundaryX + (blackOffsets[pc] || 0) * whiteKeyWidth;
      const geom = { midi: m, isBlack: true, left: centerX - blackKeyWidth / 2, width: blackKeyWidth, label: midiToNoteName(m) };
      keys.set(m, geom);
      blackKeys.push(geom);
    }
  }

  return { minMidi, maxMidi, totalWidth, whiteKeyWidth, blackKeyWidth, keys, whiteKeys, blackKeys };
}
