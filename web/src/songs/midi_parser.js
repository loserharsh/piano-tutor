/**
 * Standard MIDI File (SMF Type 0 & Type 1) parser — SONG DATA ONLY.
 * Extracts expected notes, velocities, timings, tempo changes, measures, and hand assignments.
 * Never uses MIDI hardware or MIDI keyboard input.
 */
export function parseMidiSong(arrayBuffer, fallbackTitle = 'Imported MIDI') {
  const data = new Uint8Array(arrayBuffer);
  if (data.length < 14 || data[0] !== 0x4d || data[1] !== 0x54 || data[2] !== 0x68 || data[3] !== 0x64) {
    throw new Error('Invalid MIDI file: missing MThd header.');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hdrLen = view.getUint32(4, false);
  const format = view.getUint16(8, false);
  const numTracks = view.getUint16(10, false);
  const division = view.getUint16(12, false);

  if (format > 1) throw new Error(`Unsupported MIDI format ${format} (only Format 0 and 1 supported).`);
  if ((division & 0x8000) !== 0 || division === 0) {
    throw new Error('SMPTE timecode MIDI division is not supported.');
  }

  const tpq = division;
  let title = fallbackTitle;
  let timeSigNum = 4;
  let timeSigDen = 4;
  let keySigFifths = 0;

  const rawTempos = [{ tick: 0, usec: 500000 }];
  const rawNotes = [];
  const noteTrackSet = new Set();

  const readVlq = (pos, end) => {
    let val = 0;
    for (let i = 0; i < 4; i++) {
      if (pos >= end) return null;
      const b = data[pos++];
      val = (val << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return { val, next: pos };
    }
    return null;
  };

  let pos = 8 + hdrLen;
  for (let trk = 0; trk < numTracks && pos + 8 <= data.length; trk++) {
    if (data[pos] !== 0x4d || data[pos + 1] !== 0x54 || data[pos + 2] !== 0x72 || data[pos + 3] !== 0x6b) {
      throw new Error(`Expected MTrk chunk at offset ${pos}`);
    }
    const trkLen = view.getUint32(pos + 4, false);
    pos += 8;
    const trkEnd = Math.min(data.length, pos + trkLen);

    let absTick = 0;
    let runningStatus = 0;
    let trackName = '';
    const openNotes = new Map();

    while (pos < trkEnd) {
      const vlq = readVlq(pos, trkEnd);
      if (!vlq) break;
      absTick += vlq.val;
      pos = vlq.next;
      if (pos >= trkEnd) break;

      let status = data[pos];
      if ((status & 0x80) !== 0) {
        pos++;
        if (status < 0xf0) runningStatus = status;
      } else {
        if (runningStatus === 0) break;
        status = runningStatus;
      }

      if (status === 0xff) {
        if (pos >= trkEnd) break;
        const metaType = data[pos++];
        const lenRes = readVlq(pos, trkEnd);
        if (!lenRes) break;
        pos = lenRes.next;
        const metaLen = lenRes.val;
        if (pos + metaLen > trkEnd) break;

        if (metaType === 0x03 && metaLen > 0) {
          trackName = new TextDecoder().decode(data.subarray(pos, pos + metaLen)).trim();
          if (trk === 0 && trackName) title = trackName;
        } else if (metaType === 0x51 && metaLen === 3) {
          const usec = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
          if (usec > 0) rawTempos.push({ tick: absTick, usec });
        } else if (metaType === 0x58 && metaLen >= 2) {
          timeSigNum = data[pos];
          timeSigDen = 1 << data[pos + 1];
        } else if (metaType === 0x59 && metaLen >= 1) {
          keySigFifths = view.getInt8(pos);
        } else if (metaType === 0x2f) {
          pos = trkEnd;
          break;
        }
        pos += metaLen;
      } else if (status === 0xf0 || status === 0xf7) {
        const lenRes = readVlq(pos, trkEnd);
        if (!lenRes) break;
        pos = Math.min(trkEnd, lenRes.next + lenRes.val);
      } else {
        const cmd = status & 0xf0;
        const ch = status & 0x0f;
        if (cmd === 0xc0 || cmd === 0xd0) {
          if (pos < trkEnd) pos++;
        } else if (cmd === 0x80 || cmd === 0x90 || cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) {
          if (pos + 2 > trkEnd) break;
          const d1 = data[pos++];
          const d2 = data[pos++];
          if (ch !== 9 && (cmd === 0x90 || cmd === 0x80)) {
            const key = (ch << 8) | d1;
            const isNoteOn = cmd === 0x90 && d2 > 0;
            if (isNoteOn) {
              if (!openNotes.has(key)) openNotes.set(key, []);
              openNotes.get(key).push({ startTick: absTick, velocity: d2 / 127 });
            } else {
              const list = openNotes.get(key);
              if (list && list.length > 0) {
                const open = list.shift();
                if (absTick > open.startTick) {
                  rawNotes.push({
                    midiPitch: d1,
                    startTick: open.startTick,
                    endTick: absTick,
                    velocity: open.velocity,
                    trackIndex: trk,
                    trackName,
                  });
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

  rawTempos.sort((a, b) => a.tick - b.tick);
  const mergedTempos = [];
  for (const rt of rawTempos) {
    if (mergedTempos.length > 0 && mergedTempos[mergedTempos.length - 1].tick === rt.tick) {
      mergedTempos[mergedTempos.length - 1] = rt;
    } else {
      mergedTempos.push(rt);
    }
  }

  const tempoPoints = [];
  let accumSec = 0;
  let prevTick = 0;
  let prevUsec = 500000;
  for (const rt of mergedTempos) {
    accumSec += (rt.tick - prevTick) * ((prevUsec * 1e-6) / tpq);
    tempoPoints.push({ tick: rt.tick, timeSec: accumSec, usec: rt.usec, bpm: 60000000 / rt.usec });
    prevTick = rt.tick;
    prevUsec = rt.usec;
  }

  const tickToSec = (tick) => {
    let active = tempoPoints[0];
    for (let i = 1; i < tempoPoints.length; i++) {
      if (tempoPoints[i].tick <= tick) active = tempoPoints[i];
      else break;
    }
    return active.timeSec + (tick - active.tick) * ((active.usec * 1e-6) / tpq);
  };

  const sortedTracks = Array.from(noteTrackSet).sort((a, b) => a - b);
  const compactMap = new Map(sortedTracks.map((t, i) => [t, i]));
  const beatsPerMeasure = timeSigNum * (4 / timeSigDen);
  const ticksPerMeasure = Math.max(1, beatsPerMeasure * tpq);

  const inferHand = (name, compactTrk, pitch) => {
    const l = name.toLowerCase();
    if (l.includes('right') || l.includes('rh') || l.includes('treble')) return 'right';
    if (l.includes('left') || l.includes('lh') || l.includes('bass')) return 'left';
    if (sortedTracks.length === 2) return compactTrk === 0 ? 'right' : 'left';
    return pitch >= 60 ? 'right' : 'left';
  };

  const notes = rawNotes
    .map((rn) => {
      const startSec = tickToSec(rn.startTick);
      const endSec = tickToSec(rn.endTick);
      const compactTrk = compactMap.get(rn.trackIndex) ?? 0;
      return {
        midiPitch: rn.midiPitch,
        startSec,
        durationSec: Math.max(0.02, endSec - startSec),
        endSec: Math.max(startSec + 0.02, endSec),
        velocity: rn.velocity,
        trackIndex: compactTrk,
        hand: inferHand(rn.trackName, compactTrk, rn.midiPitch),
        measureNumber: Math.floor(rn.startTick / ticksPerMeasure) + 1,
        confidence: 1.0,
      };
    })
    .sort((a, b) => (Math.abs(a.startSec - b.startSec) > 1e-6 ? a.startSec - b.startSec : a.midiPitch - b.midiPitch));

  const totalDurationSec = notes.reduce((m, n) => Math.max(m, n.endSec), 0);

  return {
    id: `midi_${Date.now()}`,
    title,
    composer: 'Imported MIDI (Song Data)',
    sourceFormat: 'midi',
    bpm: Math.round(tempoPoints[0]?.bpm || 120),
    timeSignatureNumerator: timeSigNum,
    timeSignatureDenominator: timeSigDen,
    keySignatureFifths: keySigFifths,
    tempoMap: tempoPoints,
    notes,
    totalDurationSec,
  };
}
