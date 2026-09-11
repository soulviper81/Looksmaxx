(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const video = $('#video');
  const overlay = $('#overlay');
  const octx = overlay?.getContext('2d');
  const MEDIAPIPE_VERSION = '0.4.1633559619';

  const PHASES = {
    front: { title: 'LOOK STRAIGHT', sub: 'Head level, eyes forward, face centered.', card: '#stageFront', minFrames: 6 },
    left: { title: 'TURN LEFT →', sub: 'Slowly turn left until the side of your face is clearly visible.', card: '#stageLeft', minFrames: 4 },
    right: { title: '← TURN RIGHT', sub: 'Slowly turn right until the opposite side is clearly visible.', card: '#stageRight', minFrames: 4 }
  };
  const PHASE_ORDER = ['front', 'left', 'right'];
  const PHASE_MS = 5000;
  const PHASE_MAX_MS = 8000;

  const state = {
    profile: localStorage.getItem('looksmaxx-profile') || '',
    stream: null,
    mesh: null,
    raf: 0,
    scanRaf: 0,
    phase: 'idle',
    phaseIndex: 0,
    phaseStart: 0,
    scanStart: 0,
    phaseElapsed: 0,
    frames: [],
    lastLandmarks: null,
    lastFrameAt: 0,
    sampleCounter: 0,
    analyzing: false,
    lastResult: null,
    currentQuality: { face: 0, pose: 0, sharp: 0, light: 0, scale: 0 }
  };

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const median = (a) => {
    const v = a.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!v.length) return 0;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const stdev = (a) => {
    const v = a.filter(Number.isFinite);
    if (v.length < 2) return 0;
    const m = avg(v);
    return Math.sqrt(avg(v.map((x) => (x - m) ** 2)));
  };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const round1 = (n) => Math.round(finite(n) * 10) / 10;
  const pct = (n) => `${Math.round(clamp(finite(n), 0, 100))}%`;
  const now = () => performance.now();

  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('on'), 2600);
  }

  function safeHistoryRead() {
    try {
      const raw = localStorage.getItem('looksmaxx-history');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x) => x && Number.isFinite(Number(x.score)) && x.timestamp) : [];
    } catch {
      localStorage.removeItem('looksmaxx-history');
      return [];
    }
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

  function openModal(id) { $(id)?.classList.add('open'); }
  function closeModals() { $$('.modal').forEach((m) => m.classList.remove('open')); }
  function scrollToScanner() { $('#scanner')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  function resizeOverlay() {
    if (!video || !overlay || !octx) return;
    const r = video.getBoundingClientRect();
    if (!r.width || !r.height) return;
    overlay.width = Math.round(r.width * devicePixelRatio);
    overlay.height = Math.round(r.height * devicePixelRatio);
    octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function setScanUI(phase, phaseElapsed = 0) {
    state.phase = phase;
    const p = PHASES[phase];
    const active = phase !== 'idle' && phase !== 'done';
    $('#scanState').textContent = phase === 'done' ? 'COMPLETE' : active ? 'SCANNING' : 'IDLE';
    $('#phaseLabel').textContent = phase === 'idle' ? 'Camera not started' : phase === 'done' ? 'Scan complete' : p.title;
    $('#guideText').textContent = phase === 'idle' ? 'Choose a profile, then enable camera' : phase === 'done' ? 'Building report…' : p.title;
    $('#subGuide').textContent = phase === 'idle' ? 'Your camera never leaves this page.' : phase === 'done' ? 'Checking measurement reliability.' : p.sub;
    $$('.stage-card').forEach((x) => x.classList.remove('active'));
    if (p?.card) $(p.card)?.classList.add('active');
    const progress = phase === 'done' ? 100 : clamp(((state.phaseIndex * PHASE_MS + phaseElapsed) / (PHASE_ORDER.length * PHASE_MAX_MS)) * 100, 0, 100);
    $('#progressBar').style.width = `${progress}%`;
    const seconds = active ? Math.floor(phaseElapsed / 1000) : phase === 'done' ? 15 : 0;
    $('#timer').textContent = `00:${String(seconds).padStart(2, '0')}`;
    $$('.progress-points span').forEach((el, i) => el.classList.toggle('active', active && i === state.phaseIndex));
  }

  function setQuality(q) {
    state.currentQuality = q;
    $('#qFace').textContent = q.face > .8 ? 'GOOD' : q.face > .2 ? 'FOUND' : 'NO';
    $('#qPose').textContent = q.pose > .78 ? 'GOOD' : q.pose > .45 ? 'ADJUST' : 'WAIT';
    $('#qSharp').textContent = q.sharp > .72 ? 'HIGH' : q.sharp > .42 ? 'OK' : 'LOW';
    $('#qLight').textContent = q.light > .72 ? 'GOOD' : q.light > .42 ? 'OK' : 'LOW';
  }

  function meanLuma(image) {
    const d = image.data;
    let total = 0;
    let count = 0;
    let clipped = 0;
    for (let i = 0; i < d.length; i += 20) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (r < 8 && g < 8 && b < 8) clipped++;
      if (r > 247 && g > 247 && b > 247) clipped++;
      count++;
    }
    return { luma: total / Math.max(1, count), clipped: clipped / Math.max(1, count) };
  }

  function sharpnessScore(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    let total = 0;
    let count = 0;
    for (let y = 3; y < h - 3; y += 5) {
      for (let x = 3; x < w - 3; x += 5) {
        const i = (y * w + x) * 4;
        total += Math.abs(d[i] - d[i - 8]) + Math.abs(d[i] - d[i - w * 4]);
        count += 2;
      }
    }
    return clamp(total / Math.max(1, count) / 28, 0, 1);
  }

  function bboxFromLandmarks(lm) {
    const xs = lm.map((p) => p.x), ys = lm.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY, area: (maxX - minX) * (maxY - minY) };
  }

  function rotatePoint(pt, center, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const x = pt.x - center.x, y = pt.y - center.y;
    return { x: center.x + x * c - y * s, y: center.y + x * s + y * c, z: pt.z };
  }

  function lmMetrics(lm) {
    const p = (i) => lm[i];
    const eyeL = p(33), eyeR = p(263), innerL = p(133), innerR = p(362);
    const outerL = p(130), outerR = p(359), browL = p(105), browR = p(334);
    const nose = p(1), noseBridge = p(168), chin = p(152), forehead = p(10);
    const cheekL = p(234), cheekR = p(454), jawL = p(172), jawR = p(397);
    const mouthL = p(61), mouthR = p(291), mouthTop = p(13), mouthBottom = p(14);
    const eyeMid = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
    const eyeDist = Math.max(0.001, dist(eyeL, eyeR));
    const faceWidth = Math.max(0.001, dist(cheekL, cheekR));
    const faceHeight = Math.max(0.001, dist(forehead, chin));
    const roll = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);
    const rot = (q) => rotatePoint(q, eyeMid, -roll);
    const rEyeL = rot(eyeL), rEyeR = rot(eyeR), rInnerL = rot(innerL), rInnerR = rot(innerR);
    const rBrowL = rot(browL), rBrowR = rot(browR), rMouthL = rot(mouthL), rMouthR = rot(mouthR);
    const rJawL = rot(jawL), rJawR = rot(jawR);
    const rEyeMid = { x: (rEyeL.x + rEyeR.x) / 2, y: (rEyeL.y + rEyeR.y) / 2 };
    const symmetryPairs = [[eyeL, eyeR], [innerL, innerR], [browL, browR], [mouthL, mouthR], [jawL, jawR], [cheekL, cheekR], [p(145), p(374)], [p(159), p(386)]];
    let symmetryError = 0;
    for (const [a, b] of symmetryPairs) {
      const ra = rot(a), rb = rot(b);
      symmetryError += Math.hypot((2 * rEyeMid.x - ra.x) - rb.x, ra.y - rb.y) / faceWidth;
    }
    const symmetry = clamp(1 - (symmetryError / symmetryPairs.length) / 0.18, 0, 1);
    const bbox = bboxFromLandmarks(lm);
    const pitchProxy = (nose.y - eyeMid.y) / faceHeight;
    const faceCenterOffset = Math.abs(nose.x - eyeMid.x) / faceWidth;
    const yaw = (nose.x - eyeMid.x) / eyeDist;
    return {
      eyeDist, faceWidth, faceHeight,
      jawWidth: dist(rJawL, rJawR), mouthWidth: dist(rMouthL, rMouthR), eyeSpacing: dist(rInnerL, rInnerR),
      eyeWidth: avg([dist(rInnerL, rot(outerL)), dist(rInnerR, rot(outerR))]),
      browEyeGap: avg([dist(rBrowL, rot(p(159))), dist(rBrowR, rot(p(386)))]),
      noseLength: dist(rot(noseBridge), rot(nose)), lipHeight: dist(rot(mouthTop), rot(mouthBottom)),
      yaw, roll, pitchProxy, faceCenterOffset, symmetry, bbox,
      faceRatio: faceWidth / faceHeight,
      jawRatio: dist(rJawL, rJawR) / faceWidth,
      eyeSpacingRatio: dist(rInnerL, rInnerR) / faceWidth,
      eyeWidthRatio: avg([dist(rInnerL, rot(outerL)), dist(rInnerR, rot(outerR))]) / faceWidth,
      noseRatio: dist(rot(noseBridge), rot(nose)) / faceHeight,
      mouthRatio: dist(rMouthL, rMouthR) / faceWidth,
      lipRatio: dist(rot(mouthTop), rot(mouthBottom)) / faceHeight,
      lowerFaceRatio: dist(rot(nose), rot(chin)) / faceHeight,
      chinNoseDepthProxy: finite(Math.abs((nose.z || 0) - (chin.z || 0)) / faceWidth)
    };
  }

  function poseScore(m, phase) {
    const yaw = Math.abs(m.yaw), roll = Math.abs(m.roll);
    const rollPart = clamp(1 - roll / 0.13, 0, 1);
    const scalePart = clamp(1 - Math.abs((m.bbox?.width || 0) - 0.50) / 0.34, 0, 1);
    if (phase === 'front') return 0.62 * clamp(1 - yaw / 0.14, 0, 1) + 0.23 * rollPart + 0.15 * scalePart;
    return 0.67 * clamp((yaw - 0.15) / 0.22, 0, 1) + 0.20 * rollPart + 0.13 * scalePart;
  }

  function directionOkay(m, phase) {
    if (phase === 'front') return Math.abs(m.yaw) < 0.13 && Math.abs(m.roll) < 0.12 && Math.abs(m.pitchProxy - 0.31) < 0.10;
    if (phase === 'left') return m.yaw > 0.15 && m.yaw < 0.55 && Math.abs(m.roll) < 0.14;
    if (phase === 'right') return m.yaw < -0.15 && m.yaw > -0.55 && Math.abs(m.roll) < 0.14;
    return false;
  }

  function scaleOkay(m) {
    return m.bbox.width >= 0.26 && m.bbox.width <= 0.78 && m.bbox.height >= 0.30;
  }

  function faceRoiMetrics(lm, ctx, w, h) {
    const b = bboxFromLandmarks(lm);
    const padX = Math.max(8, Math.round(b.width * w * 0.18));
    const padY = Math.max(8, Math.round(b.height * h * 0.18));
    const x = clamp(Math.floor(b.minX * w) - padX, 0, w - 1);
    const y = clamp(Math.floor(b.minY * h) - padY, 0, h - 1);
    const rw = clamp(Math.floor(b.width * w) + padX * 2, 1, w - x);
    const rh = clamp(Math.floor(b.height * h) + padY * 2, 1, h - y);
    const image = ctx.getImageData(x, y, rw, rh);
    const exposure = meanLuma(image);
    const roiCtx = { getImageData: () => image };
    const sharp = sharpnessScore(roiCtx, rw, rh);
    const light = clamp(1 - Math.abs(exposure.luma - 128) / 128, 0, 1) * clamp(1 - exposure.clipped * 4, 0, 1);
    return { sharp, light };
  }

  function snapshot(phase, lm) {
    const c = document.createElement('canvas');
    const w = 360;
    const h = Math.max(220, Math.min(480, Math.round(video.videoHeight / Math.max(1, video.videoWidth) * w)));
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const m = lmMetrics(lm);
    const roi = faceRoiMetrics(lm, ctx, w, h);
    const pose = poseScore(m, phase);
    const centered = clamp(1 - m.faceCenterOffset / 0.34, 0, 1);
    const scale = clamp(1 - Math.abs(m.bbox.width - 0.50) / 0.34, 0, 1);
    const quality = 0.36 * pose + 0.25 * roi.sharp + 0.18 * roi.light + 0.12 * centered + 0.09 * scale;
    return { phase, quality, sharp: roi.sharp, light: roi.light, pose, centered, scale, metrics: m, time: Date.now() };
  }

  async function ensureMesh() {
    if (state.mesh) return state.mesh;
    if (typeof FaceMesh === 'undefined') throw new Error('The face-landmark engine could not load. Check your connection and refresh.');
    state.mesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${MEDIAPIPE_VERSION}/${file}` });
    state.mesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.70, minTrackingConfidence: 0.70 });
    state.mesh.onResults((results) => {
      if (!results.multiFaceLandmarks?.length) {
        state.lastLandmarks = null;
        drawLandmarks(null, state.phase);
        setQuality({ face: 0, pose: 0, sharp: state.currentQuality.sharp, light: state.currentQuality.light });
        return;
      }
      const lm = results.multiFaceLandmarks[0];
      state.lastLandmarks = lm;
      const m = lmMetrics(lm);
      drawLandmarks(lm, state.phase);
      setQuality({ face: 1, pose: poseScore(m, state.phase), sharp: state.currentQuality.sharp, light: state.currentQuality.light });
    });
    return state.mesh;
  }

  async function processLoop(t) {
    if (!state.stream || state.analyzing) return;
    if (video.readyState >= 2 && state.mesh && t - state.lastFrameAt > 115) {
      state.lastFrameAt = t;
      try {
        await state.mesh.send({ image: video });
        if (state.phase !== 'idle' && state.phase !== 'done' && state.lastLandmarks) {
          state.sampleCounter++;
          if (state.sampleCounter % 2 === 0) {
            const m = lmMetrics(state.lastLandmarks);
            if (directionOkay(m, state.phase) && scaleOkay(m)) state.frames.push(snapshot(state.phase, state.lastLandmarks));
          }
        }
      } catch (e) {
        console.warn('Face processing error:', e);
      }
    }
    state.raf = requestAnimationFrame(processLoop);
  }

  function advancePhase() {
    if (state.phaseIndex >= PHASE_ORDER.length - 1) {
      setScanUI('done', state.phaseElapsed);
      state.analyzing = true;
      cancelAnimationFrame(state.raf);
      state.scanRaf = setTimeout(finishAnalysis, 650);
      return;
    }
    state.phaseIndex++;
    state.phase = PHASE_ORDER[state.phaseIndex];
    state.phaseStart = now();
    setScanUI(state.phase, 0);
  }

  function scanTick() {
    if (!state.stream || state.analyzing) return;
    const elapsed = now() - state.phaseStart;
    state.phaseElapsed = elapsed;
    const phase = PHASE_ORDER[state.phaseIndex];
    const count = state.frames.filter((f) => f.phase === phase).length;
    setScanUI(phase, elapsed);
    if (elapsed >= PHASE_MS && count >= PHASES[phase].minFrames) { advancePhase(); return; }
    if (elapsed >= PHASE_MAX_MS) { advancePhase(); return; }
    state.scanRaf = requestAnimationFrame(scanTick);
  }

  async function enableCamera() {
    if (!state.profile) { toast('Choose a rating profile first.'); $('#setup')?.scrollIntoView({ behavior: 'smooth' }); return; }
    if (!navigator.mediaDevices?.getUserMedia) { toast('Camera access is unavailable here. Use HTTPS or localhost.'); return; }
    try {
      await ensureMesh();
      if (state.stream) stopCamera(false);
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'user' }, width: { ideal: 720 }, height: { ideal: 1280 }, frameRate: { ideal: 30, max: 30 } } });
      video.srcObject = state.stream;
      await video.play();
      resizeOverlay();
      $('#cameraBtn').textContent = 'Scanning…';
      $('#cameraBtn').disabled = true;
      $('#stopBtn').disabled = false;
      $('#cameraStatus').textContent = 'Camera active. Stable face poses are captured; image quality affects reliability, not the score.';
      state.frames = [];
      state.sampleCounter = 0;
      state.lastFrameAt = 0;
      state.phaseIndex = 0;
      state.phase = 'front';
      state.phaseStart = now();
      state.scanStart = now();
      state.analyzing = false;
      state.lastResult = null;
      setScanUI('front', 0);
      state.raf = requestAnimationFrame(processLoop);
      state.scanRaf = requestAnimationFrame(scanTick);
    } catch (err) {
      console.error(err);
      $('#cameraStatus').textContent = err.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access and try again.' : 'Camera could not start. Use HTTPS or localhost and make sure another app is not using the camera.';
      toast('Camera could not be started.');
      $('#cameraBtn').disabled = false;
    }
  }

  function stopCamera(showMessage = true) {
    cancelAnimationFrame(state.raf);
    cancelAnimationFrame(state.scanRaf);
    clearTimeout(state.scanRaf);
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (video) video.srcObject = null;
    state.lastLandmarks = null;
    state.analyzing = false;
    $('#cameraBtn').textContent = 'Enable Camera';
    $('#cameraBtn').disabled = false;
    $('#stopBtn').disabled = true;
    if (showMessage) { $('#cameraStatus').textContent = 'Scan stopped. Your camera is off.'; setScanUI('idle', 0); drawLandmarks(null, 'idle'); }
  }

  function chooseDiverse(frames, count) {
    if (!frames.length) return [];
    const pool = frames.slice().sort((a, b) => b.quality - a.quality).slice(0, Math.min(24, frames.length));
    const chosen = [];
    while (pool.length && chosen.length < count) {
      if (!chosen.length) { chosen.push(pool.shift()); continue; }
      let index = 0, best = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        const timeSpread = chosen.reduce((sum, c) => sum + Math.min(1, Math.abs(candidate.time - c.time) / 1200), 0);
        const yawSpread = chosen.reduce((sum, c) => sum + Math.min(1, Math.abs(candidate.metrics.yaw - c.metrics.yaw) / 0.20), 0);
        const value = candidate.quality + 0.10 * timeSpread + 0.06 * yawSpread;
        if (value > best) { best = value; index = i; }
      }
      chosen.push(pool.splice(index, 1)[0]);
    }
    return chosen;
  }

  function robustMedian(values) {
    const v = values.filter(Number.isFinite);
    if (v.length < 4) return median(v);
    const med = median(v);
    const deviations = v.map((x) => Math.abs(x - med));
    const mad = median(deviations);
    if (mad < 1e-6) return med;
    const filtered = v.filter((x) => Math.abs(x - med) <= 3 * 1.4826 * mad);
    return median(filtered.length >= 3 ? filtered : v);
  }

  function aggregateRobust(frames) {
    if (!frames.length) return null;
    const keys = Object.keys(frames[0].metrics);
    const m = {};
    for (const key of keys) m[key] = robustMedian(frames.map((f) => f.metrics[key]));
    m.quality = robustMedian(frames.map((f) => f.quality));
    m.sharp = robustMedian(frames.map((f) => f.sharp));
    m.light = robustMedian(frames.map((f) => f.light));
    m.pose = robustMedian(frames.map((f) => f.pose));
    m.centered = robustMedian(frames.map((f) => f.centered));
    m.scale = robustMedian(frames.map((f) => f.scale));
    return m;
  }

  function rangeScore(value, low, idealLow, idealHigh, high) {
    if (!Number.isFinite(value) || value <= low || value >= high) return 0;
    if (value >= idealLow && value <= idealHigh) return 1;
    if (value < idealLow) return clamp((value - low) / Math.max(0.001, idealLow - low), 0, 1);
    return clamp((high - value) / Math.max(0.001, high - idealHigh), 0, 1);
  }

  function frontFeatureScores(f) {
    return {
      symmetry: clamp(f.symmetry, 0, 1),
      faceHarmony: rangeScore(f.faceRatio, 0.57, 0.66, 0.79, 0.96),
      jawBalance: rangeScore(f.jawRatio, 0.47, 0.56, 0.73, 0.86),
      eyeSpacing: rangeScore(f.eyeSpacingRatio, 0.25, 0.32, 0.43, 0.55),
      noseProportion: rangeScore(f.noseRatio, 0.12, 0.19, 0.29, 0.40),
      mouthProportion: rangeScore(f.mouthRatio, 0.22, 0.31, 0.47, 0.62),
      browBalance: rangeScore(f.browEyeGap / Math.max(0.001, f.faceHeight), 0.015, 0.035, 0.075, 0.13),
      lowerFace: rangeScore(f.lowerFaceRatio, 0.31, 0.40, 0.55, 0.68)
    };
  }

  function profileSupport(left, right) {
    const sides = [left, right].filter(Boolean);
    if (!sides.length) return { coverage: 0, consistency: 0.35 };
    const consistency = sides.length === 2
      ? clamp(1 - avg([
        Math.abs(left.jawRatio - right.jawRatio) / 0.18,
        Math.abs(left.lowerFaceRatio - right.lowerFaceRatio) / 0.20,
        Math.abs(left.noseRatio - right.noseRatio) / 0.14
      ]), 0, 1)
      : 0.5;
    return { coverage: sides.length === 2 ? 1 : 0.65, consistency };
  }

  function measurementStability(frontFrames) {
    if (frontFrames.length < 3) return 0.25;
    const keys = ['faceRatio', 'jawRatio', 'eyeSpacingRatio', 'noseRatio', 'mouthRatio', 'symmetry', 'lowerFaceRatio'];
    return avg(keys.map((key) => {
      const values = frontFrames.map((f) => f.metrics[key]);
      const med = Math.max(0.02, Math.abs(median(values)));
      return clamp(1 - (stdev(values) / med) / 0.10, 0, 1);
    }));
  }

  function appearanceScore(front, left, right, frontFrames, selectedFrames) {
    if (!front) return { score: 0, components: {}, reliability: 0 };
    const f = frontFeatureScores(front);
    const p = profileSupport(left, right);
    const components = { symmetry: f.symmetry, faceHarmony: f.faceHarmony, jawBalance: f.jawBalance, eyeSpacing: f.eyeSpacing, noseProportion: f.noseProportion, mouthProportion: f.mouthProportion, browBalance: f.browBalance, lowerFace: f.lowerFace };
    const weights = state.profile === 'man'
      ? { symmetry: 0.15, faceHarmony: 0.14, jawBalance: 0.16, eyeSpacing: 0.09, noseProportion: 0.09, mouthProportion: 0.06, browBalance: 0.06, lowerFace: 0.12 }
      : state.profile === 'woman'
        ? { symmetry: 0.15, faceHarmony: 0.15, jawBalance: 0.10, eyeSpacing: 0.12, noseProportion: 0.10, mouthProportion: 0.09, browBalance: 0.08, lowerFace: 0.11 }
        : { symmetry: 0.15, faceHarmony: 0.14, jawBalance: 0.13, eyeSpacing: 0.10, noseProportion: 0.09, mouthProportion: 0.08, browBalance: 0.07, lowerFace: 0.12 };
    let weighted = 0, weight = 0;
    for (const [key, w] of Object.entries(weights)) { weighted += components[key] * w; weight += w; }
    const normalized = clamp(weighted / Math.max(0.001, weight), 0, 1);
    const score = Number((normalized * 8).toFixed(1));
    const stability = measurementStability(frontFrames);
    const poseQuality = median(selectedFrames.map((x) => x.pose));
    const imageQuality = median(selectedFrames.map((x) => avg([x.sharp, x.light, x.centered, x.scale])));
    const coverage = p.coverage;
    const countQuality = clamp(frontFrames.length / 10, 0, 1);
    const reliability = Math.round(clamp(30 + 30 * stability + 18 * poseQuality + 12 * imageQuality * countQuality + 10 * coverage, 30, 96));
    return { score, components, reliability, normalized, stability, profileCoverage: coverage, profileConsistency: p.consistency };
  }

  function tier(score, profile) {
    if (profile === 'man') { if (score < 3.5) return 'LTN'; if (score < 4.8) return 'MTN'; if (score < 6.1) return 'HTN'; if (score < 7.15) return 'HIGH TIER'; return 'TOP TIER'; }
    if (profile === 'woman') { if (score < 3.5) return 'SUB-5'; if (score < 4.8) return 'LTB'; if (score < 6.1) return 'MTB'; if (score < 7.15) return 'HTB'; return 'TOP TIER'; }
    if (score < 3.5) return 'LOW'; if (score < 4.8) return 'MID'; if (score < 6.1) return 'HIGH'; if (score < 7.15) return 'VERY HIGH'; return 'TOP';
  }

  const level = (v, good, mid, bad) => v > 0.67 ? good : v > 0.42 ? mid : bad;

  function renderResults(result, front, left, right, selectedFrames) {
    const { score, components, reliability } = result;
    $('#score').textContent = score.toFixed(1);
    $('#tier').textContent = tier(score, state.profile);
    $('#meter').style.width = `${(score / 8) * 100}%`;
    $('#outProfile').textContent = state.profile.toUpperCase();
    $('#outFrames').textContent = `${selectedFrames.length} stable frames • ${[front, left, right].filter(Boolean).length} angle groups`;
    $('#confidence').textContent = `${reliability}% analysis reliability`;
    $('#scoreText').textContent = 'Looksmaxx heuristic estimate from normalized facial geometry. Camera quality, pose and lighting affect reliability rather than attractiveness points. This is not a scientifically calibrated attractiveness measurement.';
    const traits = [
      ['Face shape', front.faceRatio < 0.66 ? 'Long / oval leaning' : front.faceRatio > 0.80 ? 'Wider / rounder leaning' : 'Balanced oval leaning', 'Width-to-height landmark ratio.'],
      ['Facial symmetry', level(components.symmetry, 'High landmark balance', 'Generally balanced', 'More asymmetry visible'), 'Multiple mirrored landmark pairs after roll normalization.'],
      ['Jaw balance', level(components.jawBalance, 'Strong lower-face balance', 'Moderate', 'Softer lower-face balance'), 'Front-view jaw width relative to cheek width.'],
      ['Eye spacing', level(components.eyeSpacing, 'Proportionate', 'Moderate', 'Further from reference range'), 'Relative inner-eye spacing.'],
      ['Nose proportion', level(components.noseProportion, 'Balanced', 'Moderate', 'Further from reference range'), 'Normalized nose-length proxy.'],
      ['Mouth proportion', level(components.mouthProportion, 'Balanced', 'Moderate', 'Further from reference range'), 'Mouth width relative to facial width.'],
      ['Brow balance', level(components.browBalance, 'Balanced', 'Moderate', 'Further from reference range'), 'Brow-to-eye spacing proxy.'],
      ['Lower face', level(components.lowerFace, 'Balanced', 'Moderate', 'Further from reference range'), 'Nose-to-chin relationship in frontal geometry.'],
      ['Profile evidence', left && right ? 'Both sides captured' : left || right ? 'Partial side evidence' : 'No stable side evidence', 'Side coverage is supporting evidence, not a rotation bonus.']
    ];
    $('#traitList').innerHTML = traits.map(([a, b, c]) => `<div class="trait"><b>${a}</b><span>${b} — ${c}</span></div>`).join('');
    const metrics = [
      ['Face width / height', front.faceRatio, 0.9], ['Jaw / cheek width', front.jawRatio, 0.9], ['Eye spacing / face width', front.eyeSpacingRatio, 0.7],
      ['Eye width / face width', front.eyeWidthRatio, 0.35], ['Nose / face height', front.noseRatio, 0.5], ['Mouth / face width', front.mouthRatio, 0.7],
      ['Lip height / face height', front.lipRatio, 0.22], ['Brow-eye gap / face height', front.browEyeGap / Math.max(0.001, front.faceHeight), 0.13], ['Symmetry indicator', front.symmetry, 1]
    ];
    $('#metricGrid').innerHTML = metrics.map(([n, v, max]) => `<div class="metric"><div class="metric-top"><b>${n}</b><small>${round1(v)}</small></div><div class="bar"><i style="width:${pct((v / max) * 100)}"></i></div></div>`).join('');
    const improve = [];
    if (reliability < 70) improve.push(['S', 'Rescan for reliability', 'Keep the phone about 50–70 cm away, at eye level, with the whole face visible and steady.']);
    if (front.light < 0.64) improve.push(['L', 'Lighting', 'Use broad, even light from in front. Avoid strong side shadows and backlighting.']);
    if (front.sharp < 0.55) improve.push(['F', 'Sharpness', 'Clean the lens, hold steady, and avoid digital zoom.']);
    if (front.jawRatio < 0.56) improve.push(['J', 'Jaw presentation', 'Keep the neck neutral and use consistent three-quarter photography when checking the lower face.']);
    if (components.symmetry < 0.60) improve.push(['A', 'Camera alignment', 'Keep the head level and centered. Perspective and head roll can exaggerate apparent asymmetry.']);
    if (!improve.length) improve.push(['R', 'Baseline', 'The scan is internally consistent. Focus on grooming, hairstyle, sleep, skin care and presentation rather than chasing tiny score changes.']);
    $('#improvementList').innerHTML = improve.map(([a, b, c]) => `<div class="improvement"><span>${a}</span><div><b>${b}</b><p>${c}</p></div></div>`).join('');
    $('#resultsSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function finishAnalysis() {
    stopCamera(false);
    const frontFrames = chooseDiverse(state.frames.filter((f) => f.phase === 'front'), 8);
    const leftFrames = chooseDiverse(state.frames.filter((f) => f.phase === 'left'), 6);
    const rightFrames = chooseDiverse(state.frames.filter((f) => f.phase === 'right'), 6);
    const front = aggregateRobust(frontFrames), left = aggregateRobust(leftFrames), right = aggregateRobust(rightFrames);
    const selectedFrames = [...frontFrames, ...leftFrames, ...rightFrames];
    if (!front || frontFrames.length < PHASES.front.minFrames) {
      $('#cameraStatus').textContent = 'Not enough stable frontal frames were captured. Rescan with your face centered, level and a comfortable distance from the camera.';
      toast('Not enough stable front frames.');
      state.analyzing = false;
      $('#cameraBtn').disabled = false;
      return;
    }
    const result = appearanceScore(front, left, right, frontFrames, selectedFrames);
    state.lastResult = { score: result.score, tier: tier(result.score, state.profile), profile: state.profile, reliability: result.reliability, frames: selectedFrames.length, timestamp: new Date().toISOString(), front, left, right };
    renderResults(result, front, left, right, selectedFrames);
    loadHistory();
    state.analyzing = false;
  }

  function resultForHistory(item) {
    const date = new Date(item.timestamp);
    const reliability = Number(item.reliability ?? item.confidence ?? 0);
    return `<div class="history-item"><div><b>${String(item.profile || '').toUpperCase()} • ${item.tier || '—'}</b><span>${date.toLocaleString()} • ${item.frames || 0} stable frames • ${reliability}% reliability</span></div><strong>${Number(item.score).toFixed(1)}</strong></div>`;
  }

  function saveResult() {
    if (!state.lastResult) { toast('Complete a scan first.'); return; }
    try {
      const history = safeHistoryRead();
      history.unshift(state.lastResult);
      localStorage.setItem('looksmaxx-history', JSON.stringify(history.slice(0, 15)));
      loadHistory();
      toast('Result saved locally.');
    } catch { toast('Could not save this result on this device.'); }
  }

  function loadHistory() {
    const history = safeHistoryRead();
    const html = history.length ? history.map(resultForHistory).join('') : '<div class="empty">No saved results yet.</div>';
    $('#historyList').innerHTML = html;
    $('#historyModalBody').innerHTML = html;
  }

  function clearHistory() { localStorage.removeItem('looksmaxx-history'); loadHistory(); toast('History cleared.'); }

  function clearResult() {
    state.lastResult = null;
    $('#score').textContent = '—'; $('#tier').textContent = 'WAITING'; $('#meter').style.width = '0%'; $('#outProfile').textContent = '—'; $('#outFrames').textContent = '—'; $('#confidence').textContent = '—';
    $('#traitList').innerHTML = ''; $('#metricGrid').innerHTML = ''; $('#improvementList').innerHTML = ''; $('#scoreText').textContent = 'Complete the scan to generate a structured estimate.';
  }

  function bindEvents() {
    $$('.profile-card').forEach((b) => b.addEventListener('click', () => setProfile(b.dataset.profile)));
    $('#heroStart')?.addEventListener('click', () => { $('#setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (state.profile) setTimeout(scrollToScanner, 250); });
    $('#cameraBtn')?.addEventListener('click', enableCamera);
    $('#stopBtn')?.addEventListener('click', () => stopCamera(true));
    $('#rescanBtn')?.addEventListener('click', () => { clearResult(); scrollToScanner(); setTimeout(enableCamera, 350); });
    $('#saveBtn')?.addEventListener('click', saveResult);
    $('#clearBtn')?.addEventListener('click', clearResult);
    $('#clearHistory')?.addEventListener('click', clearHistory);
    $('#historyBtn')?.addEventListener('click', () => openModal('#historyModal'));
    $('#aboutBtn')?.addEventListener('click', () => openModal('#aboutModal'));
    $('#heroAbout')?.addEventListener('click', () => openModal('#aboutModal'));
    $$('[data-close]').forEach((el) => el.addEventListener('click', closeModals));
    window.addEventListener('resize', resizeOverlay);
    window.addEventListener('beforeunload', () => stopCamera(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
  }

  function bootstrap() { if (state.profile) setProfile(state.profile); loadHistory(); bindEvents(); resizeOverlay(); }
  bootstrap();
})();
