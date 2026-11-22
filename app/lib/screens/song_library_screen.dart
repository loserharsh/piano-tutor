import 'package:flutter/material.dart';
import '../importers/builtin_lessons.dart';
import '../importers/midi_song_parser.dart';
import '../models/song_model.dart';
import 'pitch_detector_screen.dart';
import 'practice_screen.dart';

/// Milestone 3 Song Library & Navigation Hub.
/// Loads built-in beginner lessons and Standard MIDI Files (as SONG DATA ONLY)
/// into the unified [SongModel] for [PracticeScreen].
class SongLibraryScreen extends StatefulWidget {
  const SongLibraryScreen({super.key});

  @override
  State<SongLibraryScreen> createState() => _SongLibraryScreenState();
}

class _SongLibraryScreenState extends State<SongLibraryScreen> {
  final List<SongModel> _songs = BuiltinLessons.all();

  Future<void> _promptImportMidiFile() async {
    final controller = TextEditingController();
    final path = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Import MIDI Song File (Song Data Only)'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(
            labelText: 'Path to .mid / .midi file',
            hintText: '/path/to/song.mid',
          ),
          autofocus: true,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Import'),
          ),
        ],
      ),
    );
    if (path == null || path.isEmpty) return;

    try {
      final song = await MidiSongParser.parseFile(path);
      if (!mounted) return;
      setState(() => _songs.insert(0, song));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Loaded "${song.title}" (${song.notes.length} notes)')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Failed to parse MIDI file: $e'), backgroundColor: Colors.redAccent),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('PianoTutor — Song Library'),
        actions: [
          TextButton.icon(
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => const PitchDetectorScreen()),
            ),
            icon: const Icon(Icons.mic),
            label: const Text('Mic Tester'),
          ),
          const SizedBox(width: 8),
          FilledButton.icon(
            onPressed: _promptImportMidiFile,
            icon: const Icon(Icons.file_open),
            label: const Text('Import .mid'),
          ),
          const SizedBox(width: 12),
        ],
      ),
      body: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _songs.length,
        separatorBuilder: (_, __) => const SizedBox(height: 8),
        itemBuilder: (context, idx) {
          final song = _songs[idx];
          final bpm = song.tempoMap.isNotEmpty ? song.tempoMap.first.bpm.round() : 100;
          final hasLeft = song.notes.any((n) => n.hand == PianoHand.left);
          return Card(
            child: ListTile(
              title: Text(song.title, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text(
                '${song.composer} · ${song.notes.length} notes · $bpm BPM · ${hasLeft ? "Both Hands" : "Right Hand"}',
              ),
              trailing: FilledButton(
                onPressed: () => Navigator.push(
                  context,
                  MaterialPageRoute(builder: (_) => PracticeScreen(song: song)),
                ),
                child: const Text('Practice'),
              ),
            ),
          );
        },
      ),
    );
  }
}
