'use strict';
/* ═══════════════════════════════════════════════════
   RunCoach — app.js
   Distance-based training coach with vocal guidance
═══════════════════════════════════════════════════ */

/* ─────────────────────────────────────
   AUDIO CONTEXT  (Web Audio API)
   Used for beep sounds + audio ducking
───────────────────────────────────── */
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

/**
 * Play a beep tone
 * @param {number} freq  - Hz
 * @param {number} dur   - seconds
 * @param {string} type  - oscillator type
 * @param {number} vol   - 0..1
 */
function beep(freq = 880, dur = 0.18, type = 'sine', vol = 0.7) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  } catch (e) { console.warn('beep error', e); }
}

/** Double-beep: start of effort */
function bipStart() {
  beep(880, 0.15, 'sine', 0.7);
  setTimeout(() => beep(1100, 0.2, 'sine', 0.8), 200);
}

/** Single lower beep: start of rest */
function bipRest() {
  beep(550, 0.25, 'sine', 0.65);
}

/** Triple short beep: end of session */
function bipEnd() {
  beep(880, 0.12, 'sine', 0.6);
  setTimeout(() => beep(880, 0.12, 'sine', 0.6), 180);
  setTimeout(() => beep(1320, 0.3, 'sine', 0.8), 360);
}

/* ─────────────────────────────────────
   SPEECH SYNTHESIS
   Web Speech API — French voice
───────────────────────────────────── */
let voices = [];
function loadVoices() {
  const all = window.speechSynthesis.getVoices();
  voices = all.filter(v => v.lang.startsWith('fr'));
  if (!voices.length) voices = all; // fallback to any
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

let speakQueue = [];
let isSpeaking = false;

function speak(text, interrupt = false) {
  if (!window.speechSynthesis) return;
  if (interrupt) {
    window.speechSynthesis.cancel();
    speakQueue = [];
    isSpeaking = false;
  }
  speakQueue.push(text);
  if (!isSpeaking) flushSpeakQueue();
}

function flushSpeakQueue() {
  if (!speakQueue.length) { isSpeaking = false; return; }
  isSpeaking = true;
  const text = speakQueue.shift();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  u.rate = 0.92;
  u.pitch = 1.0;
  const v = voices.find(v => v.lang === 'fr-FR') || voices[0];
  if (v) u.voice = v;
  u.onend = () => flushSpeakQueue();
  u.onerror = () => flushSpeakQueue();
  window.speechSynthesis.speak(u);
}

/* helpers */
function fmtTime(sec) {
  if (sec < 0) sec = 0;
  return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
}
function durSpoken(sec) {
  if (sec < 60) return `${sec} secondes`;
  const m = Math.floor(sec/60), s = sec%60;
  if (!s) return `${m} minute${m>1?'s':''}`;
  return `${m} minutes et ${s} secondes`;
}
function paceStr(mps) {
  if (!mps || mps < 0.3) return '--:--';
  const spk = 1000 / mps;
  return `${Math.floor(spk/60)}:${String(Math.round(spk%60)).padStart(2,'0')}`;
}
function paceSpoken(mps) {
  if (!mps || mps < 0.3) return null;
  const spk = 1000 / mps;
  const m = Math.floor(spk/60), s = Math.round(spk%60);
  return s > 0
    ? `${m} minutes ${s} par kilomètre`
    : `${m} minutes par kilomètre`;
}
/** pace in sec/km from m/s */
function paceSecPerKm(mps) {
  if (!mps || mps < 0.3) return Infinity;
  return 1000 / mps;
}

/* ─────────────────────────────────────
   CONFIG STATE
───────────────────────────────────── */
const cfg = {
  warm:     10,    // min
  rest:     2,     // min
  cool:     10,    // min
  paceFreq: 10,    // sec between pace announcements
  distAnn:  200,   // m between distance announcements
  segments: [],
  paceGuide: true, // global pace guidance toggle
};

const LIMITS = {
  warm:     [1, 60],
  rest:     [0, 15],
  cool:     [0, 60],
  paceFreq: [5, 120],
  distAnn:  [50, 2000],
};

function adj(key, delta) {
  const [mn, mx] = LIMITS[key];
  cfg[key] = Math.min(mx, Math.max(mn, cfg[key] + delta));
  document.getElementById(key + '-d').textContent = cfg[key];
  refresh();
}

/* ─────────────────────────────────────
   PACE GUIDE TOGGLE
───────────────────────────────────── */
function onPaceGuideToggle() {
  cfg.paceGuide = document.getElementById('paceGuideToggle').checked;
  const pf = document.getElementById('pace-fields');
  pf.classList.toggle('off', !cfg.paceGuide);
  // enable/disable inputs inside
  pf.querySelectorAll('input').forEach(i => i.disabled = !cfg.paceGuide);
  renderSegments();
  refresh();
}

/* ─────────────────────────────────────
   SEGMENTS
───────────────────────────────────── */
function addSegment() {
  const dist = parseFloat(document.getElementById('f-dist').value) || 1;
  const pm   = parseInt(document.getElementById('f-pm').value)    || 5;
  const ps   = parseInt(document.getElementById('f-ps').value)    || 0;
  const tol  = parseInt(document.getElementById('f-tol').value)   || 10;
  cfg.segments.push({ dist, pm, ps, tol });
  renderSegments();
  refresh();
}

function removeSegment(i) {
  cfg.segments.splice(i, 1);
  renderSegments();
  refresh();
}

function renderSegments() {
  const el = document.getElementById('segs-list');
  if (!cfg.segments.length) {
    el.innerHTML = '<div class="empty-seg">Aucun segment — ajoutez-en ci-dessous</div>';
    return;
  }
  el.innerHTML = cfg.segments.map((s, i) => {
    const paceInfo = cfg.paceGuide
      ? `${s.pm}:${String(s.ps).padStart(2,'0')} /km ± ${s.tol}s`
      : `${s.dist} km — allure libre`;
    const durEst = Math.round(s.dist * (s.pm + s.ps/60));
    return `
    <div class="seg-item">
      <span class="seg-idx">${i+1}</span>
      <div class="seg-bar"></div>
      <div class="seg-info">
        <strong>${s.dist} km</strong>
        <span>${paceInfo}${cfg.paceGuide ? ` · ~${durEst} min` : ''}</span>
      </div>
      <button class="btn-del" onclick="removeSegment(${i})">✕</button>
    </div>`;
  }).join('');
}

/* ─────────────────────────────────────
   SCHEDULE
───────────────────────────────────── */
function buildSchedule() {
  const phases = [];
  if (cfg.warm > 0)
    phases.push({ id:'warmup', label:'Échauffement', color:'var(--warm)', dur:cfg.warm*60, dist:0 });

  cfg.segments.forEach((seg, i) => {
    phases.push({
      id:'effort',
      label:`Effort ${i+1} — ${seg.dist} km`,
      color:'var(--effort)',
      dur: Math.round(seg.dist * (seg.pm*60 + seg.ps)), // expected, GPS overrides
      dist: seg.dist,
      pm: seg.pm, ps: seg.ps, tol: seg.tol,
    });
    if (i < cfg.segments.length - 1 && cfg.rest > 0)
      phases.push({ id:'rest', label:'Repos', color:'var(--rest)', dur:cfg.rest*60, dist:0 });
  });

  if (cfg.cool > 0)
    phases.push({ id:'cooldown', label:'Retour au calme', color:'var(--cool)', dur:cfg.cool*60, dist:0 });

  return phases;
}

/* ─────────────────────────────────────
   PREVIEW
───────────────────────────────────── */
function fmtDur(s) {
  if (s < 60) return s + 's';
  const m = Math.floor(s/60), r = s%60;
  return r ? `${m}m${r}s` : `${m} min`;
}

function refresh() {
  const sched = buildSchedule();
  const card  = document.getElementById('preview-card');
  const btn   = document.getElementById('btnStart');
  if (!sched.length || !cfg.segments.length) {
    card.innerHTML = '<div class="empty-seg">Ajoutez des segments pour voir l\'aperçu</div>';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  card.innerHTML = sched.map(p => `
    <div class="prev-row">
      <div class="prev-dot" style="background:${p.color}"></div>
      <div class="prev-name">${p.label}</div>
      <div class="prev-val">${p.dist ? p.dist+' km' : fmtDur(p.dur)}</div>
    </div>`).join('');
}

/* ─────────────────────────────────────
   GPS
───────────────────────────────────── */
let watcher      = null;
let lastPos      = null;
let totalDistM   = 0;
let segDistM     = 0;
let speedMs      = 0;
let speedBuf     = [];

function startGPS() {
  if (!navigator.geolocation) return;
  watcher = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
  });
  setGPS('on', 'Acquisition…');
}
function stopGPS() {
  if (watcher !== null) { navigator.geolocation.clearWatch(watcher); watcher = null; }
  setGPS('', 'GPS OFF');
}
function setGPS(cls, label) {
  document.getElementById('gpsDot').className = 'gps-dot' + (cls ? ' '+cls : '');
  document.getElementById('gpsLabel').textContent = label;
}

