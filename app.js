'use strict';
/* ═══════════════════════════════════════════════════════
   RunCoach — app.js
   ═══════════════════════════════════════════════════════ */

/* ─── CONFIG ──────────────────────────────────────────── */
const cfg = {
  warm:      10,    // min
  rest:       2,    // min
  cool:      10,    // min
  paceFreq:  10,    // seconds between pace announce (0 = off)
  distFreq: 200,    // metres between distance announce (0 = off)
  paceGuide: true,  // allure cible active
  segments: [],
};

const LIMITS = {
  warm:[0,60], rest:[0,15], cool:[0,60],
  paceFreq:[0,120], distFreq:[0,2000],
};

/* ─── AUDIO CONTEXT (beeps + duck music) ─────────────── */
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

/**
 * Play a short beep.
 * type: 'start' (high double) | 'end' (low single) | 'tick' (soft)
 */
function beep(type = 'start') {
  try {
    const ctx = getAudioCtx();
    const now = ctx.currentTime;

    const configs = {
      start: [{ f:880, t:0, dur:.12 }, { f:1100, t:.15, dur:.15 }],
      end:   [{ f:440, t:0, dur:.25 }],
      tick:  [{ f:660, t:0, dur:.06 }],
    };

    (configs[type] || configs.start).forEach(({ f, t, dur }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + t);
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.5, now + t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + dur);
      osc.start(now + t);
      osc.stop(now + t + dur + 0.01);
    });
  } catch (e) { console.warn('beep error', e); }
}

/* ─── SPEECH ─────────────────────────────────────────── */
let voices = [];
function loadVoices() {
  const all = window.speechSynthesis?.getVoices() || [];
  voices = all.filter(v => v.lang.startsWith('fr'));
  if (!voices.length) voices = all;
}
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

let speakQueue = [];
let isSpeaking = false;

function speak(text, priority = false) {
  if (!window.speechSynthesis) return;
  if (priority) {
    window.speechSynthesis.cancel();
    speakQueue = [];
    isSpeaking = false;
  }
  speakQueue.push(text);
  if (!isSpeaking) processQueue();
}

function processQueue() {
  if (!speakQueue.length) { isSpeaking = false; return; }
  isSpeaking = true;
  const text = speakQueue.shift();
  const u = new SpeechSynthesisUtterance(text);
  u.lang  = 'fr-FR';
  u.rate  = 0.92;
  u.pitch = 1;
  const v = voices.find(v => v.lang === 'fr-FR') || voices[0];
  if (v) u.voice = v;
  u.onend = () => { isSpeaking = false; processQueue(); };
  u.onerror = () => { isSpeaking = false; processQueue(); };
  window.speechSynthesis.speak(u);
}

function beepThenSpeak(beepType, text) {
  beep(beepType);
  // small delay so beep finishes before TTS starts
  setTimeout(() => speak(text, true), 400);
}

function durSpoken(sec) {
  if (sec === 0) return '0 seconde';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (!m) return `${s} seconde${s > 1 ? 's' : ''}`;
  if (!s) return `${m} minute${m > 1 ? 's' : ''}`;
  return `${m} minute${m > 1 ? 's' : ''} et ${s} seconde${s > 1 ? 's' : ''}`;
}

/* ─── GPS ────────────────────────────────────────────── */
let watcher      = null;
let lastPos      = null;
let totalDistM   = 0;
let segmentDistM = 0;
let speedMs      = 0;
let speedBuf     = [];

function startGPS() {
  if (!navigator.geolocation) return;
  watcher = navigator.geolocation.watchPosition(onPos, onPosErr, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
  });
  setGPSUI('on', 'Acquisition…');
}
function stopGPS() {
  if (watcher !== null) { navigator.geolocation.clearWatch(watcher); watcher = null; }
  setGPSUI('', 'GPS OFF');
}
function setGPSUI(cls, label) {
  document.getElementById('gpsDot').className = 'gps-dot' + (cls ? ' ' + cls : '');
  document.getElementById('gpsLabel').textContent = label;
}

