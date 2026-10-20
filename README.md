# 🐺 Karaoke Wolf

A silly, sparkly karaoke app that actually helps you get better at singing.
Pick a song, turn on your mic, and follow the glowing notes.

It runs entirely in your browser: no server, no account, no install.

## What's inside

**Singing**
- A scrolling **pitch lane** shows every note as a bar. Your voice is the glowing trail, so you can see if you're too high or too low.
- Live **"higher / lower" arrows** when you drift off the note.
- **Karaoke lyrics** that fill in syllable by syllable, with a **bouncing wolf** that hops along the pitch dots above each word.
- Visual cues: pitch dots (higher dot = higher note), hold lines on long notes, 🌬️ breath marks, and countdown dots before each line.
- Every note is scored Perfect / Great / Okay / Miss, with combos and a hype meter. Fill it up for **HYPE MODE** (double points).

**Learning**
- **Coach Wolf** comments live ("a little flat, like a pancake 🥞") and gives tips at the end: whether you sing flat or sharp, how you did on long, high and low notes, and which line to practise.
- **👂 Listen** plays the whole song sung for you (no scoring), and **🔊 Hear line** sings just the current line, so you can learn the tune before you try. Pick the guide **Singer**: 🐺 Wolfie (warm), ✨ Aria (bright, clear), 🎸 Rocco (deep rock, an octave down) or 🎹 a plain synth.
- **Loop line** + **tempo** slider (50–130%) to drill the hard bits. Tap any line in the lyric sheet to jump there.
- **Key** buttons move a song into your range. The guide melody and band volumes are adjustable.
- **Record** your voice together with the music. Every take is saved on your device in **🎧 Takes**, where you can play, download or delete it.
- **Tune Mode** (Voice Lab): pick any note on the keyboard, hear it, then slide your voice onto the target line and hold it in the green band. Has a drone for constant reference and a scale-climb drill.
- **Voice Lab**: a tuner, a range finder (with a just-for-fun voice type), and **Match the Note**, an ear-training game.
- Settings for difficulty, octave forgiveness, headphones mode and an "Echo Wolf" reverb on your voice.

**Bells & whistles**
- Soundboard: howl, air horn, applause, ba-dum-tss, boing, crowd "ooh" (keys 1–6)
- Disco lights, confetti, emoji floaties, 19 badges to unlock, personal bests

## Songs

All songs are public domain or Karaoke Wolf originals (with some wolf-themed rewrites):
Twinkle Twinkle, Mary Had a Little Wolf, Are You Sleeping Brother Wolf, Howl Howl Howl Your Song,
Happy Howl-day, Old MacDonald Had a Wolf, plus originals *Howl at the Moon*, *My Cat Thinks He's a Wolf*,
*Pizza at Midnight*, five original modern rock songs (*Full Moon Riot*, *Static Heart*, *Run With the Pack*, *Neon Fangs*, *Thunder in the Garage*) with a distorted-guitar rock band, and the *Wolf Warm-Up*.

Adding a song is easy: add an entry to [`js/songs.js`](js/songs.js). Each lyric line is a list of
`syllable:Note/beats` tokens, for example `'Twin-:C4 kle:C4 twin-:G4 kle:G4 lit-:A4 tle:A4 star:G4/2'`.
The backing band (chords, bass and drums) is generated from the melody automatically.

## Run it

Open `index.html` through any static web server, for example:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

The mic needs `localhost` or `https`. Headphones give the most accurate scoring.

## Deploy

The included GitHub Actions workflow publishes the app to GitHub Pages on every push to `main`.
Turn it on once in **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play / pause |
| R | Restart |
| L | Loop current line |
| ↑ / ↓ | Key up / down |
| 1–6 | Soundboard |
| D | Disco lights |
| Esc | Close / back |
