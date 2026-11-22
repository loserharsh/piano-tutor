import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import '../models/song_model.dart';
import '../widgets/falling_notes_canvas.dart';
import '../widgets/piano_keyboard.dart';

enum HandFilter { both, right, left }

enum KeyboardRangePreset {
  threeOctaves('3 Oct (C3–C6)', 48, 84),
  fiveOctaves('5 Oct (C2–C7)', 36, 96),
  full88('88 Keys (A0–C8)', 21, 108);

  const KeyboardRangePreset(this.label, this.minMidi, this.maxMidi);
  final String label;
  final int minMidi;
  final int maxMidi;
}

/// Milestone 3 Piano Practice Screen:
/// Synchronizes falling vertical note bars with a realistic virtual piano keyboard,
/// supporting tempo scaling, fall speed, hand filtering, octave range, and measure looping.
class PracticeScreen extends StatefulWidget {
  const PracticeScreen({super.key, required this.song});

  final SongModel song;

  @override
  State<PracticeScreen> createState() => _PracticeScreenState();
}

class _PracticeScreenState extends State<PracticeScreen> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  Duration _lastTick = Duration.zero;

  bool _isPlaying = false;
  double _currentTimeSec = -1.5; // 1.5s lead-in so first notes fall cleanly into view
  double _tempoScale = 1.0;      // 0.25x .. 1.50x
  double _fallSpeedPx = 180.0;   // 100 .. 360 px/s
  HandFilter _handFilter = HandFilter.both;
  KeyboardRangePreset _rangePreset = KeyboardRangePreset.threeOctaves;

  bool _loopEnabled = false;
  int _loopStartMeasure = 1;
  int _loopEndMeasure = 2;

  late int _maxMeasure;

  @override
  void initState() {
    super.initState();
    _maxMeasure = widget.song.notes.isEmpty
        ? 1
        : widget.song.notes.map((n) => n.measureNumber).reduce((a, b) => a > b ? a : b);
    _loopEndMeasure = _maxMeasure.clamp(1, 2);

    // Auto-select 5 octaves if the song spans wider than C3..C6.
    if (widget.song.notes.any((n) => n.midiPitch < 48 || n.midiPitch > 84)) {
      _rangePreset = KeyboardRangePreset.fiveOctaves;
    }

    _ticker = createTicker(_onTick);
  }

  void _onTick(Duration elapsed) {
    if (!_isPlaying) return;
    final dtSec = (_lastTick == Duration.zero)
        ? 0.0
        : (elapsed - _lastTick).inMicroseconds / 1e6;
    _lastTick = elapsed;

    final nextTime = _currentTimeSec + dtSec * _tempoScale;
    final endSec = widget.song.totalDurationSec + 0.5;

    if (_loopEnabled) {
      final (loopStart, loopEnd) = _loopBoundsSec();
      if (nextTime >= loopEnd) {
        setState(() => _currentTimeSec = loopStart);
        return;
      }
    }

    if (nextTime >= endSec) {
      setState(() {
        _currentTimeSec = endSec;
        _isPlaying = false;
      });
      _ticker.stop();
      return;
    }

    setState(() => _currentTimeSec = nextTime);
  }

  (double, double) _loopBoundsSec() {
    final inLoop = widget.song.notes.where(
      (n) => n.measureNumber >= _loopStartMeasure && n.measureNumber <= _loopEndMeasure,
    );
    if (inLoop.isEmpty) {
      return (0.0, widget.song.totalDurationSec);
    }
    final start = inLoop.map((n) => n.startSec).reduce((a, b) => a < b ? a : b);
    final end = inLoop.map((n) => n.endSec).reduce((a, b) => a > b ? a : b);
    return (start, end + 0.15);
  }

  void _togglePlay() {
    setState(() {
      _isPlaying = !_isPlaying;
      if (_isPlaying) {
        if (_currentTimeSec >= widget.song.totalDurationSec) {
          _currentTimeSec = -1.0;
        }
        _lastTick = Duration.zero;
        _ticker.start();
      } else {
        _ticker.stop();
      }
    });
  }

  void _restart() {
    _ticker.stop();
    setState(() {
      _isPlaying = false;
      _lastTick = Duration.zero;
      _currentTimeSec = _loopEnabled ? _loopBoundsSec().$1 - 0.5 : -1.5;
    });
  }

  List<SongNoteEvent> get _filteredNotes {
    return widget.song.notes.where((n) {
      if (_handFilter == HandFilter.right) return n.hand == PianoHand.right || n.hand == PianoHand.unknown;
      if (_handFilter == HandFilter.left) return n.hand == PianoHand.left;
      return true;
    }).toList();
  }

  Map<int, KeyVisualState> _computeKeyStates(List<SongNoteEvent> visibleNotes) {
    final states = <int, KeyVisualState>{};
    for (final n in visibleNotes) {
      if (_currentTimeSec >= n.startSec && _currentTimeSec <= n.endSec) {
        states[n.midiPitch] =
            (n.hand == PianoHand.left) ? KeyVisualState.expectedLeft : KeyVisualState.expectedRight;
      }
    }
    return states;
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final notes = _filteredNotes;
    final keyStates = _computeKeyStates(notes);
    final totalDur = widget.song.totalDurationSec.clamp(1.0, double.infinity);
    final baseBpm = widget.song.tempoMap.isNotEmpty ? widget.song.tempoMap.first.bpm : 100.0;

    return Scaffold(
      backgroundColor: const Color(0xFF0E1116),
      appBar: AppBar(
        backgroundColor: const Color(0xFF141921),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(widget.song.title, style: const TextStyle(fontSize: 16)),
            Text(
              '${widget.song.composer} · ${(baseBpm * _tempoScale).toStringAsFixed(0)} BPM',
              style: const TextStyle(fontSize: 12, color: Colors.white60),
            ),
          ],
        ),
        actions: [
          // Hand filter selector
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: SegmentedButton<HandFilter>(
              segments: const [
                ButtonSegment(value: HandFilter.both, label: Text('Both')),
                ButtonSegment(value: HandFilter.right, label: Text('RH')),
                ButtonSegment(value: HandFilter.left, label: Text('LH')),
              ],
              selected: {_handFilter},
              onSelectionChanged: (s) => setState(() => _handFilter = s.first),
            ),
          ),
          // Octave range selector
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: DropdownButton<KeyboardRangePreset>(
              value: _rangePreset,
              underline: const SizedBox.shrink(),
              items: KeyboardRangePreset.values
                  .map((p) => DropdownMenuItem(value: p, child: Text(p.label)))
                  .toList(),
              onChanged: (p) {
                if (p != null) setState(() => _rangePreset = p);
              },
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          // Transport & practice controls bar
          Container(
            color: const Color(0xFF141921),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Wrap(
              spacing: 16,
              runSpacing: 6,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    FilledButton.icon(
                      onPressed: _togglePlay,
                      icon: Icon(_isPlaying ? Icons.pause : Icons.play_arrow),
                      label: Text(_isPlaying ? 'Pause' : 'Play'),
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      tooltip: 'Restart',
                      onPressed: _restart,
                      icon: const Icon(Icons.replay),
                    ),
                  ],
                ),
                // Tempo control
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Tempo ${(_tempoScale * 100).round()}%'),
                    SizedBox(
                      width: 120,
                      child: Slider(
                        value: _tempoScale,
                        min: 0.25,
                        max: 1.50,
                        divisions: 25,
                        onChanged: (v) => setState(() => _tempoScale = v),
                      ),
                    ),
                  ],
                ),
                // Fall speed control
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text('Speed ${_fallSpeedPx.round()} px/s'),
                    SizedBox(
                      width: 120,
                      child: Slider(
                        value: _fallSpeedPx,
                        min: 100,
                        max: 360,
                        divisions: 26,
                        onChanged: (v) => setState(() => _fallSpeedPx = v),
                      ),
                    ),
                  ],
                ),
                // Measure loop toggle
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    FilterChip(
                      label: Text('Loop M$_loopStartMeasure–M$_loopEndMeasure'),
                      selected: _loopEnabled,
                      onSelected: (v) => setState(() => _loopEnabled = v),
                    ),
                    if (_loopEnabled && _maxMeasure > 1) ...[
                      IconButton(
                        tooltip: 'Increment loop end measure',
                        icon: const Icon(Icons.add_circle_outline, size: 18),
                        onPressed: () => setState(() {
                          _loopEndMeasure = (_loopEndMeasure % _maxMeasure) + 1;
                          if (_loopEndMeasure < _loopStartMeasure) {
                            _loopStartMeasure = 1;
                          }
                        }),
                      ),
                    ],
                  ],
                ),
              ],
            ),
          ),
          // Song timeline scrub bar
          Container(
            color: const Color(0xFF11161D),
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Text(
                  '${_currentTimeSec.clamp(0.0, totalDur).toStringAsFixed(1)}s',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.white70),
                ),
                Expanded(
                  child: Slider(
                    value: _currentTimeSec.clamp(-1.5, totalDur + 0.5),
                    min: -1.5,
                    max: totalDur + 0.5,
                    onChanged: (v) => setState(() => _currentTimeSec = v),
                  ),
                ),
                Text(
                  '${totalDur.toStringAsFixed(1)}s',
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12, color: Colors.white70),
                ),
              ],
            ),
          ),
          // Falling notes canvas
          Expanded(
            child: FallingNotesCanvas(
              notes: notes,
              currentTimeSec: _currentTimeSec,
              minMidi: _rangePreset.minMidi,
              maxMidi: _rangePreset.maxMidi,
              pixelsPerSecond: _fallSpeedPx,
              bpm: baseBpm,
            ),
          ),
          // Aligned virtual piano keyboard
          PianoKeyboardWidget(
            minMidi: _rangePreset.minMidi,
            maxMidi: _rangePreset.maxMidi,
            keyStates: keyStates,
            height: 150,
          ),
        ],
      ),
    );
  }
}