function onPos(pos) {
  setGPSUI('on', 'GPS OK');
  const { latitude: lat, longitude: lng } = pos.coords;
  if (lastPos) {
    const d = haversine(lastPos.lat, lastPos.lng, lat, lng);
    if (d > 1 && d < 300) {
      totalDistM   += d;
      segmentDistM += d;
      const dt = (pos.timestamp - lastPos.t) / 1000;
      if (dt > 0) {
        speedBuf.push(d / dt);
        if (speedBuf.length > 8) speedBuf.shift();
        speedMs = speedBuf.reduce((a, b) => a + b) / speedBuf.length;
      }
    }
  }
  lastPos = { lat, lng, t: pos.timestamp };
  onGPSUpdate();
}
function onPosErr() { setGPSUI('error', 'GPS ERR'); }

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(lat2 - lat1), dLon = r(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function paceSecPerKm(mps) { return mps > 0.3 ? 1000 / mps : null; }

function paceStr(mps) {
  const spk = paceSecPerKm(mps);
  if (!spk) return '--:--';
  return `${Math.floor(spk/60)}:${String(Math.round(spk%60)).padStart(2,'0')}`;
}
function paceSpoken(mps) {
  const spk = paceSecPerKm(mps);
  if (!spk) return null;
  const m = Math.floor(spk/60), s = Math.round(spk%60);
  return s ? `${m} minutes ${s} par kilomètre` : `${m} minutes par kilomètre`;
}

/* ─── CONFIG HELPERS ─────────────────────────────────── */
function adj(key, delta) {
  const [mn, mx] = LIMITS[key];
  cfg[key] = Math.min(mx, Math.max(mn, cfg[key] + delta));
  // display
  const el = document.getElementById(key + '-disp');
  if (!el) return;
  if (key === 'paceFreq') el.textContent = cfg[key] === 0 ? 'OFF' : cfg[key] + 's';
  else if (key === 'distFreq') el.textContent = cfg[key] === 0 ? 'OFF' : cfg[key] + 'm';
  else el.textContent = cfg[key];
  refresh();
}

function onPaceGuideToggle() {
  cfg.paceGuide = document.getElementById('paceGuideToggle').checked;
  const dim = !cfg.paceGuide;
  document.getElementById('pace-row').classList.toggle('dim', dim);
  document.getElementById('tol-row').classList.toggle('dim', dim);
  ['seg-pm','seg-ps','seg-tol'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = dim;
  });
  refresh();
}

/* ─── SEGMENTS ───────────────────────────────────────── */
function addSegment() {
  const dist = parseFloat(document.getElementById('seg-dist').value) || 1;
  const pm   = parseInt(document.getElementById('seg-pm').value) || 5;
  const ps   = parseInt(document.getElementById('seg-ps').value) || 0;
  const tol  = parseInt(document.getElementById('seg-tol').value) || 10;
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
  const el = document.getElementById('segments-list');
  if (!cfg.segments.length) {
    el.innerHTML = '<div class="empty-state">Aucun segment — ajoutez-en ci-dessous</div>';
    return;
  }
  el.innerHTML = cfg.segments.map((s, i) => {
    const paceInfo = cfg.paceGuide
      ? `${s.pm}:${String(s.ps).padStart(2,'0')} /km · ±${s.tol}s`
      : `${s.dist} km — allure libre`;
    return `
    <div class="segment-item">
      <span class="seg-index">${i + 1}</span>
      <div class="seg-bar"></div>
      <div class="segment-info">
        <strong>${s.dist} km</strong>
        <span>${paceInfo}</span>
      </div>
      <button class="btn-del" onclick="removeSegment(${i})">✕</button>
    </div>`;
  }).join('');
}

