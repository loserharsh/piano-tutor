/**
 * Annotated real-time FFT spectrum visualizer for the Audio Recognition Debugger.
 *
 * Displays:
 *  - Horizontal frequency axis (log 27.5–4500 Hz, or linear 20–500 Hz Low-Freq Zoom)
 *  - Vertical amplitude axis (-75 dB to -10 dB)
 *  - Highlighted detected FFT spectral peaks
 *  - Highlighted estimated fundamental (f0, teal line)
 *  - Highlighted harmonic series (H2..H5, amber dashed lines)
 */
export function renderSpectrum(canvas, dataOrBins) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;

  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  const opts = Array.isArray(dataOrBins) || dataOrBins instanceof Float32Array
    ? { bins: dataOrBins, lowZoom: false, fundamentalHz: 0, peaks: [] }
    : (dataOrBins || { bins: [], lowZoom: false, fundamentalHz: 0, peaks: [] });

  const { bins, lowZoom = false, fundamentalHz = 0, peaks = [] } = opts;

  const padL = 36;
  const padR = 10;
  const padT = 18;
  const padB = 22;
  const plotW = Math.max(10, width - padL - padR);
  const plotH = Math.max(10, height - padT - padB);

  const fMin = lowZoom ? 20.0 : 27.5;
  const fMax = lowZoom ? 500.0 : 4500.0;
  const logRatio = Math.log(fMax / fMin);

  const freqToX = (hz) => {
    if (hz < fMin || hz > fMax) return -1;
    const norm = lowZoom
      ? (hz - fMin) / (fMax - fMin)
      : Math.log(hz / fMin) / logRatio;
    return padL + norm * plotW;
  };

  const dbToY = (db) => {
    const norm = Math.max(0, Math.min(1, (db + 75) / 65));
    return padT + (1 - norm) * plotH;
  };

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#0D1015';
  ctx.fillRect(0, 0, width, height);

  // Horizontal amplitude grid lines (-20, -40, -60 dB)
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  for (const db of [-20, -40, -60]) {
    const y = dbToY(db);
    ctx.strokeStyle = '#1B222E';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillStyle = '#64748B';
    ctx.fillText(`${db}`, padL - 5, y);
  }

  // Vertical frequency axis ticks
  const ticks = lowZoom
    ? [27.5, 65, 100, 150, 200, 262, 350, 440, 500]
    : [27.5, 65, 130, 262, 523, 1000, 2000, 4186];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const f of ticks) {
    const x = freqToX(f);
    if (x < padL || x > padL + plotW) continue;
    ctx.strokeStyle = '#1B222E';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = '#64748B';
    const lbl = f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
    ctx.fillText(lbl, x, padT + plotH + 5);
  }

  // Draw spectrum bars
  if (bins && bins.length > 0) {
    const barW = plotW / bins.length;
    ctx.fillStyle = 'rgba(45, 212, 191, 0.45)';
    for (let i = 0; i < bins.length; i++) {
      const h = Math.max(0, Math.min(1, bins[i])) * plotH;
      ctx.fillRect(padL + i * barW + 0.5, padT + plotH - h, Math.max(1, barW - 1.5), h);
    }
  }

  // Highlight harmonic frequencies (H2..H5, amber dashed vertical lines)
  if (fundamentalHz > 20) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.25;
    for (let h = 2; h <= 5; h++) {
      const x = freqToX(fundamentalHz * h);
      if (x < padL || x > padL + plotW) continue;
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = '#F59E0B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`H${h}`, x, padT - 2);
    }
    ctx.restore();

    // Highlight estimated fundamental f0 (crisp teal vertical line)
    const x0 = freqToX(fundamentalHz);
    if (x0 >= padL && x0 <= padL + plotW) {
      ctx.strokeStyle = '#2DD4BF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x0, padT);
      ctx.lineTo(x0, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = '#2DD4BF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`f0 ${fundamentalHz.toFixed(0)}Hz`, Math.max(padL + 30, Math.min(padL + plotW - 30, x0)), padT - 2);
    }
  }

  // Highlight actual detected spectral peaks (dots + Hz)
  if (peaks && peaks.length > 0) {
    for (const p of peaks) {
      const x = freqToX(p.frequencyHz);
      if (x < padL || x > padL + plotW) continue;
      const y = dbToY(p.magnitudeDb);
      ctx.fillStyle = '#F8FAFC';
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Axis frame
  ctx.strokeStyle = '#263040';
  ctx.lineWidth = 1;
  ctx.strokeRect(padL, padT, plotW, plotH);

  ctx.restore();
}
