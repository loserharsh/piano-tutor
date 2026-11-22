import 'package:flutter/material.dart';
import '../models/song_model.dart';
import 'piano_layout.dart';

enum NoteFeedbackState { upcoming, active, correct, missed }

/// Smooth falling-note visualization aligned pixel-for-pixel with [PianoKeyboardWidget].
/// Renders vertical note bars moving downward toward the strike line at [size.height].
class FallingNotesCanvas extends StatelessWidget {
  const FallingNotesCanvas({
    super.key,
    required this.notes,
    required this.currentTimeSec,
    required this.minMidi,
    required this.maxMidi,
    this.pixelsPerSecond = 180.0,
    this.noteStates = const <int, NoteFeedbackState>{},
    this.bpm = 100.0,
  });

  final List<SongNoteEvent> notes;
  final double currentTimeSec;
  final int minMidi;
  final int maxMidi;
  final double pixelsPerSecond;
  final Map<int, NoteFeedbackState> noteStates; // keyed by note index
  final double bpm;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.infinite,
      painter: _FallingNotesPainter(
        notes: notes,
        currentTimeSec: currentTimeSec,
        minMidi: minMidi,
        maxMidi: maxMidi,
        pixelsPerSecond: pixelsPerSecond,
        noteStates: noteStates,
        bpm: bpm,
      ),
    );
  }
}

class _FallingNotesPainter extends CustomPainter {
  _FallingNotesPainter({
    required this.notes,
    required this.currentTimeSec,
    required this.minMidi,
    required this.maxMidi,
    required this.pixelsPerSecond,
    required this.noteStates,
    required this.bpm,
  });

  final List<SongNoteEvent> notes;
  final double currentTimeSec;
  final int minMidi;
  final int maxMidi;
  final double pixelsPerSecond;
  final Map<int, NoteFeedbackState> noteStates;
  final double bpm;

  static const Color _bgColor = Color(0xFF0E1116);
  static const Color _blackLaneBg = Color(0xFF131820);
  static const Color _octaveLineColor = Color(0xFF232B36);
  static const Color _beatLineColor = Color(0xFF1A2029);

  static const Color _rhWhite = Color(0xFF2DD4BF);
  static const Color _rhBlack = Color(0xFF14B8A6);
  static const Color _lhWhite = Color(0xFFF59E0B);
  static const Color _lhBlack = Color(0xFFD97706);
  static const Color _correctColor = Color(0xFF22C55E);
  static const Color _missedColor = Color(0xFF64748B);