/* ─── SCHEDULE ───────────────────────────────────────── */
function buildSchedule() {
  const phases = [];
  if (cfg.warm > 0)
    phases.push({ id:'warmup', label:'Échauffement', color:'var(--warm)', dur: cfg.warm * 60, dist:0 });
  cfg.segments.forEach((seg, i) => {
    phases.push({
      id:'effort', label:`Effort ${i + 1} — ${seg.dist} km`,
      color:'var(--effort)',
      dur: Math.round(seg.dist * (seg.pm * 60 + seg.ps)),
      dist: seg.dist,
      pm: seg.pm, ps: seg.ps, tol: seg.tol,
    });
    if (i < cfg.segments.length - 1 && cfg.rest > 0)
      phases.push({ id:'rest', label:'Repos', color:'var(--rest)', dur: cfg.rest * 60, dist:0 });
  });
  if (cfg.cool > 0)
    phases.push({ id:'cooldown', label:'Retour au calme', color:'var(--cool)', dur: cfg.cool * 60, dist:0 });
  return phases;
}

/* ─── PREVIEW ────────────────────────────────────────── */
function fmtDur(s) {
  if (s < 60) return s + 's';
  const m = Math.floor(s/60), r = s%60;
  return r ? `${m}m${r}s` : `${m} min`;
}

