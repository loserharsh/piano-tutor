/// Unified internal song representation used across all input formats
/// (MIDI files as song data, MusicXML, ABC notation, and OMR-converted PDF/images).
///
/// The falling-note renderer and audio matching engine consume this model exclusively,
/// remaining completely decoupled from the original source file format.
enum PianoHand { right, left, unknown }

enum SongSourceFormat { builtin, midiFile, musicXml, abc, omrPdf, omrImage }

class SongNoteEvent {
  const SongNoteEvent({
    required this.midiPitch,
    required this.startSec,
    required this.durationSec,
    this.velocity = 0.8,
    this.trackIndex = 0,
    this.hand = PianoHand.unknown,
    this.measureNumber = 1,
    this.voice = 1,
    this.confidence = 1.0, // < 1.0 flags uncertain OMR notes for user review
  });

  final int midiPitch;
  final double startSec;
  final double durationSec;
  final double velocity;
  final int trackIndex;
  final PianoHand hand;
  final int measureNumber;
  final int voice;
  final double confidence;

  double get endSec => startSec + durationSec;
}

class TempoChange {
  const TempoChange({required this.atSec, required this.bpm});
  final double atSec;
  final double bpm;
}

class SongModel {
  const SongModel({
    required this.id,
    required this.title,
    required this.composer,
    required this.sourceFormat,
    required this.notes,
    required this.tempoMap,
    this.timeSignatureNumerator = 4,
    this.timeSignatureDenominator = 4,
    this.keySignatureFifths = 0,
  });

  final String id;
  final String title;
  final String composer;
  final SongSourceFormat sourceFormat;
  final List<SongNoteEvent> notes;
  final List<TempoChange> tempoMap;
  final int timeSignatureNumerator;
  final int timeSignatureDenominator;
  final int keySignatureFifths;

  double get totalDurationSec =>
      notes.isEmpty ? 0.0 : notes.map((n) => n.endSec).reduce((a, b) => a > b ? a : b);
}
