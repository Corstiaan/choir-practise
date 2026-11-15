/* Audio engine: plays the note lists of a song through the Web Audio API.
 *
 * Time is kept in "song seconds" (seconds at the song's written tempo).
 * A playback rate stretches that onto the audio clock, so tempo changes
 * never change the pitch. Notes are scheduled a fraction of a second ahead.
 */
(function () {
  'use strict';

  var LOOKAHEAD = 0.25;      // seconds of audio scheduled ahead
  var LOOKAHEAD_HIDDEN = 1.6; // background tabs get throttled timers
  var TICK_MS = 30;

  // Vowel formants (Hz, bandwidth, gain) for the sung sounds.
  var VOWELS = {
    ooh: { high: [[400, 90, 1], [900, 110, 0.32], [2700, 170, 0.05]], low: [[330, 80, 1], [800, 100, 0.3], [2400, 160, 0.05]] },
    aah: { high: [[850, 110, 1], [1250, 120, 0.6], [2850, 180, 0.12]], low: [[700, 100, 1], [1100, 110, 0.55], [2600, 170, 0.12]] }
  };

  function Engine() {
    this.ctx = null;
    this.song = null;
    this.rate = 1;
    this.playing = false;
    this.pos = 0;            // song position while stopped or paused
    this.loop = null;        // {start, end} in song seconds
    this.sound = 'ooh';      // ooh | aah | piano, for the vocal parts
    this.clickOn = false;
    this.strips = {};
    this.levels = {};
    this.active = [];
    this.waves = {};
    this.piano = null;       // midi -> {buffer, offset}
    this.onended = null;
    this._timer = null;
  }

  Engine.prototype.ensureContext = function () {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS only */ }
    var ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    this.analyser = ctx.createAnalyser();
    this.master.connect(comp); comp.connect(this.analyser); this.analyser.connect(ctx.destination);
    this._buildStrips();
    this._decodePiano();
  };

  Engine.prototype._buildStrips = function () {
    if (!this.ctx || !this.song) return;
    var ctx = this.ctx, self = this;
    Object.keys(this.strips).forEach(function (id) { self.strips[id].gain.disconnect(); });
    this.strips = {};
    var voices = this.song.channels.filter(function (c) { return c.kind === 'voice'; });
    var ids = this.song.channels.map(function (c) { return c.id; }).concat(['click']);
    ids.forEach(function (id) {
      var gain = ctx.createGain();
      gain.gain.value = self.levels[id] == null ? 0.5 : self.levels[id];
      var out = gain;
      var vi = voices.map(function (c) { return c.id; }).indexOf(id);
      if (vi >= 0 && voices.length > 1 && ctx.createStereoPanner) {
        var pan = ctx.createStereoPanner();
        pan.pan.value = -0.35 + 0.7 * vi / (voices.length - 1); // spread the voices left to right
        gain.connect(pan); out = pan;
      }
      out.connect(self.master);
      self.strips[id] = { gain: gain };
    });
  };

  Engine.prototype._decodePiano = function () {
    var data = window.CHOIR_PIANO_SAMPLES, self = this;
    if (!data || this.piano || !this.ctx) return;
    this.piano = {};
    Object.keys(data).forEach(function (midi) {
      var bin = atob(data[midi]), buf = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      var done = function (audio) {
        // skip the silent lead-in that MP3 encoding adds
        var ch = audio.getChannelData(0), n = Math.min(ch.length, 4000), start = 0;
        for (var j = 0; j < n; j++) { if (Math.abs(ch[j]) > 0.004) { start = j; break; } }
        self.piano[midi] = { buffer: audio, offset: Math.max(0, start - 8) / audio.sampleRate };
      };
      try {
        var p = self.ctx.decodeAudioData(buf.buffer, done, function () {});
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* synth piano is used instead */ }
    });
  };

  Engine.prototype.load = function (song) {
    this.stop();
    this.song = song;
    this.loop = null;
    this.pos = 0;
    var beats = [];
    song.measures.forEach(function (m) {
      for (var b = 0; b < m.beats; b++) beats.push({ t: m.t + m.d * b / m.beats, strong: b === 0 });
    });
    this.beats = beats;
    this.kinds = {};
    var avg = {};
    song.channels.forEach(function (c) {
      var sum = 0;
      c.notes.forEach(function (n) { sum += n[2]; });
      avg[c.id] = c.notes.length ? sum / c.notes.length : 60;
    });
    this.avgPitch = avg;
    if (this.ctx) this._buildStrips();
  };

  Engine.prototype.setLevel = function (id, value) {
    this.levels[id] = value;
    var s = this.strips[id];
    if (s) s.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02);
  };

  // ---- clock -------------------------------------------------------------
  Engine.prototype._promote = function (now) {
    if (this.pending && now >= this.pending.ctx) { this.anchor = this.pending; this.pending = null; }
  };

  /** Song position for the display: what is being heard right now. */
  Engine.prototype.position = function () {
    if (!this.playing) return this.pos;
    var now = this.ctx.currentTime;
    this._promote(now);
    var heard = now - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    var t = this.anchor.song + (heard - this.anchor.ctx) * this.rate;
    var end = this.loop ? this.loop.end : this.song.duration;
    return Math.max(this.floor, Math.min(end, t));
  };

  Engine.prototype.setRate = function (rate) {
    if (this.playing) {
      var now = this.ctx.currentTime;
      this._promote(now);
      var s = this.anchor.song + (now - this.anchor.ctx) * this.rate;
      this.anchor.ctx = now; this.anchor.song = s;
      if (this.pending && this.loop) this.pending.ctx = now + (this.loop.end - s) / rate;
      if (this.endCtx != null) this.endCtx = now + (this.song.duration + 0.4 - s) / rate;
    }
    this.rate = rate;
  };

  Engine.prototype.setLoop = function (loop) {
    var wasPlaying = this.playing, p = this.position();
    if (wasPlaying) this._halt();
    this.loop = loop;
    if (loop && (p < loop.start || p >= loop.end - 0.01)) p = loop.start;
    this.pos = p;
    if (wasPlaying) this._start(false);
  };

  // ---- transport ---------------------------------------------------------
  Engine.prototype.play = function (countIn) {
    if (!this.song || this.playing) return;
    this.ensureContext();
    var end = this.loop ? this.loop.end : this.song.duration;
    if (this.pos >= end - 0.05) this.pos = this.loop ? this.loop.start : 0;
    this._start(countIn);
  };

  Engine.prototype._start = function (countIn) {
    var ctx = this.ctx, p = this.pos, self = this;
    var startCtx = ctx.currentTime + 0.08;
    if (countIn) {
      var m = this._measureAt(p), beat = m.d / m.beats / this.rate;
      for (var b = 0; b < m.beats; b++) this._click(startCtx + b * beat, b === 0, true);
      startCtx += m.beats * beat;
    }
    this.anchor = { ctx: startCtx, song: p };
    this.sched = this.anchor;
    this.pending = null;
    this.endCtx = null;
    this.floor = p;
    this.schedPos = p;
    this._seekIndices(p, true);
    this.playing = true;
    this._tick();
    this._timer = setInterval(function () { self._tick(); }, TICK_MS);
  };

  Engine.prototype._halt = function () {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.playing) this.pos = this.position();
    this.playing = false;
    this.pending = null;
    var now = this.ctx ? this.ctx.currentTime : 0;
    this.active.forEach(function (v) { v.kill(now); });
    this.active = [];
  };

  Engine.prototype.pause = function () { this._halt(); };

  Engine.prototype.stop = function () {
    this._halt();
    this.pos = this.loop ? this.loop.start : 0;
  };

  Engine.prototype.seek = function (t) {
    var wasPlaying = this.playing;
    if (wasPlaying) this._halt();
    this.pos = Math.max(0, Math.min(this.song.duration, t));
    if (wasPlaying) this._start(false);
  };

  Engine.prototype._measureAt = function (t) {
    var ms = this.song.measures, lo = 0, hi = ms.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ms[mid].t <= t + 1e-6) lo = mid; else hi = mid - 1; }
    return ms[lo];
  };

  // ---- scheduler ---------------------------------------------------------
  Engine.prototype._seekIndices = function (p, sustain) {
    var self = this;
    this.idx = {};
    this.song.channels.forEach(function (c) {
      var i = 0, notes = c.notes;
      while (i < notes.length && notes[i][0] < p - 1e-4) {
        // a sung note that is already sounding at p is picked up mid-note
        if (sustain && c.kind === 'voice' && notes[i][0] + notes[i][1] > p + 0.08) {
          self._note(c, notes[i], self.anchor.ctx, notes[i][0] + notes[i][1]);
        }
        i++;
      }
      self.idx[c.id] = i;
    });
    var b = 0;
    while (b < this.beats.length && this.beats[b].t < p - 1e-4) b++;
    this.beatIdx = b;
  };

  Engine.prototype._tick = function () {
    if (!this.playing) return;
    var ctx = this.ctx, now = ctx.currentTime;
    this._promote(now);
    var horizonCtx = now + (document.hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD);
    for (var guard = 0; guard < 8; guard++) {
      var a = this.sched;
      var horizon = a.song + (horizonCtx - a.ctx) * this.rate;
      var end = this.loop ? this.loop.end : this.song.duration + 0.4;
      var until = Math.min(horizon, end);
      if (until > this.schedPos) { this._scheduleRange(this.schedPos, until, a); this.schedPos = until; }
      if (horizon < end) break;
      var endCtx = a.ctx + (end - a.song) / this.rate;
      if (!this.loop) { this.endCtx = endCtx; break; }
      // wrap around: everything still sounding stops at the loop end
      this.active.forEach(function (v) { if (!v.released) { v.release(endCtx); v.released = endCtx; } });
      this.pending = { ctx: endCtx, song: this.loop.start };
      this.sched = this.pending;
      this.schedPos = this.loop.start;
      var keep = this.anchor; this.anchor = this.pending;
      this._seekIndices(this.loop.start, false);
      this.anchor = keep;
      this.floor = this.loop.start;
    }
    this.active = this.active.filter(function (v) { return !v.released || now < v.released + 1.5; });
    if (this.endCtx != null && now >= this.endCtx) {
      this._halt();
      this.pos = 0;
      if (this.onended) this.onended();
    }
  };

  Engine.prototype._scheduleRange = function (from, to, a) {
    var self = this, rate = this.rate;
    this.song.channels.forEach(function (c) {
      var notes = c.notes, i = self.idx[c.id];
      while (i < notes.length && notes[i][0] < to) {
        var n = notes[i];
        self._note(c, n, a.ctx + (n[0] - a.song) / rate, n[0] + n[1]);
        i++;
      }
      self.idx[c.id] = i;
    });
    while (this.beatIdx < this.beats.length && this.beats[this.beatIdx].t < to) {
      var b = this.beats[this.beatIdx++];
      if (this.clickOn && b.t >= from - 1e-4) this._click(a.ctx + (b.t - a.song) / rate, b.strong, false);
    }
    this.active.forEach(function (v) {
      if (!v.released && v.end <= to) {
        v.released = a.ctx + (v.end - a.song) / rate;
        v.release(v.released);
      }
    });
  };

  // ---- sound -------------------------------------------------------------
  Engine.prototype._note = function (channel, n, when, endSong) {
    var strip = this.strips[channel.id];
    if (!strip) return;
    when = Math.max(when, this.ctx.currentTime + 0.005);
    var v = (channel.kind === 'voice' && this.sound !== 'piano')
      ? this._sing(strip.gain, n[2], n[3], when, this.avgPitch[channel.id] >= 57 ? 'high' : 'low')
      : this._pianoNote(strip.gain, n[2], n[3], when, channel.kind === 'voice');
    v.end = endSong;
    v.released = 0;
    this.active.push(v);
  };

  Engine.prototype._wave = function (midi, register) {
    var key = this.sound + register + midi;
    if (this.waves[key]) return this.waves[key];
    var f0 = 440 * Math.pow(2, (midi - 69) / 12);
    var count = Math.max(1, Math.min(48, Math.floor(5200 / f0)));
    var real = new Float32Array(count + 1), imag = new Float32Array(count + 1);
    var formants = (VOWELS[this.sound] || VOWELS.ooh)[register];
    for (var h = 1; h <= count; h++) {
      var f = h * f0, env = 0.05;
      for (var k = 0; k < formants.length; k++) {
        var d = (f - formants[k][0]) / formants[k][1];
        env += formants[k][2] / (1 + d * d);
      }
      imag[h] = env / Math.pow(h, 1.2);
    }
    return (this.waves[key] = this.ctx.createPeriodicWave(real, imag));
  };

  Engine.prototype._sing = function (dest, midi, vel, when, register) {
    var ctx = this.ctx, wave = this._wave(midi, register);
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var gain = ctx.createGain();
    var peak = 0.2 * Math.pow(vel / 90, 1.1);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(peak, when + 0.03);
    gain.connect(dest);
    var lfo = ctx.createOscillator(), depth = ctx.createGain();
    lfo.frequency.value = 5.2 + Math.random() * 0.5;
    depth.gain.value = 0;
    depth.gain.setValueAtTime(0, when + 0.25);
    depth.gain.linearRampToValueAtTime(11, when + 0.75); // cents of vibrato on held notes
    lfo.connect(depth);
    var oscs = [-4, 5].map(function (cents) {
      var o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = freq;
      o.detune.value = cents;
      depth.connect(o.detune);
      o.connect(gain);
      o.start(when);
      return o;
    });
    lfo.start(when);
    var all = oscs.concat([lfo]);
    return {
      release: function (t) {
        t = Math.max(t, when + 0.04);
        gain.gain.setTargetAtTime(0, t, 0.035);
        all.forEach(function (o) { o.stop(t + 0.3); });
      },
      kill: function (now) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.012);
        all.forEach(function (o) { try { o.stop(now + 0.1); } catch (e) { /* already stopped */ } });
      }
    };
  };

  Engine.prototype._pianoNote = function (dest, midi, vel, when, lead) {
    var ctx = this.ctx, gain = ctx.createGain(), sources = [];
    var level = (lead ? 2.4 : 2.0) * Math.pow(vel / 90, 1.4);
    var sample = null, sampleMidi = 0, best = 99;
    if (this.piano) {
      for (var m in this.piano) {
        var dist = Math.abs(m - midi);
        if (dist < best) { best = dist; sample = this.piano[m]; sampleMidi = +m; }
      }
    }
    gain.connect(dest);
    if (sample && best <= 2) {
      var src = ctx.createBufferSource();
      src.buffer = sample.buffer;
      src.playbackRate.value = Math.pow(2, (midi - sampleMidi) / 12);
      gain.gain.setValueAtTime(level, when);
      src.connect(gain);
      src.start(when, sample.offset);
      sources.push(src);
    } else {
      // no samples (yet): a plain struck-string tone
      var freq = 440 * Math.pow(2, (midi - 69) / 12);
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(level * 0.5, when + 0.006);
      gain.gain.setTargetAtTime(0, when + 0.01, 0.5 + 40 / freq);
      ['triangle', 'sine'].forEach(function (type, i) {
        var o = ctx.createOscillator();
        o.type = type; o.frequency.value = freq * (i + 1);
        var g = ctx.createGain(); g.gain.value = i ? 0.3 : 1;
        o.connect(g); g.connect(gain); o.start(when); sources.push(o);
      });
    }
    return {
      release: function (t) {
        t = Math.max(t, when + 0.05);
        gain.gain.cancelScheduledValues(t);
        gain.gain.setTargetAtTime(0, t, 0.09);
        sources.forEach(function (s) { s.stop(t + 0.7); });
      },
      kill: function (now) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(0, now, 0.012);
        sources.forEach(function (s) { try { s.stop(now + 0.1); } catch (e) { /* already stopped */ } });
      }
    };
  };

  Engine.prototype._click = function (when, strong, always) {
    var ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = strong ? 1870 : 1320;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(always ? 0.4 : 0.6, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    o.connect(g);
    g.connect(always ? this.master : this.strips.click.gain); // the count-in is always audible
    o.start(when); o.stop(when + 0.07);
  };

  window.ChoirEngine = Engine;
})();
