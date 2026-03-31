'use strict';
/* ═══════════════════════════════════════════════════════════════
   RunCoach — app.js   (v4)
   ─ Précision GPS améliorée (fenêtre glissante 15 s, filtre vitesse)
   ─ Arrière-plan : oscillateur silencieux + MediaSession + visibility fix
   ─ Décompte 5-4-3-2-1 → bip → annonce phase suivante
   ─ Alertes tolérance : "UP" / "DOWN" uniquement
   ─ 4 stats permanents : allure · km séquence · km total · n° segment
   ─ Timer/chrono selon phase
═══════════════════════════════════════════════════════════════ */

/* ─── CONFIG ──────────────────────────────────────────────── */
const cfg = {
  warm:      10,
  rest:       2,
  cool:      10,
  paceFreq:  10,   // sec between pace announces (0 = off)
  distFreq: 200,   // metres between dist announces (0 = off)
  paceGuide: true,
  segments: [],
};
const LIMITS = {
  warm:[0,60], rest:[0,15], cool:[0,60],
  paceFreq:[0,120], distFreq:[0,2000],
};

/* ═══════════════════════════════════════════════════════════
   AUDIO — Web Audio API
   Oscillateur silencieux continu pour maintenir la session audio
   en arrière-plan même écran éteint.
═══════════════════════════════════════════════════════════ */
let _actx = null;
function getACtx() {
  if (!_actx) _actx = new (window.AudioContext || window.webkitAudioContext)();
  return _actx;
}

/* Silent loop — MUST be started on user gesture */
let _silentNode = null;
function startSilentLoop() {
  if (_silentNode) return;
  try {
    const ctx  = getACtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;     // truly inaudible, but keeps audio context alive
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    _silentNode = osc;
  } catch(e) {}
}

/**
 * beep(type)
 *  'go'   — double bip aigu  (début effort / échauffement)
 *  'stop' — bip grave unique (fin séquence / début repos)
 *  'tick' — bip court doux   (décompte)
 */
function beep(type) {
  try {
    const ctx = getACtx();
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    const defs = {
      go:   [{ f:880,t:0,d:.11 },{ f:1100,t:.14,d:.15 }],
      stop: [{ f:420,t:0,d:.28 }],
      tick: [{ f:700,t:0,d:.07 }],
    };
    (defs[type] || defs.go).forEach(({ f, t, d }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + t);
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.55, now + t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + d);
      osc.start(now + t);
      osc.stop(now + t + d + 0.02);
    });
  } catch(e) { console.warn('beep', e); }
}

