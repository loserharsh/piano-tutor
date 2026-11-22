/**
 * Built-in beginner piano lessons using the unified SongModel.
 */
function makeSong({ id, title, composer, bpm, notes }) {
  const mapped = notes.map((n) => ({
    ...n,
    endSec: n.startSec + n.durationSec,
    velocity: n.velocity ?? 0.8,
    trackIndex: n.hand === 'left' ? 1 : 0,
    confidence: 1.0,
  }));
  return {
    id,
    title,
    composer,
    sourceFormat: 'builtin',
    bpm,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    keySignatureFifths: 0,
    tempoMap: [{ tick: 0, timeSec: 0, bpm }],
    notes: mapped,
    totalDurationSec: mapped.reduce((m, n) => Math.max(m, n.endSec), 0),
  };
}

export function getBuiltinLessons() {
  // 1. C Major Scale (Up & Down)
  const scaleBpm = 90;
  const scaleBeat = 60 / scaleBpm;
  const scalePitches = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
  const scaleNotes = scalePitches.map((midiPitch, i) => ({
    midiPitch,
    startSec: i * scaleBeat,
    durationSec: (i === scalePitches.length - 1 ? 1.8 : 0.88) * scaleBeat,
    hand: 'right',
    measureNumber: Math.floor(i / 4) + 1,
  }));

  // 2. Twinkle, Twinkle, Little Star (Repeated Keys)
  const twBpm = 96;
  const twBeat = 60 / twBpm;
  const twSeq = [
    [60, 1], [60, 1], [67, 1], [67, 1],
    [69, 1], [69, 1], [67, 2],
    [65, 1], [65, 1], [64, 1], [64, 1],
    [62, 1], [62, 1], [60, 2],
  ];
  const twNotes = [];
  let twCursor = 0;
  for (const [midiPitch, durBeats] of twSeq) {
    twNotes.push({
      midiPitch,
      startSec: twCursor * twBeat,
      durationSec: durBeats * twBeat * 0.86,
      hand: 'right',
      measureNumber: Math.floor(twCursor / 4) + 1,
    });
    twCursor += durBeats;
  }

  // 3. Ode to Joy (Beethoven)
  const odeBpm = 104;
  const odeBeat = 60 / odeBpm;
  const odeSeq = [
    [64, 1], [64, 1], [65, 1], [67, 1],
    [67, 1], [65, 1], [64, 1], [62, 1],
    [60, 1], [60, 1], [62, 1], [64, 1],
    [64, 1.5], [62, 0.5], [62, 2],
  ];
  const odeNotes = [];
  let odeCursor = 0;
  for (const [midiPitch, durBeats] of odeSeq) {
    odeNotes.push({
      midiPitch,
      startSec: odeCursor * odeBeat,
      durationSec: durBeats * odeBeat * 0.88,
      hand: 'right',
      measureNumber: Math.floor(odeCursor / 4) + 1,
    });
    odeCursor += durBeats;
  }

  // 4. Two-Hand C-Position Exercise
  const thBpm = 84;
  const thBeat = 60 / thBpm;
  const thNotes = [
    { midiPitch: 48, startSec: 0 * thBeat, durationSec: 3.7 * thBeat, hand: 'left', measureNumber: 1 },
    { midiPitch: 60, startSec: 0 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 1 },
    { midiPitch: 62, startSec: 1 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 1 },
    { midiPitch: 64, startSec: 2 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 1 },
    { midiPitch: 65, startSec: 3 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 1 },
    { midiPitch: 43, startSec: 4 * thBeat, durationSec: 3.7 * thBeat, hand: 'left', measureNumber: 2 },
    { midiPitch: 67, startSec: 4 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 2 },
    { midiPitch: 65, startSec: 5 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 2 },
    { midiPitch: 64, startSec: 6 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 2 },
    { midiPitch: 62, startSec: 7 * thBeat, durationSec: 0.88 * thBeat, hand: 'right', measureNumber: 2 },
    { midiPitch: 48, startSec: 8 * thBeat, durationSec: 1.85 * thBeat, hand: 'left', measureNumber: 3 },
    { midiPitch: 64, startSec: 8 * thBeat, durationSec: 1.85 * thBeat, hand: 'right', measureNumber: 3 },
    { midiPitch: 43, startSec: 10 * thBeat, durationSec: 1.85 * thBeat, hand: 'left', measureNumber: 3 },
    { midiPitch: 62, startSec: 10 * thBeat, durationSec: 1.85 * thBeat, hand: 'right', measureNumber: 3 },
    { midiPitch: 48, startSec: 12 * thBeat, durationSec: 3.5 * thBeat, hand: 'left', measureNumber: 4 },
    { midiPitch: 60, startSec: 12 * thBeat, durationSec: 3.5 * thBeat, hand: 'right', measureNumber: 4 },
  ];

  return [
    makeSong({ id: 'builtin_scale', title: 'C Major Scale (Up & Down)', composer: 'Beginner Lesson 1 · Monophonic', bpm: scaleBpm, notes: scaleNotes }),
    makeSong({ id: 'builtin_twinkle', title: 'Twinkle, Twinkle, Little Star', composer: 'Traditional · Repeated Keys', bpm: twBpm, notes: twNotes }),
    makeSong({ id: 'builtin_ode', title: 'Ode to Joy (Theme)', composer: 'L. van Beethoven', bpm: odeBpm, notes: odeNotes }),
    makeSong({ id: 'builtin_twohand', title: 'Two-Hand C-Position Exercise', composer: 'Beginner Lesson 2 · RH / LH Practice', bpm: thBpm, notes: thNotes }),
  ];
}
