/**
 * Direct-Form-II Transposed Butterworth Biquad filter (High-Pass / Low-Pass).
 * Applied continuously per incoming hop to avoid overlap discontinuities.
 */
export class BiquadFilter {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }

  configureHighpass(sampleRate, cutoffHz, q = 0.70710678) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cosW0) * 0.5) / a0;
    this.b1 = -(1 + cosW0) / a0;
    this.b2 = ((1 + cosW0) * 0.5) / a0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.reset();
  }

  configureLowpass(sampleRate, cutoffHz, q = 0.70710678) {
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosW0 = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cosW0) * 0.5) / a0;
    this.b1 = (1 - cosW0) / a0;
    this.b2 = ((1 - cosW0) * 0.5) / a0;
    this.a1 = (-2 * cosW0) / a0;
    this.a2 = (1 - alpha) / a0;
    this.reset();
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }

  processBlock(samples) {
    let { b0, b1, b2, a1, a2, z1, z2 } = this;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      samples[i] = y;
    }
    this.z1 = z1;
    this.z2 = z2;
  }
}
