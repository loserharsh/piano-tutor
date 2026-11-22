/**
 * Direct MusicXML (.musicxml / .xml) parser normalizing into the unified SongModel.
 * Preserves pitch, accidentals, duration, measures, staves (Staff 1 = RH, Staff 2 = LH),
 * tempo, and time/key signatures.
 */
const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function parseMusicXmlSong(xmlText, fallbackTitle = 'Imported MusicXML') {
  if (typeof DOMParser === 'undefined') {
    throw new Error('DOMParser is required for MusicXML parsing (run in browser).');
  }
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid MusicXML document.');
  }

  const title =
    doc.querySelector('work-title')?.textContent?.trim() ||
    doc.querySelector('movement-title')?.textContent?.trim() ||
    fallbackTitle;
  const composer =
    doc.querySelector('creator[type="composer"]')?.textContent?.trim() || 'MusicXML Score';

  let bpm = 100;
  let divisions = 1;
  let timeSigNum = 4;
  let timeSigDen = 4;
  let keySigFifths = 0;

  const notes = [];
  const parts = Array.from(doc.querySelectorAll('part'));

  for (let pIdx = 0; pIdx < parts.length; pIdx++) {
    let cursorSec = 0;
    const measures = Array.from(parts[pIdx].querySelectorAll('measure'));

    for (let mIdx = 0; mIdx < measures.length; mIdx++) {
      const measure = measures[mIdx];
      const measureNum = parseInt(measure.getAttribute('number') || String(mIdx + 1), 10) || (mIdx + 1);
      let measureStartSec = cursorSec;
      let maxMeasureEndSec = cursorSec;
      let lastNoteStartSec = cursorSec;

      for (const child of Array.from(measure.children)) {
        const tag = child.tagName;
        if (tag === 'attributes') {
          const divEl = child.querySelector('divisions');
          if (divEl) divisions = Math.max(1, parseInt(divEl.textContent, 10) || 1);
          const beatsEl = child.querySelector('time > beats');
          const beatTypeEl = child.querySelector('time > beat-type');
          if (beatsEl && beatTypeEl) {
            timeSigNum = parseInt(beatsEl.textContent, 10) || 4;
            timeSigDen = parseInt(beatTypeEl.textContent, 10) || 4;
          }
          const fifthsEl = child.querySelector('key > fifths');
          if (fifthsEl) keySigFifths = parseInt(fifthsEl.textContent, 10) || 0;
        } else if (tag === 'direction' || tag === 'sound') {
          const sound = tag === 'sound' ? child : child.querySelector('sound[tempo]');
          const tVal = sound?.getAttribute('tempo');
          if (tVal && Number(tVal) > 0) bpm = Number(tVal);
        } else if (tag === 'backup') {
          const dur = parseInt(child.querySelector('duration')?.textContent || '0', 10);
          cursorSec = Math.max(measureStartSec, cursorSec - (dur / divisions) * (60 / bpm));
        } else if (tag === 'forward') {
          const dur = parseInt(child.querySelector('duration')?.textContent || '0', 10);
          cursorSec += (dur / divisions) * (60 / bpm);
        } else if (tag === 'note') {
          const durDivs = parseInt(child.querySelector('duration')?.textContent || '0', 10);
          const durSec = Math.max(0.05, (durDivs / divisions) * (60 / bpm));
          const isChord = child.querySelector('chord') !== null;
          const isRest = child.querySelector('rest') !== null;
          const staff = parseInt(child.querySelector('staff')?.textContent || '1', 10);
          const noteStart = isChord ? lastNoteStartSec : cursorSec;

          if (!isRest) {
            const step = child.querySelector('pitch > step')?.textContent?.trim().toUpperCase();
            const octave = parseInt(child.querySelector('pitch > octave')?.textContent || '4', 10);
            const alter = parseInt(child.querySelector('pitch > alter')?.textContent || '0', 10);
            if (step && STEP_TO_SEMITONE[step] !== undefined) {
              const midiPitch = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;
              const hand = staff === 2 ? 'left' : (staff === 1 ? 'right' : (midiPitch >= 60 ? 'right' : 'left'));
              notes.push({
                midiPitch,
                startSec: noteStart,
                durationSec: durSec * 0.92,
                endSec: noteStart + durSec * 0.92,
                velocity: 0.8,
                trackIndex: staff - 1,
                hand,
                measureNumber: measureNum,
                confidence: 1.0,
              });
            }
          }

          if (!isChord) {
            lastNoteStartSec = cursorSec;
            cursorSec += durSec;
            if (cursorSec > maxMeasureEndSec) maxMeasureEndSec = cursorSec;
          }
        }
      }
      cursorSec = maxMeasureEndSec;
    }
  }

  notes.sort((a, b) => (Math.abs(a.startSec - b.startSec) > 1e-6 ? a.startSec - b.startSec : a.midiPitch - b.midiPitch));
  const totalDurationSec = notes.reduce((m, n) => Math.max(m, n.endSec), 0);

  return {
    id: `mxml_${Date.now()}`,
    title,
    composer,
    sourceFormat: 'musicxml',
    bpm: Math.round(bpm),
    timeSignatureNumerator: timeSigNum,
    timeSignatureDenominator: timeSigDen,
    keySignatureFifths: keySigFifths,
    tempoMap: [{ tick: 0, timeSec: 0, bpm }],
    notes,
    totalDurationSec,
  };
}
