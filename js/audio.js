// Karaoke Wolf audio: a tiny Web Audio synth for the backing band,
// the guide melody and the soundboard. No samples, everything is generated.

(function () {
  'use strict';

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  class Engine {
    constructor() {
      this.ctx = null;
      this.live = new Set();
    }

    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = (this.ctx = new AC());
        this.master = ctx.createGain();
        this.master.gain.value = 0.9;
        this.comp = ctx.createDynamicsCompressor();
        this.comp.threshold.value = -14;
        this.comp.ratio.value = 4;
        this.master.connect(this.comp).connect(ctx.destination);

        // Everything musical goes through musicBus so it can also be recorded.
        this.musicBus = ctx.createGain();
        this.musicBus.connect(this.master);
        this.guideGain = ctx.createGain();
        this.backingGain = ctx.createGain();
        this.sfxGain = ctx.createGain();
        this.guideGain.connect(this.musicBus);
        this.backingGain.connect(this.musicBus);
        this.sfxGain.connect(this.musicBus);

        this.reverb = ctx.createConvolver();
        this.reverb.buffer = this._impulse(2.2, 2.5);
        this.reverbGain = ctx.createGain();
        this.reverbGain.gain.value = 0.22;
        this.reverb.connect(this.reverbGain).connect(this.musicBus);

        this.noise = this._noiseBuffer();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    get now() {
      return this.ctx ? this.ctx.currentTime : 0;
    }

    setGuideVolume(v) { if (this.ctx) this.guideGain.gain.setTargetAtTime(v, this.now, 0.03); }
    setBackingVolume(v) { if (this.ctx) this.backingGain.gain.setTargetAtTime(v, this.now, 0.03); }

    _impulse(seconds, decay) {
      const ctx = this.ctx;
      const len = Math.floor(ctx.sampleRate * seconds);
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    _noiseBuffer() {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    _track(node, stopAt) {
      this.live.add(node);
      node.onended = () => this.live.delete(node);
      node.start(node._startAt || this.now);
      node.stop(stopAt);
    }

    // Stops every scheduled note (used for pause and seek).
    stopAll() {
      for (const n of this.live) {
        try { n.stop(0); } catch (e) { /* already stopped */ }
      }
      this.live.clear();
    }

    _env(t, dur, peak, attack = 0.01, release = 0.08) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.setValueAtTime(peak, Math.max(t + attack, t + dur - release));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
      return g;
    }

    _osc(type, freq, t) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      o._startAt = t;
      return o;
    }

    // ---- band instruments ----

    guide(midi, t, dur, out = this.guideGain) {
      const ctx = this.ctx;
      const f = mtof(midi);
      const env = this._env(t, dur, 0.22, 0.02, 0.06);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      const a = this._osc('triangle', f, t);
      const b = this._osc('sine', f * 2, t);
      const bg = ctx.createGain();
      bg.gain.value = 0.25;
      if (dur > 0.45) {
        // gentle vibrato on long notes, like a real singer
        const lfo = this._osc('sine', 5.5, t);
        const depth = ctx.createGain();
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.5, dur));
        lfo.connect(depth);
        depth.connect(a.frequency);
        depth.connect(b.frequency);
        this._track(lfo, t + dur + 0.2);
      }
      a.connect(env);
      b.connect(bg).connect(env);
      env.connect(lp);
      lp.connect(out);
      lp.connect(this.reverb);
      this._track(a, t + dur + 0.2);
      this._track(b, t + dur + 0.2);
    }

    bass(midi, t, dur) {
      const ctx = this.ctx;
      const env = this._env(t, dur, 0.35, 0.005, 0.05);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, t);
      lp.frequency.exponentialRampToValueAtTime(220, t + Math.min(dur, 0.4));
      const o = this._osc('sawtooth', mtof(midi), t);
      o.connect(lp).connect(env).connect(this.backingGain);
      this._track(o, t + dur + 0.15);
    }

    pad(midis, t, dur) {
      const ctx = this.ctx;
      const env = this._env(t, dur, 0.06, 0.08, 0.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      env.connect(lp);
      lp.connect(this.backingGain);
      lp.connect(this.reverb);
      for (const m of midis) {
        for (const det of [-6, 6]) {
          const o = this._osc('sawtooth', mtof(m), t);
          o.detune.value = det;
          o.connect(env);
          this._track(o, t + dur + 0.3);
        }
      }
    }

    pluck(midi, t, vel = 0.12) {
      const env = this._env(t, 0.18, vel, 0.003, 0.15);
      const o = this._osc('square', mtof(midi), t);
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      o.connect(lp).connect(env).connect(this.backingGain);
      this._track(o, t + 0.5);
    }

    kick(t, vel = 1) {
      const o = this._osc('sine', 150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.9 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      o.connect(g).connect(this.backingGain);
      this._track(o, t + 0.32);
    }

    _noise(t, dur, type, freq, vel, out = this.backingGain) {
      const ctx = this.ctx;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src._startAt = t;
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(out);
      this._track(src, t + dur + 0.02);
      return g;
    }

    snare(t, vel = 1) {
      this._noise(t, 0.18, 'highpass', 1200, 0.45 * vel);
      const o = this._osc('triangle', 190, t);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.3 * vel, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g).connect(this.backingGain);
      this._track(o, t + 0.12);
    }

    hat(t, vel = 1) { this._noise(t, 0.05, 'highpass', 7000, 0.18 * vel); }
    crash(t) { this._noise(t, 1.8, 'highpass', 4000, 0.35); }

    click(t, accent) {
      const o = this._osc('square', accent ? 1760 : 1320, t);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      o.connect(g).connect(this.backingGain);
      this._track(o, t + 0.06);
    }

    // A clean reference tone for the Voice Lab.
    tone(midi, dur = 1.2) {
      this.ensure();
      this.guide(midi, this.now + 0.03, dur, this.sfxGain);
    }

    // ---- soundboard ----

    sfx(name) {
      this.ensure();
      const t = this.now + 0.01;
      const ctx = this.ctx;
      const out = this.sfxGain;
      switch (name) {
        case 'howl': {
          const o = this._osc('sawtooth', 300, t);
          o.frequency.linearRampToValueAtTime(620, t + 0.5);
          o.frequency.setValueAtTime(620, t + 1.1);
          o.frequency.exponentialRampToValueAtTime(340, t + 1.8);
          const lfo = this._osc('sine', 6, t);
          const lg = ctx.createGain();
          lg.gain.value = 14;
          lfo.connect(lg).connect(o.frequency);
          const bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 900;
          bp.Q.value = 1.5;
          const env = this._env(t, 1.7, 0.5, 0.25, 0.3);
          o.connect(bp).connect(env);
          env.connect(out);
          env.connect(this.reverb);
          this._track(o, t + 2.1);
          this._track(lfo, t + 2.1);
          break;
        }
        case 'airhorn': {
          for (let k = 0; k < 3; k++) {
            const st = t + k * 0.22;
            const len = k === 2 ? 0.7 : 0.16;
            for (const f of [466, 470, 622]) {
              const o = this._osc('sawtooth', f, st);
              const env = this._env(st, len, 0.09, 0.01, 0.05);
              o.connect(env).connect(out);
              this._track(o, st + len + 0.1);
            }
          }
          break;
        }
        case 'applause': {
          for (let i = 0; i < 70; i++) {
            const st = t + Math.random() * 1.8;
            this._noise(st, 0.03 + Math.random() * 0.03, 'bandpass', 1500 + Math.random() * 2500, 0.25 + Math.random() * 0.3, out);
          }
          break;
        }
        case 'rimshot': {
          this.snare(t, 0.8);
          this.kick(t + 0.18, 0.7);
          this.snare(t + 0.18, 0.6);
          const g = this._noise(t + 0.42, 1.0, 'highpass', 5000, 0.35, out);
          g.connect(this.reverb);
          break;
        }
        case 'boing': {
          const o = this._osc('sine', 180, t);
          o.frequency.exponentialRampToValueAtTime(520, t + 0.12);
          o.frequency.exponentialRampToValueAtTime(120, t + 0.5);
          const lfo = this._osc('sine', 18, t);
          const lg = ctx.createGain();
          lg.gain.value = 40;
          lfo.connect(lg).connect(o.frequency);
          const env = this._env(t, 0.45, 0.4, 0.005, 0.1);
          o.connect(env).connect(out);
          this._track(o, t + 0.6);
          this._track(lfo, t + 0.6);
          break;
        }
        case 'ooh': {
          for (const [f, d] of [[392, 0], [494, 4], [587, -4]]) {
            const o = this._osc('sawtooth', f, t);
            o.detune.value = d;
            o.frequency.linearRampToValueAtTime(f * 0.94, t + 1.2);
            const bp = ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.frequency.value = 500;
            bp.Q.value = 3;
            const env = this._env(t, 1.1, 0.12, 0.2, 0.3);
            o.connect(bp).connect(env).connect(out);
            env.connect(this.reverb);
            this._track(o, t + 1.5);
          }
          break;
        }
        case 'ding': {
          for (const [f, v] of [[1568, 0.12], [2093, 0.08]]) {
            const o = this._osc('sine', f, t);
            const env = this._env(t, 0.05, v, 0.003, 0.4);
            o.connect(env).connect(out);
            this._track(o, t + 0.5);
          }
          break;
        }
        case 'fanfare': {
          [60, 64, 67, 72].forEach((m, i) => {
            const st = t + i * 0.12;
            const len = i === 3 ? 0.8 : 0.1;
            const o = this._osc('sawtooth', mtof(m + 12), st);
            const env = this._env(st, len, 0.1, 0.01, 0.1);
            o.connect(env).connect(out);
            env.connect(this.reverb);
            this._track(o, st + len + 0.2);
          });
          break;
        }
        case 'sad': {
          [67, 66, 65, 64].forEach((m, i) => {
            const st = t + i * 0.35;
            const len = i === 3 ? 0.9 : 0.3;
            const o = this._osc('square', mtof(m - 12), st);
            const env = this._env(st, len, 0.08, 0.01, 0.1);
            if (i === 3) {
              const lfo = this._osc('sine', 6, st);
              const lg = ctx.createGain();
              lg.gain.value = 6;
              lfo.connect(lg).connect(o.frequency);
              this._track(lfo, st + len + 0.2);
            }
            o.connect(env).connect(out);
            this._track(o, st + len + 0.2);
          });
          break;
        }
      }
    }
  }

  window.KWAudio = { Engine, mtof };
})();
