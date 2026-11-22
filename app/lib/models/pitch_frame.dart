class PitchFrame {
  const PitchFrame({
    required this.hasPitch,
    required this.frequencyHz,
    required this.midiNote,
    required this.noteName,
    required this.centsOffset,
    required this.confidence,
    required this.rmsDb,
    required this.noiseFloorDb,
    required this.spectralFlux,
    required this.isOnset,
    required this.activeNoteMidi,
    required this.timestampSec,
    required this.spectrumBins,
  });

  final bool hasPitch;
  final double frequencyHz;
  final int midiNote;
  final String noteName;
  final double centsOffset;
  final double confidence;
  final double rmsDb;
  final double noiseFloorDb;
  final double spectralFlux;
  final bool isOnset;
  final int activeNoteMidi;
  final double timestampSec;
  final List<double> spectrumBins;

  static PitchFrame empty() => PitchFrame(
        hasPitch: false,
        frequencyHz: 0,
        midiNote: -1,
        noteName: '--',
        centsOffset: 0,
        confidence: 0,
        rmsDb: -100,
        noiseFloorDb: -70,
        spectralFlux: 0,
        isOnset: false,
        activeNoteMidi: -1,
        timestampSec: 0,
        spectrumBins: List<double>.filled(64, 0),
      );
}

enum DetectedNoteEventType { none, noteOn, noteOff }

class DetectedNoteEvent {
  const DetectedNoteEvent({
    required this.type,
    required this.midiNote,
    required this.noteName,
    required this.frequencyHz,
    required this.confidence,
    required this.velocityEst,
    required this.timestampSec,
  });

  final DetectedNoteEventType type;
  final int midiNote;
  final String noteName;
  final double frequencyHz;
  final double confidence;
  final double velocityEst;
  final double timestampSec;
}

class RecordedNote {
  const RecordedNote({
    required this.midiNote,
    required this.noteName,
    required this.frequencyHz,
    required this.startSec,
    required this.endSec,
    required this.durationSec,
    required this.confidence,
    required this.velocityEst,
  });

  final int midiNote;
  final String noteName;
  final double frequencyHz;
  final double startSec;
  final double endSec;
  final double durationSec;
  final double confidence;
  final double velocityEst;
}
