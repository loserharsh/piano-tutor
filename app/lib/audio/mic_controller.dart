import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/foundation.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';
import '../models/pitch_frame.dart';
import 'piano_dsp_ffi.dart';

enum MicPermissionState { unknown, granted, denied, permanentlyDenied }

class MicController extends ChangeNotifier {
  MicController({this.sampleRate = 48000});

  final int sampleRate;
  PianoDspBridge? _bridge;
  AudioRecorder? _recorder;
  StreamSubscription<Uint8List>? _pcmSub;
  Timer? _pollTimer;

  bool _isListening = false;
  bool _isRecording = false;
  MicPermissionState _permissionState = MicPermissionState.unknown;
  String? _errorMessage;
  double _noiseGateDb = -50.0;
  PitchFrame _latestFrame = PitchFrame.empty();
  final List<DetectedNoteEvent> _recentEvents = <DetectedNoteEvent>[];
  List<RecordedNote> _recordedNotes = <RecordedNote>[];

  bool get isListening => _isListening;
  bool get isRecording => _isRecording;
  MicPermissionState get permissionState => _permissionState;
  String? get errorMessage => _errorMessage;
  double get noiseGateDb => _noiseGateDb;
  PitchFrame get latestFrame => _latestFrame;
  List<DetectedNoteEvent> get recentEvents => List.unmodifiable(_recentEvents);
  List<RecordedNote> get recordedNotes => List.unmodifiable(_recordedNotes);

  void toggleRecording() {
    final bridge = _bridge;
    if (bridge == null || !_isListening) return;
    if (_isRecording) {
      bridge.stopRecording();
      _recordedNotes = bridge.getRecordedNotes();
      _isRecording = false;
    } else {
      _recordedNotes = <RecordedNote>[];
      bridge.startRecording();
      _isRecording = true;
    }
    notifyListeners();
  }

  void setNoiseGateDb(double db) {
    _noiseGateDb = db;
    _bridge?.setNoiseGateDb(db);
    notifyListeners();
  }

  Future<bool> requestPermission() async {
    if (Platform.isLinux || Platform.isWindows) {
      _permissionState = MicPermissionState.granted;
      notifyListeners();
      return true;
    }
    final status = await Permission.microphone.request();
    if (status.isGranted) {
      _permissionState = MicPermissionState.granted;
      _errorMessage = null;
      notifyListeners();
      return true;
    }
    _permissionState = status.isPermanentlyDenied
        ? MicPermissionState.permanentlyDenied
        : MicPermissionState.denied;
    _errorMessage = status.isPermanentlyDenied
        ? 'Microphone permission permanently denied. Enable it in system settings.'
        : 'Microphone permission is required to listen to your piano.';
    notifyListeners();
    return false;
  }

  Future<void> start() async {
    if (_isListening) return;
    _errorMessage = null;

    final allowed = await requestPermission();
    if (!allowed) return;

    try {
      _bridge ??= PianoDspBridge(sampleRate: sampleRate, frameSize: 4096, hopSize: 512);
      _bridge!.setNoiseGateDb(_noiseGateDb);

      if (Platform.isLinux) {
        // Use native C++ PulseAudio/PipeWire capture for lowest latency on Linux.
        final rc = _bridge!.startNativeMic(deviceId: 'default');
        if (rc != 0) {
          _errorMessage = 'Microphone error (code $rc): ${_bridge!.lastError}';
          notifyListeners();
          return;
        }
      } else {
        // Android & Windows: stream 16-bit mono PCM from device mic into C++ DSP via FFI.
        _recorder ??= AudioRecorder();
        final hasPerm = await _recorder!.hasPermission();
        if (!hasPerm) {
          _permissionState = MicPermissionState.denied;
          _errorMessage = 'Audio recorder could not acquire microphone permission.';
          notifyListeners();
          return;
        }
        final stream = await _recorder!.startStream(
          RecordConfig(
            encoder: AudioEncoder.pcm16bits,
            sampleRate: sampleRate,
            numChannels: 1,
            autoGain: false,
            echoCancel: false,
            noiseSuppress: false, // Preserve natural piano harmonics; our DSP filters noise.
          ),
        );
        _pcmSub = stream.listen(
          (bytes) {
            final samples = _pcm16BytesToFloat32(bytes);
            _bridge?.pushFloatPcm(samples);
          },
          onError: (Object err) {
            _errorMessage = 'Audio stream error: $err';
            stop();
          },
        );
      }

      _isListening = true;
      _pollTimer = Timer.periodic(const Duration(milliseconds: 30), (_) => _tick());
      notifyListeners();
    } catch (e) {
      _errorMessage = 'Failed to initialize audio engine: $e';
      _isListening = false;
      notifyListeners();
    }
  }

  void _tick() {
    final bridge = _bridge;
    if (bridge == null || !_isListening) return;

    bridge.process();
    _latestFrame = bridge.getSnapshot();

    final events = bridge.drainNoteEvents();
    if (events.isNotEmpty) {
      for (final evt in events) {
        if (evt.type == DetectedNoteEventType.noteOn) {
          _recentEvents.insert(0, evt);
          if (_recentEvents.length > 20) {
            _recentEvents.removeLast();
          }
        }
      }
    }
    notifyListeners();
  }

  Future<void> stop() async {
    _pollTimer?.cancel();
    _pollTimer = null;
    await _pcmSub?.cancel();
    _pcmSub = null;
    if (_recorder != null && await _recorder!.isRecording()) {
      await _recorder!.stop();
    }
    _bridge?.stopNativeMic();
    _isListening = false;
    notifyListeners();
  }

  static Float32List _pcm16BytesToFloat32(Uint8List bytes) {
    final count = bytes.lengthInBytes ~/ 2;
    final view = ByteData.sublistView(bytes);
    final out = Float32List(count);
    for (int i = 0; i < count; i++) {
      out[i] = view.getInt16(i * 2, Endian.little) / 32768.0;
    }
    return out;
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _pcmSub?.cancel();
    _recorder?.dispose();
    _bridge?.dispose();
    super.dispose();
  }
}