function onPos(pos) {
  setGPS('on', 'GPS OK');
  const { latitude: lat, longitude: lng } = pos.coords;
  if (lastPos) {
    const d = haversine(lastPos.lat, lastPos.lng, lat, lng);
    if (d > 1 && d < 250) {
      totalDistM += d;
      segDistM   += d;
      const dt = (pos.timestamp - lastPos.t) / 1000;
      if (dt > 0) {
        speedBuf.push(d / dt);
        if (speedBuf.length > 8) speedBuf.shift();
        speedMs = speedBuf.reduce((a,b)=>a+b) / speedBuf.length;
      }
    }
  }
  lastPos = { lat, lng, t: pos.timestamp };
  onGpsUpdate();
}
function onPosErr() { setGPS('error', 'GPS ERR'); }

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x*Math.PI/180;
  const dL = r(lat2-lat1), dG = r(lon2-lon1);
  const a = Math.sin(dL/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(dG/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ─────────────────────────────────────
   SESSION ENGINE
───────────────────────────────────── */
let session = null;
let ticker  = null;

// Pace / distance announce tracking
let paceTimer      = 0;   // seconds since last pace announce
let distAnnMarker  = 0;   // last m-mark for distance announce
let lastPaceAlertState = 'ok'; // 'ok' | 'fast' | 'slow'
let paceAlertCooldown = 0; // seconds before next tolerance alert

function startSession() {
  const sched = buildSchedule();
  if (!sched.length) return;

  // Reset all counters
  totalDistM = 0; segDistM = 0; speedMs = 0;
  speedBuf = []; lastPos = null;
  paceTimer = 0; distAnnMarker = 0;
  lastPaceAlertState = 'ok'; paceAlertCooldown = 0;

  session = {
    sched,
    idx:       0,
    remaining: sched[0].dur,
    elapsed:   0,
    totalDur:  sched.reduce((a,p) => a+p.dur, 0),
    paused:    false,
    effortTotal: sched.filter(p=>p.id==='effort').length,
    effortDone:  0,
  };

  document.getElementById('runner').classList.add('active');
  startGPS();
  phaseStart(sched[0], true);
  renderRunner();
  ticker = setInterval(tick, 1000);
}

/* ── Main clock tick ── */
function tick() {
  if (!session || session.paused) return;
  session.elapsed++;
  session.remaining--;
  paceTimer++;
  if (paceAlertCooldown > 0) paceAlertCooldown--;

  const ph = session.sched[session.idx];

  /* ── Pace announce (effort only) ── */
  if (ph.id === 'effort' && document.getElementById('paceFreqToggle').checked) {
    if (paceTimer >= cfg.paceFreq) {
      paceTimer = 0;
      const ps = paceSpoken(speedMs);
      if (ps) speak(`Allure : ${ps}`);
    }
  }

  /* ── Pace tolerance alert (effort only, with guide on) ── */
  if (ph.id === 'effort' && cfg.paceGuide && paceAlertCooldown === 0 && speedMs > 0.3) {
    const targetSpk = ph.pm*60 + ph.ps;       // sec/km
    const currentSpk = paceSecPerKm(speedMs);  // sec/km (higher = slower)
    const diff = currentSpk - targetSpk;       // positive = slower than target

    if (diff < -ph.tol) {
      // going FASTER than target (too fast) — pace too low
      if (lastPaceAlertState !== 'fast') {
        lastPaceAlertState = 'fast';
        paceAlertCooldown = 20;
        speak(`Ralentis ! Allure : ${paceSpoken(speedMs) || paceStr(speedMs)}`);
        updatePaceAlert('fast', 'Trop rapide — ralentis !');
      }
    } else if (diff > ph.tol) {
      // going SLOWER than target (too slow) — pace too high
      if (lastPaceAlertState !== 'slow') {
        lastPaceAlertState = 'slow';
        paceAlertCooldown = 20;
        speak(`Accélère ! Allure : ${paceSpoken(speedMs) || paceStr(speedMs)}`);
        updatePaceAlert('slow', 'Trop lentement — accélère !');
      }
    } else {
      if (lastPaceAlertState !== 'ok') {
        lastPaceAlertState = 'ok';
        updatePaceAlert('ok', '✓ Allure correcte');
      }
    }
  }

  /* ── Phase end by time ── */
  if (session.remaining <= 0) {
    advancePhase();
    return;
  }

  /* ── Countdown warnings ── */
  const r = session.remaining;
  if (r === 10) speak('10 secondes');
  else if (r === 5) speak('5');
  else if (r === 4) speak('4');
  else if (r === 3) speak('3');
  else if (r === 2) speak('2');
  else if (r === 1) speak('1');

  renderRunner();
}

/* ── GPS update handler (called on every GPS fix) ── */
function onGpsUpdate() {
  if (!session) return;
  renderRunner();

  const ph = session.sched[session.idx];
  if (ph.id !== 'effort') return;

  /* ── Distance announce ── */
  if (document.getElementById('distAnnToggle').checked) {
    const interval = cfg.distAnn;
    const crossings = Math.floor(segDistM / interval);
    if (crossings > distAnnMarker) {
      distAnnMarker = crossings;
      const metres = crossings * interval;
      const km = metres / 1000;
      const msg = km >= 1
        ? `${km.toFixed(km % 1 === 0 ? 0 : 1)} kilomètre${km >= 2 ? 's' : ''}`
        : `${metres} mètres`;
      speak(`${msg} dans le segment`);
    }
  }

  /* ── Segment end by distance ── */
  if (ph.dist && segDistM >= ph.dist * 1000) {
    const ps = paceSpoken(speedMs);
    speak(`Segment terminé ! ${ph.dist} kilomètre${ph.dist>1?'s':''}${ps ? `. Allure : ${ps}` : ''}.`, true);
    advancePhase();
  }
}

/* ── Advance to next phase ── */
function advancePhase() {
  if (!session) return;
  session.idx++;
  if (session.idx >= session.sched.length) { endSession(); return; }
  const ph = session.sched[session.idx];
  session.remaining = ph.dur;
  segDistM = 0;
  distAnnMarker = 0;
  paceTimer = 0;
  lastPaceAlertState = 'ok';
  paceAlertCooldown = 0;
  phaseStart(ph, false);
  renderRunner();
}

/* ── Announce phase start (beep + voice) ── */
function phaseStart(ph, isFirst) {
  // Beep
  if (ph.id === 'effort')  { setTimeout(bipStart, 200); }
  else if (ph.id === 'rest' || ph.id === 'cooldown') { setTimeout(bipRest, 200); }
  else if (ph.id === 'warmup' && !isFirst) { setTimeout(bipRest, 200); }

  // Count effort phases
  if (ph.id === 'effort' && !isFirst) session.effortDone++;

  // Voice
  let msg = isFirst ? 'La séance commence. ' : '';
  const names = { warmup:'Échauffement', effort:'Effort', rest:'Repos', cooldown:'Retour au calme' };
  msg += names[ph.id] || ph.label;

  if (ph.id === 'effort') {
    msg += `. ${ph.dist} kilomètre${ph.dist>1?'s':''}`;
    if (cfg.paceGuide)
      msg += ` à ${ph.pm} minutes${ph.ps>0?' '+ph.ps+' secondes':''} par kilomètre.`;
    else
      msg += '.';
  } else {
    msg += `. ${durSpoken(ph.dur)}.`;
  }

  setTimeout(() => speak(msg, true), ph.id === 'warmup' && isFirst ? 0 : 500);
}

/* ─────────────────────────────────────
   RUNNER UI
───────────────────────────────────── */
const PHASE_COLORS = { warmup:'var(--warm)', effort:'var(--effort)', rest:'var(--rest)', cooldown:'var(--cool)' };
const PHASE_LABELS = { warmup:'ÉCHAUFFEMENT', effort:'EFFORT', rest:'REPOS', cooldown:'RETOUR AU CALME' };
const CIRC = 540.35;

function renderRunner() {
  if (!session) return;
  const ph = session.sched[session.idx];
  const color = PHASE_COLORS[ph.id] || 'var(--text)';

  // Header
  document.getElementById('r-name').textContent = ph.label.toUpperCase();
  document.getElementById('phaseGlow').style.background = color;

  const badge = document.getElementById('phaseBadge');
  badge.textContent = PHASE_LABELS[ph.id] || ph.label.toUpperCase();
  badge.style.color = color;
  badge.style.borderColor = color;

  // Ring
  const rt = document.getElementById('ringTime');
  const rp = document.getElementById('ringProg');
  rt.style.color = color;
  rp.style.stroke = color;

  if (ph.id === 'effort' && ph.dist) {
    // Show elapsed time in this segment
    const elapsed = ph.dur - session.remaining;
    rt.textContent = fmtTime(Math.max(0, elapsed));
    document.getElementById('ringSub').textContent = 'ÉCOULÉ';
    const distPct = Math.min(segDistM / (ph.dist * 1000), 1);
    rp.style.strokeDashoffset = CIRC * (1 - distPct);
  } else {
    rt.textContent = fmtTime(session.remaining);
    document.getElementById('ringSub').textContent = 'RESTANT';
    const pct = ph.dur > 0 ? session.remaining / ph.dur : 0;
    rp.style.strokeDashoffset = CIRC * (1 - pct);
  }

  // Segment card
  const sc = document.getElementById('segCard');
  if (ph.id === 'effort' && ph.dist) {
    sc.style.display = 'block';
    document.getElementById('segDone').textContent   = (segDistM/1000).toFixed(2);
    document.getElementById('segTarget').textContent = ph.dist.toFixed(2);
    if (cfg.paceGuide) {
      document.getElementById('segPaceTarget').textContent =
        `Cible : ${ph.pm}:${String(ph.ps).padStart(2,'0')} /km  ±${ph.tol}s`;
    } else {
      document.getElementById('segPaceTarget').textContent = '';
      document.getElementById('paceAlert').textContent = '';
    }
  } else {
    sc.style.display = 'none';
  }

  // Stats
  document.getElementById('statPace').textContent = paceStr(speedMs);
  document.getElementById('statDist').textContent = (totalDistM/1000).toFixed(2);
  const effortsDone = session.sched.slice(0, session.idx+1).filter(p=>p.id==='effort').length;
  document.getElementById('statStep').textContent =
    ph.id === 'effort' ? `${effortsDone}/${session.effortTotal}` : '—';

  // Overall progress
  const pct = Math.min(Math.round(session.elapsed / Math.max(session.totalDur,1) * 100), 100);
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progPct').textContent  = pct + ' %';
}

function updatePaceAlert(state, msg) {
  const el = document.getElementById('paceAlert');
  if (!el) return;
  el.textContent = msg;
  el.className = 'pace-alert ' + state;
}

/* ─────────────────────────────────────
   CONTROLS
───────────────────────────────────── */
function togglePause() {
  if (!session) return;
  session.paused = !session.paused;
  document.getElementById('pauseBtn').textContent = session.paused ? '▶ REPRENDRE' : '⏸ PAUSE';
  speak(session.paused ? 'Pause.' : 'On repart !', true);
}

function skipPhase() {
  if (!session) return;
  speak('Phase suivante.', true);
  session.remaining = 0;
  advancePhase();
}

function stopSession() {
  if (!confirm('Arrêter la séance ?')) return;
  clearInterval(ticker); ticker = null;
  stopGPS();
  window.speechSynthesis?.cancel();
  session = null;
  document.getElementById('runner').classList.remove('active');
}

function endSession() {
  clearInterval(ticker); ticker = null;
  stopGPS();
  window.speechSynthesis?.cancel();
  bipEnd();

  const dist    = totalDistM;
  const elapsed = session ? session.elapsed : 0;
  session = null;
  document.getElementById('runner').classList.remove('active');

  const avgMps = dist > 20 ? dist / elapsed : 0;
  document.getElementById('doneGrid').innerHTML = `
    <div class="done-stat"><div class="v">${fmtTime(elapsed)}</div><div class="l">DURÉE TOTALE</div></div>
    <div class="done-stat"><div class="v">${(dist/1000).toFixed(2)}</div><div class="l">KM COURUS</div></div>
    <div class="done-stat"><div class="v">${paceStr(avgMps)}</div><div class="l">ALLURE MOY.</div></div>
    <div class="done-stat"><div class="v">✓</div><div class="l">SÉANCE OK</div></div>
  `;
  document.getElementById('done').classList.add('active');
  setTimeout(() => speak(`Séance terminée ! Bravo ! Tu as couru ${(dist/1000).toFixed(1)} kilomètres.`), 800);
}

function closeDone() {
  document.getElementById('done').classList.remove('active');
}

/* ─────────────────────────────────────
   BACKGROUND / VISIBILITY
   Keep session alive when screen off
   Use Page Visibility + NoSleep trick
───────────────────────────────────── */
// Unlock audio context on first user gesture (required by browsers)
document.addEventListener('touchstart', () => { getAudioCtx(); }, { once: true });
document.addEventListener('click',      () => { getAudioCtx(); }, { once: true });

// Wake lock — keep screen on during session
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', async () => {
  // When coming back to foreground, re-request wake lock
  if (document.visibilityState === 'visible') await requestWakeLock();

  // Workaround: speechSynthesis can be paused when tab is hidden
  // Re-trigger if we had something speaking
  if (document.visibilityState === 'visible' && window.speechSynthesis?.paused) {
    window.speechSynthesis.resume();
  }
});

/* ─────────────────────────────────────
   SERVICE WORKER  (offline + background)
───────────────────────────────────── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ─────────────────────────────────────
   INIT
───────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadVoices();
  requestWakeLock();

  // Default: 3 example segments
  cfg.segments = [
    { dist:1, pm:5, ps:15, tol:10 },
    { dist:2, pm:5, ps:15, tol:10 },
    { dist:1, pm:5, ps:15, tol:10 },
  ];
  renderSegments();
  refresh();
});
