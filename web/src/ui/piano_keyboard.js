import { computePianoLayout } from './piano_layout.js';

function keyFill(state, isBlack) {
  switch (state) {
    case 'expectedRight':
      return isBlack ? '#0F766E' : '#2DD4BF';
    case 'expectedLeft':
      return isBlack ? '#B45309' : '#F59E0B';
    case 'correct':
      return isBlack ? '#15803D' : '#22C55E';
    case 'wrong':
      return isBlack ? '#B91C1C' : '#EF4444';
    case 'detected':
      return isBlack ? '#0369A1' : '#38BDF8';
    default:
      return isBlack ? '#171A20' : '#F8FAFC';
  }
}

export function renderPianoKeyboard(canvas, { minMidi, maxMidi, keyStates }) {
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

  const layout = computePianoLayout(minMidi, maxMidi, width);

  // 1. White keys
  for (const k of layout.whiteKeys) {
    const state = keyStates.get(k.midi) || 'idle';
    ctx.fillStyle = keyFill(state, false);
    ctx.fillRect(k.left, 0, k.width, height);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(k.left + 0.5, 0.5, k.width - 1, height - 1);

    if (k.midi % 12 === 0 && k.width >= 13) {
      ctx.fillStyle = state === 'idle' ? '#475569' : '#090D12';
      ctx.font = `600 ${k.width >= 22 ? 11 : 9}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(k.label, k.left + k.width / 2, height - 6);
    }
  }

  // 2. Black keys
  const blackH = height * 0.62;
  for (const k of layout.blackKeys) {
    const state = keyStates.get(k.midi) || 'idle';
    ctx.fillStyle = keyFill(state, true);
    ctx.fillRect(k.left, 0, k.width, blackH);
    ctx.strokeStyle = '#090B0E';
    ctx.lineWidth = 1;
    ctx.strokeRect(k.left + 0.5, 0.5, k.width - 1, blackH - 1);
  }

  // Top keybed seam
  ctx.fillStyle = '#090C10';
  ctx.fillRect(0, 0, width, 2);

  ctx.restore();
}
