import { computePianoLayout } from './piano_layout.js';

function drawRoundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export function renderFallingNotes(canvas, params) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  const {
    notes,
    noteStates,
    currentTimeSec,
    minMidi,
    maxMidi,
    pixelsPerSecond = 180,
    bpm = 100,
    waitingForMidis = [],
  } = params;
  const waitingSet = new Set(waitingForMidis);

  // Background
  ctx.fillStyle = '#0D1015';
  ctx.fillRect(0, 0, width, height);

  const layout = computePianoLayout(minMidi, maxMidi, width);

  // Subtle black-key vertical lanes
  ctx.fillStyle = '#12161E';
  for (const bk of layout.blackKeys) {
    ctx.fillRect(bk.left, 0, bk.width, height);
  }

  // Octave C vertical dividers
  ctx.strokeStyle = '#1E2530';
  ctx.lineWidth = 1;
  for (const wk of layout.whiteKeys) {
    if (wk.midi % 12 === 0) {
      ctx.beginPath();
      ctx.moveTo(wk.left + 0.5, 0);
      ctx.lineTo(wk.left + 0.5, height);
      ctx.stroke();
    }
  }

  // Horizontal beat & measure grid lines
  const beatSec = 60 / Math.max(30, Math.min(240, bpm));
  const lookaheadSec = height / pixelsPerSecond;
  const firstBeat = Math.floor(currentTimeSec / beatSec);
  const lastBeat = Math.ceil((currentTimeSec + lookaheadSec) / beatSec);

  for (let b = firstBeat; b <= lastBeat; b++) {
    if (b < 0) continue;
    const y = height - (b * beatSec - currentTimeSec) * pixelsPerSecond;
    if (y < 0 || y > height) continue;
    ctx.strokeStyle = b % 4 === 0 ? '#273140' : '#171D26';
    ctx.lineWidth = b % 4 === 0 ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Viewport-culled falling note bars
  const viewStart = currentTimeSec - 0.15;
  const viewEnd = currentTimeSec + lookaheadSec + 0.15;

  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.endSec < viewStart || n.startSec > viewEnd) continue;
    const geom = layout.keys.get(n.midiPitch);
    if (!geom) continue;

    const bottomY = height - (n.startSec - currentTimeSec) * pixelsPerSecond;
    const topY = height - (n.endSec - currentTimeSec) * pixelsPerSecond;
    const barH = Math.max(8, bottomY - topY);
    const barTop = bottomY - barH;
    const inset = geom.isBlack ? 1 : 2;
    const barW = Math.max(4, geom.width - inset * 2);

    const state = noteStates ? noteStates[i] : 'upcoming';
    let fill;
    if (state === 'correct') {
      fill = '#22C55E';
    } else if (state === 'missed') {
      fill = '#475569';
    } else if (n.hand === 'left') {
      fill = geom.isBlack ? '#D97706' : '#F59E0B';
    } else {
      fill = geom.isBlack ? '#14B8A6' : '#2DD4BF';
    }

    drawRoundedRect(ctx, geom.left + inset, barTop, barW, barH, 4);
    ctx.fillStyle = fill;
    ctx.fill();

    if (state === 'active' || (waitingSet.has(n.midiPitch) && Math.abs(n.startSec - currentTimeSec) < 0.06)) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.75;
      ctx.stroke();
    }

    if (barH >= 20 && barW >= 18) {
      ctx.fillStyle = state === 'missed' ? '#E2E8F0' : '#090D12';
      ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(geom.label, geom.left + geom.width / 2, bottomY - 4);
    }
  }

  // Crisp strike line right above the keyboard
  ctx.fillStyle = waitingSet.size > 0 ? '#F59E0B' : '#38BDF8';
  ctx.fillRect(0, height - 2, width, 2);

  if (waitingSet.size > 0) {
    const labels = Array.from(waitingSet)
      .sort((a, b) => a - b)
      .map((m) => layout.keys.get(m)?.label || `MIDI ${m}`)
      .join(' + ');
    const text = `Waiting for: ${labels}`;
    const boxW = Math.max(210, text.length * 8 + 28);
    ctx.fillStyle = 'rgba(20, 25, 34, 0.92)';
    drawRoundedRect(ctx, width / 2 - boxW / 2, height - 42, boxW, 28, 6);
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#FCD34D';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height - 28);
  }

  ctx.restore();
}
