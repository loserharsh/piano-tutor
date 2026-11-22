/**
 * Self-contained Radix-2 Cooley-Tukey FFT with precomputed Hann window.
 * Exact JS mirror of native/src/fft.cpp for consistent DSP across web and native.
 */
export class FFT {
  constructor(size) {
    if (size <= 0 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a positive power of two (got ${size})`);
    }
    this.size = size;
    this.log2Size = Math.round(Math.log2(size));
    this.bitReverse = new Int32Array(size);
    for (let i = 0; i < size; i++) {
      let rev = 0;
      let x = i;
      for (let b = 0; b < this.log2Size; b++) {
        rev = (rev << 1) | (x & 1);
        x >>= 1;
      }
      this.bitReverse[i] = rev;
    }

    this.hann = new Float32Array(size);
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < size; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos((twoPi * i) / (size - 1)));
    }
  }

  /** In-place complex FFT on separate real/imag Float32Arrays. */
  transform(re, im, inverse = false) {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.bitReverse[i];
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }

    const sign = inverse ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const angle = (sign * 2 * Math.PI) / len;
      const wStepRe = Math.cos(angle);
      const wStepIm = Math.sin(angle);

      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const idx = i + j + half;
          const vRe = re[idx] * wRe - im[idx] * wIm;
          const vIm = re[idx] * wIm + im[idx] * wRe;

          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[idx] = uRe - vRe;
          im[idx] = uIm - vIm;

          const nextWRe = wRe * wStepRe - wIm * wStepIm;
          wIm = wRe * wStepIm + wIm * wStepRe;
          wRe = nextWRe;
        }
      }
    }

    if (inverse) {
      const invN = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= invN;
        im[i] *= invN;
      }
    }
  }

  realMagnitudeSpectrum(timeDomain, outMag, applyHann = true) {
    const n = this.size;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    if (applyHann) {
      for (let i = 0; i < n; i++) re[i] = timeDomain[i] * this.hann[i];
    } else {
      re.set(timeDomain);
    }
    this.transform(re, im, false);
    const bins = (n >> 1) + 1;
    const scale = 2 / n;
    for (let k = 0; k < bins; k++) {
      outMag[k] = Math.hypot(re[k], im[k]) * scale;
    }
    return outMag;
  }
}
