import 'dart:io';
import 'dart:typed_data';
import '../models/song_model.dart';

/// Standard MIDI File (SMF Type 0 & Type 1) parser — SONG DATA ONLY.
///
/// Extracts expected notes, velocities, durations, tempo changes, time/key signatures,
/// measure numbers, and hand assignments into the unified [SongModel].
/// Never interacts with MIDI hardware or MIDI keyboard input.
class MidiSongParser {
  static Future<SongModel> parseFile(String filePath) async {
    final file = File(filePath);
    if (!await file.exists()) {
      throw FormatException('MIDI file not found: $filePath');
    }
    final bytes = await file.readAsBytes();
    final baseName = file.uri.pathSegments.isNotEmpty
        ? file.uri.pathSegments.last.replaceAll(RegExp(r'\.(mid|midi)$', caseSensitive: false), '')
        : 'Imported Song';
    return parseBytes(bytes, fallbackTitle: baseName);
  }

  static SongModel parseBytes(Uint8List data, {String fallbackTitle = 'Imported Song'}) {
    if (data.length < 14 ||
        data[0] != 0x4D ||
        data[1] != 0x54 ||
        data[2] != 0x68 ||
        data[3] != 0x64) {
      throw const FormatException('Invalid MIDI file: missing MThd header.');
    }

    final view = ByteData.sublistView(data);
    final hdrLen = view.getUint32(4, Endian.big);
    if (hdrLen < 6 || 8 + hdrLen > data.length) {
      throw const FormatException('Invalid MIDI header length.');
    }

    final format = view.getUint16(8, Endian.big);
    final numTracks = view.getUint16(10, Endian.big);
    final division = view.getUint16(12, Endian.big);

    if (format > 1) {
      throw FormatException('Unsupported MIDI format $format (only Format 0 and 1 supported).');
    }
    if ((division & 0x8000) != 0 || division == 0) {
      throw const FormatException('SMPTE timecode MIDI division is not supported.');
    }

    final tpq = division;
    String title = fallbackTitle;
    int timeSigNum = 4;
    int timeSigDen = 4;
    int keySigFifths = 0;

    final rawTempos = <_RawTempo>[_RawTempo(0, 500000)];
    final rawNotes = <_RawNote>[];
    final noteTrackSet = <int>{};

    int pos = 8 + hdrLen;
    for (int trk = 0; trk < numTracks && pos + 8 <= data.length; trk++) {
      if (data[pos] != 0x4D ||
          data[pos + 1] != 0x54 ||
          data[pos + 2] != 0x72 ||
          data[pos + 3] != 0x6B) {
        throw FormatException('Expected MTrk chunk at offset $pos.');
      }
      final trkLen = view.getUint32(pos + 4, Endian.big);
      pos += 8;
      final trkEnd = (pos + trkLen <= data.length) ? pos + trkLen : data.length;

      int absTick = 0;
      int runningStatus = 0;
      String trackName = '';
      final openNotes = <int, List<_OpenNote>>{};

      while (pos < trkEnd) {
        final vlq = _readVlq(data, pos, trkEnd);
        if (vlq == null) break;
        absTick += vlq.value;
        pos = vlq.nextPos;
        if (pos >= trkEnd) break;

        int status = data[pos];
        if ((status & 0x80) != 0) {
          pos++;
          if (status < 0xF0) runningStatus = status;
        } else {
          if (runningStatus == 0) break;
          status = runningStatus;
        }

        if (status == 0xFF) {
          if (pos >= trkEnd) break;
          final metaType = data[pos++];
          final lenRes = _readVlq(data, pos, trkEnd);
          if (lenRes == null) break;
          pos = lenRes.nextPos;
          final metaLen = lenRes.value;
          if (pos + metaLen > trkEnd) break;

          if (metaType == 0x03 && metaLen > 0) {
            trackName = String.fromCharCodes(data.sublist(pos, pos + metaLen)).trim();
            if (trk == 0 && trackName.isNotEmpty) {
              title = trackName;
            }
          } else if (metaType == 0x51 && metaLen == 3) {
            final usec = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
            if (usec > 0) rawTempos.add(_RawTempo(absTick, usec));
          } else if (metaType == 0x58 && metaLen >= 2) {
            timeSigNum = data[pos];
            timeSigDen = 1 << data[pos + 1];
          } else if (metaType == 0x59 && metaLen >= 1) {
            keySigFifths = view.getInt8(pos);
          } else if (metaType == 0x2F) {
            pos = trkEnd;
            break;
          }
          pos += metaLen;
        } else if (status == 0xF0 || status == 0xF7) {
          final lenRes = _readVlq(data, pos, trkEnd);
          if (lenRes == null) break;
          pos = (lenRes.nextPos + lenRes.value).clamp(0, trkEnd);
        } else {
          final cmd = status & 0xF0;
          final ch = status & 0x0F;
          if (cmd == 0xC0 || cmd == 0xD0) {
            if (pos < trkEnd) pos++;
          } else if (cmd == 0x80 || cmd == 0x90 || cmd == 0xA0 || cmd == 0xB0 || cmd == 0xE0) {
            if (pos + 2 > trkEnd) break;
            final d1 = data[pos++];
            final d2 = data[pos++];

            if (ch != 9 && (cmd == 0x90 || cmd == 0x80)) {
              final key = (ch << 8) | d1;
              final isNoteOn = (cmd == 0x90 && d2 > 0);
              if (isNoteOn) {
                openNotes.putIfAbsent(key, () => <_OpenNote>[]).add(_OpenNote(absTick, d2 / 127.0));
              } else {
                final list = openNotes[key];
                if (list != null && list.isNotEmpty) {
                  final open = list.removeAt(0);
                  if (absTick > open.startTick) {
                    rawNotes.add(_RawNote(
                      midiPitch: d1,
                      startTick: open.startTick,
                      endTick: absTick,
                      velocity: open.velocity,
                      trackIndex: trk,
                      trackName: trackName,
                    ));
                    noteTrackSet.add(trk);
                  }
                }
              }
            }
          } else {
            break;
          }
        }
      }
      pos = trkEnd;
    }

    // Build deduplicated cumulative tempo map.
    rawTempos.sort((a, b) => a.tick.compareTo(b.tick));
    final mergedTempos = <_RawTempo>[];
    for (final rt in rawTempos) {
      if (mergedTempos.isNotEmpty && mergedTempos.last.tick == rt.tick) {
        mergedTempos.last = rt;
      } else {
        mergedTempos.add(rt);
      }
    }

    final tempoPoints = <_TempoPoint>[];
    double accumSec = 0.0;
    int prevTick = 0;
    int prevUsec = 500000;
    for (final rt in mergedTempos) {
      accumSec += (rt.tick - prevTick) * (prevUsec * 1e-6 / tpq);
      tempoPoints.add(_TempoPoint(rt.tick, accumSec, rt.usecPerQuarter));
      prevTick = rt.tick;
      prevUsec = rt.usecPerQuarter;
    }

    final sortedTracks = noteTrackSet.toList()..sort();
    final compactTrackMap = <int, int>{
      for (int i = 0; i < sortedTracks.length; i++) sortedTracks[i]: i,
    };

    final beatsPerMeasure = timeSigNum * (4.0 / timeSigDen);
    final ticksPerMeasure = (beatsPerMeasure * tpq).clamp(1.0, double.infinity);

    final notes = rawNotes.map((rn) {
      final startSec = _tickToSec(rn.startTick, tpq, tempoPoints);
      final endSec = _tickToSec(rn.endTick, tpq, tempoPoints);
      final compactTrk = compactTrackMap[rn.trackIndex] ?? 0;
      return SongNoteEvent(
        midiPitch: rn.midiPitch,
        startSec: startSec,
        durationSec: (endSec - startSec).clamp(0.02, double.infinity),
        velocity: rn.velocity,
        trackIndex: compactTrk,
        hand: _inferHand(rn.trackName, compactTrk, sortedTracks.length, rn.midiPitch),
        measureNumber: (rn.startTick / ticksPerMeasure).floor() + 1,
      );
    }).toList()
      ..sort((a, b) {
        final cmp = a.startSec.compareTo(b.startSec);
        return cmp != 0 ? cmp : a.midiPitch.compareTo(b.midiPitch);
      });

    return SongModel(
      id: 'midi_${DateTime.now().millisecondsSinceEpoch}',
      title: title,
      composer: 'Imported MIDI',
      sourceFormat: SongSourceFormat.midiFile,
      notes: notes,
      tempoMap: tempoPoints
          .map((tp) => TempoChange(atSec: tp.timeSec, bpm: 60000000.0 / tp.usecPerQuarter))
          .toList(),
      timeSignatureNumerator: timeSigNum,
      timeSignatureDenominator: timeSigDen,
      keySignatureFifths: keySigFifths,
    );
  }

