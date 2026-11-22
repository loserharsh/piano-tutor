import '../models/song_model.dart';

/// Built-in beginner piano lessons using the unified [SongModel].
class BuiltinLessons {
  static List<SongModel> all() => [
        cMajorScale(),
        twinkleTwinkle(),
        odeToJoy(),
        twoHandCPosition(),
      ];

  static SongModel cMajorScale() {
    const bpm = 96.0;
    const beat = 60.0 / bpm;
    const pitches = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
    final notes = <SongNoteEvent>[];
    for (int i = 0; i < pitches.length; i++) {
      notes.add(SongNoteEvent(
        midiPitch: pitches[i],
        startSec: i * beat,
        durationSec: (i == pitches.length - 1) ? beat * 1.8 : beat * 0.9,
        hand: PianoHand.right,
        measureNumber: (i ~/ 4) + 1,
      ));
    }
    return SongModel(
      id: 'builtin_c_major_scale',
      title: 'C Major Scale (Up & Down)',
      composer: 'Beginner Lesson 1',
      sourceFormat: SongSourceFormat.builtin,
      notes: notes,
      tempoMap: const [TempoChange(atSec: 0, bpm: bpm)],
    );
  }

  static SongModel twinkleTwinkle() {
    const bpm = 100.0;
    const beat = 60.0 / bpm;
    // C4 C4 G4 G4 A4 A4 G4(2) | F4 F4 E4 E4 D4 D4 C4(2)
    final seq = <(int, double)>[
      (60, 1), (60, 1), (67, 1), (67, 1),
      (69, 1), (69, 1), (67, 2),
      (65, 1), (65, 1), (64, 1), (64, 1),
      (62, 1), (62, 1), (60, 2),
    ];
    final notes = <SongNoteEvent>[];
    double beatCursor = 0;
    for (final (midi, durBeats) in seq) {
      notes.add(SongNoteEvent(
        midiPitch: midi,
        startSec: beatCursor * beat,
        durationSec: durBeats * beat * 0.88,
        hand: PianoHand.right,
        measureNumber: (beatCursor ~/ 4) + 1,
      ));
      beatCursor += durBeats;
    }
    return SongModel(
      id: 'builtin_twinkle',
      title: 'Twinkle, Twinkle, Little Star',
      composer: 'Traditional (Repeated Keys)',
      sourceFormat: SongSourceFormat.builtin,
      notes: notes,
      tempoMap: const [TempoChange(atSec: 0, bpm: bpm)],
    );
  }

  static SongModel odeToJoy() {
    const bpm = 108.0;
    const beat = 60.0 / bpm;
    final seq = <(int, double)>[
      (64, 1), (64, 1), (65, 1), (67, 1),
      (67, 1), (65, 1), (64, 1), (62, 1),
      (60, 1), (60, 1), (62, 1), (64, 1),
      (64, 1.5), (62, 0.5), (62, 2),
    ];
    final notes = <SongNoteEvent>[];
    double beatCursor = 0;
    for (final (midi, durBeats) in seq) {
      notes.add(SongNoteEvent(
        midiPitch: midi,
        startSec: beatCursor * beat,
        durationSec: durBeats * beat * 0.9,
        hand: PianoHand.right,
        measureNumber: (beatCursor ~/ 4) + 1,
      ));
      beatCursor += durBeats;
    }
    return SongModel(
      id: 'builtin_ode_to_joy',
      title: 'Ode to Joy (Theme)',
      composer: 'L. van Beethoven',
      sourceFormat: SongSourceFormat.builtin,
      notes: notes,
      tempoMap: const [TempoChange(atSec: 0, bpm: bpm)],
    );
  }

  static SongModel twoHandCPosition() {
    const bpm = 88.0;
    const beat = 60.0 / bpm;
    final notes = <SongNoteEvent>[
      // Measure 1: LH C3 whole note + RH C4-D4-E4-F4
      SongNoteEvent(midiPitch: 48, startSec: 0 * beat, durationSec: 3.8 * beat, hand: PianoHand.left, trackIndex: 1, measureNumber: 1),
      SongNoteEvent(midiPitch: 60, startSec: 0 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 1),
      SongNoteEvent(midiPitch: 62, startSec: 1 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 1),
      SongNoteEvent(midiPitch: 64, startSec: 2 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 1),
      SongNoteEvent(midiPitch: 65, startSec: 3 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 1),
      // Measure 2: LH G2 whole note + RH G4-F4-E4-D4
      SongNoteEvent(midiPitch: 43, startSec: 4 * beat, durationSec: 3.8 * beat, hand: PianoHand.left, trackIndex: 1, measureNumber: 2),
      SongNoteEvent(midiPitch: 67, startSec: 4 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 2),
      SongNoteEvent(midiPitch: 65, startSec: 5 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 2),
      SongNoteEvent(midiPitch: 64, startSec: 6 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 2),
      SongNoteEvent(midiPitch: 62, startSec: 7 * beat, durationSec: 0.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 2),
      // Measure 3: LH C3 half + G2 half, RH E4 half + D4 half
      SongNoteEvent(midiPitch: 48, startSec: 8 * beat, durationSec: 1.9 * beat, hand: PianoHand.left, trackIndex: 1, measureNumber: 3),
      SongNoteEvent(midiPitch: 64, startSec: 8 * beat, durationSec: 1.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 3),
      SongNoteEvent(midiPitch: 43, startSec: 10 * beat, durationSec: 1.9 * beat, hand: PianoHand.left, trackIndex: 1, measureNumber: 3),
      SongNoteEvent(midiPitch: 62, startSec: 10 * beat, durationSec: 1.9 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 3),
      // Measure 4: Final C3 + C4
      SongNoteEvent(midiPitch: 48, startSec: 12 * beat, durationSec: 3.6 * beat, hand: PianoHand.left, trackIndex: 1, measureNumber: 4),
      SongNoteEvent(midiPitch: 60, startSec: 12 * beat, durationSec: 3.6 * beat, hand: PianoHand.right, trackIndex: 0, measureNumber: 4),
    ];
    return SongModel(
      id: 'builtin_two_hand_c',
      title: 'Two-Hand C-Position Exercise',
      composer: 'Beginner Lesson 2 (RH + LH)',
      sourceFormat: SongSourceFormat.builtin,
      notes: notes,
      tempoMap: const [TempoChange(atSec: 0, bpm: bpm)],
    );
  }
}
