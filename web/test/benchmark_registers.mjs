import { AudioPipeline } from '../src/dsp/audio_engine.js';
import { midiToHz, midiToNoteName } from '../src/dsp/yin.js';
import { BiquadFilter } from '../src/dsp/biquad.js';

/**
 * Physically-informed acoustic piano note generator with optional smartphone-mic
 * bass rolloff (simulating real missing/weak fundamental on low piano keys).
 */
function synthRealisticPiano(midi, sampleRate, durationSec, {
  phoneMicRolloff = false,
  dominantSecondHarmonic = false,
  noiseRms = 0.002,
} = {}) {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  // Real piano string inharmonicity B increases toward treble and very low bass
  const B = midi < 36 ? 0.00025 : (midi < 48 ? 0.00018 : (midi < 72 ? 0.00038 : 0.0012));
  const numPartials = f0 > 1500 ? 3 : (midi < 48 ? 10 : 8);

  let seed = 9001 + midi * 31;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const attack = Math.min(1, t / 0.004);
    let sample = 0;
    for (let h = 1; h <= numPartials; h++) {
      const fn = h * f0 * Math.sqrt(1 + B * h * h);
      if (fn >= sampleRate * 0.45) break;

      // Realistic acoustic piano bass harmonic profile: H2 and H3 dominate over H1 on low keys!
      let amp = 1 / Math.pow(h, 0.78);
      if (midi < 48) {
        if (dominantSecondHarmonic) {
          if (h === 1) amp *= 0.03;       // Nearly missing fundamental (-30 dB)
          else if (h === 2) amp *= 2.40;  // Dominant 2nd harmonic
          else if (h === 3) amp *= 0.55;  // Modest 3rd harmonic
          else if (h === 4) amp *= 1.10;  // Strong 4th harmonic (2nd of H2!)
        } else {
          if (h === 1) amp *= 0.18;       // Weak acoustic bass fundamental (-15 dB)
          else if (h === 2) amp *= 1.35;  // Strong 2nd harmonic
          else if (h === 3) amp *= 1.15;  // Strong 3rd harmonic
        }
      }
      const decay = Math.exp(-t * (1.1 + 0.55 * h));
      sample += amp * decay * Math.sin(2 * Math.PI * fn * t);
    }
    // Broadband wooden/felt hammer strike transient (first 20 ms)
    const hammer = 0.35 * Math.exp(-t / 0.006) * rand();
    out[i] = 0.65 * attack * (sample * 0.42 + hammer) + noiseRms * rand();
  }

  // Optional smartphone microphone low-frequency rolloff (2nd-order HP at 95 Hz)
  if (phoneMicRolloff) {
    const micHp = new BiquadFilter();
    micHp.configureHighpass(sampleRate, 95.0, 0.707);
    micHp.processBlock(out);
  }

  return out;
}

const REGISTERS = {
  low: [21, 24, 28, 31, 33, 36, 40, 43, 45, 47],      // A0 .. B2 (10 notes)
  mid: [48, 52, 55, 57, 60, 64, 67, 69, 72, 76, 79, 83], // C3 .. B5 (12 notes)
  high: [84, 88, 91, 93, 96, 100, 103, 105, 108],     // C6 .. C8 (9 notes)
};

function evaluateMode(mode, sampleRate, opts) {
  const summary = {};
  for (const [regName, midis] of Object.entries(REGISTERS)) {
    let exact = 0;
    let octaveErrors = 0;
    let wrongOther = 0;
    let misses = 0;
    const failures = [];

    for (const midi of midis) {
      const pipe = new AudioPipeline({ mode, sampleRate, hopSize: 512 });
      const audio = synthRealisticPiano(midi, sampleRate, 0.55, opts);
      pipe.pushSamples(audio);
      const snap = pipe.latestSnapshot;

      if (!snap.hasPitch || snap.midiNote === -1) {
        misses++;
        failures.push(`${midiToNoteName(midi)}->NONE`);
      } else if (snap.midiNote === midi) {
        exact++;
      } else if (Math.abs(snap.midiNote - midi) % 12 === 0) {
        octaveErrors++;
        failures.push(`${midiToNoteName(midi)}->${midiToNoteName(snap.midiNote)}(oct)`);
      } else {
        wrongOther++;
        failures.push(`${midiToNoteName(midi)}->${midiToNoteName(snap.midiNote)}`);
      }
    }

    summary[regName] = {
      total: midis.length,
      exact,
      accuracyPct: ((exact / midis.length) * 100).toFixed(1),
      octaveErrors,
      wrongOther,
      misses,
      failures,
    };
  }
  return summary;
}

const label = process.argv[2] || 'BENCHMARK';
console.log(`\n=== ${label} (48 kHz Realistic Piano Acoustic Benchmark) ===`);
for (const [scenario, opts] of [
  ['Acoustic Piano (Weak Bass Fundamental)', { phoneMicRolloff: false, dominantSecondHarmonic: false }],
  ['Phone Mic Piano (95 Hz Bass Rolloff)', { phoneMicRolloff: true, dominantSecondHarmonic: false }],
  ['Dominant 2nd Harmonic / Missing Fundamental Bass', { phoneMicRolloff: true, dominantSecondHarmonic: true }],
]) {
  console.log(`\nScenario: ${scenario}`);
  for (const mode of ['monophonic', 'polyphonic']) {
    const res = evaluateMode(mode, 48000, opts);
    console.log(`  Mode: ${mode}`);
    for (const [reg, r] of Object.entries(res)) {
      const failStr = r.failures.length ? ` | fails: ${r.failures.join(', ')}` : '';
      console.log(
        `    ${reg.padEnd(4)}: ${r.exact}/${r.total} (${r.accuracyPct}%) | octErr=${r.octaveErrors} | otherErr=${r.wrongOther} | miss=${r.misses}${failStr}`,
      );
    }
  }
}
