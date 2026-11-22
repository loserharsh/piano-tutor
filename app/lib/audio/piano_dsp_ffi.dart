import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';
import 'package:ffi/ffi.dart';
import '../models/pitch_frame.dart';

final class _PianoDspEngine extends Opaque {}

final class _PianoDspSnapshot extends Struct {
  @Int32()
  external int hasPitch;

  @Float()
  external double frequencyHz;

  @Int32()
  external int midiNote;

  @Float()
  external double centsOffset;

  @Float()
  external double confidence;

  @Float()
  external double rmsDb;

  @Float()
  external double noiseFloorDb;

  @Float()
  external double spectralFlux;

  @Int32()
  external int isOnset;

  @Int32()
  external int activeNoteMidi;

  @Double()
  external double timestampSec;

  @Array(64)
  external Array<Float> spectrumBins;
}

final class _PianoDspNoteEvent extends Struct {
  @Int32()
  external int type;

  @Int32()
  external int midiNote;

  @Float()
  external double frequencyHz;

  @Float()
  external double confidence;

  @Float()
  external double velocityEst;

  @Double()
  external double timestampSec;
}

final class _PianoDspRecordedNote extends Struct {
  @Int32()
  external int midiNote;

  @Float()
  external double frequencyHz;

  @Double()
  external double startSec;

  @Double()
  external double endSec;

  @Double()
  external double durationSec;

  @Float()
  external double confidence;

  @Float()
  external double velocityEst;
}

typedef _VoidEngineNative = Void Function(Pointer<_PianoDspEngine>);
typedef _VoidEngineDart = void Function(Pointer<_PianoDspEngine>);

typedef _IntEngineNative = Int32 Function(Pointer<_PianoDspEngine>);
typedef _IntEngineDart = int Function(Pointer<_PianoDspEngine>);

typedef _GetRecNoteNative = Int32 Function(
    Pointer<_PianoDspEngine>, Int32, Pointer<_PianoDspRecordedNote>);
typedef _GetRecNoteDart = int Function(
    Pointer<_PianoDspEngine>, int, Pointer<_PianoDspRecordedNote>);

typedef _CreateNative = Pointer<_PianoDspEngine> Function(Int32, Int32, Int32);
typedef _CreateDart = Pointer<_PianoDspEngine> Function(int, int, int);

typedef _DestroyNative = Void Function(Pointer<_PianoDspEngine>);
typedef _DestroyDart = void Function(Pointer<_PianoDspEngine>);

typedef _SetFloatNative = Void Function(Pointer<_PianoDspEngine>, Float);
typedef _SetFloatDart = void Function(Pointer<_PianoDspEngine>, double);

typedef _PushAudioNative = Int32 Function(Pointer<_PianoDspEngine>, Pointer<Float>, Int32);
typedef _PushAudioDart = int Function(Pointer<_PianoDspEngine>, Pointer<Float>, int);

typedef _ProcessNative = Int32 Function(Pointer<_PianoDspEngine>);
typedef _ProcessDart = int Function(Pointer<_PianoDspEngine>);

typedef _StartMicNative = Int32 Function(Pointer<_PianoDspEngine>, Pointer<Utf8>);
typedef _StartMicDart = int Function(Pointer<_PianoDspEngine>, Pointer<Utf8>);

typedef _StopMicNative = Void Function(Pointer<_PianoDspEngine>);
typedef _StopMicDart = void Function(Pointer<_PianoDspEngine>);

typedef _IsMicRunningNative = Int32 Function(Pointer<_PianoDspEngine>);
typedef _IsMicRunningDart = int Function(Pointer<_PianoDspEngine>);

typedef _LastErrorNative = Pointer<Utf8> Function(Pointer<_PianoDspEngine>);
typedef _LastErrorDart = Pointer<Utf8> Function(Pointer<_PianoDspEngine>);

typedef _GetSnapshotNative = Void Function(Pointer<_PianoDspEngine>, Pointer<_PianoDspSnapshot>);
typedef _GetSnapshotDart = void Function(Pointer<_PianoDspEngine>, Pointer<_PianoDspSnapshot>);