  @override
  void paint(Canvas canvas, Size size) {
    canvas.clipRect(Offset.zero & size);
    canvas.drawRect(Offset.zero & size, Paint()..color = _bgColor);

    final layout = PianoKeyLayout(
      minMidi: minMidi,
      maxMidi: maxMidi,
      totalWidth: size.width,
    );

    // 1. Subtle vertical lane shading for black keys and octave C dividers.
    final blackLanePaint = Paint()..color = _blackLaneBg;
    for (final bk in layout.blackKeys) {
      canvas.drawRect(Rect.fromLTWH(bk.left, 0, bk.width, size.height), blackLanePaint);
    }

    final octavePaint = Paint()
      ..color = _octaveLineColor
      ..strokeWidth = 1.0;
    for (final wk in layout.whiteKeys) {
      if (wk.midi % 12 == 0) {
        canvas.drawLine(Offset(wk.left, 0), Offset(wk.left, size.height), octavePaint);
      }
    }

    // 2. Horizontal beat guide lines synchronized with song clock.
    final beatSec = 60.0 / bpm.clamp(30.0, 240.0);
    final lookaheadSec = size.height / pixelsPerSecond;
    final firstBeat = (currentTimeSec / beatSec).floor();
    final lastBeat = ((currentTimeSec + lookaheadSec) / beatSec).ceil();
    final beatPaint = Paint()
      ..color = _beatLineColor
      ..strokeWidth = 1.0;
    final measurePaint = Paint()
      ..color = const Color(0xFF283240)
      ..strokeWidth = 1.5;

    for (int b = firstBeat; b <= lastBeat; b++) {
      if (b < 0) continue;
      final t = b * beatSec;
      final y = size.height - (t - currentTimeSec) * pixelsPerSecond;
      if (y < 0 || y > size.height) continue;
      canvas.drawLine(
        Offset(0, y),
        Offset(size.width, y),
        (b % 4 == 0) ? measurePaint : beatPaint,
      );
    }

    // 3. Draw visible falling note bars (viewport culled).
    final viewStart = currentTimeSec - 0.15;
    final viewEnd = currentTimeSec + lookaheadSec + 0.15;

    for (int i = 0; i < notes.length; i++) {
      final n = notes[i];
      if (n.endSec < viewStart || n.startSec > viewEnd) continue;

      final geom = layout.keys[n.midiPitch];
      if (geom == null) continue;

      final bottomY = size.height - (n.startSec - currentTimeSec) * pixelsPerSecond;
      final topY = size.height - (n.endSec - currentTimeSec) * pixelsPerSecond;
      final barHeight = (bottomY - topY).clamp(6.0, size.height * 4);
      final clampedTop = bottomY - barHeight;

      final inset = geom.isBlack ? 1.0 : 2.0;
      final rect = RRect.fromRectAndRadius(
        Rect.fromLTWH(
          geom.left + inset,
          clampedTop,
          (geom.width - inset * 2).clamp(4.0, geom.width),
          barHeight,
        ),
        const Radius.circular(4),
      );

      final fb = noteStates[i] ??
          ((currentTimeSec >= n.startSec && currentTimeSec <= n.endSec)
              ? NoteFeedbackState.active
              : NoteFeedbackState.upcoming);

      Color fillColor;
      if (fb == NoteFeedbackState.correct) {
        fillColor = _correctColor;
      } else if (fb == NoteFeedbackState.missed) {
        fillColor = _missedColor;
      } else if (n.hand == PianoHand.left) {
        fillColor = geom.isBlack ? _lhBlack : _lhWhite;
      } else {
        fillColor = geom.isBlack ? _rhBlack : _rhWhite;
      }

      canvas.drawRRect(rect, Paint()..color = fillColor);

      // Subtle active highlight border when crossing the strike line.
      if (fb == NoteFeedbackState.active) {
        canvas.drawRRect(
          rect,
          Paint()
            ..color = Colors.white
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.5,
        );
      }

      // Draw crisp note label inside bar when space permits.
      if (barHeight >= 22 && geom.width >= 18) {
        final label = PianoKeyLayout.midiToLabel(n.midiPitch);
        final tp = TextPainter(
          text: TextSpan(
            text: label,
            style: const TextStyle(
              color: Color(0xFF0B0F14),
              fontSize: 10,
              fontWeight: FontWeight.w700,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        if (tp.width <= geom.width - 4) {
          tp.paint(
            canvas,
            Offset(geom.left + (geom.width - tp.width) / 2, bottomY - tp.height - 4),
          );
        }
      }
    }

    // 4. Crisp horizontal strike line right above the keyboard.
    canvas.drawLine(
      Offset(0, size.height - 1),
      Offset(size.width, size.height - 1),
      Paint()
        ..color = const Color(0xFF38BDF8)
        ..strokeWidth = 2.0,
    );
  }

  @override
  bool shouldRepaint(covariant _FallingNotesPainter oldDelegate) {
    return oldDelegate.currentTimeSec != currentTimeSec ||
        oldDelegate.pixelsPerSecond != pixelsPerSecond ||
        oldDelegate.minMidi != minMidi ||
        oldDelegate.maxMidi != maxMidi ||
        oldDelegate.notes != notes ||
        oldDelegate.noteStates != noteStates;
  }
}
