/* Choir practice: score view, timeline, mixer and transport. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var engine = new window.ChoirEngine();
  var song = null;
  var current = { measure: -1, system: -1 };
  var loop = null;             // {from, to} measure indices, inclusive
  var raf = 0;
  var wakeLock = null;

  // Highlighter colours, one per sung part, in score order.
  var VOICE_COLORS = ['#ff6fae', '#ffc933', '#3fc8f2', '#b79bff', '#7ddc8a'];
  var OTHER_COLORS = { piano: '#6b7399', click: '#9aa1bd' };

  var STORE_KEY = 'choirPractice.v1';
  var settings = { vol: {}, mute: {}, solo: {}, voice: {}, rate: {}, sound: 'ooh', countIn: true, click: false, song: null };
  try {
    var saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved) Object.keys(saved).forEach(function (k) { settings[k] = saved[k]; });
  } catch (e) { /* private mode: settings just do not persist */ }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- songs
  function loadSong(id) {
    var done = function () {
      var data = window.CHOIR_SONGS && window.CHOIR_SONGS[id];
      if (data) showSong(data); else notice('This song could not be loaded. Check that songs/' + id + '/song.js is on the server.');
    };
    if (window.CHOIR_SONGS && window.CHOIR_SONGS[id]) return done();
    var s = document.createElement('script');
    s.src = 'songs/' + id + '/song.js';
    s.onload = done;
    s.onerror = done;
    document.head.appendChild(s);
  }

  function notice(text) {
    $('notice').textContent = text;
    $('notice').hidden = !text;
  }

  function showSong(data) {
    song = data;
    settings.song = song.id;
    save();
    engine.load(song);
    engine.sound = settings.sound;
    engine.clickOn = settings.click;
    loop = null;
    current = { measure: -1, system: -1 };
    document.title = song.title + ' · Choir practice';
    $('songTitle').textContent = song.title;
    $('songSub').textContent = song.subtitle || '';
    notice('');
    buildVoices();
    buildMixer();
    buildScore();
    buildTimeline();
    var rate = settings.rate[song.id] || 1;
    $('tempo').value = Math.round(rate * 100);
    applyTempo();
    $('loopFrom').value = song.measures[0].n;
    $('loopTo').value = song.measures[Math.min(song.measures.length - 1, 3)].n;
    updateLoopUi();
    layout();
    render(true);
  }

  function voices() { return song.channels.filter(function (c) { return c.kind === 'voice'; }); }
  function colorOf(id) {
    var vs = voices().map(function (c) { return c.id; }), i = vs.indexOf(id);
    if (i >= 0) return VOICE_COLORS[i % VOICE_COLORS.length];
    return id === 'click' ? OTHER_COLORS.click : OTHER_COLORS.piano;
  }
  function myVoice() {
    var v = settings.voice[song.id];
    return voices().some(function (c) { return c.id === v; }) ? v : null;
  }

  // --------------------------------------------------------- voice picker
  function buildVoices() {
    var box = $('voiceButtons');
    box.textContent = '';
    voices().forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.textContent = c.name;
      b.dataset.id = c.id;
      b.style.setProperty('--c', colorOf(c.id));
      b.addEventListener('click', function () {
        settings.voice[song.id] = myVoice() === c.id ? null : c.id;
        save();
        markVoice();
      });
      box.appendChild(b);
    });
    markVoice();
  }
  function markVoice() {
    var mine = myVoice();
    Array.prototype.forEach.call($('voiceButtons').children, function (b) {
      b.setAttribute('aria-checked', b.dataset.id === mine ? 'true' : 'false');
    });
    document.documentElement.style.setProperty('--me', mine ? colorOf(mine) : '#ffc933');
    Array.prototype.forEach.call(document.querySelectorAll('.strip'), function (row) {
      row.classList.toggle('mine', row.dataset.id === mine);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#presets [data-preset]'), function (b) {
      if (b.dataset.preset !== 'all') b.disabled = !mine;
    });
  }

  // ---------------------------------------------------------------- mixer
  function strips() {
    return song.channels.map(function (c) { return { id: c.id, name: c.name, kind: c.kind }; })
      .concat([{ id: 'click', name: 'Click', kind: 'click' }]);
  }
  function volOf(id) { return settings.vol[id] == null ? (id === 'click' ? 60 : 80) : settings.vol[id]; }

  function buildMixer() {
    var box = $('mixer');
    box.textContent = '';
    strips().forEach(function (s) {
      var row = document.createElement('div');
      row.className = 'strip';
      row.dataset.id = s.id;
      row.style.setProperty('--c', colorOf(s.id));
      var id = 'vol-' + s.id;
      row.innerHTML =
        '<label class="strip-name" for="' + id + '"><i></i><span></span></label>' +
        '<input type="range" min="0" max="100" step="1" id="' + id + '">' +
        '<output for="' + id + '"></output>' +
        '<button type="button" class="ms" data-k="mute" aria-pressed="false" title="Mute">M</button>' +
        (s.id !== 'click' ? '<button type="button" class="ms" data-k="solo" aria-pressed="false" title="Solo: hear only this">S</button>' : '');
      row.querySelector('.strip-name span').textContent = s.name;
      row.querySelector('[data-k=mute]').setAttribute('aria-label', 'Mute ' + s.name);
      var soloLbl = row.querySelector('[data-k=solo]');
      if (soloLbl) soloLbl.setAttribute('aria-label', 'Solo ' + s.name);
      var range = row.querySelector('input');
      range.value = volOf(s.id);
      range.addEventListener('input', function () {
        settings.vol[s.id] = +range.value;
        save();
        applyMix();
      });
      Array.prototype.forEach.call(row.querySelectorAll('.ms'), function (b) {
        b.addEventListener('click', function () {
          var k = b.dataset.k;
          settings[k][s.id] = !settings[k][s.id];
          save();
          applyMix();
        });
      });
      box.appendChild(row);
    });
    applyMix();
  }

  function applyMix() {
    var anySolo = strips().some(function (s) { return s.id !== 'click' && settings.solo[s.id]; });
    strips().forEach(function (s) {
      var row = document.querySelector('.strip[data-id="' + s.id + '"]');
      var v = volOf(s.id);
      var silent = settings.mute[s.id] || (anySolo && s.id !== 'click' && !settings.solo[s.id]);
      row.querySelector('input').value = v;
      row.querySelector('input').style.setProperty('--fill', v + '%');
      row.querySelector('output').textContent = v;
      row.querySelector('[data-k=mute]').setAttribute('aria-pressed', settings.mute[s.id] ? 'true' : 'false');
      var soloBtn = row.querySelector('[data-k=solo]');
      if (soloBtn) soloBtn.setAttribute('aria-pressed', settings.solo[s.id] ? 'true' : 'false');
      row.classList.toggle('silent', !!silent);
      var trim = s.kind === 'piano' ? 0.9 : 1;
      engine.setLevelSafe(s.id, silent ? 0 : Math.pow(v / 100, 1.8) * trim);
    });
  }

  engine.setLevelSafe = function (id, value) {
    this.levels[id] = value;
    if (this.ctx && this.strips[id]) this.setLevel(id, value);
  };

  function preset(kind) {
    var mine = myVoice();
    strips().forEach(function (s) {
      if (s.id === 'click') return;
      settings.mute[s.id] = false;
      settings.solo[s.id] = false;
      var isVoice = s.kind === 'voice';
      if (kind === 'all') settings.vol[s.id] = isVoice ? 80 : 70;
      if (kind === 'mine') settings.vol[s.id] = s.id === mine ? 100 : (isVoice ? 35 : 50);
      if (kind === 'without') settings.vol[s.id] = s.id === mine ? 0 : (isVoice ? 85 : 70);
    });
    save();
    applyMix();
  }

  // ---------------------------------------------------------------- score
  function buildScore() {
    var sheet = $('sheet');
    sheet.textContent = '';
    song.systems.forEach(function (sys, i) {
      var el = document.createElement('div');
      el.className = 'system';
      el.dataset.i = i;
      var img = document.createElement('img');
      img.src = 'songs/' + song.id + '/' + sys.img;
      img.alt = 'Measures ' + song.measures[sys.first].n + ' to ' + song.measures[sys.last].n;
      img.width = sys.w;
      img.height = sys.h;
      img.decoding = 'async';
      if (i > 2) img.loading = 'lazy';
      img.draggable = false;
      var marker = document.createElement('div');
      marker.className = 'marker';
      var pad = Math.min(sys.y0, 1 - sys.y1, 0.06);
      marker.style.top = (sys.y0 - pad) * 100 + '%';
      marker.style.height = (sys.y1 - sys.y0 + 2 * pad) * 100 + '%';
      el.appendChild(img);
      el.appendChild(marker);
      el.addEventListener('click', function (ev) {
        var r = el.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width;
        var target = sys.first;
        for (var m = sys.first; m <= sys.last; m++) if (x >= song.measures[m].x0) target = m;
        seekMeasure(target);
      });
      sheet.appendChild(el);
    });
  }

  /** One scale for every line of the score, so the staff size never jumps. */
  function layout() {
    if (!song) return;
    var score = $('score'), sheet = $('sheet');
    var maxW = 0, maxH = 0;
    song.systems.forEach(function (s) { maxW = Math.max(maxW, s.w); maxH = Math.max(maxH, s.h); });
    var cs = getComputedStyle(sheet);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    var ss = getComputedStyle(score);
    var availW = score.clientWidth - parseFloat(ss.paddingLeft) - parseFloat(ss.paddingRight) - padX - 2;
    var availH = score.clientHeight;
    var width = Math.max(240, Math.min(availW, 0.82 * availH * maxW / maxH, 1500));
    sheet.style.width = (width + padX) + 'px';
    Array.prototype.forEach.call(sheet.children, function (el, i) {
      el.style.width = (song.systems[i].w / maxW * 100) + '%';
    });
    layoutLabels();
    scrollToSystem(current.system, true);
  }

  function scrollToSystem(i, instant) {
    var el = $('sheet').children[i];
    if (!el) return;
    var score = $('score');
    var top = el.offsetTop - Math.max(8, (score.clientHeight - el.offsetHeight) * 0.12);
    var smooth = !instant && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    score.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }

  // ------------------------------------------------------------- timeline
  var labels = [];
  function buildTimeline() {
    var cells = $('tlCells');
    cells.textContent = '';
    var marks = {};
    song.marks.forEach(function (mk) { marks[mk.m] = mk.label; });
    labels = [];
    $('tlLabels').textContent = '';
    song.measures.forEach(function (m, i) {
      var c = document.createElement('i');
      c.style.flexGrow = m.d;
      var first = song.systems[m.sys].first === i;
      if (first) c.className = 'line-start';
      cells.appendChild(c);
      if (first || marks[i] != null) {
        var l = document.createElement('span');
        l.textContent = m.n;
        if (marks[i] != null) l.className = 'mark';
        l.style.left = (m.t / song.duration * 100) + '%';
        $('tlLabels').appendChild(l);
        labels.push({ el: l, mark: marks[i] != null, at: m.t / song.duration });
      }
    });
    $('timeTotal').textContent = clock(song.duration / engine.rate);
  }

  /** Show as many measure numbers as fit; boxed rehearsal marks go first. */
  function layoutLabels() {
    var w = $('tlLabels').clientWidth, taken = [];
    var fits = function (x, gap) { return taken.every(function (t) { return Math.abs(t - x) >= gap; }); };
    labels.forEach(function (l) { l.el.hidden = true; });
    [true, false].forEach(function (pass) {
      labels.forEach(function (l) {
        if (l.mark !== pass) return;
        var x = l.at * w;
        if (fits(x, pass ? 30 : 34)) { taken.push(x); l.el.hidden = false; }
      });
    });
  }

  function measureFromEvent(ev) {
    var r = $('tlTrack').getBoundingClientRect();
    var t = Math.max(0, Math.min(0.9999, (ev.clientX - r.left) / r.width)) * song.duration;
    return measureAt(t);
  }

  function wireTimeline() {
    var tl = $('timeline'), start = -1, dragged = false;
    tl.addEventListener('pointerdown', function (ev) {
      if (!song) return;
      start = measureFromEvent(ev);
      dragged = false;
      tl.setPointerCapture(ev.pointerId);
    });
    tl.addEventListener('pointermove', function (ev) {
      if (start < 0) return;
      var now = measureFromEvent(ev);
      if (now !== start) dragged = true;
      if (dragged) showLoopBand(Math.min(start, now), Math.max(start, now), true);
    });
    var finish = function (ev) {
      if (start < 0) return;
      var end = measureFromEvent(ev);
      if (dragged && end !== start) setLoop(Math.min(start, end), Math.max(start, end));
      else { updateLoopUi(); seekMeasure(start); }
      start = -1;
    };
    tl.addEventListener('pointerup', finish);
    tl.addEventListener('pointercancel', function () { start = -1; updateLoopUi(); });
  }

  function showLoopBand(a, b, visible) {
    var band = $('tlLoop');
    band.hidden = !visible;
    if (!visible) return;
    var t0 = song.measures[a].t, t1 = song.measures[b].t + song.measures[b].d;
    band.style.left = (t0 / song.duration * 100) + '%';
    band.style.width = ((t1 - t0) / song.duration * 100) + '%';
  }

  // ----------------------------------------------------------------- loop
  function indexOfNumber(n) {
    for (var i = 0; i < song.measures.length; i++) if (String(song.measures[i].n) === String(n)) return i;
    return -1;
  }
  function setLoop(a, b) {
    loop = { from: a, to: b };
    $('loopFrom').value = song.measures[a].n;
    $('loopTo').value = song.measures[b].n;
    engine.setLoop({ start: song.measures[a].t, end: song.measures[b].t + song.measures[b].d });
    updateLoopUi();
    render(true);
  }
  function clearLoop() {
    loop = null;
    engine.setLoop(null);
    updateLoopUi();
  }
  function loopFromFields() {
    var a = indexOfNumber($('loopFrom').value), b = indexOfNumber($('loopTo').value);
    if (a < 0) a = 0;
    if (b < 0) b = song.measures.length - 1;
    setLoop(Math.min(a, b), Math.max(a, b));
  }
  function updateLoopUi() {
    $('loopToggle').setAttribute('aria-pressed', loop ? 'true' : 'false');
    $('loopToggle').textContent = loop ? 'Looping' : 'Loop';
    if (loop) showLoopBand(loop.from, loop.to, true); else showLoopBand(0, 0, false);
  }

  // ------------------------------------------------------------ transport
  function measureAt(t) {
    var ms = song.measures, lo = 0, hi = ms.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ms[mid].t <= t + 1e-6) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function seekMeasure(i) {
    i = Math.max(0, Math.min(song.measures.length - 1, i));
    if (loop && (i < loop.from || i > loop.to)) clearLoop();
    engine.seek(song.measures[i].t);
    render(true);
  }
  function play() {
    if (!song) return;
    engine.play(settings.countIn);
    setPlaying(true);
  }
  function pause() { engine.pause(); setPlaying(false); render(true); }
  function stop() { engine.stop(); setPlaying(false); render(true); }
  function toggle() { if (engine.playing) pause(); else play(); }

  function setPlaying(on) {
    document.body.classList.toggle('playing', on);
    $('play').setAttribute('aria-label', on ? 'Pause' : 'Play');
    $('play').title = on ? 'Pause (Space)' : 'Play (Space)';
    cancelAnimationFrame(raf);
    if (on) {
      var frame = function () { render(false); raf = requestAnimationFrame(frame); };
      raf = requestAnimationFrame(frame);
      if (navigator.wakeLock && !wakeLock) {
        navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
      }
    } else if (wakeLock) {
      wakeLock.release().catch(function () {});
      wakeLock = null;
    }
  }
  engine.onended = function () { setPlaying(false); render(true); };

  function applyTempo() {
    var pct = +$('tempo').value, rate = pct / 100;
    engine.setRate(rate);
    $('tempo').style.setProperty('--fill', ((pct - 40) / 90 * 100) + '%');
    $('tempoOut').textContent = song ? Math.round(song.bpm * rate) + ' bpm' : pct + '%';
    $('tempoReset').hidden = pct === 100;
    $('tempoReset').textContent = 'Back to written tempo (' + (song ? Math.round(song.bpm) : '') + ' bpm)';
    if (song) {
      settings.rate[song.id] = rate;
      save();
      $('timeTotal').textContent = clock(song.duration / rate);
    }
  }

  function clock(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ':' + ('0' + sec % 60).slice(-2);
  }

  // --------------------------------------------------------------- render
  function xAt(sys, t) {
    var p = sys.pts, lo = 0, hi = p.length - 1;
    if (t <= p[0][0]) return p[0][1];
    if (t >= p[hi][0]) return p[hi][1];
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (p[mid][0] <= t) lo = mid; else hi = mid; }
    var f = (t - p[lo][0]) / (p[hi][0] - p[lo][0]);
    return p[lo][1] + f * (p[hi][1] - p[lo][1]);
  }

  function render(jump) {
    if (!song) return;
    var t = engine.position();
    var mi = measureAt(Math.min(t, song.duration - 1e-3));
    var m = song.measures[mi], si = m.sys, sys = song.systems[si];
    var sheet = $('sheet');
    if (si !== current.system) {
      var old = sheet.children[current.system];
      if (old) old.classList.remove('current');
      sheet.children[si].classList.add('current');
      var far = Math.abs(si - current.system) > 1;
      current.system = si;
      scrollToSystem(si, jump && far);
    }
    if (mi !== current.measure) {
      current.measure = mi;
      $('measureNo').textContent = m.n;
    }
    var marker = sheet.children[si].lastChild;
    marker.style.left = (xAt(sys, t) * 100) + '%';
    $('tlCursor').style.left = (t / song.duration * 100) + '%';
    $('timeNow').textContent = clock(t / engine.rate);
  }

  // ----------------------------------------------------------------- wire
  function wire() {
    $('play').addEventListener('click', toggle);
    $('stop').addEventListener('click', stop);
    $('prev').addEventListener('click', function () {
      var t = engine.position(), i = measureAt(t);
      seekMeasure(t - song.measures[i].t > 0.35 ? i : i - 1);
    });
    $('next').addEventListener('click', function () { seekMeasure(measureAt(engine.position()) + 1); });

    $('tempo').addEventListener('input', applyTempo);
    $('tempoReset').addEventListener('click', function () { $('tempo').value = 100; applyTempo(); });

    $('loopToggle').addEventListener('click', function () { if (loop) clearLoop(); else loopFromFields(); });
    $('loopSystem').addEventListener('click', function () {
      var sys = song.systems[song.measures[measureAt(engine.position())].sys];
      setLoop(sys.first, sys.last);
    });
    ['loopFrom', 'loopTo'].forEach(function (id) {
      $(id).addEventListener('change', function () { if (loop) loopFromFields(); });
    });

    $('sound').value = settings.sound;
    $('sound').addEventListener('change', function () {
      settings.sound = engine.sound = $('sound').value;
      save();
    });
    $('countIn').checked = !!settings.countIn;
    $('countIn').addEventListener('change', function () { settings.countIn = $('countIn').checked; save(); });
    $('click').checked = !!settings.click;
    $('click').addEventListener('change', function () {
      settings.click = engine.clickOn = $('click').checked;
      save();
    });

    Array.prototype.forEach.call(document.querySelectorAll('#presets [data-preset]'), function (b) {
      b.addEventListener('click', function () { preset(b.dataset.preset); });
    });

    document.addEventListener('keydown', function (ev) {
      if (!song || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var tag = ev.target.tagName;
      var typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (ev.code === 'Space' && tag !== 'BUTTON' && !(typing && ev.target.type !== 'range')) {
        ev.preventDefault(); toggle();
      } else if (!typing && ev.key === 'ArrowLeft') { ev.preventDefault(); $('prev').click(); }
      else if (!typing && ev.key === 'ArrowRight') { ev.preventDefault(); $('next').click(); }
      else if (!typing && ev.key === 'Home') { ev.preventDefault(); seekMeasure(0); }
      else if (!typing && (ev.key === 'l' || ev.key === 'L')) { $('loopToggle').click(); }
    });

    wireTimeline();
    wireHelp();
    var resizeTimer = 0;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 80); });
    window.addEventListener('load', layout);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && engine.playing && navigator.wakeLock) {
        navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
      }
    });
  }

  // ----------------------------------------------------------------- help
  /** [what it points at, side of the bubble, how far along the target (0 to 1), text] */
  var TIPS = [
    ['#voiceButtons', 'below', 0.5, 'Tap your part. The highlighter and the mixer then use your colour.'],
    ['#score', 'mid', 0.5, 'The highlighter follows the music. Tap any measure to jump there.'],
    ['#mixer', 'mid', 0.5,'Make a part louder or softer. M mutes it, S plays only that part.'],
    ['.panel:nth-child(2) h2', 'right', 0.5, 'Slow the music down to learn a hard bit.'],
    ['.panel:nth-child(3) h2', 'right', 0.5, 'Repeat a passage. "This line" repeats the line you are on.'],
    ['.panel:nth-child(4) h2', 'right', 0.5, 'Choose how the voices sound. Add a count-in or a click.'],
    ['#play', 'above', 0.5, 'Play and pause. The arrows step one measure.'],
    ['#timeline', 'above', 0.78, 'The whole song. Tap to jump, drag to loop a passage.']
  ];

  function wireHelp() {
    var btn = $('helpBtn'), layer = document.createElement('div');
    layer.className = 'help';
    layer.hidden = true;
    TIPS.forEach(function (t) {
      var b = document.createElement('p');
      b.className = 'tip ' + (t[1] === 'mid' ? 'above' : t[1]);
      b.textContent = t[3];
      layer.appendChild(b);
    });
    document.body.appendChild(layer);

    function place() {
      if (layer.hidden) return;
      var vw = document.documentElement.clientWidth, gap = 14;
      TIPS.forEach(function (t, i) {
        var el = document.querySelector(t[0]), b = layer.children[i], side = t[1];
        var r = el.getBoundingClientRect();
        var cx = r.left + r.width * t[2], cy = r.top + r.height / 2;
        // only show a bubble when its target is really on screen and not covered
        var hit = document.elementFromPoint(cx, cy);
        if (!hit || !el.contains(hit)) { b.style.visibility = 'hidden'; return; }
        var w = b.offsetWidth, h = b.offsetHeight, left, top;
        if (side === 'right') { left = r.right + gap; top = r.top - 6; }
        else {
          left = cx - w / 2;
          top = side === 'below' ? r.bottom + gap : (side === 'mid' ? cy : r.top) - h - gap;
        }
        left = Math.max(8, Math.min(left, vw - w - 8));
        b.style.left = left + 'px';
        b.style.top = top + 'px';
        b.style.setProperty('--ax', Math.max(18, Math.min(cx - left, w - 18)) + 'px');
        b.style.visibility = '';
      });
    }

    function show(on) {
      layer.hidden = !on;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      place();
    }
    btn.addEventListener('click', function () { show(layer.hidden); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') show(false); });
    // capture: the score and the controls scroll inside their own boxes
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
  }

  function start() {
    wire();
    var index = window.CHOIR_SONG_INDEX || [];
    if (!index.length) {
      notice('No songs yet. Build one with tools/build_song.py and upload the songs folder.');
      return;
    }
    var select = $('songSelect');
    index.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.id; o.textContent = s.title;
      select.appendChild(o);
    });
    var wanted = new URLSearchParams(location.search).get('song') || settings.song;
    var first = index.some(function (s) { return s.id === wanted; }) ? wanted : index[0].id;
    if (index.length > 1) {
      select.hidden = false;
      $('songTitle').classList.add('visually-hidden');
      select.value = first;
      select.addEventListener('change', function () {
        setPlaying(false);
        loadSong(select.value);
      });
    }
    loadSong(first);
  }

  window.choirPractice = { engine: engine, settings: settings };
  start();
})();
