// Karaoke Wolf microphone + pitch detection (YIN algorithm).

(function () {
  'use strict';

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiName(m) {
    const r = Math.round(m);
    return NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
  }

  // Returns { freq, clarity } for a voiced frame, or null.
  function yin(buf, sr, threshold = 0.15) {
    const minLag = Math.floor(sr / 1100);
    const maxLag = Math.min(Math.floor(sr / 65), buf.length >> 1);
    const W = buf.length - maxLag;
    const d = new Float32Array(maxLag + 1);
    for (let tau = 1; tau <= maxLag; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const x = buf[j] - buf[j + tau];
        s += x * x;
      }
      d[tau] = s;
    }
    d[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxLag; tau++) {
      run += d[tau];
      d[tau] = run ? (d[tau] * tau) / run : 1;
    }
    let tau = -1;
    for (let t = minLag; t <= maxLag; t++) {
      if (d[t] < threshold) {
        while (t + 1 <= maxLag && d[t + 1] < d[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) return null;
    const x0 = d[tau - 1];
    const x1 = d[tau];
    const x2 = tau + 1 <= maxLag ? d[tau + 1] : x1;
    const denom = x0 + x2 - 2 * x1;
    const shift = denom ? (x0 - x2) / (2 * denom) : 0;
    return { freq: sr / (tau + shift), clarity: 1 - x1 };
  }

  class Mic {
    constructor(engine) {
      this.engine = engine;
      this.on = false;
      this.level = 0;
      this.history = [];
      this.monitor = null;
    }

    async enable(opts = {}) {
      const ctx = this.engine.ensure();
      if (this.on) return true;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: !opts.headphones,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      this.source = ctx.createMediaStreamSource(this.stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.buf = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      this.on = true;
      this.setEcho(!!opts.echo);
      return true;
    }

    disable() {
      if (!this.on) return;
      this.setEcho(false);
      this.stream.getTracks().forEach((t) => t.stop());
      this.source.disconnect();
      this.on = false;
      this.level = 0;
      this.history = [];
    }

    // "Echo Wolf": hear yourself with a slap-back echo + reverb (headphones!).
    setEcho(on) {
      const e = this.engine;
      if (!this.on) return;
      if (on && !this.monitor) {
        const ctx = e.ctx;
        const g = ctx.createGain();
        g.gain.value = 0.8;
        const delay = ctx.createDelay(1);
        delay.delayTime.value = 0.16;
        const fb = ctx.createGain();
        fb.gain.value = 0.28;
        this.source.connect(g);
        g.connect(e.musicBus);
        g.connect(delay);
        delay.connect(fb).connect(delay);
        delay.connect(e.musicBus);
        g.connect(e.reverb);
        this.monitor = { g, delay, fb };
      } else if (!on && this.monitor) {
        const { g, delay, fb } = this.monitor;
        try { this.source.disconnect(g); } catch (err) { /* not connected */ }
        g.disconnect();
        delay.disconnect();
        fb.disconnect();
        this.monitor = null;
      }
    }

    // Reads the current pitch. Returns { midi, freq, clarity } or null.
    read() {
      if (!this.on) return null;
      this.analyser.getFloatTimeDomainData(this.buf);
      let rms = 0;
      for (let i = 0; i < this.buf.length; i++) rms += this.buf[i] * this.buf[i];
      rms = Math.sqrt(rms / this.buf.length);
      this.level = this.level * 0.7 + Math.min(1, rms * 6) * 0.3;
      if (rms < 0.012) {
        this.history = [];
        return null;
      }
      const r = yin(this.buf, this.engine.ctx.sampleRate);
      if (!r || r.freq < 65 || r.freq > 1100) {
        this.history = [];
        return null;
      }
      const midi = 69 + 12 * Math.log2(r.freq / 440);
      // A median of the last three readings removes the odd octave glitch.
      this.history.push(midi);
      if (this.history.length > 3) this.history.shift();
      const sorted = this.history.slice().sort((a, b) => a - b);
      const smooth = sorted[Math.floor(sorted.length / 2)];
      return { midi: smooth, freq: r.freq, clarity: r.clarity };
    }
  }

  window.KWPitch = { Mic, yin, midiName, NOTE_NAMES };
})();
