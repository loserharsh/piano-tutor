import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:piano_tutor/importers/midi_song_parser.dart';
import 'package:piano_tutor/models/song_model.dart';
import 'package:piano_tutor/widgets/piano_layout.dart';

void main() {
  test('MidiSongParser parses SMF Type 1 with tempo change and two hands', () {
    List<int> chunk(String id, List<int> payload) {
      final len = payload.length;
      return [
        ...id.codeUnits,
        (len >> 24) & 0xFF,
        (len >> 16) & 0xFF,
        (len >> 8) & 0xFF,
        len & 0xFF,
        ...payload,
      ];
    }

    final bytes = Uint8List.fromList([
      ...chunk('MThd', [0x00, 0x01, 0x00, 0x02, 0x01, 0xE0]),
      ...chunk('MTrk', [
        0x00, 0xFF, 0x03, 0x0A, ...'Right Hand'.codeUnits,
        0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, // 120 BPM
        0x00, 0x90, 60, 100,
        0x83, 0x60, 60, 0, // running status NoteOff @ 480 (0.5s)
        0x00, 0xFF, 0x51, 0x03, 0x0F, 0x42, 0x40, // 60 BPM
        0x00, 0x90, 64, 90,
        0x83, 0x60, 0x80, 64, 0, // NoteOff @ 960 (1.5s)
        0x00, 0xFF, 0x2F, 0x00,
      ]),
      ...chunk('MTrk', [
        0x00, 0xFF, 0x03, 0x09, ...'Left Hand'.codeUnits,
        0x00, 0x90, 48, 80,
        0x83, 0x60, 0x80, 48, 0,
        0x00, 0xFF, 0x2F, 0x00,
      ]),
    ]);

    final song = MidiSongParser.parseBytes(bytes);
    expect(song.tempoMap.length, 2);
    expect(song.notes.length, 3);
    expect(song.notes[0].midiPitch, 48);
    expect(song.notes[0].hand, PianoHand.left);
    expect(song.notes[1].midiPitch, 60);
    expect(song.notes[1].hand, PianoHand.right);
    expect(song.notes[2].midiPitch, 64);
    expect(song.notes[2].startSec, closeTo(0.5, 1e-4));
    expect(song.notes[2].durationSec, closeTo(1.0, 1e-4));
  });

  test('PianoKeyLayout aligns 88 keys within totalWidth without overflow', () {
    final layout = PianoKeyLayout(minMidi: 21, maxMidi: 108, totalWidth: 1040.0);
    expect(layout.whiteKeys.length, 52);
    expect(layout.blackKeys.length, 36);
    expect(layout.whiteKeys.first.left, closeTo(0.0, 1e-6));
    expect(layout.whiteKeys.last.right, closeTo(1040.0, 1e-6));
    expect(PianoKeyLayout.midiToLabel(60), 'C4');
    expect(PianoKeyLayout.midiToLabel(21), 'A0');
    expect(PianoKeyLayout.midiToLabel(108), 'C8');
  });
}
