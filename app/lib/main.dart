import 'package:flutter/material.dart';
import 'screens/song_library_screen.dart';

void main() {
  runApp(const PianoTutorApp());
}

class PianoTutorApp extends StatelessWidget {
  const PianoTutorApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PianoTutor',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.teal,
          brightness: Brightness.dark,
        ),
      ),
      home: const SongLibraryScreen(),
    );
  }
}