typedef _PopEventNative = Int32 Function(Pointer<_PianoDspEngine>, Pointer<_PianoDspNoteEvent>);
typedef _PopEventDart = int Function(Pointer<_PianoDspEngine>, Pointer<_PianoDspNoteEvent>);

typedef _MidiToNameNative = Void Function(Int32, Pointer<Utf8>, Int32);
typedef _MidiToNameDart = void Function(int, Pointer<Utf8>, int);

class PianoDspBridge {
  PianoDspBridge({int sampleRate = 48000, int frameSize = 4096, int hopSize = 512}) {
    _lib = _openLibrary();
    _create = _lib.lookupFunction<_CreateNative, _CreateDart>('piano_dsp_create');
    _destroy = _lib.lookupFunction<_DestroyNative, _DestroyDart>('piano_dsp_destroy');
    _setNoiseGate = _lib.lookupFunction<_SetFloatNative, _SetFloatDart>('piano_dsp_set_noise_gate_db');
    _pushAudio = _lib.lookupFunction<_PushAudioNative, _PushAudioDart>('piano_dsp_push_audio');
    _process = _lib.lookupFunction<_ProcessNative, _ProcessDart>('piano_dsp_process');
    _startMic = _lib.lookupFunction<_StartMicNative, _StartMicDart>('piano_dsp_start_mic');
    _stopMic = _lib.lookupFunction<_StopMicNative, _StopMicDart>('piano_dsp_stop_mic');
    _isMicRunning = _lib.lookupFunction<_IsMicRunningNative, _IsMicRunningDart>('piano_dsp_is_mic_running');
    _lastError = _lib.lookupFunction<_LastErrorNative, _LastErrorDart>('piano_dsp_last_error');
    _getSnapshot = _lib.lookupFunction<_GetSnapshotNative, _GetSnapshotDart>('piano_dsp_get_snapshot');
    _popEvent = _lib.lookupFunction<_PopEventNative, _PopEventDart>('piano_dsp_pop_note_event');
    _midiToName = _lib.lookupFunction<_MidiToNameNative, _MidiToNameDart>('piano_dsp_midi_to_name');
    _startRecording = _lib.lookupFunction<_VoidEngineNative, _VoidEngineDart>('piano_dsp_start_recording');
    _stopRecording = _lib.lookupFunction<_VoidEngineNative, _VoidEngineDart>('piano_dsp_stop_recording');
    _getRecordedCount = _lib.lookupFunction<_IntEngineNative, _IntEngineDart>('piano_dsp_get_recorded_count');
    _getRecordedNote = _lib.lookupFunction<_GetRecNoteNative, _GetRecNoteDart>('piano_dsp_get_recorded_note');

    _engine = _create(sampleRate, frameSize, hopSize);
    _snapPtr = calloc<_PianoDspSnapshot>();
    _eventPtr = calloc<_PianoDspNoteEvent>();
    _recNotePtr = calloc<_PianoDspRecordedNote>();
    _nameBuf = calloc<Uint8>(16).cast<Utf8>();
  }

  late final DynamicLibrary _lib;
  late final Pointer<_PianoDspEngine> _engine;
  late final Pointer<_PianoDspSnapshot> _snapPtr;
  late final Pointer<_PianoDspNoteEvent> _eventPtr;
  late final Pointer<_PianoDspRecordedNote> _recNotePtr;
  late final Pointer<Utf8> _nameBuf;

  late final _CreateDart _create;
  late final _DestroyDart _destroy;
  late final _SetFloatDart _setNoiseGate;
  late final _PushAudioDart _pushAudio;
  late final _ProcessDart _process;
  late final _StartMicDart _startMic;
  late final _StopMicDart _stopMic;
  late final _IsMicRunningDart _isMicRunning;
  late final _LastErrorDart _lastError;
  late final _GetSnapshotDart _getSnapshot;
  late final _PopEventDart _popEvent;
  late final _MidiToNameDart _midiToName;
  late final _VoidEngineDart _startRecording;
  late final _VoidEngineDart _stopRecording;
  late final _IntEngineDart _getRecordedCount;
  late final _GetRecNoteDart _getRecordedNote;

