const SETTINGS_KEY = 'pianotutor_settings_v1';
const PROGRESS_KEY = 'pianotutor_progress_v1';
const CUSTOM_SONGS_KEY = 'pianotutor_custom_songs_v1';

/**
 * Local persistence layer for user calibration/settings, per-song learning progress,
 * session history, and imported songs. Works with browser localStorage or an injected
 * in-memory storage mock (for Node.js unit tests).
 */
export class ProgressStore {
  constructor(storage = null) {
    this.storage = storage || (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null);
  }

  loadSettings(defaults) {
    if (!this.storage) return { ...defaults };
    try {
      const raw = this.storage.getItem(SETTINGS_KEY);
      if (!raw) return { ...defaults };
      return { ...defaults, ...JSON.parse(raw) };
    } catch {
      return { ...defaults };
    }
  }

  saveSettings(settings) {
    if (!this.storage) return;
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Ignore quota errors
    }
  }

  loadProgress() {
    const empty = { bySong: {}, recentSessions: [] };
    if (!this.storage) return empty;
    try {
      const raw = this.storage.getItem(PROGRESS_KEY);
      if (!raw) return empty;
      const parsed = JSON.parse(raw);
      return {
        bySong: parsed.bySong || {},
        recentSessions: Array.isArray(parsed.recentSessions) ? parsed.recentSessions : [],
      };
    } catch {
      return empty;
    }
  }

  recordSession({ songId, songTitle, accuracyPct, f1Score, correctCount, totalNotes, meanAbsTimingMs, handFilter, tempoScale }) {
    const data = this.loadProgress();
    const prev = data.bySong[songId] || {
      plays: 0,
      bestAccuracyPct: 0,
      bestF1: 0,
      lastPlayedAt: null,
    };

    const nowIso = new Date().toISOString();
    data.bySong[songId] = {
      plays: prev.plays + 1,
      bestAccuracyPct: Math.max(prev.bestAccuracyPct, accuracyPct),
      bestF1: Math.max(prev.bestF1, f1Score),
      lastPlayedAt: nowIso,
    };

    data.recentSessions.unshift({
      songId,
      songTitle,
      accuracyPct: Math.round(accuracyPct * 10) / 10,
      f1Score: Math.round(f1Score * 100) / 100,
      correctCount,
      totalNotes,
      meanAbsTimingMs: Math.round(meanAbsTimingMs),
      handFilter,
      tempoPct: Math.round(tempoScale * 100),
      playedAt: nowIso,
    });
    if (data.recentSessions.length > 30) {
      data.recentSessions.length = 30;
    }

    if (this.storage) {
      try {
        this.storage.setItem(PROGRESS_KEY, JSON.stringify(data));
      } catch {
        // Ignore quota errors
      }
    }
    return data;
  }

  loadCustomSongs() {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(CUSTOM_SONGS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveCustomSongs(songs) {
    if (!this.storage) return;
    try {
      const customOnly = songs.filter((s) => s.sourceFormat !== 'builtin').slice(0, 25);
      this.storage.setItem(CUSTOM_SONGS_KEY, JSON.stringify(customOnly));
    } catch {
      // Ignore quota errors
    }
  }
}