  static PianoHand _inferHand(String trackName, int compactTrack, int noteTracks, int midiPitch) {
    final lower = trackName.toLowerCase();
    if (lower.contains('right') || lower.contains('rh') || lower.contains('treble')) {
      return PianoHand.right;
    }
    if (lower.contains('left') || lower.contains('lh') || lower.contains('bass')) {
      return PianoHand.left;
    }
    if (noteTracks == 2) {
      return compactTrack == 0 ? PianoHand.right : PianoHand.left;
    }
    return midiPitch >= 60 ? PianoHand.right : PianoHand.left;
  }

  static double _tickToSec(int tick, int tpq, List<_TempoPoint> map) {
    _TempoPoint active = map.first;
    for (int i = 1; i < map.length; i++) {
      if (map[i].tick <= tick) {
        active = map[i];
      } else {
        break;
      }
    }
    return active.timeSec + (tick - active.tick) * (active.usecPerQuarter * 1e-6 / tpq);
  }

  static _VlqResult? _readVlq(Uint8List data, int pos, int end) {
    int value = 0;
    for (int i = 0; i < 4; i++) {
      if (pos >= end) return null;
      final b = data[pos++];
      value = (value << 7) | (b & 0x7F);
      if ((b & 0x80) == 0) return _VlqResult(value, pos);
    }
    return null;
  }
}

class _VlqResult {
  const _VlqResult(this.value, this.nextPos);
  final int value;
  final int nextPos;
}

class _RawTempo {
  const _RawTempo(this.tick, this.usecPerQuarter);
  final int tick;
  final int usecPerQuarter;
}

class _TempoPoint {
  const _TempoPoint(this.tick, this.timeSec, this.usecPerQuarter);
  final int tick;
  final double timeSec;
  final int usecPerQuarter;
}

class _OpenNote {
  const _OpenNote(this.startTick, this.velocity);
  final int startTick;
  final double velocity;
}

class _RawNote {
  const _RawNote({
    required this.midiPitch,
    required this.startTick,
    required this.endTick,
    required this.velocity,
    required this.trackIndex,
    required this.trackName,
  });
  final int midiPitch;
  final int startTick;
  final int endTick;
  final double velocity;
  final int trackIndex;
  final String trackName;
}