  static DynamicLibrary _openLibrary() {
    if (Platform.isLinux) {
      for (final path in [
        'libpiano_dsp.so',
        '../native/build/libpiano_dsp.so',
        'native/build/libpiano_dsp.so',
      ]) {
        try {
          return DynamicLibrary.open(path);
        } catch (_) {}
      }
      throw StateError('Could not load libpiano_dsp.so. Build native/ first.');
    }
    if (Platform.isAndroid) {
      return DynamicLibrary.open('libpiano_dsp.so');
    }
    if (Platform.isWindows) {
      return DynamicLibrary.open('piano_dsp.dll');
    }
    throw UnsupportedError('Unsupported platform: ${Platform.operatingSystem}');
  }

  void setNoiseGateDb(double db) => _setNoiseGate(_engine, db);

  int startNativeMic({String deviceId = 'default'}) {
    final devPtr = deviceId.toNativeUtf8();
    try {
      return _startMic(_engine, devPtr);
    } finally {
      calloc.free(devPtr);
    }
  }

  void stopNativeMic() => _stopMic(_engine);
  bool get isNativeMicRunning => _isMicRunning(_engine) != 0;
  String get lastError => _lastError(_engine).toDartString();

  int pushFloatPcm(Float32List samples) {
    final ptr = calloc<Float>(samples.length);
    try {
      ptr.asTypedList(samples.length).setAll(0, samples);
      return _pushAudio(_engine, ptr, samples.length);
    } finally {
      calloc.free(ptr);
    }
  }

  int process() => _process(_engine);

  void startRecording() => _startRecording(_engine);
  void stopRecording() => _stopRecording(_engine);

  List<RecordedNote> getRecordedNotes() {
    final count = _getRecordedCount(_engine);
    final out = <RecordedNote>[];
    for (int i = 0; i < count; i++) {
      if (_getRecordedNote(_engine, i, _recNotePtr) != 0) {
        final r = _recNotePtr.ref;
        out.add(RecordedNote(
          midiNote: r.midiNote,
          noteName: midiToName(r.midiNote),
          frequencyHz: r.frequencyHz,
          startSec: r.startSec,
          endSec: r.endSec,
          durationSec: r.durationSec,
          confidence: r.confidence,
          velocityEst: r.velocityEst,
        ));
      }
    }
    return out;
  }

  String midiToName(int midi) {
    _midiToName(midi, _nameBuf, 16);
    return _nameBuf.toDartString();
  }

  PitchFrame getSnapshot() {
    _getSnapshot(_engine, _snapPtr);
    final s = _snapPtr.ref;
    final bins = List<double>.generate(64, (i) => s.spectrumBins[i]);
    return PitchFrame(
      hasPitch: s.hasPitch != 0,
      frequencyHz: s.frequencyHz,
      midiNote: s.midiNote,
      noteName: s.hasPitch != 0 ? midiToName(s.midiNote) : '--',
      centsOffset: s.centsOffset,
      confidence: s.confidence,
      rmsDb: s.rmsDb,
      noiseFloorDb: s.noiseFloorDb,
      spectralFlux: s.spectralFlux,
      isOnset: s.isOnset != 0,
      activeNoteMidi: s.activeNoteMidi,
      timestampSec: s.timestampSec,
      spectrumBins: bins,
    );
  }

  List<DetectedNoteEvent> drainNoteEvents() {
    final events = <DetectedNoteEvent>[];
    while (_popEvent(_engine, _eventPtr) != 0) {
      final e = _eventPtr.ref;
      events.add(DetectedNoteEvent(
        type: e.type == 1
            ? DetectedNoteEventType.noteOn
            : (e.type == 2 ? DetectedNoteEventType.noteOff : DetectedNoteEventType.none),
        midiNote: e.midiNote,
        noteName: midiToName(e.midiNote),
        frequencyHz: e.frequencyHz,
        confidence: e.confidence,
        velocityEst: e.velocityEst,
        timestampSec: e.timestampSec,
      ));
    }
    return events;
  }

  void dispose() {
    _destroy(_engine);
    calloc.free(_snapPtr);
    calloc.free(_eventPtr);
    calloc.free(_recNotePtr);
    calloc.free(_nameBuf);
  }
}
