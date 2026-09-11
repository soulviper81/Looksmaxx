(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const video = $('#video');
  const overlay = $('#overlay');
  const octx = overlay?.getContext('2d');

  const state = {
    profile: localStorage.getItem('looksmaxx-profile') || '',
    stream: null,
    mesh: null,
    raf: 0,
    timerRaf: 0,
    phase: 'idle',
    frames: [],
    lastLandmarks: null,
    lastFrameAt: 0,
    sampleCounter: 0,
    analyzing: false,
    scanStart: 0,
    totalMs: 15000,
    currentQuality: { face: 0, pose: 0, sharp: 0, light: 0 },
    lastResult: null
  };

  const PHASES = {
    front: { title: 'LOOK STRAIGHT', sub: 'Eyes forward, head level, and keep the oval centered.', card: '#stageFront' },
    left: { title: 'TURN LEFT →', sub: 'Slowly turn left until a clear side / three-quarter view is visible.', card: '#stageLeft' },
    right: { title: '← TURN RIGHT', sub: 'Slowly turn right until the opposite side is clearly visible.', card: '#stageRight' }
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

  function setScanUI(phase, elapsed = 0) {
    state.phase = phase;
    const p = PHASES[phase];
    const active = phase !== 'idle' && phase !== 'done';
    $('#scanState').textContent = phase === 'done' ? 'COMPLETE' : active ? 'SCANNING' : 'IDLE';
    $('#phaseLabel').textContent = phase === 'idle' ? 'Camera not started' : phase === 'done' ? 'Scan complete' : p.title;
    $('#guideText').textContent = phase === 'idle' ? 'Choose a profile, then enable camera' : phase === 'done' ? 'Building report…' : p.title;
    $('#subGuide').textContent = phase === 'idle' ? 'Your camera never leaves this page.' : phase === 'done' ? 'Checking measurement stability.' : p.sub;
    $$('.stage-card').forEach((x) => x.classList.remove('active'));
    if (p?.card) $(p.card)?.classList.add('active');
    $('#progressBar').style.width = `${phase === 'done' ? 100 : clamp((elapsed / state.totalMs) * 100, 0, 100)}%`;
    const seconds = active ? Math.min(15, Math.floor(elapsed / 1000) + 1) : phase === 'done' ? 15 : 0;
    $('#timer').textContent = `00:${String(seconds).padStart(2, '0')}`;
    $$('.progress-points span').forEach((el, i) => el.classList.toggle('active', active && i === (phase === 'front' ? 0 : phase === 'left' ? 1 : 2)));
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
    let total = 0, count = 0;
    for (let i = 0; i < d.length; i += 20) {
      total += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      count++;
    }
    return total / Math.max(1, count);
  }

  function sharpnessScore(ctx, w, h) {
    const d = ctx.getImageData(0, 0, w, h).data;
    let total = 0, count = 0;
    for (let y = 3; y < h - 3; y += 5) {
      for (let x = 3; x < w - 3; x += 5) {
        const i = (y * w + x) * 4;
        total += Math.abs(d[i] - d[i - 8]) + Math.abs(d[i] - d[i - w * 4]);
        count += 2;
      }
    }
    return clamp(total / Math.max(1, count) / 28, 0, 1);
  }

  function lmMetrics(lm) {
    const p = (i) => lm[i];
    const eyeL = p(33), eyeR = p(263);
    const innerL = p(133), innerR = p(362);
    const outerL = p(130), outerR = p(359);
    const browL = p(105), browR = p(334);
    const nose = p(1), noseBridge = p(168);
    const chin = p(152), forehead = p(10);
    const cheekL = p(234), cheekR = p(454);
    const jawL = p(172), jawR = p(397);
    const mouthL = p(61), mouthR = p(291);
    const mouthTop = p(13), mouthBottom = p(14);
    const eyeMid = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
    const eyeDist = Math.max(0.001, dist(eyeL, eyeR));
    const faceWidth = Math.max(0.001, dist(cheekL, cheekR));
    const faceHeight = Math.max(0.001, dist(forehead, chin));
    const jawWidth = dist(jawL, jawR);
    const mouthWidth = dist(mouthL, mouthR);
    const eyeSpacing = dist(innerL, innerR);
    const eyeWidth = avg([dist(innerL, outerL), dist(innerR, outerR)]);
    const browEyeGap = avg([dist(browL, p(159)), dist(browR, p(386))]);
    const noseLength = dist(noseBridge, nose);
    const lipHeight = dist(mouthTop, mouthBottom);
    const roll = Math.atan2(eyeR.y - eyeL.y, eyeR.x - eyeL.x);
    const yaw = (nose.x - eyeMid.x) / eyeDist;
    const faceCenterOffset = Math.abs(nose.x - eyeMid.x) / faceWidth;

    const pairs = [[33, 263], [133, 362], [105, 334], [61, 291], [172, 397], [234, 454], [145, 374], [159, 386]];
    let symmetryError = 0;
    for (const [a, b] of pairs) {
      const pa = p(a), pb = p(b);
      const mirrorX = 2 * eyeMid.x - pa.x;
      symmetryError += Math.hypot(mirrorX - pb.x, pa.y - pb.y) / faceWidth;
    }
    const symmetry = clamp(1 - (symmetryError / pairs.length) / 0.18, 0, 1);

    return {
      eyeDist, faceWidth, faceHeight, jawWidth, mouthWidth, eyeSpacing, eyeWidth,
      browEyeGap, noseLength, lipHeight, yaw, roll, faceCenterOffset, symmetry,
      faceRatio: faceWidth / faceHeight,
      jawRatio: jawWidth / faceWidth,
      eyeSpacingRatio: eyeSpacing / faceWidth,
      eyeWidthRatio: eyeWidth / faceWidth,
      noseRatio: noseLength / faceHeight,
      mouthRatio: mouthWidth / faceWidth,
      lipRatio: lipHeight / faceHeight,
      lowerFaceRatio: dist(nose, chin) / faceHeight
    };
  }

  function poseScore(m, phase) {
    const yaw = Math.abs(m.yaw);
    const roll = Math.abs(m.roll);
    if (phase === 'front') {
      return 0.72 * clamp(1 - yaw / 0.14, 0, 1) + 0.28 * clamp(1 - roll / 0.11, 0, 1);
    }
    return 0.78 * clamp((yaw - 0.15) / 0.22, 0, 1) + 0.22 * clamp(1 - roll / 0.13, 0, 1);
  }

  function validPose(m, phase) {
    if (phase === 'front') return Math.abs(m.yaw) < 0.13 && Math.abs(m.roll) < 0.12;
    return Math.abs(m.yaw) > 0.15 && Math.abs(m.yaw) < 0.55 && Math.abs(m.roll) < 0.14;
  }

  function drawLandmarks(lm, phase) {
    if (!octx || !video) return;
    const r = video.getBoundingClientRect();
    octx.clearRect(0, 0, r.width, r.height);
    if (!lm) return;
    const key = [10, 152, 33, 263, 234, 454, 172, 397, 1, 61, 291];
    octx.lineWidth = 1.4;
    octx.strokeStyle = 'rgba(215,255,79,.72)';
    key.forEach((i) => {
      const pt = lm[i];
      if (!pt) return;
      octx.beginPath();
      octx.arc(pt.x * r.width, pt.y * r.height, 2.2, 0, Math.PI * 2);
      octx.stroke();
    });
    const m = lmMetrics(lm);
    const cx = ((lm[234].x + lm[454].x) / 2) * r.width;
    const cy = ((lm[10].y + lm[152].y) / 2) * r.height;
    octx.strokeStyle = phase === 'front' ? 'rgba(100,220,255,.65)' : 'rgba(215,255,79,.7)';
    octx.beginPath();
    octx.arc(cx, cy, Math.max(25, m.faceWidth * r.width * 0.38), 0, Math.PI * 2);
    octx.stroke();
  }

  function snapshot(phase, lm) {
    const c = document.createElement('canvas');
    const w = 320;
    const h = Math.max(180, Math.min(420, Math.round(video.videoHeight / Math.max(1, video.videoWidth) * w)));
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const m = lmMetrics(lm);
    const image = ctx.getImageData(0, 0, w, h);
    const luma = meanLuma(image);
    const light = clamp(1 - Math.abs(luma - 128) / 128, 0, 1);
    const sharp = sharpnessScore(ctx, w, h);
    const pose = poseScore(m, phase);
    const face = clamp(m.faceWidth / 0.42, 0, 1);
    const centered = clamp(1 - m.faceCenterOffset / 0.34, 0, 1);
    const quality = 0.35 * pose + 0.25 * sharp + 0.18 * light + 0.12 * face + 0.10 * centered;
    return { phase, sideSign: Math.sign(m.yaw), quality, sharp, light, pose, centered, metrics: m, time: Date.now() };
  }

  async function ensureMesh() {
    if (state.mesh) return state.mesh;
    if (typeof FaceMesh === 'undefined') throw new Error('The face-landmark engine could not load. Refresh the page and try again.');
    state.mesh = new FaceMesh({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}` });
    state.mesh.setOptions({ maxNumFaces: 1, refineLandmarks: true, minDetectionConfidence: 0.68, minTrackingConfidence: 0.68 });
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
    if (video.readyState >= 2 && state.mesh && t - state.lastFrameAt > 110) {
      state.lastFrameAt = t;
      try {
        await state.mesh.send({ image: video });
        if (state.phase !== 'idle' && state.phase !== 'done' && state.lastLandmarks) {
          state.sampleCounter++;
          if (state.sampleCounter % 2 === 0) {
            const m = lmMetrics(state.lastLandmarks);
            if (validPose(m, state.phase)) state.frames.push(snapshot(state.phase, state.lastLandmarks));
          }
        }
      } catch (e) {
        console.warn('Face processing error:', e);
      }
    }
    state.raf = requestAnimationFrame(processLoop);
  }

  async function enableCamera() {
    if (!state.profile) {
      toast('Choose a rating profile first.');
      $('#setup')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('Camera access is unavailable here. Use HTTPS or localhost.');
      return;
    }
    try {
      await ensureMesh();
      if (state.stream) stopCamera(false);
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 720 },
          height: { ideal: 1280 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      video.srcObject = state.stream;
      await video.play();
      resizeOverlay();
      $('#cameraBtn').textContent = 'Scanning…';
      $('#cameraBtn').disabled = true;
      $('#stopBtn').disabled = false;
      $('#cameraStatus').textContent = 'Camera active. Only stable frontal and side-pose frames are retained.';
      state.frames = [];
      state.sampleCounter = 0;
      state.lastFrameAt = 0;
      state.scanStart = now();
      state.analyzing = false;
      state.lastResult = null;
      setScanUI('front', 0);
      state.raf = requestAnimationFrame(processLoop);
      runTimedScan();
    } catch (err) {
      console.error(err);
      $('#cameraStatus').textContent = err.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access and try again.'
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
        state.timerRaf = setTimeout(finishAnalysis, 650);
        return;
      }
      setScanUI(elapsed < 5000 ? 'front' : elapsed < 10000 ? 'left' : 'right', elapsed);
      state.timerRaf = requestAnimationFrame(loop);
    };
    state.timerRaf = requestAnimationFrame(loop);
  }

  function stopCamera(showMessage = true) {
    cancelAnimationFrame(state.raf);
    cancelAnimationFrame(state.timerRaf);
    clearTimeout(state.timerRaf);
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    if (video) video.srcObject = null;
    state.lastLandmarks = null;
    state.analyzing = false;
    $('#cameraBtn').textContent = 'Enable Camera';
    $('#cameraBtn').disabled = false;
    $('#stopBtn').disabled = true;
    if (showMessage) {
      $('#cameraStatus').textContent = 'Scan stopped. Your camera is off.';
      setScanUI('idle', 0);
      drawLandmarks(null, 'idle');
    }
  }

  function selectBest(frames, count) {
    const sorted = frames.slice().sort((a, b) => b.quality - a.quality);
    return sorted.slice(0, Math.min(count, sorted.length));
  }

  function aggregateRobust(frames) {
    if (!frames.length) return null;
    const keys = Object.keys(frames[0].metrics);
    const m = {};
    for (const key of keys) m[key] = median(frames.map((f) => f.metrics[key]));
    m.quality = median(frames.map((f) => f.quality));
    m.sharp = median(frames.map((f) => f.sharp));
    m.light = median(frames.map((f) => f.light));
    m.pose = median(frames.map((f) => f.pose));
    m.centered = median(frames.map((f) => f.centered));
    return m;
  }

  function rangeScore(value, low, idealLow, idealHigh, high) {
    if (!Number.isFinite(value) || value <= low || value >= high) return 0;
    if (value >= idealLow && value <= idealHigh) return 1;
    if (value < idealLow) return clamp((value - low) / Math.max(0.001, idealLow - low), 0, 1);
    return clamp((high - value) / Math.max(0.001, high - idealHigh), 0, 1);
  }

  function featureScores(front) {
    return {
      symmetry: clamp(front.symmetry, 0, 1),
      faceHarmony: rangeScore(front.faceRatio, 0.57, 0.66, 0.79, 0.96),
      jawBalance: rangeScore(front.jawRatio, 0.47, 0.56, 0.73, 0.86),
      eyeSpacing: rangeScore(front.eyeSpacingRatio, 0.25, 0.32, 0.43, 0.55),
      noseProportion: rangeScore(front.noseRatio, 0.12, 0.19, 0.29, 0.40),
      mouthProportion: rangeScore(front.mouthRatio, 0.22, 0.31, 0.47, 0.62),
      browBalance: rangeScore(front.browEyeGap / Math.max(0.001, front.faceHeight), 0.015, 0.035, 0.075, 0.13),
      lowerFace: rangeScore(front.lowerFaceRatio, 0.31, 0.40, 0.55, 0.68)
    };
  }

  function profileSupport(left, right) {
    const sides = [left, right].filter(Boolean);
    if (!sides.length) return { coverage: 0, structure: 0.5, balance: 0.5 };

    const structureScores = sides.map((s) => avg([
      rangeScore(s.jawRatio, 0.47, 0.56, 0.73, 0.86),
      rangeScore(s.lowerFaceRatio, 0.31, 0.40, 0.55, 0.68)
    ]));
    const structure = avg(structureScores);
    const balance = sides.length === 2
      ? clamp(1 - avg([
        Math.abs(left.jawRatio - right.jawRatio) / 0.18,
        Math.abs(left.lowerFaceRatio - right.lowerFaceRatio) / 0.18
      ]), 0, 1)
      : 0.5;
    return { coverage: sides.length === 2 ? 1 : 0.55, structure, balance };
  }

  function measurementStability(frontFrames) {
    if (frontFrames.length < 3) return 0.35;
    const keys = ['faceRatio', 'jawRatio', 'eyeSpacingRatio', 'noseRatio', 'mouthRatio', 'symmetry', 'lowerFaceRatio'];
    const instability = avg(keys.map((key) => {
      const values = frontFrames.map((f) => f.metrics[key]);
      const scale = Math.max(0.02, Math.abs(median(values)) * 0.12);
      return clamp(stdev(values) / scale, 0, 1);
    }));
    return clamp(1 - instability, 0, 1);
  }

  function appearanceScore(front, left, right, frontFrames, selectedFrames) {
    if (!front) return { score: 0, components: {}, confidence: 0, normalized: 0, stability: 0 };
    const f = featureScores(front);
    const p = profileSupport(left, right);
    const components = {
      symmetry: f.symmetry,
      faceHarmony: f.faceHarmony,
      jawBalance: f.jawBalance,
      eyeSpacing: f.eyeSpacing,
      noseProportion: f.noseProportion,
      mouthProportion: f.mouthProportion,
      browBalance: f.browBalance,
      lowerFace: f.lowerFace,
      profileStructure: p.structure,
      profileBalance: p.balance
    };

    // Transparent heuristic: no camera-quality term is allowed to add attractiveness points.
    // Profile rotation itself is never rewarded; only the geometry visible in accepted side views is used.
    const weights = {
      symmetry: 0.15,
      faceHarmony: 0.14,
      jawBalance: 0.14,
      eyeSpacing: 0.09,
      noseProportion: 0.09,
      mouthProportion: 0.07,
      browBalance: 0.06,
      lowerFace: 0.10,
      profileStructure: 0.08,
      profileBalance: 0.08
    };
    let weighted = 0;
    let weight = 0;
    for (const [key, w] of Object.entries(weights)) {
      weighted += components[key] * w;
      weight += w;
    }
    const normalized = clamp(weighted / Math.max(0.001, weight), 0, 1);
    const score = Number((normalized * 8).toFixed(1));

    const stability = measurementStability(frontFrames);
    const poseQuality = avg(selectedFrames.map((f) => f.pose));
    const imageQuality = avg(selectedFrames.map((f) => avg([f.sharp, f.light, f.centered])));
    const countQuality = clamp(Math.min(frontFrames.length, 18) / 18, 0, 1);
    const coverage = p.coverage;
    const confidence = Math.round(clamp(
      35 + 22 * stability + 18 * poseQuality + 12 * imageQuality * countQuality + 13 * coverage,
      35,
      96
    ));

    return { score, components, confidence, normalized, stability };
  }

  function tier(score, profile) {
    if (profile === 'man') {
      if (score < 3.5) return 'LTN';
      if (score < 4.8) return 'MTN';
      if (score < 6.1) return 'HTN';
      if (score < 7.15) return 'HIGH TIER';
      return 'TOP TIER';
    }
    if (profile === 'woman') {
      if (score < 3.5) return 'SUB-5';
      if (score < 4.8) return 'LTB';
      if (score < 6.1) return 'MTB';
      if (score < 7.15) return 'HTB';
      return 'TOP TIER';
    }
    if (score < 3.5) return 'LOW';
    if (score < 4.8) return 'MID';
    if (score < 6.1) return 'HIGH';
    if (score < 7.15) return 'VERY HIGH';
    return 'TOP';
  }

  const level = (v, good, mid, bad) => v > 0.67 ? good : v > 0.42 ? mid : bad;

  function renderResults(result, front, left, right, selectedFrames) {
    const { score, components, confidence } = result;
    const t = tier(score, state.profile);
    $('#score').textContent = score.toFixed(1);
    $('#tier').textContent = t;
    $('#meter').style.width = `${(score / 8) * 100}%`;
    $('#outProfile').textContent = state.profile.toUpperCase();
    $('#outFrames').textContent = `${selectedFrames.length} stable frames • ${[front, left, right].filter(Boolean).length} angle groups`;
    $('#confidence').textContent = `${confidence}% analysis confidence`;
    $('#scoreText').textContent = 'PSL-style heuristic from normalized facial geometry and stable multi-frame measurements. Camera quality affects confidence, not the attractiveness score itself.';

    const faceShape = front.faceRatio < 0.66 ? 'Long / oval leaning' : front.faceRatio > 0.80 ? 'Wider / rounder leaning' : 'Balanced oval leaning';
    const traits = [
      ['Face shape', faceShape, 'Width-to-height landmark ratio.'],
      ['Facial symmetry', level(components.symmetry, 'High landmark balance', 'Generally balanced', 'More asymmetry visible'), 'Multiple left/right landmark pairs are compared.'],
      ['Jaw balance', level(components.jawBalance, 'Strong lower-face balance', 'Moderate', 'Softer lower-face balance'), 'Front-view jaw width relative to cheek width.'],
      ['Eye spacing', level(components.eyeSpacing, 'Proportionate', 'Moderate', 'Further from reference range'), 'Relative inner-eye spacing.'],
      ['Nose proportion', level(components.noseProportion, 'Balanced', 'Moderate', 'Further from reference range'), 'Normalized nose-length proxy.'],
      ['Mouth proportion', level(components.mouthProportion, 'Balanced', 'Moderate', 'Further from reference range'), 'Mouth width relative to facial width.'],
      ['Brow balance', level(components.browBalance, 'Balanced', 'Moderate', 'Further from reference range'), 'Brow-to-eye spacing proxy.'],
      ['Lower face', level(components.lowerFace, 'Balanced', 'Moderate', 'Further from reference range'), 'Nose-to-chin relationship in the frontal view.'],
      ['Profile evidence', left && right ? 'Both side groups captured' : left || right ? 'Partial side evidence' : 'No stable side evidence', 'Side frames are supporting evidence rather than bonus points.']
    ];
    $('#traitList').innerHTML = traits.map(([a, b, c]) => `<div class="trait"><b>${a}</b><span>${b} — ${c}</span></div>`).join('');

    const metrics = [
      ['Face width / height', front.faceRatio, 0.9],
      ['Jaw / cheek width', front.jawRatio, 0.9],
      ['Eye spacing / face width', front.eyeSpacingRatio, 0.7],
      ['Nose / face height', front.noseRatio, 0.5],
      ['Mouth / face width', front.mouthRatio, 0.7],
      ['Symmetry indicator', front.symmetry, 1]
    ];
    $('#metricGrid').innerHTML = metrics.map(([n, v, max]) => `<div class="metric"><div class="metric-top"><b>${n}</b><small>${round1(v)}</small></div><div class="bar"><i style="width:${pct((v / max) * 100)}"></i></div></div>`).join('');

    const improve = [];
    if (selectedFrames.length < 8) improve.push(['S', 'Scan quality', 'Rescan with the phone about 50–70 cm away, camera at eye level, with the full face visible.']);
    if (front.light < 0.64) improve.push(['L', 'Lighting', 'Use broad, even light from in front of you. Shadows can make facial structure look different.']);
    if (front.sharp < 0.55) improve.push(['F', 'Sharpness', 'Clean the lens, hold steady, and avoid digital zoom.']);
    if (components.jawBalance < 0.5) improve.push(['J', 'Jaw presentation', 'Neutral neck posture and consistent three-quarter photography will show the lower face more reliably.']);
    if (components.symmetry < 0.6) improve.push(['A', 'Camera angle', 'Keep the head level. Small roll/yaw changes can exaggerate apparent asymmetry.']);
    if (!improve.length) improve.push(['R', 'Baseline', 'The scan is internally consistent. Focus on grooming, hairstyle, skin care, sleep, posture and presentation rather than tiny score changes.']);
    $('#improvementList').innerHTML = improve.map(([a, b, c]) => `<div class="improvement"><span>${a}</span><div><b>${b}</b><p>${c}</p></div></div>`).join('');
    $('#resultsSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function finishAnalysis() {
    stopCamera(false);

    const frontFrames = selectBest(state.frames.filter((f) => f.phase === 'front'), 8);
    const sideFrames = selectBest(state.frames.filter((f) => f.phase === 'left' || f.phase === 'right'), 16);

    // Classify the two side groups from actual detected yaw sign. This avoids a mirrored/selfie UI reversing left/right.
    const sideA = sideFrames.filter((f) => f.sideSign > 0).slice(0, 8);
    const sideB = sideFrames.filter((f) => f.sideSign < 0).slice(0, 8);

    const front = aggregateRobust(frontFrames);
    const left = aggregateRobust(sideA);
    const right = aggregateRobust(sideB);
    const selectedFrames = [...frontFrames, ...sideA, ...sideB];

    if (!front || frontFrames.length < 3) {
      $('#cameraStatus').textContent = 'Not enough stable frontal frames were captured. Keep your face centered and rescan.';
      toast('Not enough stable frontal frames.');
      state.analyzing = false;
      $('#cameraBtn').disabled = false;
      return;
    }

    const result = appearanceScore(front, left, right, frontFrames, selectedFrames);
    state.lastResult = {
      score: result.score,
      tier: tier(result.score, state.profile),
      profile: state.profile,
      confidence: result.confidence,
      frames: selectedFrames.length,
      timestamp: new Date().toISOString(),
      front,
      left,
      right
    };

    renderResults(result, front, left, right, selectedFrames);
    loadHistory();
    state.analyzing = false;
  }

  function resultForHistory(item) {
    const date = new Date(item.timestamp);
    return `<div class="history-item"><div><b>${item.profile.toUpperCase()} • ${item.tier}</b><span>${date.toLocaleString()} • ${item.frames} stable frames • ${item.confidence}% confidence</span></div><strong>${Number(item.score).toFixed(1)}</strong></div>`;
  }

  function saveResult() {
    if (!state.lastResult) {
      toast('Complete a scan first.');
      return;
    }
    const key = 'looksmaxx-history';
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    history.unshift(state.lastResult);
    localStorage.setItem(key, JSON.stringify(history.slice(0, 15)));
    loadHistory();
    toast('Result saved locally.');
  }

  function loadHistory() {
    const history = JSON.parse(localStorage.getItem('looksmaxx-history') || '[]');
    const html = history.length ? history.map(resultForHistory).join('') : '<div class="empty">No saved results yet.</div>';
    $('#historyList').innerHTML = html;
    $('#historyModalBody').innerHTML = html;
  }

  function clearHistory() {
    localStorage.removeItem('looksmaxx-history');
    loadHistory();
    toast('History cleared.');
  }

  function clearResult() {
    state.lastResult = null;
    $('#score').textContent = '—';
    $('#tier').textContent = 'WAITING';
    $('#meter').style.width = '0%';
    $('#outProfile').textContent = '—';
    $('#outFrames').textContent = '—';
    $('#confidence').textContent = '—';
    $('#traitList').innerHTML = '';
    $('#metricGrid').innerHTML = '';
    $('#improvementList').innerHTML = '';
    $('#scoreText').textContent = 'Complete the scan to generate a structured estimate.';
  }

  function bindEvents() {
    $$('.profile-card').forEach((b) => b.addEventListener('click', () => setProfile(b.dataset.profile)));
    $('#heroStart')?.addEventListener('click', () => {
      $('#setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (state.profile) setTimeout(scrollToScanner, 250);
    });
    $('#cameraBtn')?.addEventListener('click', enableCamera);
    $('#stopBtn')?.addEventListener('click', () => stopCamera(true));
    $('#rescanBtn')?.addEventListener('click', () => {
      clearResult();
      scrollToScanner();
      setTimeout(enableCamera, 350);
    });
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

  function bootstrap() {
    if (state.profile) setProfile(state.profile);
    loadHistory();
    bindEvents();
    resizeOverlay();
  }

  bootstrap();
})();
