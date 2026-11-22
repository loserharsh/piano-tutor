import 'package:flutter/material.dart';
import 'piano_layout.dart';

enum KeyVisualState {
  idle,
  expectedRight,
  expectedLeft,
  correct,
  wrong,
  missed,
}

/// Clean, realistic multi-octave virtual piano keyboard.
/// Uses flat tactile shading without unnecessary gradients or clutter.
class PianoKeyboardWidget extends StatelessWidget {
  const PianoKeyboardWidget({
    super.key,
    required this.minMidi,
    required this.maxMidi,
    required this.keyStates,
    this.height = 148,
  });

  final int minMidi;
  final int maxMidi;
  final Map<int, KeyVisualState> keyStates;
  final double height;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      width: double.infinity,
      child: CustomPaint(
        painter: _PianoKeyboardPainter(
          minMidi: minMidi,
          maxMidi: maxMidi,
          keyStates: keyStates,
        ),
      ),
    );
  }
}

class _PianoKeyboardPainter extends CustomPainter {
  _PianoKeyboardPainter({
    required this.minMidi,
    required this.maxMidi,
    required this.keyStates,
  });

  final int minMidi;
  final int maxMidi;
  final Map<int, KeyVisualState> keyStates;

  static const Color _rhColor = Color(0xFF2DD4BF);      // Teal
  static const Color _lhColor = Color(0xFFF59E0B);      // Amber
  static const Color _correctColor = Color(0xFF22C55E); // Emerald
  static const Color _wrongColor = Color(0xFFEF4444);   // Red
  static const Color _missedColor = Color(0xFF94A3B8);  // Slate

  Color _fillFor(KeyVisualState state, bool isBlack) {
    switch (state) {
      case KeyVisualState.expectedRight:
        return isBlack ? const Color(0xFF0F766E) : _rhColor;
      case KeyVisualState.expectedLeft:
        return isBlack ? const Color(0xFFB45309) : _lhColor;
      case KeyVisualState.correct:
        return isBlack ? const Color(0xFF15803D) : _correctColor;
      case KeyVisualState.wrong:
        return isBlack ? const Color(0xFFB91C1C) : _wrongColor;
      case KeyVisualState.missed:
        return isBlack ? const Color(0xFF475569) : _missedColor;
      case KeyVisualState.idle:
        return isBlack ? const Color(0xFF181B20) : const Color(0xFFF8FAFC);
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    final layout = PianoKeyLayout(
      minMidi: minMidi,
      maxMidi: maxMidi,
      totalWidth: size.width,
    );

    final borderPaint = Paint()
      ..color = const Color(0xFF334155)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.0;

    final blackBorderPaint = Paint()
      ..color = const Color(0xFF090B0E)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.0;

    // 1. Draw white keys first.
    for (final k in layout.whiteKeys) {
      final state = keyStates[k.midi] ?? KeyVisualState.idle;
      final rect = RRect.fromRectAndCorners(
        Rect.fromLTWH(k.left, 0, k.width, size.height),
        bottomLeft: const Radius.circular(4),
        bottomRight: const Radius.circular(4),
      );
      canvas.drawRRect(rect, Paint()..color = _fillFor(state, false));
      canvas.drawRRect(rect, borderPaint);

      // Octave C labels (C2, C3, C4, C5...) for spatial orientation.
      if (k.midi % 12 == 0 && k.width >= 14) {
        final label = PianoKeyLayout.midiToLabel(k.midi);
        final tp = TextPainter(
          text: TextSpan(
            text: label,
            style: TextStyle(
              color: state == KeyVisualState.idle ? const Color(0xFF475569) : Colors.black87,
              fontSize: k.width >= 22 ? 11 : 9,
              fontWeight: FontWeight.w600,
            ),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        tp.paint(
          canvas,
          Offset(k.left + (k.width - tp.width) / 2, size.height - tp.height - 6),
        );
      }
    }

    // 2. Draw black keys on top.
    final blackHeight = size.height * 0.62;
    for (final k in layout.blackKeys) {
      final state = keyStates[k.midi] ?? KeyVisualState.idle;
      final rect = RRect.fromRectAndCorners(
        Rect.fromLTWH(k.left, 0, k.width, blackHeight),
        bottomLeft: const Radius.circular(3),
        bottomRight: const Radius.circular(3),
      );
      canvas.drawRRect(rect, Paint()..color = _fillFor(state, true));
      canvas.drawRRect(rect, blackBorderPaint);
    }

    // Top keybed shadow line.
    canvas.drawLine(
      Offset.zero,
      Offset(size.width, 0),
      Paint()
        ..color = const Color(0xFF0F172A)
        ..strokeWidth = 2.0,
    );
  }

  @override
  bool shouldRepaint(covariant _PianoKeyboardPainter oldDelegate) {
    return oldDelegate.minMidi != minMidi ||
        oldDelegate.maxMidi != maxMidi ||
        oldDelegate.keyStates != keyStates;
  }
}
