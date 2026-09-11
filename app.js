(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const video = $('#video');
  const overlay = $('#overlay');
  const octx = overlay.getContext('2d');
  const state = {
    profile: localStorage.getItem('looksmaxx-profile') || '',
    stream: null,
    mesh: null,
    raf: 0,
    phase: 'idle',
    phaseStart: 0,
    frames: [],
    lastLandmarks: null,
    lastFrameAt: 0,
    analyzing: false,
    rotation: 0,
    scanStart: 0,
    totalMs: 15000,
    currentQuality: { face: 0, pose: 0, sharp: 0, light: 0 }
  };

  const PHASES = {
    front: { start: 0, end: 5000, title: 'LOOK STRAIGHT', sub: 'Keep your eyes forward and your face inside the guide.', card: '#stageFront' },
    left: { start: 5000, end: 10000, title: 'TURN LEFT →', sub: 'Slowly turn left so the left jawline and profile are visible.', card: '#stageLeft' },
    right: { start: 10000, end: 15000, title: '← TURN RIGHT', sub: 'Slowly turn right so the right jawline and profile are visible.', card: '#stageRight' }
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const round1 = (n) => Math.round(n * 10) / 10;
  const pct = (n) => `${Math.round(clamp(n, 0, 100))}%`;
  const now = () => performance.now();

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('on'), 2600);
  }

  function setProfile(profile) {
    state.profile = profile;
    localStorage.setItem('looksmaxx-profile', profile);
    $$('.profile-card').forEach((b) => b.classList.toggle('selected', b.dataset.profile === profile));
    $('#profileStatus').textContent = profile === 'man'
      ? 'Man profile selected — scan ready.'
      : profile === 'woman'
        ? 'Woman profile selected — scan ready.'
        : 'Neutral profile selected — scan ready.';
    $('#profileStatus').style.color = 'var(--lime)';
  }

  function scrollToScanner() {
    $('#scanner').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function openModal(id) { $(id).classList.add('open'); }
  function closeModals() { $$('.modal').forEach((m) => m.classList.remove('open')); }

  function resizeOverlay() {
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    overlay.width = Math.max(1, Math.round(rect.width * devicePixelRatio));
    overlay.height = Math.max(1, Math.round(rect.height * devicePixelRatio));
    octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function setScanUI(phase, elapsed = 0) {
    state.phase = phase;
    const p = PHASES[phase];
    const active = phase !== 'idle' && phase !== 'done';
    $('#scanState').textContent = phase === 'done' ? 'COMPLETE' : active ? 'SCANNING' : 'IDLE';
    $('#phaseLabel').textContent = phase === 'idle' ? 'Camera not started' : phase === 'done' ? 'Scan complete' : p.title;
    $('#guideText').textContent = phase === 'idle' ? 'Choose a profile, then enable camera' : phase === 'done' ? 'Preparing your report…' : p.title;
    $('#subGuide').textContent = phase === 'idle' ? 'Your camera never leaves this page.' : phase === 'done' ? 'Selecting the best usable frames.' : p.sub;
    $$('.stage-card').forEach((el) => el.classList.remove('active'));
    if (p?.card) $(p.card).classList.add('active');
    const progress = phase === 'done' ? 100 : clamp(((phase === 'idle' ? 0 : elapsed) / state.totalMs) * 100, 0, 100);
    $('#progressBar').style.width = `${progress}%`;
    const seconds = active ? Math.min(15, Math.floor(elapsed / 1000) + 1) : phase === 'done' ? 15 : 0;
    $('#timer').textContent = `00:${String(seconds).padStart(2, '0')}`;
  }

  function setQuality(q) {
    state.currentQuality = q;
    $('#qFace').textContent = q.face > .6 ? 'GOOD' : q.face > .2 ? 'FOUND' : 'NO';
    $('#qPose').textContent = q.pose > .72 ? 'GOOD' : q.pose > .4 ? 'ADJUST' : '—';
    $('#qSharp').textContent = q.sharp > .7 ? 'HIGH' : q.sharp > .38 ? 'OK' : 'LOW';
    $('#qLight').textContent = q.light > .7 ? 'GOOD' : q.light > .4 ? 'OK' : 'LOW';
  }

  function meanLuma(imageData) {
    const d = imageData.data;
    let total = 0, count = 0;
    for (let i = 0; i < d.length; i += 16) {
      total += (0.2126 * d[i]) + (0.7152 * d[i + 1]) + (0.0722 * d[i + 2]);
      count++;
    }
    return total / Math.max(1, count);
  }

  function sharpnessScore(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const stride = 4;
    let sum = 0, n = 0;
    for (let y = 2; y < h - 2; y += 4) {
      for (let x = 2; x < w - 2; x += 4) {
        const i = (y * w + x) * stride;
        const gx = d[i] - d[i - 8];
        const gy = d[i] - d[i - w * 4];
        sum += Math.abs(gx) + Math.abs(gy);
        n += 2;
      }
    }
    return clamp(sum / Math.max(1, n) / 30, 0, 1);
  }

  function landmarkMetrics(lm) {
    const p = (i) => lm[i];
    const eyeL = p(33), eyeR = p(263), eyeMid = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
    const nose = p(1), chin = p(152), forehead = p(10), cheekL = p(234), cheekR = p(454), jawL = p(172), jawR = p(397);
    const mouthL = p(61), mouthR = p(291), upperLip = p(13), lowerLip = p(14);
    const eyeDist = dist(eyeL, eyeR);
    const faceWidth = dist(cheekL, cheekR);
    const faceHeight = dist(forehead, chin);
    const jawWidth = dist(jawL, jawR);
    const mouthWidth = dist(mouthL, mouthR);
    const eyeSpacing = dist(p(133), p(362));
    const browToEyeL = dist(p(105), p(159));
    const browToEyeR = dist(p(334), p(386));
    const noseLength = dist(p(168), p(2));
    const lipHeight = dist(upperLip, lowerLip);
    const yaw = (nose.x - eyeMid.x) / Math.max(.001, eyeDist);
    const eyeTilt = Math.abs((eyeL.y - eyeR.y) / Math.max(.001, eyeDist));
    const symmetry = clamp(1 - (Math.abs((p(159).y - p(386).y)) / .04 + Math.abs((p(145).y - p(374).y)) / .04) / 2, 0, 1);
    const faceRatio = faceWidth / Math.max(.001, faceHeight);
    const jawRatio = jawWidth / Math.max(.001, faceWidth);
    const chinRatio = dist(nose, chin) / Math.max(.001, faceHeight);
    const midfaceRatio = dist(p(159), p(386)) / Math.max(.001, faceHeight);
    return { eyeDist, faceWidth, faceHeight, jawWidth, mouthWidth, eyeSpacing, browToEyeL, browToEyeR, noseLength, lipHeight, yaw, eyeTilt, symmetry, faceRatio, jawRatio, chinRatio, midfaceRatio };
  }

  function poseScore(metrics, phase) {
    const y = Math.abs(metrics.yaw);
    if (phase === 'front') return clamp(1 - y / .18, 0, 1);
    if (phase === 'left') return clamp((metrics.yaw - .12) / .22, 0, 1);
    if (phase === 'right') return clamp((-metrics.yaw - .12) / .22, 0, 1);
    return .5;
  }

  function drawLandmarks(lm, phase) {
    const rect = video.getBoundingClientRect();
    octx.clearRect(0, 0, rect.width, rect.height);
    if (!lm) return;
    const key = [10, 152, 33, 263, 234, 454, 172, 397, 1, 61, 291];
    octx.lineWidth = 1.4;
    octx.strokeStyle = 'rgba(215,255,79,.72)';
    key.forEach((i) => {
      const pt = lm[i];
      if (!pt) return;
      octx.beginPath();
      octx.arc(pt.x * rect.width, pt.y * rect.height, 2.2, 0, Math.PI * 2);
      octx.stroke();
    });
    const m = landmarkMetrics(lm);
    const c = { x: ((lm[234].x + lm[454].x) / 2) * rect.width, y: ((lm[10].y + lm[152].y) / 2) * rect.height };
    octx.strokeStyle = phase === 'front' ? 'rgba(100,220,255,.7)' : 'rgba(215,255,79,.7)';
    octx.beginPath();
    octx.arc(c.x, c.y, Math.max(25, m.faceWidth * rect.width * .38), 0, Math.PI * 2);
    octx.stroke();
  }

  function makeFrameSnapshot(phase, lm) {
    const c = document.createElement('canvas');
    const w = 320, h = Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * w);
    c.width = w; c.height = Math.max(180, Math.min(420, h));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, c.width, c.height);
    const metrics = landmarkMetrics(lm);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const luma = meanLuma(img);
    const light = clamp(1 - Math.abs(luma - 128) / 128, 0, 1);
    const sharp = sharpnessScore(ctx, c.width, c.height);
    const pose = poseScore(metrics, phase);
    const face = clamp(metrics.faceWidth / .45, 0, 1);
    const quality = .38 * pose + .25 * sharp + .2 * light + .17 * face;
    return { phase, quality, sharp, light, pose, metrics, time: Date.now() };
  }

  async function ensureMesh() {
    if (state.mesh) return state.mesh;
    if (typeof FaceMesh === 'undefined') throw new Error('The face-landmark engine could not load. Refresh the page and try again.');
    state.mesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
    state.mesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: .6, minTrackingConfidence: .6 });
    state.mesh.onResults(handleResults);
    return state.mesh;
  }

  function handleResults(results) {
    if (!results.multiFaceLandmarks?.length) {
      setQuality({ face: 0, pose: 0, sharp: state.currentQuality.sharp, light: state.currentQuality.light });
      drawLandmarks(null, state.phase);
      state.lastLandmarks = null;
      return;
    }
    const lm = results.multiFaceLandmarks[0];
    state.lastLandmarks = lm;
    const metrics = landmarkMetrics(lm);
    drawLandmarks(lm, state.phase);
    const q = { face: 1, pose: poseScore(metrics, state.phase), sharp: state.currentQuality.sharp, light: state.currentQuality.light };
    setQuality(q);
  }

  async function processLoop(t) {
    if (!state.stream || state.analyzing) return;
    if (video.readyState >= 2 && state.mesh && t - state.lastFrameAt > 80) {
      state.lastFrameAt = t;
      try {
        await state.mesh.send({ image: video });
        if (state.phase !== 'idle' && state.phase !== 'done' && state.lastLandmarks && t - state.lastFrameAt < 1000) {
          const snap = makeFrameSnapshot(state.phase, state.lastLandmarks);
          state.frames.push(snap);
          setQuality({ face: 1, pose: snap.pose, sharp: snap.sharp, light: snap.light });
        }
      } catch (e) {
        console.warn('Face processing error', e);
      }
    }
    state.raf = requestAnimationFrame(processLoop);
  }

  async function enableCamera() {
    if (!state.profile) {
      toast('Choose a rating profile first.');
      $('#setup').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    try {
      await ensureMesh();
      if (state.stream) stopCamera(false);
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'user' }, width: { ideal: 720 }, height: { ideal: 1280 } } });
      video.srcObject = state.stream;
      await video.play();
      resizeOverlay();
      $('#cameraBtn').textContent = 'Scanning…';
      $('#cameraBtn').disabled = true;
      $('#stopBtn').disabled = false;
      $('#cameraStatus').textContent = 'Camera active. Keep your face inside the guide and follow the directions.';
      state.frames = [];
      state.scanStart = now();
      setScanUI('front', 0);
      requestAnimationFrame(processLoop);
      runTimedScan();
    } catch (err) {
      console.error(err);
      $('#cameraStatus').textContent = err.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in the browser and try again.'
        : 'Camera could not start. Use HTTPS or localhost and make sure another app is not using the camera.';
      toast('Camera could not be started.');
      $('#cameraBtn').disabled = false;
    }
  }

  function runTimedScan() {
    const loop = () => {
      if (!state.stream) return;
      const elapsed = now() - state.scanStart;
      if (elapsed >= state.totalMs) {
        setScanUI('done', state.totalMs);
        state.analyzing = true;
        cancelAnimationFrame(state.raf);
        setTimeout(() => finishAnalysis(), 550);
        return;
      }
      const nextPhase = elapsed < 5000 ? 'front' : elapsed < 10000 ? 'left' : 'right';
      setScanUI(nextPhase, elapsed);
      state.raf = requestAnimationFrame(processLoop);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function pickBest(phase, n = 3) {
    return state.frames.filter((f) => f.phase === phase).sort((a, b) => b.quality - a.quality).slice(0, n);
  }

  function aggregateMetrics(frames) {
    if (!frames.length) return null;
    const keys = Object.keys(frames[0].metrics);
    const metrics = {};
    for (const k of keys) metrics[k] = avg(frames.map((f) => f.metrics[k]));
    metrics.bestQuality = avg(frames.map((f) => f.quality));
    metrics.bestSharp = avg(frames.map((f) => f.sharp));
    metrics.bestLight = avg(frames.map((f) => f.light));
    return metrics;
  }

  function scoreFromMetrics(front, left, right) {
    if (!front) return 0;
    const sides = [left, right].filter(Boolean);
    const symmetry = clamp(front.symmetry, 0, 1);
    const ratioIdeal = 1 - clamp(Math.abs(front.faceRatio - .72) / .28, 0, 1);
    const jaw = clamp((front.jawRatio - .60) / .20, 0, 1);
    const chin = 1 - clamp(Math.abs(front.chinRatio - .47) / .22, 0, 1);
    const eyes = 1 - clamp(Math.abs(front.eyeSpacing / Math.max(.001, front.faceWidth) - .37) / .17, 0, 1);
    const mouth = 1 - clamp(Math.abs(front.mouthWidth / Math.max(.001, front.faceWidth) - .37) / .2, 0, 1);
    const poseQuality = avg(sides.length ? sides.map((s) => Math.abs(s.yaw)) : [0]);
    const profileQuality = sides.length ? clamp(poseQuality / .28, 0, 1) : .5;
    const cameraQuality = avg([front.bestQuality || .5, front.bestSharp || .5, front.bestLight || .5]);
    const base = 3.1 + 1.05 * symmetry + .8 * ratioIdeal + .75 * jaw + .55 * chin + .5 * eyes + .35 * mouth + .5 * profileQuality + .55 * cameraQuality;
    return clamp(base, 0, 8);
  }

  function tierFor(score, profile) {
    if (profile === 'man') {
      if (score < 3.5) return 'LTN';
      if (score < 4.8) return 'MTN';
      if (score < 6.1) return 'HTN';
      if (score < 7.15) return 'HIGH TIER';
      return 'TOP TIER';
    }
    if (profile === 'woman') {
      if (score < 3.5) return 'LTB';
      if (score < 4.8) return 'MTB';
      if (score < 6.1) return 'HTB';
      if (score < 7.15) return 'HIGH TIER';
      return 'TOP TIER';
    }
    if (score < 3.5) return 'LOW';
    if (score < 4.8) return 'MID';
    if (score < 6.1) return 'HIGH';
    if (score < 7.15) return 'VERY HIGH';
    return 'TOP';
  }

  function traitLabel(score, good = 'strong', mid = 'balanced', low = 'less pronounced') {
    return score > .67 ? good : score > .42 ? mid : low;
  }

  function renderResults(score, front, left, right) {
    const bestFrames = [front, left, right].filter(Boolean).length;
    const tier = tierFor(score, state.profile);
    $('#score').textContent = score.toFixed(1);
    $('#tier').textContent = tier;
    $('#meter').style.width = `${(score / 8) * 100}%`;
    $('#outProfile').textContent = state.profile === 'man' ? 'MAN' : state.profile === 'woman' ? 'WOMAN' : 'NEUTRAL';
    $('#outFrames').textContent = `${bestFrames} angle sets selected`;
    const confidence = clamp(55 + bestFrames * 10 + ((front?.bestQuality || .5) * 25), 0, 95);
    $('#confidence').textContent = `${Math.round(confidence)}% frame confidence`;
    $('#scoreText').textContent = `A structured PSL-style appearance estimate based on facial landmarks, pose coverage and frame quality. It is not a scientific measurement.`;

    const jaw = clamp((front.jawRatio - .55) / .28, 0, 1);
    const faceShape = front.faceRatio < .66 ? 'Long/oval leaning' : front.faceRatio > .80 ? 'Wider/rounder leaning' : 'Balanced oval leaning';
    const symmetry = clamp(front.symmetry, 0, 1);
    const profile = left && right ? 'Two-sided profile captured' : 'Partial profile coverage';
    const traits = [
      ['Face shape', faceShape, 'Based on width-to-height landmark ratio.'],
      ['Jaw definition', traitLabel(jaw, 'Pronounced', 'Moderate', 'Softer/less pronounced'), 'Estimated from lower-face width relative to cheek width.'],
      ['Facial balance', traitLabel(symmetry, 'High landmark balance', 'Generally balanced', 'More asymmetry visible'), 'Comparison of left/right landmark relationships.'],
      ['Eye spacing', traitLabel(1 - Math.abs(front.eyeSpacing / Math.max(.001, front.faceWidth) - .37) / .2, 'Proportionate', 'Moderate', 'Further from reference range'), 'Relative spacing between inner eye landmarks.'],
      ['Midface', traitLabel(1 - Math.abs(front.midfaceRatio - .30) / .18, 'Compact/balanced', 'Average', 'Longer-looking'), 'Approximate eye-to-chin relationship.'],
      ['Chin projection', traitLabel(1 - Math.abs(front.chinRatio - .47) / .22, 'Balanced', 'Moderate', 'Less pronounced'), 'Front-view proxy; side profile is more informative.'],
      ['Profile coverage', profile, 'Left and right captures help contextualize the result.']
    ];
    $('#traitList').innerHTML = traits.map(([a,b,c]) => `<div class="trait"><b>${a}</b><span>${b} — ${c}</span></div>`).join('');

    const metrics = [
      ['Face width / height', front.faceRatio, 'shape ratio'],
      ['Jaw / cheek width', front.jawRatio, 'jaw proportion'],
      ['Eye spacing / face width', front.eyeSpacing / Math.max(.001, front.faceWidth), 'eye proportion'],
      ['Nose / face height', front.noseLength / Math.max(.001, front.faceHeight), 'nose proportion'],
      ['Mouth / face width', front.mouthWidth / Math.max(.001, front.faceWidth), 'mouth proportion'],
      ['Symmetry indicator', front.symmetry, 'landmark balance']
    ];
    $('#metricGrid').innerHTML = metrics.map(([name,val,note]) => `<div class="metric"><div class="metric-top"><b>${name}</b><small>${note}</small></div><div class="bar"><i style="width:${pct(clamp((val / (name.includes('width / height') ? .9 : name.includes('Symmetry') ? 1 : .5)) * 100, 0, 100))}"></i></div><small>${round1(val)}</small></div>`).join('');

    const improvements = [];
    if (front.bestLight < .64) improvements.push(['L', 'Lighting', 'Use a large, soft light in front of you. Even lighting makes facial proportions easier to judge.']);
    if (front.bestSharp < .55) improvements.push(['F', 'Photo sharpness', 'Keep the phone steady, clean the lens and avoid digital zoom.']);
    if (jaw < .5) improvements.push(['J', 'Jaw presentation', 'A cleaner hairstyle, neutral neck posture and three-quarter angles can make the jaw area read more clearly.']);
    if (symmetry < .62) improvements.push(['S', 'Balance', 'Try relaxed posture and level head positioning. Small pose changes can exaggerate asymmetry in photos.']);
    improvements.push(['H', 'Hair / framing', 'Choose a hairstyle that complements your face shape rather than hiding the entire forehead or jaw.']);
    improvements.push(['G', 'Grooming', 'Consistent skincare, tidy facial hair where applicable and clean brows can improve overall presentation.']);
    improvements.push(['P', 'Profile shots', 'Keep using left and right three-quarter views when comparing progress; they reveal more than a single straight selfie.']);
    $('#improvementList').innerHTML = improvements.slice(0, 7).map(([i,t,p]) => `<div class="improvement"><span>${i}</span><div><b>${t}</b><p>${p}</p></div></div>`).join('');

    $('#resultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function finishAnalysis() {
    state.analyzing = false;
    const frontFrames = pickBest('front', 4);
    const leftFrames = pickBest('left', 3);
    const rightFrames = pickBest('right', 3);
    const front = aggregateMetrics(frontFrames);
    const left = aggregateMetrics(leftFrames);
    const right = aggregateMetrics(rightFrames);
    if (!front) {
      toast('No usable face frames were captured. Try again with your face fully visible.');
      $('#cameraStatus').textContent = 'No reliable front frames were captured. Improve lighting and keep your face inside the guide.';
      return;
    }
    const rawScore = scoreFromMetrics(front, left, right);
    const score = Math.round(rawScore * 10) / 10;
    renderResults(score, front, left, right);
    stopCamera(false);
    state.lastResult = { score, profile: state.profile, tier: tierFor(score, state.profile), bestFrames: { front: frontFrames.length, left: leftFrames.length, right: rightFrames.length }, createdAt: Date.now() };
  }

  function stopCamera(showToast = true) {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    video.srcObject = null;
    $('#cameraBtn').disabled = false;
    $('#cameraBtn').textContent = 'Enable Camera';
    $('#stopBtn').disabled = true;
    if (showToast) toast('Camera stopped.');
  }

  function saveResult() {
    if (!state.lastResult) return toast('Complete a scan first.');
    const old = JSON.parse(localStorage.getItem('looksmaxx-history') || '[]');
    old.unshift(state.lastResult);
    localStorage.setItem('looksmaxx-history', JSON.stringify(old.slice(0, 20)));
    renderHistory();
    toast('Result saved to this browser.');
  }

  function renderHistory() {
    const items = JSON.parse(localStorage.getItem('looksmaxx-history') || '[]');
    const html = items.length ? items.map((x) => `<div class="history-item"><div><b>${escapeHtml(x.tier)}</b><span>${new Date(x.createdAt).toLocaleString()} • ${escapeHtml(String(x.profile).toUpperCase())}</span></div><strong>${Number(x.score).toFixed(1)}</strong></div>`).join('') : '<div class="empty">No saved results yet.</div>';
    $('#historyList').innerHTML = html;
    $('#historyModalBody').innerHTML = html;
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[m]); }

  function clearResult() {
    state.lastResult = null;
    $('#score').textContent = '—'; $('#tier').textContent = 'WAITING'; $('#meter').style.width = '0%';
    $('#outProfile').textContent = '—'; $('#outFrames').textContent = '—'; $('#confidence').textContent = '—';
    $('#scoreText').textContent = 'Complete the scan to generate a structured estimate.';
    $('#traitList').innerHTML = '<div class="empty">No report yet.</div>';
    $('#metricGrid').innerHTML = '';
    $('#improvementList').innerHTML = '';
  }

  $$('.profile-card').forEach((b) => b.addEventListener('click', () => setProfile(b.dataset.profile)));
  $('#startBtn').addEventListener('click', () => { setProfile(state.profile || ''); scrollToScanner(); if (state.profile) setTimeout(enableCamera, 500); });
  $('#heroStart').addEventListener('click', () => { scrollToScanner(); if (state.profile) setTimeout(enableCamera, 500); else $('#setup').scrollIntoView({ behavior: 'smooth' }); });
  $('#guideBtn').addEventListener('click', () => $('#guide').scrollIntoView({ behavior: 'smooth' }));
  $('#heroAbout').addEventListener('click', () => openModal('#aboutModal'));
  $('#aboutBtn').addEventListener('click', () => openModal('#aboutModal'));
  $('#historyBtn').addEventListener('click', () => { renderHistory(); openModal('#historyModal'); });
  $('#cameraBtn').addEventListener('click', enableCamera);
  $('#stopBtn').addEventListener('click', () => stopCamera(true));
  $('#rescanBtn').addEventListener('click', () => { clearResult(); scrollToScanner(); setTimeout(enableCamera, 350); });
  $('#saveBtn').addEventListener('click', saveResult);
  $('#clearBtn').addEventListener('click', clearResult);
  $('#clearHistory').addEventListener('click', () => { localStorage.removeItem('looksmaxx-history'); renderHistory(); toast('History cleared.'); });
  $$('[data-close]').forEach((el) => el.addEventListener('click', closeModals));
  window.addEventListener('resize', resizeOverlay);
  window.addEventListener('beforeunload', () => stopCamera(false));

  // Camera requires a secure context. This also gives a clear error before the user reaches the button.
  if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    $('#cameraStatus').textContent = 'Camera access requires HTTPS or localhost. The page cannot open the camera from a plain file:// URL.';
    $('#cameraBtn').disabled = true;
  } else if (!navigator.mediaDevices?.getUserMedia) {
    $('#cameraStatus').textContent = 'This browser does not expose the required camera API.';
    $('#cameraBtn').disabled = true;
  }

  if (state.profile) setProfile(state.profile);
  renderHistory();
  resizeOverlay();
})();
