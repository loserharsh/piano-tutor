export function renderSpectrum(canvas, bins) {
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

  ctx.fillStyle = '#0D1015';
  ctx.fillRect(0, 0, width, height);

  if (bins && bins.length > 0) {
    const barW = width / bins.length;
    ctx.fillStyle = '#2DD4BF';
    for (let i = 0; i < bins.length; i++) {
      const h = Math.max(0, Math.min(1, bins[i])) * (height - 8);
      ctx.fillRect(i * barW + 1, height - h, Math.max(1, barW - 2), h);
    }
  }

  ctx.restore();
}