/* ═══════════════════════════════════════════════════════════
   SPEECH — TTS avec file d'attente
   Workaround Android : relance le processQueue si speechSynthesis
   se bloque (bug connu quand l'écran se rallume).
═══════════════════════════════════════════════════════════ */
let _voices = [];
function loadVoices() {
  const all = window.speechSynthesis?.getVoices() || [];
  _voices = all.filter(v => v.lang.startsWith('fr'));
  if (!_voices.length) _voices = all;
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

let _queue = [];
let _speaking = false;
let _watchdog = null;

function speak(text, priority = false) {
  if (!window.speechSynthesis) return;
  if (priority) { window.speechSynthesis.cancel(); _queue = []; _speaking = false; }
  _queue.push(text);
  if (!_speaking) _processQueue();
}

function _processQueue() {
  if (!_queue.length) { _speaking = false; return; }
  _speaking = true;
  const text = _queue.shift();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = 'fr-FR';
  u.rate  = 0.90;
  u.pitch = 1.0;
  const v = _voices.find(v => v.lang === 'fr-FR') || _voices[0];
  if (v) u.voice = v;
  // Watchdog: if onend never fires (Android background bug), force-continue after 8s
  u.onstart = () => {
    clearTimeout(_watchdog);
    _watchdog = setTimeout(() => { _speaking = false; _processQueue(); }, 8000);
  };
  u.onend = () => { clearTimeout(_watchdog); _speaking = false; _processQueue(); };
  u.onerror = () => { clearTimeout(_watchdog); _speaking = false; _processQueue(); };
  window.speechSynthesis.speak(u);
}

function beepThenSpeak(beepType, text, delay = 420) {
  beep(beepType);
  setTimeout(() => speak(text, true), delay);
}

function durStr(sec) {
  if (!sec) return '0 seconde';
  const m = Math.floor(sec / 60), s = sec % 60;
  const ms = m ? `${m} minute${m > 1 ? 's' : ''}` : '';
  const ss = s ? `${s} seconde${s > 1 ? 's' : ''}` : '';
  return [ms, ss].filter(Boolean).join(' et ');
}

/* ═══════════════════════════════════════════════════════════
   GPS — Filtre Kalman léger + fenêtre glissante 15 s
   But : éliminer les "sauts" GPS (1 min/km à l'arrêt, etc.)

   On accumule des échantillons (distance, durée) sur une
   fenêtre glissante de MAX_WINDOW_SEC secondes.
   On filtre aussi les échantillons aberrants (> MAX_SPEED m/s).
═══════════════════════════════════════════════════════════ */
const MAX_SPEED_MS  = 7.0;  // ~25 km/h — seuil rejet improbable pour course à pied
const MIN_DIST_M    = 2;    // ignore déplacements < 2 m (bruit GPS stationnaire)
const WINDOW_SEC    = 15;   // fenêtre glissante d'estimation d'allure

let _watcher     = null;
let _lastPos     = null;
let _totalDistM  = 0;
let _segDistM    = 0;
let _paceWindow  = [];      // [{dist, dt, t}]  t = timestamp ms

function _smoothSpeed() {
  // Retire les échantillons hors fenêtre
  const now = Date.now();
  _paceWindow = _paceWindow.filter(s => (now - s.t) <= WINDOW_SEC * 1000);
  if (!_paceWindow.length) return 0;
  const totalD = _paceWindow.reduce((a, s) => a + s.dist, 0);
  const totalT = _paceWindow.reduce((a, s) => a + s.dt,   0);
  return totalT > 0 ? totalD / totalT : 0;
}

function startGPS() {
  if (!navigator.geolocation) return;
  _lastPos = null; _paceWindow = [];
  _watcher = navigator.geolocation.watchPosition(_onPos, _onPosErr, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 20000,
  });
  setGPSUI('on', 'Acquisition…');
}
function stopGPS() {
  if (_watcher !== null) { navigator.geolocation.clearWatch(_watcher); _watcher = null; }
  setGPSUI('', 'GPS OFF');
}
function setGPSUI(cls, lbl) {
  document.getElementById('gpsDot').className = 'gps-dot' + (cls ? ' ' + cls : '');
  document.getElementById('gpsLabel').textContent = lbl;
}

function _onPos(pos) {
  setGPSUI('on', 'GPS OK');
  const { latitude: lat, longitude: lng } = pos.coords;

  if (_lastPos) {
    const d  = haversine(_lastPos.lat, _lastPos.lng, lat, lng);
    const dt = (pos.timestamp - _lastPos.t) / 1000;

    if (dt > 0 && d >= MIN_DIST_M) {
      const spd = d / dt;
      if (spd <= MAX_SPEED_MS) {
        // Sample is plausible → accumulate
        _totalDistM += d;
        _segDistM   += d;
        _paceWindow.push({ dist: d, dt, t: pos.timestamp });
      }
      // else: GPS jump / spike → silently ignore
    }
  }
  _lastPos = { lat, lng, t: pos.timestamp };
  _onGPSUpdate();
}
function _onPosErr() { setGPSUI('error', 'GPS ERR'); }

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function currentSpeedMs() { return _smoothSpeed(); }

function paceSecPKm(mps) { return mps > 0.5 ? 1000 / mps : null; }

