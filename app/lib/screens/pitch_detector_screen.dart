import 'package:flutter/material.dart';
import '../audio/mic_controller.dart';
import '../models/pitch_frame.dart';

/// Milestone 1 utilitarian screen: proves live microphone-based piano note
/// recognition (no MIDI hardware) with frequency, note, cents, confidence,
/// and real-time log-frequency spectrum visualization.
class PitchDetectorScreen extends StatefulWidget {
  const PitchDetectorScreen({super.key});

  @override
  State<PitchDetectorScreen> createState() => _PitchDetectorScreenState();
}

class _PitchDetectorScreenState extends State<PitchDetectorScreen> {
  late final MicController _controller;

  @override
  void initState() {
    super.initState();
    _controller = MicController(sampleRate: 48000);
    _controller.addListener(_onUpdate);
  }

  void _onUpdate() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _controller.removeListener(_onUpdate);
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final frame = _controller.latestFrame;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('PianoTutor — M1 Mic Pitch Detector'),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: Text(
                '${_controller.sampleRate} Hz · Mic Only (No MIDI)',
                style: theme.textTheme.bodySmall,
              ),
            ),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (_controller.errorMessage != null)
              Container(
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.red.withValues(alpha: 0.15),
                  border: Border.all(color: Colors.redAccent),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  _controller.errorMessage!,
                  style: const TextStyle(color: Colors.redAccent),
                ),
              ),
            // Primary readout card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Row(
                  children: [
                    SizedBox(
                      width: 130,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('NOTE', style: theme.textTheme.labelSmall),
                          Text(
                            frame.noteName,
                            style: theme.textTheme.displayMedium?.copyWith(
                              fontWeight: FontWeight.bold,
                              color: frame.hasPitch ? Colors.tealAccent : Colors.grey,
                            ),
                          ),
                          Text(
                            frame.hasPitch ? 'MIDI ${frame.midiNote}' : 'Listening...',
                            style: theme.textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _metricRow('Frequency',
                              frame.hasPitch ? '${frame.frequencyHz.toStringAsFixed(2)} Hz' : '--'),
                          _metricRow('Cents Offset',
                              frame.hasPitch ? '${frame.centsOffset >= 0 ? '+' : ''}${frame.centsOffset.toStringAsFixed(1)} ¢' : '--'),
                          _metricRow('Confidence', '${(frame.confidence * 100).toStringAsFixed(0)}%'),
                          const SizedBox(height: 6),
                          LinearProgressIndicator(
                            value: frame.confidence.clamp(0.0, 1.0),
                            minHeight: 8,
                            backgroundColor: Colors.white12,
                            color: frame.confidence >= 0.8 ? Colors.tealAccent : Colors.amber,
                          ),
                          const SizedBox(height: 8),
                          _metricRow('Input RMS / Floor',
                              '${frame.rmsDb.toStringAsFixed(1)} dB / ${frame.noiseFloorDb.toStringAsFixed(1)} dB'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            // Real-time log-frequency spectrum visualizer
            Text('Real-Time Spectrum (27.5 Hz A0 – 4500 Hz C8)', style: theme.textTheme.labelMedium),
            const SizedBox(height: 6),
            Container(
              height: 150,
              decoration: BoxDecoration(
                color: const Color(0xFF111418),
                border: Border.all(color: Colors.white12),
                borderRadius: BorderRadius.circular(8),
              ),
              child: CustomPaint(
                painter: _SpectrumPainter(frame.spectrumBins),
              ),
            ),
            const SizedBox(height: 12),
            // Controls: Mic toggle + Record Melody + Noise gate slider
            Row(
              children: [
                FilledButton.icon(
                  onPressed: _controller.isListening ? _controller.stop : _controller.start,
                  icon: Icon(_controller.isListening ? Icons.stop : Icons.mic),
                  label: Text(_controller.isListening ? 'Stop Mic' : 'Start Mic'),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _controller.isListening ? _controller.toggleRecording : null,
                  icon: Icon(
                    _controller.isRecording ? Icons.stop_circle : Icons.fiber_manual_record,
                    color: _controller.isRecording ? Colors.redAccent : null,
                  ),
                  label: Text(_controller.isRecording ? 'Stop Rec' : 'Record Melody'),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Row(
                    children: [
                      Text('Gate: ${_controller.noiseGateDb.toStringAsFixed(0)} dB'),
                      Expanded(
                        child: Slider(
                          value: _controller.noiseGateDb,
                          min: -70,
                          max: -20,
                          divisions: 50,
                          onChanged: _controller.setNoiseGateDb,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            // Recorded melody summary or live NoteOn log
            Text(
              _controller.recordedNotes.isNotEmpty
                  ? 'Recorded Melody (${_controller.recordedNotes.length} notes)'
                  : 'Detected Note Events',
              style: theme.textTheme.labelMedium,
            ),
            const SizedBox(height: 4),
            Expanded(
              child: Container(
                decoration: BoxDecoration(
                  color: const Color(0xFF111418),
                  border: Border.all(color: Colors.white12),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: _controller.recordedNotes.isNotEmpty
                    ? ListView.builder(
                        itemCount: _controller.recordedNotes.length,
                        itemBuilder: (context, idx) {
                          final r = _controller.recordedNotes[idx];
                          return ListTile(
                            dense: true,
                            title: Text('#${idx + 1}  ${r.noteName} (${r.frequencyHz.toStringAsFixed(1)} Hz)'),
                            trailing: Text(
                              'start ${r.startSec.toStringAsFixed(2)}s · dur ${r.durationSec.toStringAsFixed(2)}s',
                              style: theme.textTheme.bodySmall,
                            ),
                          );
                        },
                      )
                    : ListView.builder(
                        itemCount: _controller.recentEvents.length,
                        itemBuilder: (context, idx) {
                          final e = _controller.recentEvents[idx];
                          return ListTile(
                            dense: true,
                            title: Text('${e.noteName} (${e.frequencyHz.toStringAsFixed(1)} Hz)'),
                            trailing: Text(
                              't=${e.timestampSec.toStringAsFixed(2)}s · ${(e.confidence * 100).toStringAsFixed(0)}%',
                              style: theme.textTheme.bodySmall,
                            ),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _metricRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: const TextStyle(color: Colors.white70)),
          Text(value, style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

class _SpectrumPainter extends CustomPainter {
  _SpectrumPainter(this.bins);
  final List<double> bins;

  @override
  void paint(Canvas canvas, Size size) {
    if (bins.isEmpty) return;
    final barPaint = Paint()..color = Colors.tealAccent;
    final barWidth = size.width / bins.length;
    for (int i = 0; i < bins.length; i++) {
      final h = (bins[i].clamp(0.0, 1.0)) * (size.height - 8);
      final rect = Rect.fromLTWH(
        i * barWidth + 1,
        size.height - h,
        (barWidth - 2).clamp(1.0, barWidth),
        h,
      );
      canvas.drawRect(rect, barPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _SpectrumPainter oldDelegate) => true;
}