function refresh() {
  const sched = buildSchedule();
  const card  = document.getElementById('preview-card');
  const btn   = document.getElementById('btnStart');
  if (!sched.length) {
    card.innerHTML = '<div class="empty-state">Ajoutez des segments pour voir l\'aperçu</div>';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const COLORS = { warmup:'var(--warm)', effort:'var(--effort)', rest:'var(--rest)', cooldown:'var(--cool)' };
  card.innerHTML = sched.map(p => `
    <div class="prev-row">
      <div class="prev-dot" style="background:${COLORS[p.id]}"></div>
      <div class="prev-name">${p.label}</div>
      <div class="prev-val">${p.dist ? p.dist + ' km' : fmtDur(p.dur)}</div>
    </div>
  `).join('');
}

/* ─── SESSION ENGINE ─────────────────────────────────── */
let session = null;
let ticker  = null;

// Per-phase announce trackers
let paceTimer     = 0;   // seconds since last pace announce
let lastDistBand  = 0;   // how many distFreq-bands already announced
let paceAlertCooldown = 0; // seconds before next pace-tolerance alert

function startSession() {
  const sched = buildSchedule();
  if (!sched.length) return;

  // Unlock audio on first user gesture
  try { getAudioCtx().resume(); } catch(e){}

  totalDistM = 0; segmentDistM = 0;
  speedMs = 0; speedBuf = []; lastPos = null;
  paceTimer = 0; lastDistBand = 0; paceAlertCooldown = 0;

  session = {
    sched,
    idx:       0,
    remaining: sched[0].dur,
    elapsed:   0,
    totalDur:  sched.reduce((a, p) => a + p.dur, 0),
    paused:    false,
    totalEfforts: sched.filter(p => p.id === 'effort').length,
    effortsDone:  0,
  };

  document.getElementById('runner').classList.add('active');
  startGPS();
  announcePhaseStart(sched[0], true);
  renderRunner();
  ticker = setInterval(tick, 1000);
}

function tick() {
  if (!session || session.paused) return;
  session.elapsed++;
  session.remaining--;
  paceTimer++;
  if (paceAlertCooldown > 0) paceAlertCooldown--;

  const phase = session.sched[session.idx];

  if (phase.id === 'effort') {
    // ── Pace announce every X seconds
    if (cfg.paceFreq > 0 && paceTimer >= cfg.paceFreq) {
      paceTimer = 0;
      const ps = paceSpoken(speedMs);
      if (ps) speak(`Allure : ${ps}`);
    }

    // ── Pace tolerance alert
    if (cfg.paceGuide && phase.pm && paceAlertCooldown === 0) {
      checkPaceTolerance(phase);
    }
  }

  // ── Countdown beeps before end of timed phase
  if (phase.dur > 0) {
    const r = session.remaining;
    if (r === 3) beep('tick');
    else if (r === 2) beep('tick');
    else if (r === 1) beep('tick');
  }

  if (session.remaining <= 0) {
    advancePhase();
  } else {
    renderRunner();
  }
}

function checkPaceTolerance(phase) {
  const spk = paceSecPerKm(speedMs);
  if (!spk) return;
  const target  = phase.pm * 60 + phase.ps;  // sec/km
  const tol     = phase.tol || 10;
  const fast    = target - tol;  // below this = trop rapide (lower sec/km = faster)
  const slow    = target + tol;  // above this = trop lent

  let alertMsg = null;
  let alertCls = null;

  if (spk < fast) {
    // Going too fast (lower sec/km = faster pace)
    alertMsg = 'Trop rapide ! Réduis l\'allure.';
    alertCls = 'too-fast';
  } else if (spk > slow) {
    alertMsg = 'Trop lent ! Accélère.';
    alertCls = 'too-slow';
  }

  const alertEl = document.getElementById('paceAlert');
  if (alertMsg) {
    alertEl.textContent = alertMsg;
    alertEl.className = 'pace-alert show ' + alertCls;
    speak(alertMsg);
    paceAlertCooldown = 20; // don't alert again for 20s
  } else {
    alertEl.className = 'pace-alert';
  }
}

function onGPSUpdate() {
  if (!session) return;
  const phase = session.sched[session.idx];

  // ── Distance announce every Y metres (segment distance)
  if (phase.id === 'effort' && cfg.distFreq > 0) {
    const band = Math.floor(segmentDistM / cfg.distFreq);
    if (band > lastDistBand) {
      lastDistBand = band;
      const km = (segmentDistM / 1000).toFixed(2);
      speak(`${km} kilomètre${segmentDistM >= 1000 ? 's' : ''} dans le segment`);
    }
  }

  // ── Effort end by GPS distance
  if (phase.id === 'effort' && phase.dist && segmentDistM >= phase.dist * 1000) {
    const ps = paceSpoken(speedMs);
    beep('end');
    setTimeout(() => {
      speak(
        `Segment terminé. ${phase.dist} kilomètre${phase.dist > 1 ? 's' : ''} parcourus.` +
        (ps ? ` Allure moyenne : ${ps}.` : ''),
        true
      );
    }, 200);
    advancePhase();
    return;
  }

  renderRunner();
}

function advancePhase() {
  if (!session) return;
  if (session.sched[session.idx].id === 'effort') session.effortsDone++;

  session.idx++;
  if (session.idx >= session.sched.length) { endSession(); return; }

  const phase = session.sched[session.idx];
  session.remaining = phase.dur;
  segmentDistM = 0;
  paceTimer = 0;
  lastDistBand = 0;
  paceAlertCooldown = 0;
  document.getElementById('paceAlert').className = 'pace-alert';

  announcePhaseStart(phase, false);
  renderRunner();
}

function announcePhaseStart(phase, isFirst) {
  let msg = isFirst ? 'La séance commence. ' : '';
  if (phase.id === 'warmup') {
    msg += `Échauffement. ${durSpoken(phase.dur)}.`;
    beepThenSpeak('start', msg);
  } else if (phase.id === 'effort') {
    msg += `Effort ${session ? session.effortsDone + 1 : 1}. ` +
           `${phase.dist} kilomètre${phase.dist > 1 ? 's' : ''}.`;
    if (cfg.paceGuide && phase.pm) {
      msg += ` Allure cible : ${phase.pm} minutes` +
             (phase.ps ? ` ${phase.ps}` : '') + ` par kilomètre.`;
    }
    beepThenSpeak('start', msg);
  } else if (phase.id === 'rest') {
    msg += `Repos. ${durSpoken(phase.dur)}.`;
    beepThenSpeak('end', msg);
  } else if (phase.id === 'cooldown') {
    msg += `Retour au calme. ${durSpoken(phase.dur)}.`;
    beepThenSpeak('end', msg);
  }
}

/* ─── RUNNER UI ──────────────────────────────────────── */
const PHASE_COLOR = { warmup:'var(--warm)', effort:'var(--effort)', rest:'var(--rest)', cooldown:'var(--cool)' };
const PHASE_LABEL = { warmup:'ÉCHAUFFEMENT', effort:'EFFORT', rest:'REPOS', cooldown:'RETOUR AU CALME' };
const CIRCUMFERENCE = 521.50; // 2π × 83

function renderRunner() {
  if (!session) return;
  const phase = session.sched[session.idx];
  const color = PHASE_COLOR[phase.id] || 'var(--text)';

  // Header
  document.getElementById('rhName').textContent = phase.label.toUpperCase();
  document.getElementById('phaseGlow').style.background = color;

  // Badge
  const badge = document.getElementById('phaseBadge');
  badge.textContent = PHASE_LABEL[phase.id] || phase.label.toUpperCase();
  badge.style.color = color;
  badge.style.borderColor = color;

  // Ring
  const rt = document.getElementById('ringTime');
  const rp = document.getElementById('ringProg');
  rt.style.color = color;
  rp.style.stroke = color;

  if (phase.id === 'effort' && phase.dist) {
    // Show segment elapsed time; ring shows distance progress
    const segElapsed = phase.dur - session.remaining;
    rt.textContent = fmtTime(segElapsed);
    document.getElementById('ringSub').textContent = 'ÉCOULÉ';
    const distPct = Math.min(segmentDistM / (phase.dist * 1000), 1);
    rp.style.strokeDashoffset = CIRCUMFERENCE * (1 - distPct);
  } else {
    rt.textContent = fmtTime(session.remaining);
    document.getElementById('ringSub').textContent = 'RESTANT';
    const pct = phase.dur > 0 ? session.remaining / phase.dur : 0;
    rp.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
  }

  // Segment card
  const segCard = document.getElementById('segCard');
  if (phase.id === 'effort' && phase.dist) {
    segCard.style.display = 'block';
    document.getElementById('segDone').textContent   = (segmentDistM / 1000).toFixed(2);
    document.getElementById('segTarget').textContent = phase.dist.toFixed(2);
    const paceEl = document.getElementById('segPaceTarget');
    if (cfg.paceGuide && phase.pm) {
      const tgt = `${phase.pm}:${String(phase.ps).padStart(2,'0')}`;
      const lo  = fmtPaceFromSec(phase.pm*60 + phase.ps - phase.tol);
      const hi  = fmtPaceFromSec(phase.pm*60 + phase.ps + phase.tol);
      paceEl.style.color = 'var(--text3)';
      paceEl.textContent = `Cible ${tgt} /km · ±${phase.tol}s [${lo} – ${hi}]`;
    } else {
      paceEl.textContent = 'Allure libre';
      paceEl.style.color = 'var(--text3)';
    }
  } else {
    segCard.style.display = 'none';
  }

  // Stats
  document.getElementById('statPace').textContent = paceStr(speedMs);
  document.getElementById('statDist').textContent = (totalDistM / 1000).toFixed(2);
  const effortNum = session.sched.slice(0, session.idx + 1).filter(p => p.id === 'effort').length;
  document.getElementById('statStep').textContent =
    phase.id === 'effort' ? `${effortNum}/${session.totalEfforts}` : '—';

  // Progress
  const pct = Math.min(Math.round(session.elapsed / Math.max(session.totalDur, 1) * 100), 100);
  document.getElementById('progFill').style.width = pct + '%';
  document.getElementById('progPct').textContent  = pct + ' %';
}

function fmtTime(sec) {
  if (sec < 0) sec = 0;
  return `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
}
function fmtPaceFromSec(sec) {
  if (sec <= 0) return '--:--';
  return `${Math.floor(sec/60)}:${String(Math.round(sec%60)).padStart(2,'0')}`;
}

/* ─── CONTROLS ───────────────────────────────────────── */
function togglePause() {
  if (!session) return;
  session.paused = !session.paused;
  document.getElementById('pauseBtn').textContent = session.paused ? '▶ REPRENDRE' : '⏸ PAUSE';
  if (session.paused) {
    beep('tick');
    setTimeout(() => speak('Pause.', true), 200);
  } else {
    beepThenSpeak('start', 'On repart !');
  }
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
  document.getElementById('paceAlert').className = 'pace-alert';
}

function endSession() {
  clearInterval(ticker); ticker = null;
  stopGPS();
  window.speechSynthesis?.cancel();

  const dist    = totalDistM;
  const elapsed = session?.elapsed || 0;
  session = null;
  document.getElementById('runner').classList.remove('active');

  const avgMps = dist > 20 ? dist / elapsed : 0;
  document.getElementById('completeGrid').innerHTML = `
    <div class="complete-stat"><div class="v">${fmtTime(elapsed)}</div><div class="l">DURÉE TOTALE</div></div>
    <div class="complete-stat"><div class="v">${(dist/1000).toFixed(2)}</div><div class="l">KM COURUS</div></div>
    <div class="complete-stat"><div class="v">${paceStr(avgMps)}</div><div class="l">ALLURE MOY.</div></div>
    <div class="complete-stat"><div class="v">✓</div><div class="l">SÉANCE OK</div></div>
  `;
  document.getElementById('completeScreen').classList.add('active');
  beep('end');
  setTimeout(() => {
    speak(`Séance terminée ! Bravo ! Tu as couru ${(dist/1000).toFixed(1)} kilomètres.`);
  }, 400);
}

function closeComplete() {
  document.getElementById('completeScreen').classList.remove('active');
}

/* ─── WAKE LOCK ─────────────────────────────────────── */
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', async () => {
  // When page becomes visible again, re-request wake lock AND un-suspend speech synthesis
  if (document.visibilityState === 'visible') {
    await requestWakeLock();
    // Workaround: some browsers suspend SpeechSynthesis when tab is hidden
    if (window.speechSynthesis?.paused) window.speechSynthesis.resume();
  }
});

/* ─── BACKGROUND / AUDIO SESSION (Media Session API) ── */
function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'RunCoach',
    artist: 'Séance en cours',
    album: 'RunCoach',
  });
  // Allow headset buttons to pause/resume
  navigator.mediaSession.setActionHandler('pause', togglePause);
  navigator.mediaSession.setActionHandler('play',  () => { if (session?.paused) togglePause(); });
}

// Tiny silent audio loop — keeps audio session alive in background
// so TTS continues working even with screen off
let silentAudio = null;
function startSilentAudio() {
  if (silentAudio) return;
  try {
    const ctx = getAudioCtx();
    // Create a silent oscillator at 0 gain looping forever
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.001; // inaudible but non-zero keeps session alive
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    silentAudio = osc;
    setupMediaSession();
  } catch(e) {}
}

/* ─── SERVICE WORKER ─────────────────────────────────── */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

/* ─── INIT ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadVoices();
  requestWakeLock();

  // Default segments: 1km + 2km + 1km
  cfg.segments = [
    { dist:1, pm:5, ps:15, tol:10 },
    { dist:2, pm:5, ps:15, tol:10 },
    { dist:1, pm:5, ps:15, tol:10 },
  ];
  renderSegments();
  refresh();

  // Start silent audio on first touch (needed for iOS / Android audio policies)
  document.addEventListener('touchstart', () => {
    try { getAudioCtx().resume(); startSilentAudio(); } catch(e) {}
  }, { once: true });
  document.addEventListener('click', () => {
    try { getAudioCtx().resume(); startSilentAudio(); } catch(e) {}
  }, { once: true });
});