function paceStr(mps) {
  const s = paceSecPKm(mps);
  if (!s) return '--:--';
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}
function paceSpoken(mps) {
  const s = paceSecPKm(mps);
  if (!s) return null;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return r ? `${m} minutes ${r} par kilomètre` : `${m} minutes par kilomètre`;
}
function fmtPaceFromSec(sec) {
  if (sec <= 0) return '--:--';
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════
   CONFIG HELPERS
═══════════════════════════════════════════════════════════ */
function adj(key, delta) {
  const [mn, mx] = LIMITS[key];
  cfg[key] = Math.min(mx, Math.max(mn, cfg[key] + delta));
  const el = document.getElementById(key + '-disp');
  if (el) {
    if (key === 'paceFreq') el.textContent = cfg[key] === 0 ? 'OFF' : cfg[key] + 's';
    else if (key === 'distFreq') el.textContent = cfg[key] === 0 ? 'OFF' : cfg[key] + 'm';
    else el.textContent = cfg[key];
  }
  refresh();
}

function onPaceGuideToggle() {
  cfg.paceGuide = document.getElementById('paceGuideToggle').checked;
  const dim = !cfg.paceGuide;
  document.getElementById('pace-row').classList.toggle('dim', dim);
  document.getElementById('tol-row').classList.toggle('dim', dim);
  ['seg-pm', 'seg-ps', 'seg-tol'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = dim;
  });
  renderSegments();
  refresh();
}

