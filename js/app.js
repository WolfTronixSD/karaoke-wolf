// Karaoke Wolf: the app. Screens, playback, scoring, lyrics, lab and fun stuff.

(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const { midiName } = window.KWPitch;
  const { vowelOf } = window.KWAudio;

  // ------------------------------------------------------------------
  // Storage + settings
  // ------------------------------------------------------------------

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('kw:' + k);
        return v == null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try { localStorage.setItem('kw:' + k, JSON.stringify(v)); } catch (e) { /* private mode */ }
    },
  };

  const settings = Object.assign({
    guideVol: 0.7,
    bandVol: 0.6,
    tempo: 1,
    difficulty: 'normal',
    octaveFree: true,
    headphones: false,
    echo: false,
    ding: true,
    voiceGuide: true,
    disco: true,
    record: false,
    rangeLow: null,
    rangeHigh: null,
  }, store.get('settings', {}));
  if (!settings.singer) settings.singer = settings.voiceGuide === false ? 'synth' : 'wolfie';
  const saveSettings = () => store.set('settings', settings);

  const TOLERANCE = { easy: 1.1, normal: 0.7, pro: 0.4 };

  // ------------------------------------------------------------------
  // Songs
  // ------------------------------------------------------------------

  const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d)$/;
  function noteToMidi(n) {
    const m = NOTE_RE.exec(n);
    if (!m) throw new Error('Bad note ' + n);
    const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
    const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
    return 12 * (parseInt(m[3], 10) + 1) + base + acc;
  }

  const TOKEN_RE = /^(.+?)(?::([A-Ga-g][#b]?-?\d))?(?:\/([\d.]+))?$/;
  function parseTokens(str) {
    return str.trim().split(/\s+/).map((tok) => {
      const m = TOKEN_RE.exec(tok);
      if (!m) throw new Error('Bad token ' + tok);
      const beats = m[3] ? parseFloat(m[3]) : 1;
      if (m[1] === '_') return { rest: true, beats };
      return { text: m[1], midi: noteToMidi(m[2]), beats };
    });
  }

  function buildSong(def) {
    const bpb = def.beatsPerBar || 4;
    const barSec = (bpb * 60) / def.bpm;
    const countIn = (barSec < 2.2 ? 2 : 1) * bpb;
    let t = countIn - (def.pickup || 0);
    const notes = [];
    const lines = [];
    const syls = [];
    def.lines.forEach((str, li) => {
      const line = { i: li, syls: [], notes: [] };
      let prev = null;
      for (const tok of parseTokens(str)) {
        if (tok.rest) {
          if (prev && tok.beats >= 0.5) prev.breath = true;
          t += tok.beats;
          continue;
        }
        const note = { i: notes.length, t, d: tok.beats, midi: tok.midi, line: li };
        if (tok.text === '~' && prev) {
          prev.end = t + tok.beats;
          prev.notes.push(note);
          note.syl = prev;
        } else {
          const syl = {
            i: syls.length,
            text: tok.text.replace(/-$/, ''),
            glue: tok.text.endsWith('-'),
            start: t,
            end: t + tok.beats,
            midi: tok.midi,
            notes: [note],
            line: li,
          };
          note.syl = syl;
          syls.push(syl);
          line.syls.push(syl);
          prev = syl;
        }
        notes.push(note);
        line.notes.push(note);
        t += tok.beats;
      }
      line.start = line.notes[0].t;
      const last = line.notes[line.notes.length - 1];
      line.end = last.t + last.d;
      line.text = line.syls.map((s) => s.text + (s.glue ? '' : ' ')).join('').trim();
      lines.push(line);
    });
    lines.forEach((l, i) => {
      const prevEnd = i ? lines[i - 1].end : 0;
      l.gapBefore = l.start - prevEnd;
      if (i && l.gapBefore >= 0.5) lines[i - 1].syls[lines[i - 1].syls.length - 1].breath = true;
    });
    const lastEnd = lines[lines.length - 1].end;
    const endBar = Math.ceil((lastEnd + 0.01) / bpb) * bpb;
    const midis = notes.map((n) => n.midi);
    const song = Object.assign({}, def, {
      bpb, countIn, notes, lines, syls, endBar,
      totalBeats: endBar + bpb,
      lo: Math.min(...midis),
      hi: Math.max(...midis),
    });
    song.events = buildEvents(song);
    song.seconds = (song.totalBeats * 60) / def.bpm;
    return song;
  }

  const CHORDS = [
    { root: 0, q: [0, 4, 7], bias: 0.15 },
    { root: 5, q: [0, 4, 7], bias: 0.05 },
    { root: 7, q: [0, 4, 7], bias: 0.1 },
    { root: 9, q: [0, 3, 7], bias: -0.05 },
    { root: 2, q: [0, 3, 7], bias: -0.1 },
    { root: 4, q: [0, 3, 7], bias: -0.2 },
    { root: 2, q: [0, 4, 7], bias: -0.35 },
    { root: 4, q: [0, 4, 7], bias: -0.35 },
  ];

  function chooseChord(w, prev) {
    const total = w.reduce((a, b) => a + b, 0);
    if (!total) return prev;
    let best = prev;
    let bestScore = -Infinity;
    for (const c of CHORDS) {
      const pcs = c.q.map((iv) => (c.root + iv) % 12);
      let s = 0;
      for (let pc = 0; pc < 12; pc++) s += pcs.includes(pc) ? w[pc] : -0.6 * w[pc];
      s += c.bias * total + (c === prev ? 0.1 * total : 0);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  }

  // Voice a chord's pitch classes into a comfy pad register.
  function voice(c) {
    return c.q.map((iv) => {
      let m = 48 + ((c.root + iv) % 12);
      while (m < 55) m += 12;
      return m;
    });
  }

  function buildEvents(song) {
    const ev = [];
    const { bpb, countIn, endBar } = song;
    for (let b = 0; b < countIn; b++) ev.push({ b, k: 'click', acc: b % bpb === 0 });
    for (const n of song.notes) ev.push({ b: n.t, k: 'guide', m: n.midi, d: n.d, v: vowelOf(n.syl.text), on: n.syl.notes[0] === n });

    const unit = bpb === 4 ? 2 : bpb === 6 ? 3 : bpb;
    let prev = CHORDS[0];
    for (let u = countIn; u < endBar; u += unit) {
      const w = new Array(12).fill(0);
      for (const n of song.notes) {
        const ov = Math.min(n.t + n.d, u + unit) - Math.max(n.t, u);
        if (ov > 0) w[n.midi % 12] += ov * (Math.abs(n.t - u) < 0.01 ? 1.6 : 1);
      }
      const c = u + unit >= endBar ? CHORDS[0] : chooseChord(w, prev);
      prev = c;
      const root = 36 + c.root;
      const fifth = root + 7 > 47 ? root - 5 : root + 7;
      const tones = voice(c);
      ev.push({ b: u, k: 'pad', ms: tones, d: unit });
      for (let i = 0; i < unit; i++) {
        const b = u + i;
        const bar = b - countIn;
        const pos = ((bar % bpb) + bpb) % bpb;
        switch (song.style) {
          case 'pop':
            ev.push({ b, k: 'bass', m: i % 2 ? fifth : root, d: 0.9 });
            ev.push({ b: b + 0.5, k: 'hat', v: 0.6 }, { b, k: 'hat', v: 1 });
            if (pos === 0 || pos === 2) ev.push({ b, k: 'kick' });
            if (pos === 2 && Math.floor(bar / bpb) % 2) ev.push({ b: b + 0.5, k: 'kick', v: 0.6 });
            if (pos === 1 || pos === 3) ev.push({ b, k: 'snare' });
            break;
          case 'rock': {
            const gtr = 40 + ((c.root - 4 + 12) % 12);
            for (const off of [0, 0.5]) {
              ev.push({ b: b + off, k: 'guitar', m: gtr, d: 0.42, v: off ? 0.07 : 0.1 });
              ev.push({ b: b + off, k: 'bass', m: root, d: 0.42 });
              ev.push({ b: b + off, k: 'hat', v: off ? 0.5 : 0.8 });
            }
            if (pos === 0 || pos === 2) ev.push({ b, k: 'kick' });
            if (pos === 2) ev.push({ b: b + 0.5, k: 'kick', v: 0.7 });
            if (pos === 1 || pos === 3) ev.push({ b, k: 'snare', v: 1.1 });
            if (pos === 0 && Math.floor(bar / bpb) % 4 === 0) ev.push({ b, k: 'crash' });
            break;
          }
          case 'gentle':
            if (i === 0) ev.push({ b, k: 'bass', m: root, d: unit * 0.95 });
            ev.push({ b, k: 'pluck', m: tones[(pos * 2) % 3] + 12, v: 0.06 });
            ev.push({ b: b + 0.5, k: 'pluck', m: tones[(pos * 2 + 1) % 3] + 12, v: 0.045 });
            if (pos === 0) ev.push({ b, k: 'kick', v: 0.5 });
            ev.push({ b, k: 'hat', v: 0.35 });
            break;
          case 'waltz':
            if (pos % 3 === 0) {
              ev.push({ b, k: 'bass', m: root, d: 0.9 }, { b, k: 'kick', v: 0.8 });
            } else {
              ev.push({ b, k: 'pluck', m: tones[1], v: 0.08 }, { b, k: 'pluck', m: tones[2], v: 0.07 }, { b, k: 'hat', v: 0.6 });
            }
            break;
          default: // warmup: soft metronome and a held chord
            if (i === 0) ev.push({ b, k: 'bass', m: root, d: unit * 0.95 });
            ev.push({ b, k: 'hat', v: pos === 0 ? 0.7 : 0.35 });
        }
      }
    }
    ev.push({ b: endBar, k: 'pad', ms: voice(CHORDS[0]), d: bpb }, { b: endBar, k: 'bass', m: 36, d: bpb },
      { b: endBar, k: 'kick' }, { b: endBar, k: 'crash' });
    ev.sort((a, b) => a.b - b.b);
    return ev;
  }

  const LIB = window.SONGS.map(buildSong);
  const byId = (id) => LIB.find((s) => s.id === id);

  // ------------------------------------------------------------------
  // Audio, mic, recording
  // ------------------------------------------------------------------

  const eng = new window.KWAudio.Engine();
  const mic = new window.KWPitch.Mic(eng);
  const rec = { mr: null, chunks: [], url: null, linkedSource: null };

  function applyVolumes() {
    eng.setGuideVolume(settings.guideVol);
    eng.setBackingVolume(settings.bandVol);
  }

  async function enableMic() {
    try {
      await mic.enable({ headphones: settings.headphones, echo: settings.echo });
      applyVolumes();
      updateMicButton();
      toast('🎤 Mic on! Sing your heart out.', true);
      return true;
    } catch (e) {
      toast('🙉 Could not open the mic. Check your browser permissions.', true);
      updateMicButton();
      return false;
    }
  }

  function disableMic() {
    mic.disable();
    updateMicButton();
  }

  function updateMicButton() {
    const b = $('#btn-mic');
    b.setAttribute('aria-pressed', String(mic.on));
    $('.mic-label', b).textContent = mic.on ? 'Mic on' : 'Mic off';
  }

  // Saved takes live in IndexedDB so they survive a reload (memory if that fails).
  const takesDB = (() => {
    let dbp = null;
    const mem = [];
    function open() {
      if (!dbp) {
        dbp = new Promise((res) => {
          try {
            const r = indexedDB.open('karaoke-wolf', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('takes', { keyPath: 'id' });
            r.onsuccess = () => res(r.result);
            r.onerror = () => res(null);
          } catch (e) {
            res(null);
          }
        });
      }
      return dbp;
    }
    async function tx(mode, fn) {
      const db = await open();
      if (!db) return null;
      return new Promise((res, rej) => {
        const t = db.transaction('takes', mode);
        const req = fn(t.objectStore('takes'));
        t.oncomplete = () => res(req.result === undefined ? true : req.result);
        t.onerror = () => rej(t.error);
      });
    }
    return {
      async add(take) {
        try { if (await tx('readwrite', (st) => st.put(take))) return; } catch (e) { /* fall back to memory */ }
        mem.push(take);
      },
      async list() {
        let all = [];
        try { all = (await tx('readonly', (st) => st.getAll())) || []; } catch (e) { /* none */ }
        return all.concat(mem).sort((a, b) => b.date - a.date);
      },
      async remove(id) {
        try { await tx('readwrite', (st) => st.delete(id)); } catch (e) { /* ignore */ }
        const i = mem.findIndex((t) => t.id === id);
        if (i >= 0) mem.splice(i, 1);
      },
    };
  })();

  // Starts recording you + the music (only when Record is on and the mic is on).
  function recStart() {
    if (rec.mr || !cur || cur.listen || !settings.record || !mic.on || typeof MediaRecorder === 'undefined') return;
    if (!eng.recDest) {
      eng.recDest = eng.ctx.createMediaStreamDestination();
      eng.musicBus.connect(eng.recDest);
    }
    if (rec.linkedSource !== mic.source) {
      const g = eng.ctx.createGain();
      g.gain.value = 1.4;
      mic.source.connect(g).connect(eng.recDest);
      rec.linkedSource = mic.source;
    }
    try {
      rec.chunks = [];
      const mr = new MediaRecorder(eng.recDest.stream);
      mr.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
      mr.start(500);
      rec.mr = mr;
      rec.song = cur.song;
      rec.acc = 0;
      rec.t0 = performance.now();
      document.body.classList.add('recording');
    } catch (e) {
      rec.mr = null;
    }
  }

  function recPause() {
    if (rec.mr && rec.mr.state === 'recording') {
      rec.mr.pause();
      rec.acc += performance.now() - rec.t0;
      document.body.classList.remove('recording');
    }
  }

  function recResume() {
    if (rec.mr && rec.mr.state === 'paused') {
      rec.mr.resume();
      rec.t0 = performance.now();
      document.body.classList.add('recording');
      return true;
    }
    return false;
  }

  // Stops the recording and saves it as a take. Calls back with its URL (or null).
  function recSave(extra, cb) {
    const mr = rec.mr;
    document.body.classList.remove('recording');
    if (!mr) return cb && cb(null);
    rec.mr = null;
    const secs = (rec.acc + (mr.state === 'recording' ? performance.now() - rec.t0 : 0)) / 1000;
    const song = rec.song;
    mr.onstop = () => {
      const blob = new Blob(rec.chunks, { type: mr.mimeType || 'audio/webm' });
      if (!blob.size || secs < 2) return cb && cb(null);
      const take = Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), date: Date.now(), secs,
        songId: song.id, title: song.title, emoji: song.emoji, blob }, extra || {});
      takesDB.add(take).then(() => {
        award('record');
        if (!extra) toast('📼 Take saved! Hear it any time in 🎧 Takes.', true);
        if (screen === 'takes') renderTakes();
      });
      cb && cb(URL.createObjectURL(blob));
    };
    if (mr.state === 'paused') mr.resume();
    mr.stop();
  }

  const fmtSecs = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  let takeUrls = [];
  async function renderTakes() {
    takeUrls.forEach((u) => URL.revokeObjectURL(u));
    takeUrls = [];
    const list = await takesDB.list();
    const box = $('#takes-list');
    box.innerHTML = '';
    $('#takes-empty').hidden = list.length > 0;
    for (const t of list) {
      const url = URL.createObjectURL(t.blob);
      takeUrls.push(url);
      const el = document.createElement('div');
      el.className = 'take card';
      const when = new Date(t.date).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
        <div class="take-head"><span class="take-emoji"></span><div><b class="take-title"></b><small class="take-meta"></small></div>
          <span class="take-grade"></span></div>
        <audio controls preload="metadata"></audio>
        <div class="row"><a class="btn mini dl">⬇ Download</a><button class="btn mini ghost danger del">🗑 Delete</button></div>`;
      $('.take-emoji', el).textContent = t.emoji;
      $('.take-title', el).textContent = t.title;
      $('.take-meta', el).textContent = `${when} · ${fmtSecs(t.secs)}${t.score != null ? ' · ' + t.score.toLocaleString() + ' pts' : ''}`;
      $('.take-grade', el).textContent = t.grade || '';
      $('audio', el).src = url;
      const dl = $('.dl', el);
      dl.href = url;
      dl.download = `karaoke-wolf-${t.songId}-${new Date(t.date).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${(t.blob.type || '').includes('ogg') ? 'ogg' : (t.blob.type || '').includes('mp4') ? 'm4a' : 'webm'}`;
      $('.del', el).addEventListener('click', async () => {
        if (!confirm(`Delete this take of "${t.title}"?`)) return;
        await takesDB.remove(t.id);
        renderTakes();
      });
      box.appendChild(el);
    }
  }

  // ------------------------------------------------------------------
  // Fun layer: toasts, floaties, confetti, MC Wolf, badges
  // ------------------------------------------------------------------

  function toast(msg, plain) {
    const el = document.createElement('div');
    el.className = 'toast' + (plain ? ' plain' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 3700);
  }

  function floaty(emoji, x, y, n = 5) {
    const box = $('#floaties');
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span');
      el.className = 'floaty';
      el.textContent = emoji;
      el.style.left = x + (Math.random() - 0.5) * 60 + 'px';
      el.style.top = y + 'px';
      el.style.setProperty('--dx', (Math.random() - 0.5) * 200 + 'px');
      el.style.setProperty('--rot', (Math.random() - 0.5) * 90 + 'deg');
      el.style.animationDelay = i * 0.07 + 's';
      box.appendChild(el);
      setTimeout(() => el.remove(), 2200);
    }
  }

  const confetti = (() => {
    const cv = $('#confetti');
    const g = cv.getContext('2d');
    const parts = [];
    const colors = ['#ff4fd8', '#3ee8ff', '#ffd23f', '#4dff91', '#8b5cff', '#ff9f43'];
    let running = false;
    function size() {
      cv.width = innerWidth * devicePixelRatio;
      cv.height = innerHeight * devicePixelRatio;
    }
    addEventListener('resize', size);
    size();
    function loop() {
      g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      g.clearRect(0, 0, innerWidth, innerHeight);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.vy += 0.25;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        p.life -= 1;
        if (p.life <= 0 || p.y > innerHeight + 30) { parts.splice(i, 1); continue; }
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.r);
        g.fillStyle = p.c;
        g.globalAlpha = Math.min(1, p.life / 30);
        if (p.e) {
          g.font = '22px serif';
          g.fillText(p.e, -10, 8);
        } else {
          g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        }
        g.restore();
      }
      if (parts.length) requestAnimationFrame(loop);
      else { running = false; g.clearRect(0, 0, innerWidth, innerHeight); }
    }
    function start() { if (!running) { running = true; requestAnimationFrame(loop); } }
    return {
      burst(x, y, n = 60, emoji) {
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) n = Math.min(n, 12);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 3 + Math.random() * 8;
          parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6, r: 0, vr: (Math.random() - 0.5) * 0.4,
            c: pick(colors), s: 6 + Math.random() * 8, life: 90 + Math.random() * 60, e: emoji && Math.random() < 0.3 ? emoji : null });
        }
        start();
      },
      rain(n = 120, emoji) {
        for (let i = 0; i < n; i++) {
          parts.push({ x: Math.random() * innerWidth, y: -20 - Math.random() * 300, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 3,
            r: 0, vr: (Math.random() - 0.5) * 0.3, c: pick(colors), s: 7 + Math.random() * 8, life: 220, e: emoji && Math.random() < 0.25 ? emoji : null });
        }
        start();
      },
    };
  })();

  const MC = {
    intro: [
      'Mic check, one two... AWOOO! 🎤',
      "If you can't hit the note, hit it with confidence.",
      'Shoulders down, chin level, belly breaths. Let’s howl!',
      'Follow the glowing bars. Your voice is the little light. Make them meet!',
      'Pro tip: smile while you sing. It literally brightens your tone. 😁',
    ],
    noMic: [
      'No mic? I’ll pretend I heard a masterpiece. Tap 🎤 to get scored!',
      'Turn on the mic up top and I’ll tell you how you’re doing.',
    ],
    perfectLine: [
      'That line was cleaner than a freshly licked plate! 🍽️',
      'Did a professional just walk in? Oh wait, it’s you.',
      'Pitch perfect! The moon is blushing. 🌕',
      'Okay, show-off! 😎',
      'Somebody call a record label!',
    ],
    combo10: ['10 in a row! The pack is impressed. 🐺🐺🐺', 'You’re on fire! Call the fire wolf-partment! 🔥', 'Combo! Your vocal cords just got a gym membership. 💪'],
    combo25: ['25 COMBO?! I need to sit down. 🪑', 'Legend status unlocked. The owls are taking notes. 🦉'],
    flat: ['A little flat, like a pancake 🥞. Aim a tiny bit higher!', 'Lift it! Imagine the note is on a shelf above you. ⬆', 'Raise your eyebrows. Weirdly, it helps you go up!'],
    sharp: ['A bit sharp! Easy, tiger... err, wolf. Relax the jaw.', 'Too high! Dogs three blocks away just tilted their heads. 🐕', 'Ease off a little, let the note sit lower. ⬇'],
    silent: ['Hello? Is this thing on? 🎤 Sing out!', 'I can’t hear you! Get closer to the mic or sing louder.', 'Don’t be shy, the neighbors are already listening. 👀'],
    miss: ['Every legend starts by missing notes. Keep going!', 'Wobbly? That’s called artistic interpretation. 🎨', 'Try turning on the guide melody, or slow the tempo down.', 'Struggling? Try the Key buttons to move the song into your range.'],
    hype: ['HYPE MODE! Double points! 🔥🔥', 'THE CROWD GOES WILD! 🙌'],
  };
  let mcTimer = 0;
  const mcLast = {};
  function mc(kind, force) {
    const now = performance.now();
    if (!force && (now - (mcLast.any || 0) < 4500 || now - (mcLast[kind] || 0) < 12000)) return;
    mcLast.any = now;
    mcLast[kind] = now;
    $('#mc-text').textContent = typeof kind === 'string' && MC[kind] ? pick(MC[kind]) : kind;
    const el = $('#mc');
    el.classList.add('show');
    clearTimeout(mcTimer);
    mcTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  const BADGES = [
    { id: 'first', ic: '🎤', name: 'First Howl', desc: 'Finish your first song' },
    { id: 'warmup', ic: '🏋️', name: 'Stretchy Throat', desc: 'Finish the Wolf Warm-Up' },
    { id: 'combo10', ic: '🔗', name: 'Pack Mentality', desc: 'Hit a 10-note combo' },
    { id: 'combo25', ic: '⛓️', name: 'Unstoppable Wolf', desc: 'Hit a 25-note combo' },
    { id: 'perfectline', ic: '🎯', name: 'Laser Larynx', desc: 'Sing a whole line perfectly' },
    { id: 'gradeA', ic: '🥈', name: 'Pack Leader', desc: 'Get an A on any song' },
    { id: 'gradeS', ic: '👑', name: 'Alpha Howler', desc: 'Get an S on any song' },
    { id: 'hype', ic: '🔥', name: 'Hype Beast', desc: 'Trigger hype mode' },
    { id: 'all', ic: '📚', name: 'Song Hoarder', desc: 'Finish every song' },
    { id: 'originals', ic: '🌕', name: 'True Wolf', desc: 'Finish all Wolf Originals' },
    { id: 'sound', ic: '🎛️', name: 'Sound Guy', desc: 'Press the soundboard 30 times' },
    { id: 'night', ic: '🦉', name: 'Night Wolf', desc: 'Sing between midnight and 5am' },
    { id: 'practice', ic: '🔁', name: 'Practice Makes Pawfect', desc: 'Loop a line 5 times' },
    { id: 'range', ic: '🎢', name: 'Range Rover', desc: 'Measure a range of 1.5 octaves or more' },
    { id: 'tune', ic: '🎚️', name: 'Note Ninja', desc: 'Lock 10 notes in Tune Mode' },
    { id: 'ear', ic: '👂', name: 'Golden Ear', desc: 'Match 5 notes in a row in the Voice Lab' },
    { id: 'record', ic: '📼', name: 'Studio Wolf', desc: 'Record a performance' },
    { id: 'slow', ic: '🐢', name: 'Slow and Steady', desc: 'Finish a song at 70% tempo or slower' },
    { id: 'key', ic: '🔑', name: 'Key Master', desc: 'Change the key to fit your voice' },
  ];
  const earned = new Set(store.get('badges', []));
  function award(id) {
    if (earned.has(id)) return;
    const b = BADGES.find((x) => x.id === id);
    if (!b) return;
    earned.add(id);
    store.set('badges', [...earned]);
    toast(`${b.ic} Badge unlocked: ${b.name}!`);
    eng.ctx && eng.sfx('fanfare');
    confetti.burst(innerWidth / 2, innerHeight - 60, 40, b.ic);
  }

  // ------------------------------------------------------------------
  // Screens + home
  // ------------------------------------------------------------------

  let screen = 'home';
  function show(name) {
    if (screen === 'stage' && name !== 'stage') stopPlayback();
    if (screen === 'lab' && name !== 'lab') { matchStop(); toggleDrone(false); }
    if (name !== 'stage') $('#sheet').hidden = true;
    screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === 'screen-' + name));
    $$('.nav-btn[data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === name));
    if (name === 'home') renderHome();
    if (name === 'badges') renderBadges();
    if (name === 'takes') renderTakes();
    window.scrollTo({ top: 0 });
  }

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  let homeCat = 'all';
  function renderHome() {
    const best = store.get('best', {});
    const grid = $('#song-grid');
    grid.innerHTML = '';
    for (const s of LIB) {
      if (homeCat !== 'all' && s.category !== homeCat) continue;
      const b = best[s.id];
      const card = document.createElement('button');
      card.className = 'song-card';
      card.innerHTML = `
        <div class="emoji">${s.emoji}</div>
        <h3></h3>
        <div class="artist"></div>
        <div class="blurb"></div>
        <div class="meta">
          <span class="paws" title="Difficulty">${'🐾'.repeat(s.difficulty)}<span style="opacity:.25">${'🐾'.repeat(4 - s.difficulty)}</span></span>
          <span>${fmtTime(s.seconds)}</span>
          ${b ? `<span class="best ${b.grade}">${b.grade} · ${b.score.toLocaleString()}</span>` : '<span class="best">New!</span>'}
        </div>`;
      $('h3', card).textContent = s.title;
      $('.artist', card).textContent = s.artist;
      $('.blurb', card).textContent = s.blurb;
      card.addEventListener('click', () => openStage(s));
      grid.appendChild(card);
    }
  }

  function renderBadges() {
    const grid = $('#badge-grid');
    grid.innerHTML = '';
    for (const b of BADGES) {
      const el = document.createElement('div');
      el.className = 'badge' + (earned.has(b.id) ? ' got' : '');
      el.innerHTML = `<div class="ic">${b.ic}</div><b></b><small></small>`;
      $('b', el).textContent = b.name;
      $('small', el).textContent = b.desc;
      grid.appendChild(el);
    }
    $('#badge-count').textContent = `${earned.size} of ${BADGES.length} unlocked. Keep howling!`;
  }

  // ------------------------------------------------------------------
  // Stage: playback
  // ------------------------------------------------------------------

  let cur = null;
  const P = { playing: false, t0: 0, spb: 0.5, idx: 0, timer: 0, pausedBeat: 0 };

  function beatNow() {
    return P.playing ? (eng.now - P.t0) / P.spb : P.pausedBeat;
  }

  function defaultTranspose(song) {
    const saved = store.get('keys', {})[song.id];
    if (typeof saved === 'number') return saved;
    if (settings.rangeLow == null) return 0;
    const t = Math.round((settings.rangeLow + settings.rangeHigh) / 2 - (song.lo + song.hi) / 2);
    return clamp(t, -12, 12);
  }

  function openStage(song) {
    stopPlayback();
    cur = {
      song,
      transpose: defaultTranspose(song),
      stats: song.notes.map(() => ({ h: 0, f: 0, v: 0, r: null, ratio: 0 })),
      ni: 0,
      li: -1,
      score: 0,
      shownScore: 0,
      combo: 0,
      maxCombo: 0,
      misses: 0,
      silentBeats: 0,
      hype: 0,
      hypeUntil: 0,
      diffSum: 0,
      diffT: 0,
      recent: [],
      trail: [],
      loopLine: null,
      loops: 0,
      practiced: false,
      finished: false,
      lastBeat: -1,
      lastDing: 0,
      listen: false,
      preview: null,
    };
    document.body.classList.remove('listening');
    $('#btn-listen').setAttribute('aria-pressed', 'false');
    P.pausedBeat = 0;
    $('#st-title').textContent = song.title;
    $('#st-emoji').textContent = song.emoji;
    $('#out-key').textContent = fmtKey(cur.transpose);
    $('#btn-loop').setAttribute('aria-pressed', 'false');
    renderSheet();
    updateHud();
    show('stage');
    renderLyricLines(0, 0);
    setPlayButton();
    setTimeout(() => mc(mic.on ? 'intro' : 'noMic', true), 400);
  }

  const fmtKey = (t) => (t > 0 ? '+' + t : String(t));

  function play(from) {
    eng.ensure();
    applyVolumes();
    eng.stopAll();
    P.spb = 60 / (cur.song.bpm * settings.tempo);
    P.t0 = eng.now + 0.08 - from * P.spb;
    const ev = cur.song.events;
    let i = 0;
    while (i < ev.length && ev[i].b < from - 0.001) i++;
    P.idx = i;
    P.playing = true;
    clearInterval(P.timer);
    P.timer = setInterval(pump, 25);
    pump();
    setPlayButton();
  }

  function pump() {
    if (!P.playing) return;
    const horizon = (eng.now + 0.25 - P.t0) / P.spb;
    const ev = cur.song.events;
    while (P.idx < ev.length && ev[P.idx].b < horizon) {
      sched(ev[P.idx]);
      P.idx++;
    }
  }

  function sched(e) {
    const t = P.t0 + e.b * P.spb;
    if (t < eng.now - 0.03) return;
    const T = cur.transpose;
    const d = (e.d || 0) * P.spb;
    switch (e.k) {
      case 'guide': singNote(e, e.m + T, t, d); break;
      case 'bass': eng.bass(e.m + T, t, d); break;
      case 'pad': eng.pad(e.ms.map((m) => m + T), t, d); break;
      case 'pluck': eng.pluck(e.m + T, t, e.v); break;
      case 'guitar': eng.guitar(e.m + T, t, d, e.v); break;
      case 'kick': eng.kick(t, e.v || 1); break;
      case 'snare': eng.snare(t, e.v || 1); break;
      case 'hat': eng.hat(t, e.v || 1); break;
      case 'crash': eng.crash(t); break;
      case 'click': eng.click(t, e.acc); break;
    }
  }

  function singNote(e, midi, t, d) {
    if (settings.singer === 'synth') eng.guide(midi, t, Math.max(0.08, d * 0.95));
    else eng.voice(midi, t, Math.max(0.1, d * 0.97), e.v, e.on, eng.guideGain, settings.singer);
  }

  // A reference note for the Voice Lab, sung or synth depending on the setting.
  function refTone(midi, dur = 1.2) {
    eng.ensure();
    applyVolumes();
    if (settings.singer === 'synth') eng.tone(midi, dur);
    else eng.voice(midi, eng.now + 0.03, dur, 'a', false, eng.sfxGain, settings.singer);
  }

  // Sing one lyric line on its own (with the voice), so you can hear the tune.
  function previewLine(line) {
    if (!cur) return;
    if (P.playing) pause();
    eng.ensure();
    applyVolumes();
    eng.stopAll();
    const spb = 60 / (cur.song.bpm * settings.tempo);
    const t0 = eng.now + 0.1 - line.start * spb;
    for (const n of line.notes) {
      singNote({ v: vowelOf(n.syl.text), on: n.syl.notes[0] === n }, n.midi + cur.transpose, t0 + n.t * spb, n.d * spb);
    }
    // Let the lyrics and lane follow along while it plays.
    P.pausedBeat = line.start - 0.5;
    cur.preview = { t0, spb, end: line.end + 0.3, from: Math.max(0, line.start - cur.song.bpb) };
    toast(`🔊 Line ${line.i + 1}: listen, then sing it back!`, true);
  }

  function setListen(on) {
    if (!cur) return;
    const song = cur.song;
    if (on) {
      openStage(song);
      cur.listen = true;
      document.body.classList.add('listening');
      $('#btn-listen').setAttribute('aria-pressed', 'true');
      play(0);
      eng.setGuideVolume(Math.max(0.9, settings.guideVol));
      mc('👂 Listen mode: just listen to how it goes. Your turn next!', true);
    } else {
      document.body.classList.remove('listening');
      $('#btn-listen').setAttribute('aria-pressed', 'false');
      openStage(song);
    }
  }

  function pause() {
    if (!P.playing) return;
    P.pausedBeat = beatNow();
    P.playing = false;
    clearInterval(P.timer);
    eng.stopAll();
    recPause();
    setPlayButton();
  }

  function stopPlayback() {
    pause();
    recSave();
    document.body.classList.remove('hype');
  }

  function togglePlay() {
    if (!cur) return;
    if (P.playing) return pause();
    if (cur.finished) return restart();
    if (cur.preview) {
      const back = cur.preview.from;
      cur.preview = null;
      eng.stopAll();
      seekTo(back);
    }
    const from = P.pausedBeat;
    if (!recResume()) recStart();
    play(from);
  }

  function restart() {
    recSave();
    openStage(cur.song);
    recStart();
    play(0);
  }

  // Jump to a beat and forget the scores of everything after it.
  function seekTo(beat) {
    beat = Math.max(0, beat);
    cur.practiced = true;
    const notes = cur.song.notes;
    let i = 0;
    while (i < notes.length && notes[i].t + notes[i].d <= beat) i++;
    cur.ni = i;
    for (let k = i; k < notes.length; k++) cur.stats[k] = { h: 0, f: 0, v: 0, r: null, ratio: 0 };
    cur.trail = [];
    cur.li = -1;
    if (P.playing) play(beat);
    else P.pausedBeat = beat;
    $$('.syl').forEach((el) => el.classList.remove('r-perfect', 'r-great', 'r-okay', 'r-miss', 'done'));
  }

  function setPlayButton() {
    const b = $('#btn-play');
    b.textContent = P.playing ? '❚❚' : '▶';
    b.setAttribute('aria-label', P.playing ? 'Pause' : 'Play');
  }

  // ------------------------------------------------------------------
  // Stage: scoring
  // ------------------------------------------------------------------

  function foldDiff(sung, target) {
    let d = sung - target;
    if (settings.octaveFree) d -= 12 * Math.round(d / 12);
    return d;
  }

  function scoreFrame(beat, reading, dt) {
    const { notes } = cur.song;
    while (cur.ni < notes.length && notes[cur.ni].t + notes[cur.ni].d <= beat) {
      finalizeNote(notes[cur.ni]);
      cur.ni++;
    }
    cur.onPitch = false;
    cur.liveDiff = null;
    const n = notes[cur.ni];
    if (!n || n.t > beat) return;
    const st = cur.stats[n.i];
    const tol = TOLERANCE[settings.difficulty] || 0.7;
    let hit = false;
    if (reading) {
      const diff = foldDiff(reading.midi, n.midi + cur.transpose);
      hit = Math.abs(diff) <= tol;
      st.v += dt;
      cur.liveDiff = diff;
      cur.onPitch = hit;
      if (Math.abs(diff) < 3) {
        cur.diffSum += diff * dt;
        cur.diffT += dt;
        cur.recent.push({ t: performance.now(), d: diff });
      }
    }
    // A short grace period at the start of each note: we don't punish the attack.
    const into = (beat - n.t) * P.spb;
    const grace = into < Math.min(0.12, 0.3 * n.d * P.spb);
    if (!grace || hit) st.f += dt;
    if (hit) st.h += dt;

    // Live coaching on drift.
    const now = performance.now();
    cur.recent = cur.recent.filter((r) => now - r.t < 1500);
    if (cur.recent.length > 40) {
      const avg = cur.recent.reduce((a, r) => a + r.d, 0) / cur.recent.length;
      if (avg < -tol * 0.8) mc('flat');
      else if (avg > tol * 0.8) mc('sharp');
    }
  }

  const RATING = [
    { r: 'perfect', min: 0.75, mult: 1, label: 'PERFECT!', hype: 7 },
    { r: 'great', min: 0.45, mult: 0.7, label: 'GREAT', hype: 4 },
    { r: 'okay', min: 0.2, mult: 0.4, label: 'OKAY', hype: 1 },
    { r: 'miss', min: -1, mult: 0, label: 'MISS', hype: -4 },
  ];

  function finalizeNote(n) {
    const st = cur.stats[n.i];
    if (st.r || !mic.on) return;
    st.ratio = st.f > 0 ? st.h / st.f : 0;
    const R = RATING.find((x) => st.ratio >= x.min);
    st.r = R.r;
    const hyped = performance.now() < cur.hypeUntil;
    if (R.mult > 0.5) {
      cur.combo++;
      cur.misses = 0;
    } else {
      cur.combo = 0;
      if (R.r === 'miss') cur.misses++;
    }
    cur.maxCombo = Math.max(cur.maxCombo, cur.combo);
    cur.score += Math.round(100 * n.d * R.mult * (1 + Math.min(cur.combo, 20) * 0.05) * (hyped ? 2 : 1));
    if (!hyped) cur.hype = clamp(cur.hype + R.hype, 0, 100);
    if (cur.hype >= 100 && !hyped) startHype();
    judge(R);
    if (R.r === 'perfect' && settings.ding && performance.now() - cur.lastDing > 180) {
      cur.lastDing = performance.now();
      eng.sfx('ding');
    }
    if (cur.combo === 10) { mc('combo10', true); award('combo10'); confetti.burst(innerWidth * 0.25, innerHeight * 0.35, 50); }
    if (cur.combo === 25) { mc('combo25', true); award('combo25'); confetti.rain(150, '🐺'); }
    if (cur.misses >= 5) { mc('miss'); cur.misses = 0; }
    if (st.v === 0) {
      cur.silentBeats += n.d;
      if (cur.silentBeats >= 8) { mc('silent'); cur.silentBeats = 0; }
    } else {
      cur.silentBeats = 0;
    }
    const line = cur.song.lines[n.line];
    if (line.notes[line.notes.length - 1] === n) lineDone(line);
  }

  function lineDone(line) {
    const rs = line.notes.map((n) => cur.stats[n.i].r);
    if (rs.every((r) => r === 'perfect')) {
      mc('perfectLine', true);
      award('perfectline');
      const lyr = $('#lyrics').getBoundingClientRect();
      confetti.burst(lyr.left + lyr.width / 2, lyr.top + 60, 80);
    }
    const li = $(`#sheet-lines li[data-i="${line.i}"] .acc`);
    if (li) li.textContent = lineAccuracy(line) + '%';
  }

  function lineAccuracy(line) {
    let s = 0;
    let d = 0;
    for (const n of line.notes) {
      s += Math.min(1, cur.stats[n.i].ratio / 0.75) * n.d;
      d += n.d;
    }
    return Math.round((100 * s) / d);
  }

  function judge(R) {
    const el = $('#judge');
    el.className = 'judge';
    void el.offsetWidth;
    el.textContent = R.label + (cur.combo >= 3 && R.mult > 0.5 ? ` ×${cur.combo}` : '');
    el.className = 'judge show ' + R.r;
  }

  function startHype() {
    cur.hypeUntil = performance.now() + 8000;
    document.body.classList.add('hype');
    eng.sfx('airhorn');
    mc('hype', true);
    award('hype');
    confetti.rain(160, '🔥');
  }

  function updateHud() {
    if (!cur) return;
    cur.shownScore += (cur.score - cur.shownScore) * 0.2;
    if (Math.abs(cur.score - cur.shownScore) < 1) cur.shownScore = cur.score;
    $('#st-score').textContent = Math.round(cur.shownScore).toLocaleString();
    $('#st-combo').textContent = cur.combo;
    const now = performance.now();
    let pct = cur.hype;
    if (now < cur.hypeUntil) pct = ((cur.hypeUntil - now) / 8000) * 100;
    else if (document.body.classList.contains('hype')) {
      document.body.classList.remove('hype');
      cur.hype = 0;
    }
    $('#st-hype').style.width = pct + '%';
  }

  // ------------------------------------------------------------------
  // Stage: pitch lane
  // ------------------------------------------------------------------

  const lane = $('#lane');
  const lg = lane.getContext('2d');
  const LINE_COLORS = ['#3ee8ff', '#ff4fd8', '#8b5cff', '#4dff91'];
  const R_COLORS = { perfect: '#ffd23f', great: '#4dff91', okay: '#3ee8ff', miss: '#ff5c7a' };

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawLane(beat, reading) {
    const dpr = devicePixelRatio || 1;
    const W = lane.clientWidth;
    const H = lane.clientHeight;
    if (lane.width !== Math.round(W * dpr) || lane.height !== Math.round(H * dpr)) {
      lane.width = Math.round(W * dpr);
      lane.height = Math.round(H * dpr);
    }
    const g = lg;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const song = cur.song;
    const T = cur.transpose;
    const lo = song.lo + T - 2.5;
    const hi = song.hi + T + 2.5;
    const pad = 12;
    const rowH = (H - pad * 2) / (hi - lo);
    const y = (m) => H - pad - (m - lo) * rowH;
    const spb = P.spb || 60 / (song.bpm * settings.tempo);
    const px = W * 0.22;
    const pxPerBeat = (W * 0.78 * spb) / 4;
    const X = (b) => px + (b - beat) * pxPerBeat;

    // semitone rows
    g.font = '700 10px Nunito, sans-serif';
    for (let m = Math.ceil(lo); m <= Math.floor(hi); m++) {
      const yy = y(m);
      const black = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
      if (black) {
        g.fillStyle = 'rgba(255,255,255,0.025)';
        g.fillRect(0, yy - rowH / 2, W, rowH);
      }
      if (m % 12 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillText(midiName(m), 4, yy + 3);
        g.fillStyle = 'rgba(255,255,255,0.08)';
        g.fillRect(24, yy, W, 1);
      }
    }
    // bar lines
    const firstBar = Math.floor((beat - px / pxPerBeat) / song.bpb) * song.bpb;
    for (let b = firstBar; X(b) < W; b += song.bpb) {
      if (b < 0) continue;
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(X(b), 0, 1, H);
    }

    // target note bars
    const active = song.notes[cur.ni];
    const isActive = active && active.t <= beat;
    for (const n of song.notes) {
      const x1 = X(n.t);
      const x2 = X(n.t + n.d);
      if (x2 < 0) continue;
      if (x1 > W) break;
      const yy = y(n.midi + T);
      const h = Math.max(8, Math.min(22, rowH * 0.85));
      const st = cur.stats[n.i];
      const on = n === active && isActive;
      g.save();
      if (st.r) g.fillStyle = R_COLORS[st.r];
      else if (on) g.fillStyle = '#ffffff';
      else g.fillStyle = LINE_COLORS[n.line % LINE_COLORS.length];
      g.globalAlpha = st.r ? 0.85 : x2 < px ? 0.35 : 0.75;
      if (on && cur.onPitch) {
        g.shadowColor = '#ffd23f';
        g.shadowBlur = 24;
        g.fillStyle = '#ffd23f';
      }
      roundRect(g, x1 + 1, yy - h / 2, Math.max(4, x2 - x1 - 2), h, h / 2);
      g.fill();
      if (on) {
        // how much of this note you've hit so far
        const prog = clamp((px - x1) / (x2 - x1), 0, 1);
        g.globalAlpha = 0.9;
        g.shadowBlur = 0;
        g.fillStyle = 'rgba(255,79,216,0.55)';
        roundRect(g, x1 + 1, yy + h / 2 - 4, Math.max(4, (x2 - x1 - 2) * prog * (st.f ? st.h / st.f : 0)), 4, 2);
        g.fill();
      }
      g.restore();
      if (n.syl.notes[0] === n && x2 - x1 > 26) {
        g.fillStyle = 'rgba(10,5,30,0.85)';
        g.font = '800 11px Nunito, sans-serif';
        g.fillText(n.syl.text, x1 + 7, yy + 4);
      }
      if (n.syl.breath && n.syl.notes[n.syl.notes.length - 1] === n) {
        g.font = '14px serif';
        g.fillText('🌬️', x2 + 3, yy - h / 2 - 2);
      }
    }

    // playhead
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,79,216,0)');
    grad.addColorStop(0.5, 'rgba(255,79,216,0.9)');
    grad.addColorStop(1, 'rgba(255,79,216,0)');
    g.fillStyle = grad;
    g.fillRect(px - 1.5, 0, 3, H);

    // your voice: a glowing trail
    const target = active ? active.midi + T : song.notes[song.notes.length - 1].midi + T;
    let dm = null;
    if (reading) {
      dm = settings.octaveFree ? target + foldDiff(reading.midi, target) : reading.midi;
      dm = clamp(dm, lo + 0.3, hi - 0.3);
    }
    if (P.playing) {
      cur.trail.push({ b: beat, m: dm });
      while (cur.trail.length && cur.trail[0].b < beat - px / pxPerBeat) cur.trail.shift();
    }
    g.save();
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = cur.onPitch ? '#ffd23f' : '#ffffff';
    g.shadowColor = g.strokeStyle;
    g.shadowBlur = 12;
    g.beginPath();
    let pen = false;
    for (const p of cur.trail) {
      if (p.m == null) { pen = false; continue; }
      const xx = X(p.b);
      const yy = y(p.m);
      if (pen) g.lineTo(xx, yy);
      else g.moveTo(xx, yy);
      pen = true;
    }
    g.stroke();
    g.restore();
    if (dm != null) {
      const yy = y(dm);
      g.save();
      g.fillStyle = cur.onPitch ? '#ffd23f' : '#ffffff';
      g.shadowColor = g.fillStyle;
      g.shadowBlur = 20;
      g.beginPath();
      g.arc(px, yy, 8, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // the big "go higher / go lower" coach arrow
      if (isActive && cur.liveDiff != null && !cur.onPitch) {
        const up = cur.liveDiff < 0;
        g.save();
        g.fillStyle = up ? '#4dff91' : '#ff9f43';
        g.font = '900 15px Nunito, sans-serif';
        const ax = px + 18;
        const ay = yy + (up ? -10 : 10);
        g.beginPath();
        g.moveTo(ax, ay + (up ? -12 : 12));
        g.lineTo(ax - 9, ay);
        g.lineTo(ax + 9, ay);
        g.closePath();
        g.fill();
        g.fillText(up ? 'higher' : 'lower', ax + 14, ay + (up ? -2 : 8));
        g.restore();
      }
    }
  }

  // ------------------------------------------------------------------
  // Stage: lyrics + bouncing wolf
  // ------------------------------------------------------------------

  function renderLine(el, line, isCur) {
    el.innerHTML = '';
    el.classList.remove('enter');
    if (!line) return;
    void el.offsetWidth;
    el.classList.add('enter');
    const ms = line.syls.map((s) => s.midi);
    const lo = Math.min(...ms);
    const hi = Math.max(...ms);
    const spb = 60 / (cur.song.bpm * settings.tempo);
    let word = null;
    line.syls.forEach((s, k) => {
      if (!word) {
        word = document.createElement('span');
        word.className = 'word';
        el.appendChild(word);
      }
      const sp = document.createElement('span');
      sp.className = 'syl';
      sp.textContent = s.text;
      if (isCur) {
        sp.style.setProperty('--h', hi === lo ? 0.5 : (s.midi - lo) / (hi - lo));
        const dot = document.createElement('i');
        dot.className = 'pd';
        sp.appendChild(dot);
        const secs = (s.end - s.start) * spb;
        if (secs >= 1.1) {
          sp.classList.add('hold');
          sp.style.setProperty('--len', Math.min(3, secs * 0.6).toFixed(2));
        }
      }
      word.appendChild(sp);
      s.el = isCur ? sp : null;
      if (!s.glue || k === line.syls.length - 1) {
        if (s.breath && isCur) {
          const br = document.createElement('span');
          br.className = 'breath';
          br.textContent = '🌬️';
          br.title = 'Breathe here';
          word.appendChild(br);
        }
        word = null;
      }
    });
  }

  function renderLyricLines(li) {
    const L = cur.song.lines;
    renderLine($('#lyric-cur'), L[li], true);
    renderLine($('#lyric-next'), L[li + 1], false);
    $$('#sheet-lines li').forEach((el) => el.classList.toggle('cur', +el.dataset.i === li));
  }

  function lineIndexAt(beat) {
    const L = cur.song.lines;
    for (let i = 0; i < L.length; i++) if (beat < L[i].end + 0.25) return i;
    return L.length - 1;
  }

  function updateLyrics(beat) {
    const li = lineIndexAt(beat);
    if (li !== cur.li) {
      cur.li = li;
      renderLyricLines(li);
    }
    const line = cur.song.lines[li];
    for (const s of line.syls) {
      if (!s.el) continue;
      const p = clamp((beat - s.start) / (s.end - s.start), 0, 1);
      s.el.style.setProperty('--p', p.toFixed(3));
      if (p >= 1 && !s.el.dataset.r) {
        const r = cur.stats[s.notes[s.notes.length - 1].i].r;
        s.el.classList.add('done');
        if (r) {
          s.el.classList.add('r-' + r);
          s.el.dataset.r = r;
        }
      }
    }

    // bouncing wolf: hops from syllable to syllable, riding on the pitch dots
    const box = $('#lyrics').getBoundingClientRect();
    const ball = $('#ball');
    const sy = line.syls;
    let k = sy.findIndex((s) => beat < s.end);
    if (k < 0) k = sy.length - 1;
    const spot = (s) => {
      const r = s.el.getBoundingClientRect();
      const h = parseFloat(s.el.style.getPropertyValue('--h')) || 0;
      return { x: r.left + r.width / 2 - box.left - 16, y: r.top - box.top - 52 - h * 22 };
    };
    if (sy[k] && sy[k].el) {
      const s = sy[k];
      const to = spot(s);
      let x = to.x;
      let yy = to.y;
      const prev = sy[k - 1];
      if (prev && prev.el && beat < s.start) {
        const from = spot(prev);
        const hs = Math.max(prev.start, s.start - 0.5);
        const u = clamp((beat - hs) / (s.start - hs || 1), 0, 1);
        x = lerp(from.x, to.x, u);
        yy = lerp(from.y, to.y, u) - Math.sin(Math.PI * u) * 26;
      } else if (beat < s.start) {
        yy -= Math.abs(Math.sin(beat * Math.PI)) * 10;
      }
      ball.style.transform = `translate(${x}px, ${yy}px)`;
      ball.style.opacity = 1;
    } else {
      ball.style.opacity = 0;
    }
    ball.classList.toggle('onpitch', !!cur.onPitch);

    // countdown dots before a line that starts after a pause
    const dots = $$('#countdown i');
    const rem = line.start - beat;
    const showDots = (li === 0 || line.gapBefore >= 2) && rem > 0 && rem <= 3;
    dots.forEach((d, i) => d.classList.toggle('on', showDots && i < Math.ceil(rem)));
  }

  function updateCountIn(beat) {
    const el = $('#countin');
    const first = cur.song.notes[0].t;
    const rem = Math.ceil(first - beat);
    const txt = P.playing && beat < first && rem <= cur.song.bpb ? String(rem) : '';
    if (el.textContent !== txt) {
      el.textContent = txt;
      el.classList.remove('pop');
      if (txt) { void el.offsetWidth; el.classList.add('pop'); }
    }
  }

  function renderSheet() {
    const ol = $('#sheet-lines');
    ol.innerHTML = '';
    cur.song.lines.forEach((l) => {
      const li = document.createElement('li');
      li.dataset.i = l.i;
      li.textContent = l.text;
      const acc = document.createElement('span');
      acc.className = 'acc';
      li.appendChild(acc);
      const hear = document.createElement('button');
      hear.className = 'hear';
      hear.textContent = '🔊';
      hear.title = 'Hear this line';
      hear.addEventListener('click', (e) => {
        e.stopPropagation();
        previewLine(l);
      });
      li.prepend(hear);
      li.addEventListener('click', () => {
        seekTo(l.start - cur.song.bpb);
        if (cur.loopLine != null) cur.loopLine = l.i;
        if (!P.playing) togglePlay();
      });
      ol.appendChild(li);
    });
  }

  // ------------------------------------------------------------------
  // Stage: frame + finish
  // ------------------------------------------------------------------

  function stageFrame(reading, dt) {
    const beat = beatNow();
    const song = cur.song;
    if (cur.preview && !P.playing) {
      const pb = (eng.now - cur.preview.t0) / cur.preview.spb;
      if (pb > cur.preview.end) {
        const from = cur.preview.from;
        cur.preview = null;
        seekTo(from);
      } else P.pausedBeat = pb;
    }
    if (P.playing) {
      if (!cur.listen) scoreFrame(beat, reading, dt);
      if (cur.loopLine != null) {
        const L = song.lines[cur.loopLine];
        if (beat > L.end + 0.75) {
          cur.loops++;
          if (cur.loops >= 5) award('practice');
          seekTo(L.start - song.bpb);
          return;
        }
      }
      const bi = Math.floor(beat);
      if (bi !== cur.lastBeat) {
        cur.lastBeat = bi;
        if (settings.disco && bi >= song.countIn) {
          document.body.classList.add('beat');
          setTimeout(() => document.body.classList.remove('beat'), 90);
        }
      }
      if (beat >= song.totalBeats) return finish();
    }
    updateCountIn(beat);
    drawLane(beat, reading);
    updateLyrics(beat);
    updateHud();
  }

  const GRADES = [
    { g: 'S', min: 90, title: 'Alpha Howler 👑', quips: ['The moon called. It wants your autograph.', 'Flawless. Are you secretly a professional?'] },
    { g: 'A', min: 75, title: 'Pack Leader 🐺', quips: ['The whole pack is following your lead!', 'Strong, steady, and seriously good.'] },
    { g: 'B', min: 55, title: 'Howl-ing Good 🎶', quips: ['Solid! A few more runs and you’ll be leading the pack.', 'Nice! The neighbors only complained a little.'] },
    { g: 'C', min: 35, title: 'Pup in Training 🐶', quips: ['Every great wolf started as a squeaky pup.', 'Getting there! Try a slower tempo or the guide melody.'] },
    { g: 'D', min: 0, title: 'Lost Puppy 🐾', quips: ['Hey, you showed up and sang. That’s step one!', 'The good news: there’s nowhere to go but up!'] },
  ];

  function finish() {
    if (cur.finished) return;
    if (cur.listen) {
      setListen(false);
      mc('Your turn! Press ▶ and sing it like you just heard. 🎤', true);
      return;
    }
    const song = cur.song;
    for (let i = cur.ni; i < song.notes.length; i++) finalizeNote(song.notes[i]);
    cur.ni = song.notes.length;
    cur.finished = true;
    pause();
    P.pausedBeat = song.totalBeats;
    document.body.classList.remove('hype');
    const res = computeResults();
    const G = GRADES.find((g) => res.acc >= g.min);
    recSave(mic.on ? { score: cur.score, grade: G.g } : {}, (url) => showResults(url));
  }

  function computeResults() {
    const song = cur.song;
    let s = 0;
    let d = 0;
    const counts = { perfect: 0, great: 0, okay: 0, miss: 0 };
    for (const n of song.notes) {
      const st = cur.stats[n.i];
      s += Math.min(1, st.ratio / 0.75) * n.d;
      d += n.d;
      if (st.r) counts[st.r]++;
    }
    const acc = Math.round((100 * s) / d);
    const lineAcc = song.lines.map(lineAccuracy);
    return { acc, counts, lineAcc };
  }

  function coachTips(res) {
    const song = cur.song;
    const tips = [];
    const T = cur.transpose;
    const voiced = cur.stats.reduce((a, st) => a + st.v, 0);
    const total = cur.stats.reduce((a, st) => a + st.f, 0) || 1;
    if (voiced / total < 0.5) tips.push('🔊 I could only hear you about half the time. Sing louder, get closer to the mic, or try headphones so the band doesn’t drown you out.');
    const bias = cur.diffT > 1 ? (cur.diffSum / cur.diffT) * 100 : 0;
    if (bias < -25) tips.push(`⬆ You sing a little flat on average (${Math.round(bias)} cents). Think "up": lift your eyebrows, smile a bit, and push more air from your belly.`);
    else if (bias > 25) tips.push(`⬇ You sing a little sharp on average (+${Math.round(bias)} cents). Relax your jaw and throat and let the note settle instead of pushing.`);
    else if (cur.diffT > 3) tips.push('🎯 Your average pitch is right on target. Your ear is great!');
    const group = (pred) => {
      let a = 0;
      let dd = 0;
      for (const n of song.notes) if (pred(n)) { a += Math.min(1, cur.stats[n.i].ratio / 0.75) * n.d; dd += n.d; }
      return dd ? (100 * a) / dd : null;
    };
    const longAcc = group((n) => n.d * P.spb >= 1);
    const highAcc = group((n) => n.midi >= song.hi - 2);
    const lowAcc = group((n) => n.midi <= song.lo + 2);
    if (longAcc != null && longAcc < res.acc - 10) tips.push('🌬️ Long notes wobble a bit. Practise the "Hmmm" and "Ahhh" holds in the Wolf Warm-Up and keep the airflow slow and steady.');
    if (highAcc != null && highAcc < res.acc - 15) tips.push(`🏔️ The high notes were the hardest. Try Key ${fmtKey(T - 2)} to bring the song down, or find your range in the Voice Lab.`);
    if (lowAcc != null && lowAcc < res.acc - 15) tips.push(`🕳️ The low notes were tricky. Try Key ${fmtKey(T + 2)} to lift the song a little.`);
    const worst = res.lineAcc.indexOf(Math.min(...res.lineAcc));
    if (res.acc < 90) tips.push(`🔁 Your toughest line was "${song.lines[worst].text}". Hit "Practise weakest line" to loop it at your own pace.`);
    if (settings.tempo > 0.85 && res.acc < 55) tips.push('🐢 Slow the tempo down to 70–80% while learning. Speed comes later.');
    if (!tips.length) tips.push('🌟 Honestly? Nothing to fix. Try a harder song or switch the difficulty to Pro.');
    return tips.slice(0, 4);
  }

  function showResults(url) {
    const song = cur.song;
    const res = computeResults();
    const noMic = !mic.on;
    const G = GRADES.find((g) => res.acc >= g.min);
    $('#rs-grade').textContent = noMic ? '🎤' : G.g;
    $('#rs-title').textContent = noMic ? 'Shower Singer 🚿' : G.title;
    $('#rs-quip').textContent = noMic ? 'Turn on the mic next time and I’ll score you for real!' : pick(G.quips);
    $('#rs-score').textContent = cur.score.toLocaleString();
    $('#rs-acc').textContent = noMic ? '—' : res.acc + '%';
    $('#rs-combo').textContent = cur.maxCombo;
    const c = res.counts;
    $('#rs-notes').innerHTML = noMic ? '' :
      `<span style="color:var(--yellow)">✨ ${c.perfect} perfect</span><span style="color:var(--green)">👍 ${c.great} great</span><span style="color:var(--cyan)">👌 ${c.okay} okay</span><span style="color:var(--red)">💥 ${c.miss} miss</span>`;
    const bars = $('#rs-lines');
    bars.innerHTML = '';
    const maxA = Math.max(...res.lineAcc);
    const minA = Math.min(...res.lineAcc);
    res.lineAcc.forEach((a, i) => {
      const b = document.createElement('i');
      b.style.height = Math.max(3, a) + '%';
      b.title = `Line ${i + 1}: ${a}% · ${song.lines[i].text}`;
      if (!noMic && a === maxA) b.classList.add('best');
      else if (!noMic && a === minA) b.classList.add('worst');
      bars.appendChild(b);
    });
    const tips = $('#rs-tips');
    tips.innerHTML = '';
    (noMic ? ['🎤 Tap the Mic button at the top so Coach Wolf can hear you and give you real tips.'] : coachTips(res)).forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      tips.appendChild(li);
    });
    $('#rs-rec').hidden = !url;
    if (url) {
      $('#rs-audio').src = url;
      $('#rs-download').href = url;
    }
    cur.result = { acc: res.acc, grade: G.g, lineAcc: res.lineAcc };

    // bookkeeping: best scores + badges
    let isBest = false;
    if (!noMic && !cur.practiced) {
      const best = store.get('best', {});
      if (!best[song.id] || cur.score > best[song.id].score) {
        isBest = !!best[song.id];
        best[song.id] = { score: cur.score, grade: G.g, acc: res.acc };
        store.set('best', best);
      }
    }
    $('#rs-new').hidden = !isBest;
    const done = new Set(store.get('done', []));
    done.add(song.id);
    store.set('done', [...done]);
    award('first');
    if (song.id === 'warmup') award('warmup');
    if (done.size >= LIB.length) award('all');
    if (LIB.filter((s) => s.category === 'originals').every((s) => done.has(s.id))) award('originals');
    if (!noMic && res.acc >= 75) award('gradeA');
    if (!noMic && res.acc >= 90) award('gradeS');
    if (settings.tempo <= 0.7) award('slow');
    const h = new Date().getHours();
    if (h < 5) award('night');

    $('#results').hidden = false;
    if (!noMic && res.acc >= 55) {
      eng.sfx('applause');
      confetti.rain(res.acc >= 90 ? 220 : 120, res.acc >= 90 ? '👑' : '🐺');
    } else if (!noMic) {
      eng.sfx('sad');
    } else {
      eng.sfx('rimshot');
    }
  }

  // ------------------------------------------------------------------
  // Voice Lab
  // ------------------------------------------------------------------

  const lab = { stable: [], low: null, high: null };
  const match = { active: false, target: null, hold: 0, listenUntil: 0, deadline: 0, points: 0, streak: 0, best: store.get('matchBest', 0) };
  $('#mt-best').textContent = match.best;

  (function buildPiano() {
    const p = $('#tn-piano');
    for (let m = 48; m <= 84; m++) {
      const k = document.createElement('i');
      k.dataset.m = m;
      if ([1, 3, 6, 8, 10].includes(m % 12)) k.className = 'blk';
      if (m % 12 === 0) k.innerHTML = `<b>${midiName(m)}</b>`;
      p.appendChild(k);
    }
  })();

  function voiceType(lo, hi) {
    const mid = (lo + hi) / 2;
    if (mid < 53.5) return 'Bass 🎻';
    if (mid < 57.5) return 'Baritone 🎷';
    if (mid < 62.5) return 'Tenor 🎺';
    if (mid < 67) return 'Alto 🎹';
    if (mid < 70.5) return 'Mezzo-soprano 🎼';
    return 'Soprano 🎶';
  }

  function renderRange() {
    $('#rg-low').textContent = lab.low != null ? midiName(lab.low) : '—';
    $('#rg-high').textContent = lab.high != null ? midiName(lab.high) : '—';
    const span = lab.low != null ? lab.high - lab.low : null;
    $('#rg-span').textContent = span != null ? (span >= 12 ? (span / 12).toFixed(1) + ' oct' : span + ' st') : '—';
    $('#rg-type').textContent = span != null && span >= 5 ? `You might be a ${voiceType(lab.low, lab.high)} (just for fun!)` : 'Voice type: sing to find out';
    if (span != null && span >= 18) award('range');
    if (settings.rangeLow != null) $('#rg-saved').textContent = `Songs will start in a key for ${midiName(settings.rangeLow)}–${midiName(settings.rangeHigh)}.`;
  }

  function labFrame(reading, dt) {
    const note = $('#tn-note');
    $$('#tn-piano i.on').forEach((k) => k.classList.remove('on'));
    if (reading) {
      const r = Math.round(reading.midi);
      const cents = Math.round((reading.midi - r) * 100);
      note.textContent = midiName(r);
      note.classList.toggle('in', Math.abs(cents) < 12);
      $('#tn-hz').textContent = `${reading.freq.toFixed(1)} Hz · ${cents > 0 ? '+' : ''}${cents} cents`;
      $('#tn-needle').style.left = 50 + cents + '%';
      const key = $(`#tn-piano i[data-m="${r}"]`);
      if (key) key.classList.add('on');

      const now = performance.now();
      lab.stable.push({ t: now, m: reading.midi });
      lab.stable = lab.stable.filter((s) => now - s.t < 350);
      if (lab.stable.length >= 8) {
        const ms = lab.stable.map((s) => s.m);
        if (Math.max(...ms) - Math.min(...ms) < 0.7) {
          const m = Math.round(ms.sort((a, b) => a - b)[ms.length >> 1]);
          if (lab.low == null || m < lab.low || m > lab.high) {
            lab.low = lab.low == null ? m : Math.min(lab.low, m);
            lab.high = lab.high == null ? m : Math.max(lab.high, m);
            renderRange();
          }
        }
      }
    } else {
      lab.stable = [];
    }
    matchFrame(reading, dt);
    tuneFrame(reading, dt);
  }

  function matchNext() {
    const lo = settings.rangeLow != null ? settings.rangeLow + 2 : 55;
    const hi = settings.rangeHigh != null ? settings.rangeHigh - 2 : 67;
    let t;
    do { t = lo + Math.floor(Math.random() * (Math.max(hi, lo + 4) - lo + 1)); } while (t === match.target);
    match.target = t;
    match.hold = 0;
    matchPlay();
    $('#mt-target').textContent = midiName(t);
    $('#mt-ring').classList.remove('win');
  }

  function matchPlay() {
    if (match.target == null) return;
    refTone(match.target, 1.2);
    match.listenUntil = performance.now() + 1200;
    match.deadline = performance.now() + 13000;
    $('#mt-hint').textContent = '👂 Listen...';
  }

  async function matchStart() {
    if (!mic.on && !(await enableMic())) return;
    match.active = true;
    match.points = 0;
    match.streak = 0;
    $('#mt-points').textContent = 0;
    $('#mt-streak').textContent = 0;
    $('#mt-start').textContent = '■ Stop';
    matchNext();
  }

  function matchStop() {
    match.active = false;
    $('#mt-start').textContent = '▶ Start';
    $('#mt-hint').textContent = 'Press start!';
  }

  function matchFrame(reading, dt) {
    if (!match.active) return;
    const now = performance.now();
    if (now < match.listenUntil) return;
    const hint = $('#mt-hint');
    if (reading) {
      const d = foldDiff(reading.midi, match.target);
      if (Math.abs(d) < 0.4) {
        match.hold += dt;
        hint.textContent = '🔥 Hold it!';
      } else {
        match.hold = Math.max(0, match.hold - dt * 0.5);
        hint.textContent = d < 0 ? '⬆ Go higher' : '⬇ Go lower';
      }
    } else {
      match.hold = Math.max(0, match.hold - dt * 0.3);
      hint.textContent = '🎤 Your turn! Sing it back';
    }
    const p = clamp(match.hold / 1, 0, 1);
    $('#mt-fill').style.strokeDashoffset = String(326.7 * (1 - p));
    if (p >= 1) {
      match.points++;
      match.streak++;
      if (match.streak > match.best) {
        match.best = match.streak;
        store.set('matchBest', match.best);
      }
      if (match.streak >= 5) award('ear');
      $('#mt-points').textContent = match.points;
      $('#mt-streak').textContent = match.streak;
      $('#mt-best').textContent = match.best;
      hint.textContent = pick(['🎯 Nailed it!', '🐺 AWOOO! Perfect!', '✨ Golden ear!', '👏 Bullseye!']);
      $('#mt-ring').classList.add('win');
      eng.sfx('ding');
      const r = $('#mt-ring').getBoundingClientRect();
      confetti.burst(r.left + r.width / 2, r.top + r.height / 2, 40);
      match.listenUntil = now + 900;
      setTimeout(() => match.active && matchNext(), 900);
    } else if (now > match.deadline) {
      match.streak = 0;
      $('#mt-streak').textContent = 0;
      hint.textContent = `💤 Time's up! It was ${midiName(match.target)}.`;
      eng.sfx('boing');
      match.listenUntil = now + 1500;
      setTimeout(() => match.active && matchNext(), 1500);
    }
  }

  // ------------------------------------------------------------------
  // Tune Mode: pick a note, hear it, slide onto it and hold it
  // ------------------------------------------------------------------

  const SCALE_STEPS = [2, 2, 1, 2, 2, 2, 1];
  const tune = { target: 60, hold: 0, locks: 0, trail: [], stopDrone: null, climb: false, climbPos: 0, climbRoot: 60, cool: 0 };
  const TUNE_LOCK = 0.3; // semitones (30 cents)
  const TUNE_HOLD = 1.5; // seconds

  (function buildTuneKeys() {
    const box = $('#tu-keys');
    const whites = [];
    for (let m = 48; m <= 72; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
    const w = 100 / whites.length;
    whites.forEach((m, i) => {
      const k = document.createElement('button');
      k.className = 'wk';
      k.dataset.m = m;
      k.style.left = i * w + '%';
      k.style.width = w + '%';
      k.innerHTML = `<b>${midiName(m)}</b>`;
      k.setAttribute('aria-label', midiName(m));
      box.appendChild(k);
      if ([0, 2, 5, 7, 9].includes(m % 12) && m < 72) {
        const b = document.createElement('button');
        b.className = 'bk';
        b.dataset.m = m + 1;
        b.style.left = (i + 1) * w - w * 0.3 + '%';
        b.style.width = w * 0.6 + '%';
        b.setAttribute('aria-label', midiName(m + 1));
        box.appendChild(b);
      }
    });
    box.addEventListener('click', (e) => {
      const k = e.target.closest('[data-m]');
      if (!k) return;
      tune.climb = false;
      $('#tu-climb').setAttribute('aria-pressed', 'false');
      setTuneTarget(+k.dataset.m, true);
    });
  })();

  function setTuneTarget(m, play) {
    tune.target = clamp(m, 40, 84);
    tune.hold = 0;
    tune.trail = [];
    $('#tu-target').textContent = midiName(tune.target);
    $$('#tu-keys [data-m]').forEach((k) => k.classList.toggle('on', +k.dataset.m === tune.target));
    if (tune.stopDrone) {
      tune.stopDrone();
      tune.stopDrone = eng.drone(tune.target, 'a', settings.singer === 'synth' ? 'wolfie' : settings.singer);
    } else if (play) {
      refTone(tune.target, 1.4);
    }
    $('#tu-status').textContent = mic.on ? '🎤 Slide your voice onto the line' : '🎤 Turn on the mic, then sing the note';
  }

  function toggleDrone(on) {
    if (tune.stopDrone) { tune.stopDrone(); tune.stopDrone = null; }
    if (on) tune.stopDrone = eng.drone(tune.target, 'a', settings.singer === 'synth' ? 'wolfie' : settings.singer);
    $('#tu-drone').setAttribute('aria-pressed', String(on));
  }

  function climbNote(pos) {
    // up the major scale for 8 notes, then back down
    const up = pos <= 7 ? pos : 14 - pos;
    let m = tune.climbRoot;
    for (let i = 0; i < up; i++) m += SCALE_STEPS[i];
    return m;
  }

  function tuneFrame(reading, dt) {
    const cv = $('#tu-graph');
    const dpr = devicePixelRatio || 1;
    const W = cv.clientWidth;
    const H = cv.clientHeight;
    if (!W) return;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const now = performance.now();
    const RANGE = 3;
    const y = (d) => H / 2 - (clamp(d, -RANGE, RANGE) / RANGE) * (H / 2 - 10);

    let diff = null;
    if (reading) diff = foldDiff(reading.midi, tune.target);
    tune.trail.push({ t: now, d: diff });
    while (tune.trail.length && now - tune.trail[0].t > 6000) tune.trail.shift();

    // bands
    g.fillStyle = 'rgba(77,255,145,0.10)';
    g.fillRect(0, y(0.75), W, y(-0.75) - y(0.75));
    g.fillStyle = 'rgba(77,255,145,0.22)';
    g.fillRect(0, y(TUNE_LOCK), W, y(-TUNE_LOCK) - y(TUNE_LOCK));
    g.font = '700 11px Nunito, sans-serif';
    for (let s2 = -RANGE; s2 <= RANGE; s2++) {
      g.fillStyle = s2 === 0 ? 'rgba(255,210,63,0.9)' : 'rgba(255,255,255,0.08)';
      g.fillRect(0, y(s2), W, s2 === 0 ? 2 : 1);
      if (s2) {
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillText(midiName(tune.target + s2), 6, y(s2) + 4);
      }
    }
    g.fillStyle = '#ffd23f';
    g.fillText(midiName(tune.target) + ' 🎯', 6, y(0) - 6);

    // your voice
    const X = (t) => W - 40 - ((now - t) / 6000) * (W - 80);
    g.save();
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowBlur = 10;
    let pen = false;
    g.beginPath();
    for (const p of tune.trail) {
      if (p.d == null) { pen = false; continue; }
      if (pen) g.lineTo(X(p.t), y(p.d)); else g.moveTo(X(p.t), y(p.d));
      pen = true;
    }
    const locked = diff != null && Math.abs(diff) < TUNE_LOCK;
    g.strokeStyle = locked ? '#4dff91' : '#ffffff';
    g.shadowColor = g.strokeStyle;
    g.stroke();
    if (diff != null) {
      g.beginPath();
      g.fillStyle = g.strokeStyle;
      g.arc(W - 40, y(diff), 9, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // hold meter along the bottom
    g.fillStyle = 'rgba(255,255,255,0.1)';
    g.fillRect(0, H - 6, W, 6);
    g.fillStyle = '#4dff91';
    g.fillRect(0, H - 6, (W * tune.hold) / TUNE_HOLD, 6);

    const st = $('#tu-status');
    if (!mic.on) return;
    if (now < tune.cool) return;
    if (diff == null) {
      tune.hold = Math.max(0, tune.hold - dt * 0.5);
      st.textContent = '🎤 Sing ' + midiName(tune.target);
      return;
    }
    const cents = Math.round(diff * 100);
    if (locked) {
      tune.hold += dt;
      st.textContent = `🔒 Locked in! Hold it... (${cents > 0 ? '+' : ''}${cents}¢)`;
    } else {
      tune.hold = Math.max(0, tune.hold - dt);
      const far = Math.abs(diff) > 1 ? ' a lot' : ' a little';
      st.textContent = diff < 0 ? `⬆ Go higher${far} (${cents}¢)` : `⬇ Go lower${far} (+${cents}¢)`;
    }
    if (tune.hold >= TUNE_HOLD) {
      tune.hold = 0;
      tune.locks++;
      $('#tu-locks').textContent = tune.locks;
      if (tune.locks >= 10) award('tune');
      eng.sfx('ding');
      const r = cv.getBoundingClientRect();
      confetti.burst(r.right - 40, r.top + y(diff), 30);
      tune.cool = now + 700;
      if (tune.climb) {
        tune.climbPos = (tune.climbPos + 1) % 15;
        if (tune.climbPos === 0) {
          st.textContent = '🪜 You climbed the whole scale! AWOOO!';
          eng.sfx('fanfare');
        } else {
          st.textContent = pick(['🎯 Nice!', '✨ Got it!', '🐺 Awoo!']) + ' Next: ' + midiName(climbNote(tune.climbPos));
        }
        setTimeout(() => setTuneTarget(climbNote(tune.climbPos), true), 700);
      } else {
        st.textContent = pick(['🎯 Nailed it! Try another key.', '✨ Perfectly in tune!', '🐺 AWOOO! Locked!']);
      }
    }
  }

  $('#tu-play').addEventListener('click', () => refTone(tune.target, 1.4));
  $('#tu-up').addEventListener('click', () => setTuneTarget(tune.target + 1, true));
  $('#tu-down').addEventListener('click', () => setTuneTarget(tune.target - 1, true));
  $('#tu-drone').addEventListener('click', () => toggleDrone(!tune.stopDrone));
  $('#tu-climb').addEventListener('click', () => {
    tune.climb = !tune.climb;
    $('#tu-climb').setAttribute('aria-pressed', String(tune.climb));
    if (tune.climb) {
      tune.climbRoot = tune.target;
      tune.climbPos = 0;
      toast(`🪜 Scale climb from ${midiName(tune.target)}: lock each note to move up.`, true);
      setTuneTarget(tune.target, true);
    }
  });
  setTuneTarget(settings.rangeLow != null ? Math.round((settings.rangeLow + settings.rangeHigh) / 2) - 3 : 60, false);

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------

  let lastTs = performance.now();
  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (ts - lastTs) / 1000);
    lastTs = ts;
    const reading = mic.on && (screen === 'stage' || screen === 'lab') ? mic.read() : null;
    $('.mic-meter i').style.width = (mic.on ? mic.level * 100 : 0) + '%';
    if (screen === 'stage' && cur) stageFrame(reading, dt);
    else if (screen === 'lab') labFrame(reading, dt);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  $$('[data-go]').forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));
  $$('.chip').forEach((c) => c.addEventListener('click', () => {
    homeCat = c.dataset.cat;
    $$('.chip').forEach((x) => x.classList.toggle('active', x === c));
    renderHome();
  }));
  $$('[data-song]').forEach((b) => b.addEventListener('click', () => openStage(byId(b.dataset.song))));
  $('#btn-quick').addEventListener('click', () => openStage(pick(LIB.filter((s) => s.category !== 'warmups'))));

  $('#btn-mic').addEventListener('click', () => (mic.on ? disableMic() : enableMic().then((ok) => ok && cur && screen === 'stage' && mc('intro', true))));
  $('#btn-back').addEventListener('click', () => show('home'));
  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-restart').addEventListener('click', () => cur && restart());
  $('#btn-loop').addEventListener('click', () => {
    if (!cur) return;
    const on = cur.loopLine == null;
    cur.loopLine = on ? lineIndexAt(beatNow()) : null;
    cur.loops = 0;
    if (on) cur.practiced = true;
    $('#btn-loop').setAttribute('aria-pressed', String(on));
    toast(on ? `🔁 Looping line ${cur.loopLine + 1}. Tap again to stop.` : '🔁 Loop off', true);
  });
  $('#btn-rec').setAttribute('aria-pressed', String(settings.record));
  $('#btn-rec').addEventListener('click', () => {
    settings.record = !settings.record;
    saveSettings();
    $('#btn-rec').setAttribute('aria-pressed', String(settings.record));
    if (settings.record) {
      const armed = () => {
        toast('⏺ Recording is on: press ▶ and sing. Your voice + the music get saved in 🎧 Takes.', true);
        if (P.playing) recStart();
      };
      if (mic.on) armed();
      else enableMic().then((ok) => ok && armed());
    } else {
      recSave();
      toast('⏺ Recording off', true);
    }
  });
  $('#btn-listen').addEventListener('click', () => cur && setListen(!cur.listen));
  $('#btn-hear').addEventListener('click', () => {
    if (!cur) return;
    if (cur.listen) setListen(false);
    previewLine(cur.song.lines[lineIndexAt(beatNow())]);
  });
  const singerSel = $('#sel-singer');
  singerSel.value = settings.singer;
  singerSel.addEventListener('change', () => {
    settings.singer = singerSel.value;
    saveSettings();
    if (tune.stopDrone) toggleDrone(true);
    // a quick hello so you can hear the new singer
    if (cur && !P.playing) {
      eng.ensure();
      applyVolumes();
      const m = cur.song.notes[0].midi + cur.transpose;
      singNote({ v: 'a', on: true }, m, eng.now + 0.05, 0.35);
      singNote({ v: 'u', on: true }, m + 4, eng.now + 0.45, 0.35);
      singNote({ v: 'o', on: true }, m + 7, eng.now + 0.85, 0.7);
    }
  });
  $('#btn-sheet').addEventListener('click', () => { $('#sheet').hidden = !$('#sheet').hidden; });
  $('#sheet-close').addEventListener('click', () => { $('#sheet').hidden = true; });

  const tempoIn = $('#in-tempo');
  tempoIn.value = Math.round(settings.tempo * 100);
  $('#out-tempo').textContent = tempoIn.value + '%';
  tempoIn.addEventListener('input', () => {
    settings.tempo = tempoIn.value / 100;
    $('#out-tempo').textContent = tempoIn.value + '%';
    saveSettings();
    if (cur && P.playing) play(beatNow());
  });

  function changeKey(delta) {
    if (!cur) return;
    cur.transpose = clamp(cur.transpose + delta, -12, 12);
    $('#out-key').textContent = fmtKey(cur.transpose);
    const keys = store.get('keys', {});
    keys[cur.song.id] = cur.transpose;
    store.set('keys', keys);
    award('key');
    if (!P.playing) {
      eng.ensure();
      applyVolumes();
      eng.guide(cur.song.notes[0].midi + cur.transpose, eng.now + 0.02, 0.4);
    }
  }
  $('#key-down').addEventListener('click', () => changeKey(-1));
  $('#key-up').addEventListener('click', () => changeKey(1));

  const guideIn = $('#in-guide');
  const bandIn = $('#in-band');
  guideIn.value = settings.guideVol;
  bandIn.value = settings.bandVol;
  guideIn.addEventListener('input', () => { settings.guideVol = +guideIn.value; saveSettings(); applyVolumes(); });
  bandIn.addEventListener('input', () => { settings.bandVol = +bandIn.value; saveSettings(); applyVolumes(); });

  const SFX_EMOJI = { howl: '🐺', airhorn: '📯', applause: '👏', rimshot: '🥁', boing: '🌀', ooh: '😮' };
  function fireSfx(name, btn) {
    eng.sfx(name);
    const r = btn.getBoundingClientRect();
    floaty(SFX_EMOJI[name], r.left + r.width / 2, r.top, name === 'applause' ? 8 : 5);
    btn.classList.add('hit');
    setTimeout(() => btn.classList.remove('hit'), 150);
    const n = store.get('sfxCount', 0) + 1;
    store.set('sfxCount', n);
    if (n >= 30) award('sound');
    if (cur && performance.now() > cur.hypeUntil) {
      cur.hype = clamp(cur.hype + 2, 0, 99);
    }
  }
  $$('.sfx[data-sfx]').forEach((b) => b.addEventListener('click', () => fireSfx(b.dataset.sfx, b)));

  function setDisco(on) {
    settings.disco = on;
    saveSettings();
    document.body.classList.toggle('disco', on);
    $('#btn-disco').setAttribute('aria-pressed', String(on));
    $('#set-disco').checked = on;
  }
  $('#btn-disco').addEventListener('click', () => setDisco(!settings.disco));
  setDisco(settings.disco);

  // Lab
  $('#rg-reset').addEventListener('click', () => { lab.low = lab.high = null; renderRange(); });
  $('#rg-save').addEventListener('click', () => {
    if (lab.low == null || lab.high - lab.low < 5) return toast('Sing a few more notes first, low and high!', true);
    settings.rangeLow = lab.low;
    settings.rangeHigh = lab.high;
    saveSettings();
    store.set('keys', {});
    renderRange();
    toast('🎢 Range saved! Songs will now start in your key.');
  });
  $('#mt-start').addEventListener('click', () => (match.active ? matchStop() : matchStart()));
  $('#mt-again').addEventListener('click', () => { if (match.active) matchPlay(); });
  renderRange();

  // Results
  $('#rs-again').addEventListener('click', () => { $('#results').hidden = true; restart(); });
  $('#rs-takes').addEventListener('click', () => { $('#results').hidden = true; show('takes'); });
  $('#rs-home').addEventListener('click', () => { $('#results').hidden = true; show('home'); });
  $('#rs-practice').addEventListener('click', () => {
    $('#results').hidden = true;
    const la = cur.result.lineAcc;
    const worst = la.indexOf(Math.min(...la));
    const song = cur.song;
    openStage(song);
    cur.loopLine = worst;
    cur.practiced = true;
    $('#btn-loop').setAttribute('aria-pressed', 'true');
    if (settings.tempo > 0.8) {
      settings.tempo = 0.8;
      tempoIn.value = 80;
      $('#out-tempo').textContent = '80%';
      saveSettings();
    }
    seekTo(song.lines[worst].start - song.bpb);
    play(beatNow());
    toast(`🎯 Looping line ${worst + 1} at ${Math.round(settings.tempo * 100)}% speed`, true);
  });
  $('#rs-share').addEventListener('click', async () => {
    const r = cur.result;
    const txt = `🐺 I scored ${cur.score.toLocaleString()} (${r.grade}, ${r.acc}% accuracy) on "${cur.song.title}" in Karaoke Wolf! AWOOO!`;
    try {
      await navigator.clipboard.writeText(txt);
      toast('📋 Copied! Go brag.', true);
    } catch (e) {
      toast(txt, true);
    }
  });

  // Settings
  const setEls = {
    diff: $('#set-diff'), octave: $('#set-octave'), headphones: $('#set-headphones'),
    echo: $('#set-echo'), ding: $('#set-ding'), disco: $('#set-disco'),
  };
  function openSettings() {
    setEls.diff.value = settings.difficulty;
    setEls.octave.checked = settings.octaveFree;
    setEls.headphones.checked = settings.headphones;
    setEls.echo.checked = settings.echo;
    setEls.ding.checked = settings.ding;
    setEls.disco.checked = settings.disco;
    $('#settings').hidden = false;
  }
  $('#btn-settings').addEventListener('click', openSettings);
  $('#set-close').addEventListener('click', () => { $('#settings').hidden = true; });
  setEls.diff.addEventListener('change', () => { settings.difficulty = setEls.diff.value; saveSettings(); });
  setEls.octave.addEventListener('change', () => { settings.octaveFree = setEls.octave.checked; saveSettings(); });
  setEls.ding.addEventListener('change', () => { settings.ding = setEls.ding.checked; saveSettings(); });
  setEls.disco.addEventListener('change', () => setDisco(setEls.disco.checked));
  setEls.echo.addEventListener('change', () => {
    settings.echo = setEls.echo.checked;
    saveSettings();
    mic.setEcho(settings.echo);
    if (settings.echo) toast('🎧 Echo Wolf on. Headphones please, or it will squeal!', true);
  });
  setEls.headphones.addEventListener('change', async () => {
    settings.headphones = setEls.headphones.checked;
    saveSettings();
    if (mic.on) {
      mic.disable();
      await enableMic();
    }
  });
  $('#set-reset').addEventListener('click', () => {
    if (!confirm('Reset all scores, badges and saved keys?')) return;
    ['best', 'badges', 'done', 'keys', 'sfxCount', 'matchBest'].forEach((k) => store.set(k, k === 'badges' || k === 'done' ? [] : k === 'sfxCount' || k === 'matchBest' ? 0 : {}));
    earned.clear();
    toast('🧹 Fresh start!', true);
    renderHome();
  });

  // Keyboard shortcuts
  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'Escape') {
      if (!$('#settings').hidden) $('#settings').hidden = true;
      else if (!$('#results').hidden) $('#results').hidden = true;
      else if (!$('#sheet').hidden) $('#sheet').hidden = true;
      else if (screen !== 'home') show('home');
      return;
    }
    if (screen !== 'stage' || !$('#results').hidden) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'r' || e.key === 'R') restart();
    else if (e.key === 'l' || e.key === 'L') $('#btn-loop').click();
    else if (e.key === 'd' || e.key === 'D') setDisco(!settings.disco);
    else if (e.key === 'ArrowUp') changeKey(1);
    else if (e.key === 'ArrowDown') changeKey(-1);
    else if (e.key >= '1' && e.key <= '6') {
      const b = $$('.sfx[data-sfx]')[+e.key - 1];
      fireSfx(b.dataset.sfx, b);
    }
  });

  document.addEventListener('visibilitychange', () => { if (document.hidden && P.playing) pause(); });

  // Version + build time and a live clock in the header
  (function versionAndClock() {
    const V = window.KW_VERSION || { version: '1', build: 'dev' };
    const built = V.builtAt ? new Date(V.builtAt) : null;
    const fmtBuilt = built
      ? built.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'local build';
    const label = `v${V.version}.${V.build}`;
    const el = $('#version');
    el.textContent = `${label} · ${fmtBuilt}`;
    el.title = `Karaoke Wolf ${label}${V.commit ? ' (' + V.commit + ')' : ''}, built ${fmtBuilt}`;
    const tEl = $('#clock-time');
    const dEl = $('#clock-date');
    function tick() {
      const now = new Date();
      tEl.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      dEl.textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }
    tick();
    setInterval(tick, 1000);
  })();

  renderHome();

  // Exposed for tests and curious wolves.
  window.KaraokeWolf = { LIB, buildSong, parseTokens, noteToMidi, state: () => cur, beatNow, tune, eng };
})();
