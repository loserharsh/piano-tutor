/// Shared pixel-exact geometry engine for both [FallingNotesCanvas] and [PianoKeyboardWidget].
/// Ensures every falling note bar aligns precisely with its corresponding white or black key.
class PianoKeyGeometry {
  const PianoKeyGeometry({
    required this.midi,
    required this.isBlack,
    required this.left,
    required this.width,
  });

  final int midi;
  final bool isBlack;
  final double left;
  final double width;

  double get right => left + width;
}

class PianoKeyLayout {
  PianoKeyLayout({
    required this.minMidi,
    required this.maxMidi,
    required this.totalWidth,
  }) {
    _compute();
  }

  final int minMidi;
  final int maxMidi;
  final double totalWidth;

  late final double whiteKeyWidth;
  late final double blackKeyWidth;
  final Map<int, PianoKeyGeometry> keys = <int, PianoKeyGeometry>{};
  final List<PianoKeyGeometry> whiteKeys = <PianoKeyGeometry>[];
  final List<PianoKeyGeometry> blackKeys = <PianoKeyGeometry>[];

  static bool isBlackKey(int midi) {
    final pc = midi % 12;
    return pc == 1 || pc == 3 || pc == 6 || pc == 8 || pc == 10;
  }

  static String midiToLabel(int midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return '${names[midi % 12]}${(midi ~/ 12) - 1}';
  }

  void _compute() {
    int whiteCount = 0;
    for (int m = minMidi; m <= maxMidi; m++) {
      if (!isBlackKey(m)) whiteCount++;
    }
    whiteKeyWidth = whiteCount > 0 ? totalWidth / whiteCount : totalWidth;
    blackKeyWidth = whiteKeyWidth * 0.62;

    // Subtle acoustic-piano black key center offsets relative to the boundary
    // between the preceding white key and the next white key.
    const blackOffsets = <int, double>{
      1: -0.06, // C#
      3: 0.06,  // D#
      6: -0.08, // F#
      8: 0.0,   // G#
      10: 0.08, // A#
    };

    int whiteIdx = 0;
    for (int m = minMidi; m <= maxMidi; m++) {
      if (!isBlackKey(m)) {
        final geom = PianoKeyGeometry(
          midi: m,
          isBlack: false,
          left: whiteIdx * whiteKeyWidth,
          width: whiteKeyWidth,
        );
        keys[m] = geom;
        whiteKeys.add(geom);
        whiteIdx++;
      } else {
        final pc = m % 12;
        final boundaryX = whiteIdx * whiteKeyWidth;
        final centerX = boundaryX + (blackOffsets[pc] ?? 0.0) * whiteKeyWidth;
        final geom = PianoKeyGeometry(
          midi: m,
          isBlack: true,
          left: centerX - blackKeyWidth / 2,
          width: blackKeyWidth,
        );
        keys[m] = geom;
        blackKeys.add(geom);
      }
    }
  }
}