/* ═══════════════════════════════════════════════════════════
   SEGMENTS
═══════════════════════════════════════════════════════════ */
function addSegment() {
  cfg.segments.push({
    dist: parseFloat(document.getElementById('seg-dist').value) || 1,
    pm:   parseInt(document.getElementById('seg-pm').value)    || 5,
    ps:   parseInt(document.getElementById('seg-ps').value)    || 0,
    tol:  parseInt(document.getElementById('seg-tol').value)   || 10,
  });
  renderSegments();
  refresh();
}
function removeSegment(i) {
  cfg.segments.splice(i, 1);
  renderSegments();
  refresh();
}
function renderSegments() {
  const el = document.getElementById('segments-list');
  if (!cfg.segments.length) {
    el.innerHTML = '<div class="empty-state">Aucun segment — ajoutez-en ci-dessous</div>';
    return;
  }
  el.innerHTML = cfg.segments.map((s, i) => {
    const info = cfg.paceGuide
      ? `${s.pm}:${String(s.ps).padStart(2, '0')} /km · ±${s.tol}s`
      : 'Allure libre';
    return `<div class="segment-item">
      <span class="seg-index">${i + 1}</span>
      <div class="seg-bar"></div>
      <div class="segment-info">
        <strong>${s.dist} km</strong><span>${info}</span>
      </div>
      <button class="btn-del" onclick="removeSegment(${i})">✕</button>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   SCHEDULE
═══════════════════════════════════════════════════════════ */
function buildSchedule() {
  const p = [];
  if (cfg.warm > 0)
    p.push({ id:'warmup',   label:'Échauffement',    color:'var(--warm)',   dur: cfg.warm * 60, dist:0 });
  cfg.segments.forEach((s, i) => {
    p.push({ id:'effort', label:`Effort ${i + 1} — ${s.dist} km`, color:'var(--effort)',
      dur: Math.round(s.dist * (s.pm * 60 + s.ps)), dist: s.dist, pm: s.pm, ps: s.ps, tol: s.tol });
    if (i < cfg.segments.length - 1 && cfg.rest > 0)
      p.push({ id:'rest', label:'Repos', color:'var(--rest)', dur: cfg.rest * 60, dist:0 });
  });
  if (cfg.cool > 0)
    p.push({ id:'cooldown', label:'Retour au calme', color:'var(--cool)',   dur: cfg.cool * 60, dist:0 });
  return p;
}

function fmtDur(s) {
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m}m${r}s` : `${m} min`;
}

function refresh() {
  const sched = buildSchedule();
  const card  = document.getElementById('preview-card');
  const btn   = document.getElementById('btnStart');
  if (!sched.length) {
    card.innerHTML = '<div class="empty-state">Ajoutez des segments pour voir l\'aperçu</div>';
    btn.disabled = true; return;
  }
  btn.disabled = false;
  const C = { warmup:'var(--warm)', effort:'var(--effort)', rest:'var(--rest)', cooldown:'var(--cool)' };
  card.innerHTML = sched.map(p =>
    `<div class="prev-row">
      <div class="prev-dot" style="background:${C[p.id]}"></div>
      <div class="prev-name">${p.label}</div>
      <div class="prev-val">${p.dist ? p.dist + ' km' : fmtDur(p.dur)}</div>
    </div>`
  ).join('');
}

/* ═══════════════════════════════════════════════════════════
   SESSION ENGINE
═══════════════════════════════════════════════════════════ */
let session = null;
let ticker  = null;

// Per-tick counters
let _paceTimer    = 0;   // sec since last pace announce
let _lastDistBand = 0;   // how many distFreq bands announced
let _tolCooldown  = 0;   // sec before next tolerance alert
let _countingDown = false; // are we in the 5-4-3-2-1 countdown?

function startSession() {
  const sched = buildSchedule();
  if (!sched.length) return;
  try { getACtx().resume(); startSilentLoop(); setupMediaSession(); } catch(e) {}

  _totalDistM = 0; _segDistM = 0; _paceWindow = []; _lastPos = null;
  _paceTimer = 0; _lastDistBand = 0; _tolCooldown = 0; _countingDown = false;

  session = {
    sched,
    idx: 0,
    remaining: sched[0].dur,
    elapsed: 0,
    totalDur: sched.reduce((a, p) => a + p.dur, 0),
    paused: false,
    totalEfforts: sched.filter(p => p.id === 'effort').length,
    effortsDone: 0,
    seqDistM: 0,   // distance accumulated in current sequence
    seqElapsed: 0, // elapsed seconds in current sequence
  };

  document.getElementById('runner').classList.add('active');
  startGPS();
  _announcePhaseStart(sched[0], true);
  renderRunner();
  ticker = setInterval(_tick, 1000);
}

/* ─── TICK ──────────────────────────────────────────────── */
function _tick() {
  if (!session || session.paused) return;

  session.elapsed++;
  session.remaining--;
  session.seqElapsed++;
  _paceTimer++;
  if (_tolCooldown > 0) _tolCooldown--;

  const phase = session.sched[session.idx];
  const spd   = currentSpeedMs();

  // ── Pace announce (all phases, if enabled)
  if (cfg.paceFreq > 0 && _paceTimer >= cfg.paceFreq) {
    _paceTimer = 0;
    const ps = paceSpoken(spd);
    if (ps) speak(`Allure : ${ps}`);
  }

  // ── Effort-only features
  if (phase.id === 'effort') {
    // Pace tolerance alert → "UP" or "DOWN"
    if (cfg.paceGuide && phase.pm && _tolCooldown === 0) {
      _checkTolerance(phase, spd);
    }
  }

  // ── End-of-phase countdown (last 5 seconds, timed phases only)
  if (phase.dur > 0 && !_countingDown) {
    const r = session.remaining;
    if (r <= 5 && r > 0) {
      beep('tick');
      speak(String(r));
    }
  }

  // ── Phase end
  if (session.remaining <= 0) {
    _advancePhase();
  } else {
    renderRunner();
  }
}

/* ─── TOLERANCE CHECK ───────────────────────────────────── */
function _checkTolerance(phase, spd) {
  const curSec = paceSecPKm(spd);
  if (!curSec) return;
  const target = phase.pm * 60 + phase.ps;
  const lo = target - phase.tol;  // faster limit (lower sec/km)
  const hi = target + phase.tol;  // slower limit

  const alertEl = document.getElementById('paceAlert');

  if (curSec < lo) {
    // Too fast → need to slow DOWN (pace sec/km too low)
    alertEl.textContent = '▼ DOWN';
    alertEl.className = 'pace-alert show too-fast';
    speak('down');
    _tolCooldown = 15;
  } else if (curSec > hi) {
    // Too slow → need to speed UP
    alertEl.textContent = '▲ UP';
    alertEl.className = 'pace-alert show too-slow';
    speak('up');
    _tolCooldown = 15;
  } else {
    alertEl.className = 'pace-alert';
  }
}

/* ─── GPS UPDATE ────────────────────────────────────────── */
function _onGPSUpdate() {
  if (!session) return;
  const phase = session.sched[session.idx];

  // Update sequence distance (seqDistM mirrors _segDistM, reset on phase change)
  session.seqDistM = _segDistM;

  // Distance announce (effort only)
  if (phase.id === 'effort' && cfg.distFreq > 0) {
    const band = Math.floor(_segDistM / cfg.distFreq);
    if (band > _lastDistBand) {
      _lastDistBand = band;
      const km = (_segDistM / 1000).toFixed(2);
      const unit = _segDistM >= 1000 ? 'kilomètre' + (_segDistM >= 2000 ? 's' : '') : 'mètre';
      speak(`${_segDistM >= 1000 ? km : Math.round(_segDistM)} ${unit}`);
    }
  }

  // Effort end by GPS distance
  if (phase.id === 'effort' && phase.dist && _segDistM >= phase.dist * 1000) {
    const ps = paceSpoken(currentSpeedMs());
    beep('stop');
    setTimeout(() => speak(
      `Segment terminé. ${phase.dist} kilomètre${phase.dist > 1 ? 's' : ''}.` +
      (ps ? ` Allure : ${ps}.` : ''), true
    ), 250);
    _advancePhase();
    return;
  }

  renderRunner();
}

/* ─── ADVANCE PHASE ─────────────────────────────────────── */
function _advancePhase() {
  if (!session) return;
  if (session.sched[session.idx].id === 'effort') session.effortsDone++;

  session.idx++;
  if (session.idx >= session.sched.length) { endSession(); return; }

  const phase = session.sched[session.idx];
  session.remaining  = phase.dur;
  session.seqElapsed = 0;
  _segDistM      = 0;
  session.seqDistM   = 0;
  _paceTimer     = 0;
  _lastDistBand  = 0;
  _tolCooldown   = 0;
  _countingDown  = false;
  document.getElementById('paceAlert').className = 'pace-alert';

  _announcePhaseStart(phase, false);
  renderRunner();
}

/* ─── ANNOUNCE ──────────────────────────────────────────── */
function _announcePhaseStart(phase, isFirst) {
  let msg = isFirst ? 'La séance commence. ' : '';
  if (phase.id === 'warmup') {
    msg += `Échauffement. ${durStr(phase.dur)}.`;
    beepThenSpeak('go', msg);
  } else if (phase.id === 'effort') {
    const effortN = (session?.effortsDone ?? 0) + 1;
    msg += `Segment ${effortN}. ${phase.dist} kilomètre${phase.dist > 1 ? 's' : ''}.`;
    if (cfg.paceGuide && phase.pm)
      msg += ` Cible : ${phase.pm} minutes${phase.ps ? ' ' + phase.ps : ''} par kilomètre.`;
    beepThenSpeak('go', msg);
  } else if (phase.id === 'rest') {
    msg += `Repos. ${durStr(phase.dur)}.`;
    beepThenSpeak('stop', msg);
  } else if (phase.id === 'cooldown') {
    msg += `Retour au calme. ${durStr(phase.dur)}.`;
    beepThenSpeak('stop', msg);
  }
}

/* ═══════════════════════════════════════════════════════════
   RUNNER UI
═══════════════════════════════════════════════════════════ */
const PCOLOR = { warmup:'var(--warm)', effort:'var(--effort)', rest:'var(--rest)', cooldown:'var(--cool)' };
const PLABEL = { warmup:'ÉCHAUFFEMENT', effort:'EFFORT', rest:'REPOS', cooldown:'RETOUR AU CALME' };
const CIRCUMFERENCE = 496.46; // 2π × 79

function renderRunner() {
  if (!session) return;
  const phase = session.sched[session.idx];
  const color = PCOLOR[phase.id] || 'var(--text)';
  const spd   = currentSpeedMs();

  // Header / badge
  document.getElementById('rhName').textContent     = phase.label.toUpperCase();
  document.getElementById('phaseGlow').style.background = color;
  const badge = document.getElementById('phaseBadge');
  badge.textContent   = PLABEL[phase.id];
  badge.style.color   = color;
  badge.style.borderColor = color;

  // ── Ring
  const rt = document.getElementById('ringTime');
  const rp = document.getElementById('ringProg');
  rt.style.color = color;
  rp.style.stroke = color;

  if (phase.id === 'effort') {
    // Chronomètre : temps écoulé dans le segment
    rt.textContent = fmtTime(session.seqElapsed);
    document.getElementById('ringSub').textContent = 'ÉCOULÉ';
    // Ring = progression distance
    const pct = phase.dist ? Math.min(_segDistM / (phase.dist * 1000), 1) : 0;
    rp.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
  } else {
    // Minuteur : temps restant
    rt.textContent = fmtTime(session.remaining);
    document.getElementById('ringSub').textContent = 'RESTANT';
    const pct = phase.dur > 0 ? session.remaining / phase.dur : 0;
    rp.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
  }

  // ── Target strip (effort only)
  const strip = document.getElementById('targetStrip');
  if (phase.id === 'effort' && phase.dist) {
    strip.style.display = 'block';
    if (cfg.paceGuide && phase.pm) {
      const lo = fmtPaceFromSec(phase.pm * 60 + phase.ps - phase.tol);
      const hi = fmtPaceFromSec(phase.pm * 60 + phase.ps + phase.tol);
      strip.textContent = `${(_segDistM/1000).toFixed(2)} / ${phase.dist} km  ·  cible ${phase.pm}:${String(phase.ps).padStart(2,'0')} [${lo}–${hi}] /km`;
    } else {
      strip.textContent = `${(_segDistM/1000).toFixed(2)} / ${phase.dist} km  ·  allure libre`;
    }
  } else {
    strip.style.display = 'none';
  }

  // ── 4 stats
  document.getElementById('statPace').textContent = paceStr(spd);

  // km séquence : distance parcourue dans la séquence en cours
  document.getElementById('statSegDist').textContent = (_segDistM / 1000).toFixed(2);
  const seqLabel = document.getElementById('statSegDistLabel');
  if (phase.id === 'effort') seqLabel.textContent = 'km segment';
  else if (phase.id === 'warmup') seqLabel.textContent = 'km éch.';
  else if (phase.id === 'rest') seqLabel.textContent = 'km repos';
  else seqLabel.textContent = 'km calme';

  document.getElementById('statTotalDist').textContent = (_totalDistM / 1000).toFixed(2);

  const effortN = session.sched.slice(0, session.idx + 1).filter(p => p.id === 'effort').length;
  document.getElementById('statStep').textContent =
    phase.id === 'effort' ? `${effortN}/${session.totalEfforts}` : '—';

  // ── Progress
  const pct = Math.min(Math.round(session.elapsed / Math.max(session.totalDur, 1) * 100), 100);
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progPct').textContent  = pct + ' %';
  document.getElementById('progLabel').textContent = `Séance ${pct} %`;
}

function fmtTime(sec) {
  if (sec < 0) sec = 0;
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════
   CONTROLS
═══════════════════════════════════════════════════════════ */
function togglePause() {
  if (!session) return;
  session.paused = !session.paused;
  document.getElementById('pauseBtn').textContent = session.paused ? '▶ REPRENDRE' : '⏸ PAUSE';
  if (session.paused) { beep('tick'); setTimeout(() => speak('Pause.', true), 200); }
  else beepThenSpeak('go', 'On repart !');
}

function skipPhase() {
  if (!session) return;
  speak('Phase suivante.', true);
  session.remaining = 0;
  _advancePhase();
}

function stopSession() {
  if (!confirm('Arrêter la séance ?')) return;
  clearInterval(ticker); ticker = null;
  stopGPS();
  window.speechSynthesis?.cancel();
  session = null;
  document.getElementById('runner').classList.remove('active');
  document.getElementById('paceAlert').className = 'pace-alert';
}

function endSession() {
  clearInterval(ticker); ticker = null;
  stopGPS();
  window.speechSynthesis?.cancel();
  const dist = _totalDistM, elapsed = session?.elapsed || 0;
  session = null;
  document.getElementById('runner').classList.remove('active');
  const avgMps = dist > 20 ? dist / elapsed : 0;
  document.getElementById('completeGrid').innerHTML = `
    <div class="complete-stat"><div class="v">${fmtTime(elapsed)}</div><div class="l">DURÉE TOTALE</div></div>
    <div class="complete-stat"><div class="v">${(dist/1000).toFixed(2)}</div><div class="l">KM COURUS</div></div>
    <div class="complete-stat"><div class="v">${paceStr(avgMps)}</div><div class="l">ALLURE MOY.</div></div>
    <div class="complete-stat"><div class="v">✓</div><div class="l">SÉANCE OK</div></div>`;
  document.getElementById('completeScreen').classList.add('active');
  beep('stop');
  setTimeout(() => speak(`Séance terminée ! Bravo ! Tu as couru ${(dist/1000).toFixed(1)} kilomètres.`), 400);
}

function closeComplete() {
  document.getElementById('completeScreen').classList.remove('active');
}

/* ═══════════════════════════════════════════════════════════
   BACKGROUND KEEP-ALIVE
═══════════════════════════════════════════════════════════ */
/* Wake lock — empêche l'écran de s'éteindre si l'utilisateur
   ne veut pas. Sur Android, l'écran peut quand même s'éteindre
   si l'OS le force (économie de batterie). Dans ce cas, le
   silent loop + MediaSession garantissent que l'audio continue. */
let _wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) _wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    await requestWakeLock();
    // Android bug : speechSynthesis se met en pause quand l'onglet redevient visible
    if (window.speechSynthesis?.paused) window.speechSynthesis.resume();
    // Relance le watchdog si la queue est bloquée
    if (_speaking) { clearTimeout(_watchdog); _speaking = false; _processQueue(); }
    // Relance l'AudioContext si suspendu
    try { if (_actx?.state === 'suspended') _actx.resume(); } catch(e) {}
  }
});

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'RunCoach — Séance en cours', artist: 'RunCoach', album: 'Running',
  });
  navigator.mediaSession.setActionHandler('pause', togglePause);
  navigator.mediaSession.setActionHandler('play',  () => { if (session?.paused) togglePause(); });
  navigator.mediaSession.setActionHandler('stop',  stopSession);
}

/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER + INIT
═══════════════════════════════════════════════════════════ */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

document.addEventListener('DOMContentLoaded', () => {
  loadVoices();
  requestWakeLock();

  cfg.segments = [
    { dist:1, pm:5, ps:15, tol:10 },
    { dist:2, pm:5, ps:15, tol:10 },
    { dist:1, pm:5, ps:15, tol:10 },
  ];
  renderSegments();
  refresh();

  // Unlock AudioContext on first user gesture (required by browsers)
  const unlock = () => {
    try { getACtx().resume(); startSilentLoop(); } catch(e) {}
    document.removeEventListener('touchstart', unlock);
    document.removeEventListener('click', unlock);
  };
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('click', unlock);
});
