(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const video = $('#video');
  const overlay = $('#overlay');
  const ctx = overlay?.getContext('2d');
  const MP_VERSION = '0.4.1633559619';
  const PHASES = ['front', 'left', 'right'];
  const PHASE_MS = 5000;
  const state = {
    profile: localStorage.getItem('looksmaxx-profile') || '',
    stream: null,
    mesh: null,
    phase: 'idle',
    phaseIndex: 0,
    phaseStart: 0,
    phaseTimer: 0,
    captureTimer: 0,
    raf: 0,
    meshBusy: false,
    lastSend: 0,
    landmarks: null,
    frontFrames: [],
    sideFrames: { left: [], right: [] },
    analyzing: false,
    generation: 0
  };
  const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
  const avg = (a) => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
  const median = (a) => { const v=a.filter(Number.isFinite).slice().sort((x,y)=>x-y); if(!v.length)return 0; const m=Math.floor(v.length/2); return v.length%2?v[m]:(v[m-1]+v[m])/2; };
  const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const toast = (msg) => { const e=$('#toast'); if(!e)return; e.textContent=msg; e.classList.add('on'); clearTimeout(toast.t); toast.t=setTimeout(()=>e.classList.remove('on'),2400); };

  function setProfile(p){
    state.profile=p; localStorage.setItem('looksmaxx-profile',p);
    $$('.profile-card').forEach(x=>x.classList.toggle('selected',x.dataset.profile===p));
    $('#profileStatus').textContent=p==='man'?'Man profile selected — scan ready.':p==='woman'?'Woman profile selected — scan ready.':'Neutral profile selected — scan ready.';
  }
  function resizeOverlay(){
    if(!video||!overlay||!ctx)return;
    const r=video.getBoundingClientRect(); const d=Math.min(devicePixelRatio||1,2);
    overlay.width=Math.max(1,Math.round(r.width*d)); overlay.height=Math.max(1,Math.round(r.height*d)); ctx.setTransform(d,0,0,d,0,0);
  }
  function phaseTitle(p){ return p==='front'?'LOOK STRAIGHT':p==='left'?'TURN LEFT →':p==='right'?'← TURN RIGHT':'Camera not started'; }
  function phaseSub(p){ return p==='front'?'Head level, eyes forward, face centered.':p==='left'?'Slowly turn left until the side of your face is visible.':p==='right'?'Slowly turn right until the opposite side is visible.':'Choose a profile, then enable camera.'; }
  function setUI(p,elapsed=0){
    state.phase=p;
    const active=PHASES.includes(p);
    $('#scanState').textContent=active?'SCANNING':p==='done'?'COMPLETE':'IDLE';
    $('#phaseLabel').textContent=p==='done'?'Scan complete':phaseTitle(p);
    $('#guideText').textContent=p==='done'?'Building report…':phaseTitle(p);
    $('#subGuide').textContent=p==='done'?'Checking captured data.':phaseSub(p);
    $$('.stage-card').forEach(x=>x.classList.remove('active'));
    const card=p==='front'?'#stageFront':p==='left'?'#stageLeft':p==='right'?'#stageRight':null; if(card)$(card)?.classList.add('active');
    const seconds=active?Math.min(5,Math.floor(elapsed/1000)):p==='done'?15:0;
    $('#timer').textContent=`00:${String(seconds).padStart(2,'0')}`;
    const progress=active?((state.phaseIndex*5+Math.min(5,elapsed/1000))/15)*100:p==='done'?100:0;
    $('#progressBar').style.width=`${clamp(progress,0,100)}%`;
    $$('.progress-points span').forEach((x,i)=>x.classList.toggle('active',active&&i===state.phaseIndex));
  }
  function metrics(lm){
    const p=i=>lm[i];
    const el=p(33),er=p(263),n=p(1),c=p(152),f=p(10),cl=p(234),cr=p(454),jl=p(172),jr=p(397),ml=p(61),mr=p(291);
    const eyeMid={x:(el.x+er.x)/2,y:(el.y+er.y)/2};
    const eyeD=Math.max(.001,dist(el,er));
    const faceW=Math.max(.001,dist(cl,cr));
    const faceH=Math.max(.001,dist(f,c));
    return {yaw:(n.x-eyeMid.x)/eyeD,faceW,faceH,faceRatio:faceW/faceH,jawRatio:dist(jl,jr)/faceW,mouthRatio:dist(ml,mr)/faceW,center:Math.abs(n.x-eyeMid.x)/faceW};
  }
  function draw(lm){
    if(!ctx||!video)return;
    const r=video.getBoundingClientRect(); ctx.clearRect(0,0,r.width,r.height); if(!lm)return;
    ctx.fillStyle='rgba(170,255,0,.75)';
    for(let i=0;i<lm.length;i+=10){const p=lm[i];ctx.beginPath();ctx.arc(p.x*r.width,p.y*r.height,1.6,0,Math.PI*2);ctx.fill();}
  }
  async function initMesh(){
    if(state.mesh)return;
    if(typeof FaceMesh==='undefined')throw new Error('Face-landmark engine failed to load. Refresh and try again.');
    state.mesh=new FaceMesh({locateFile:f=>`https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@${MP_VERSION}/${f}`});
    state.mesh.setOptions({maxNumFaces:1,refineLandmarks:true,minDetectionConfidence:.55,minTrackingConfidence:.55});
    state.mesh.onResults(r=>{state.landmarks=r.multiFaceLandmarks?.[0]||null;draw(state.landmarks);});
  }
  function captureFront(){
    if(state.phase!=='front'||!state.landmarks)return;
    const m=metrics(state.landmarks);
    if(Math.abs(m.yaw)<.16 && m.faceRatio>0.35 && m.faceRatio<1.25) state.frontFrames.push({metrics:m,time:performance.now()});
  }
  function startInference(gen){
    const loop=async(t)=>{
      if(gen!==state.generation||!state.stream||state.analyzing)return;
      if(state.phase==='front' && video.readyState>=2 && state.mesh && !state.meshBusy && t-state.lastSend>180){
        state.lastSend=t; state.meshBusy=true;
        try { await state.mesh.send({image:video}); } catch(e) { console.warn('FaceMesh frame error:',e); }
        state.meshBusy=false;
      }
      captureFront();
      state.raf=requestAnimationFrame(loop);
    };
    cancelAnimationFrame(state.raf); state.raf=requestAnimationFrame(loop);
  }
  function startCaptureTimer(gen){
    clearTimeout(state.captureTimer);
    const tick=()=>{
      if(gen!==state.generation||!state.stream||state.analyzing)return;
      captureFront();
      state.captureTimer=setTimeout(tick,350);
    };
    state.captureTimer=setTimeout(tick,350);
  }
  function advancePhase(){
    if(state.phaseIndex>=2){ finish(); return; }
    state.phaseIndex++;
    state.phaseStart=performance.now();
    state.landmarks=null;
    setUI(PHASES[state.phaseIndex],0);
  }
  function phaseTick(gen){
    if(gen!==state.generation||!state.stream||state.analyzing)return;
    const elapsed=performance.now()-state.phaseStart;
    setUI(PHASES[state.phaseIndex],elapsed);
    if(elapsed>=PHASE_MS){ advancePhase(); return; }
    state.phaseTimer=setTimeout(()=>phaseTick(gen),80);
  }
  async function start(){
    if(!state.profile){toast('Choose a rating profile first.');$('#setup')?.scrollIntoView({behavior:'smooth'});return;}
    if(!window.isSecureContext){toast('Camera requires HTTPS or localhost.');return;}
    if(!navigator.mediaDevices?.getUserMedia){toast('This browser does not provide camera access.');return;}
    const gen=++state.generation;
    try{
      $('#cameraStatus').textContent='Loading face scanner…';
      await initMesh();
      stop(false);
      state.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'user'},width:{ideal:720},height:{ideal:720}},audio:false});
      if(gen!==state.generation){state.stream.getTracks().forEach(t=>t.stop());return;}
      video.srcObject=state.stream;
      await new Promise((resolve,reject)=>{const to=setTimeout(()=>reject(new Error('Video startup timeout')),5000);video.onloadedmetadata=()=>{clearTimeout(to);resolve();};});
      await video.play(); resizeOverlay();
      state.phaseIndex=0; state.phase='front'; state.phaseStart=performance.now(); state.lastSend=0; state.landmarks=null;
      state.meshBusy=false; state.frontFrames=[]; state.sideFrames={left:[],right:[]}; state.analyzing=false;
      $('#cameraBtn').disabled=true;$('#cameraBtn').textContent='Scanning…';$('#stopBtn').disabled=false;
      $('#cameraStatus').textContent='Camera active. Front landmarks are tracked; turn phases are timed independently.';
      setUI('front',0);
      clearTimeout(state.phaseTimer);clearTimeout(state.captureTimer);
      startInference(gen); startCaptureTimer(gen); phaseTick(gen);
    }catch(e){
      console.error('Camera startup failed:',e);
      if(state.stream){state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}
      video.srcObject=null;
      $('#cameraBtn').disabled=false;
      $('#cameraStatus').textContent=e.name==='NotAllowedError'?'Camera permission was denied. Allow camera access for this site and try again.':e.name==='NotFoundError'?'No camera was found on this device.':e.name==='NotReadableError'?'The camera is busy in another app or tab.':e.message||'Camera could not start.';
      toast('Camera could not be started.');
    }
  }
  function stop(show=true){
    state.generation++;
    clearTimeout(state.phaseTimer);clearTimeout(state.captureTimer);cancelAnimationFrame(state.raf);
    state.phaseTimer=0;state.captureTimer=0;state.meshBusy=false;
    if(state.stream)state.stream.getTracks().forEach(t=>t.stop());
    state.stream=null;if(video)video.srcObject=null;
    if(show){setUI('idle',0);$('#stopBtn').disabled=true;$('#cameraBtn').disabled=false;$('#cameraBtn').textContent='Enable Camera';$('#cameraStatus').textContent='Scan stopped. Your camera is off.';draw(null);}
  }
  function score(){
    const f=state.frontFrames.map(x=>x.metrics);
    if(f.length<5){$('#cameraStatus').textContent='Not enough stable front frames were captured. Please rescan with your face centered.';toast('Not enough stable front frames.');$('#cameraBtn').disabled=false;return;}
    const faceRatio=median(f.map(x=>x.faceRatio)),jawRatio=median(f.map(x=>x.jawRatio)),mouthRatio=median(f.map(x=>x.mouthRatio));
    const faceS=clamp(1-Math.abs(faceRatio-.72)/.22,0,1),jawS=clamp(1-Math.abs(jawRatio-.64)/.22,0,1),mouthS=clamp(1-Math.abs(mouthRatio-.40)/.20,0,1),symmetry=clamp(1-median(f.map(x=>x.center))/.16,0,1);
    const w=state.profile==='man'?{face:.26,jaw:.24,mouth:.12,sym:.38}:state.profile==='woman'?{face:.28,jaw:.16,mouth:.16,sym:.40}:{face:.27,jaw:.20,mouth:.14,sym:.39};
    const norm=clamp(faceS*w.face+jawS*w.jaw+mouthS*w.mouth+symmetry*w.sym,0,1);const s=Number((norm*8).toFixed(1));
    const tier=state.profile==='man'?(s<3.5?'LTN':s<4.8?'MTN':s<6.1?'HTN':s<7.15?'HIGH TIER':'TOP TIER'):state.profile==='woman'?(s<3.5?'SUB-5':s<4.8?'LTB':s<6.1?'MTB':s<7.15?'HTB':'TOP TIER'):(s<3.5?'LOW':s<4.8?'MID':s<6.1?'HIGH':s<7.15?'VERY HIGH':'TOP');
    const reliability=Math.round(clamp(40+Math.min(25,f.length*2)+Math.min(20,(state.sideFrames.left.length+state.sideFrames.right.length)*2),40,90));
    $('#score').textContent=s.toFixed(1);$('#tier').textContent=tier;$('#meter').style.width=`${s/8*100}%`;$('#outProfile').textContent=(state.profile||'neutral').toUpperCase();$('#outFrames').textContent=`${f.length+state.sideFrames.left.length+state.sideFrames.right.length} captured frames`;$('#confidence').textContent=`${reliability}% analysis reliability`;
    $('#scoreText').textContent='Browser landmark heuristic. Photo quality affects reliability, not attractiveness points. This is not a scientifically calibrated attractiveness measurement.';
    $('#traitList').innerHTML=[['Face shape',faceRatio<.66?'Long / oval leaning':faceRatio>.80?'Wider leaning':'Balanced oval leaning'],['Jaw balance',jawS>.67?'Strong balance':jawS>.42?'Moderate':'Further from reference range'],['Mouth proportion',mouthS>.67?'Balanced':mouthS>.42?'Moderate':'Further from reference range'],['Profile evidence',state.sideFrames.left.length&&state.sideFrames.right.length?'Both sides captured':state.sideFrames.left.length||state.sideFrames.right.length?'Partial side evidence':'No stable side evidence']].map(x=>`<div class="trait"><b>${x[0]}</b><span>${x[1]}</span></div>`).join('');
    $('#metricGrid').innerHTML=[['Face width / height',faceRatio],['Jaw / cheek width',jawRatio],['Mouth / face width',mouthRatio],['Front frames',f.length],['Left frames',state.sideFrames.left.length],['Right frames',state.sideFrames.right.length]].map(x=>`<div class="metric"><div class="metric-top"><b>${x[0]}</b><small>${Number.isFinite(x[1])?Number(x[1]).toFixed(2):x[1]}</small></div><div class="bar"><i style="width:${clamp((Number(x[1])||0)*100,0,100)}%"></i></div></div>`).join('');
    $('#improvementList').innerHTML='<div class="improvement"><b>Presentation</b><span>Use even frontal lighting, a steady phone and a consistent camera distance for repeatable scans.</span></div><div class="improvement"><b>Grooming</b><span>Hair, skin care and grooming can change perceived facial presentation more than tiny score differences.</span></div>';
    setUI('done',15000);$('#cameraStatus').textContent='Scan complete. Your camera is off.';stop(false);$('#resultsSection')?.scrollIntoView({behavior:'smooth'});
  }
  function finish(){
    clearTimeout(state.phaseTimer);clearTimeout(state.captureTimer);state.analyzing=true;setUI('done',15000);setTimeout(score,350);
  }
  function history(){try{const a=JSON.parse(localStorage.getItem('looksmaxx-history')||'[]');return Array.isArray(a)?a:[];}catch{return[];}}
  function renderHistory(){const a=history();$('#historyList').innerHTML=a.length?a.slice().reverse().map(x=>`<div class="history-item"><b>${Number(x.score).toFixed(1)} / 8</b><span>${x.tier||''} • ${new Date(x.timestamp).toLocaleString()}</span></div>`).join(''):'<div class="empty">No saved results yet.</div>';}
  function save(){const s=Number($('#score')?.textContent);if(!Number.isFinite(s))return toast('Complete a scan first.');const a=history();a.push({score:s,tier:$('#tier').textContent,timestamp:Date.now()});localStorage.setItem('looksmaxx-history',JSON.stringify(a.slice(-30)));renderHistory();toast('Result saved locally.');}
  $$('.profile-card').forEach(b=>b.addEventListener('click',()=>setProfile(b.dataset.profile)));
  $('#cameraBtn')?.addEventListener('click',start);
  $('#stopBtn')?.addEventListener('click',()=>stop(true));
  $('#saveBtn')?.addEventListener('click',save);
  $('#clearBtn')?.addEventListener('click',()=>{$('#score').textContent='—';$('#tier').textContent='WAITING';toast('Result cleared.');});
  $('#clearHistory')?.addEventListener('click',()=>{localStorage.removeItem('looksmaxx-history');renderHistory();});
  $('#historyBtn')?.addEventListener('click',()=>$('#historySection')?.scrollIntoView({behavior:'smooth'}));
  $('#aboutBtn')?.addEventListener('click',()=>$('#aboutModal')?.classList.add('open'));
  $('#heroAbout')?.addEventListener('click',()=>$('#aboutModal')?.classList.add('open'));
  $('#heroStart')?.addEventListener('click',()=>$('#setup')?.scrollIntoView({behavior:'smooth'}));
  $$('[data-close]').forEach(x=>x.addEventListener('click',()=>x.closest('.modal')?.classList.remove('open')));
  window.addEventListener('resize',resizeOverlay);
  window.addEventListener('beforeunload',()=>stop(false));
  renderHistory();
  if(state.profile)setProfile(state.profile);
})();