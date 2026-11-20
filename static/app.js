/* SoundSwitch client — models come from the server, history goes to the server */
if (window.ort && ort.env && ort.env.wasm) {
  ort.env.wasm.simd = true;
  ort.env.wasm.numThreads = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
}
const CLASSES = ["breathing","clock_ticking","coughing","eating","sniffing","throat_clearing","typing"];
const NICE = {breathing:"Breathing",clock_ticking:"Clock",coughing:"Coughing",eating:"Eating",
  sniffing:"Sniffing",throat_clearing:"Throat",typing:"Typing"};
/* SR/WINLEN/NFFT/HOP come from engine.js (loaded first) */
let HOPOUT=16384;
let det=null, sep=null, AC=null, stream=null, node=null;
let running=false, bypass=false, events=0, lastDb=0, micMeter=0, outAvg=0;
let lastDet=null, cycN=0, sessionId=null, t0Session=0, dbSum=0, dbN=0, evQueue=[];
let ring=new Float32Array(WINLEN), rw=0, pending=[], pendN=0, busy=false;
const muted={}; CLASSES.forEach(c=>muted[c]=true); const live={};
const $=id=>document.getElementById(id);
const L=$('log');
const log=(s,c)=>{L.innerHTML+='\n'+(c==='ok'?`<span class="ok2">${s}</span>`:
  c==='bad'?`<span class="bad2">${s}</span>`:s); L.scrollTop=L.scrollHeight;};

/* ---------- chips ---------- */
const cw=$('chips');
CLASSES.forEach(c=>{const d=document.createElement('div');d.className='chip';d.id='c-'+c;
  d.innerHTML=`<span>${NICE[c]}</span><i></i>`;
  d.onclick=()=>{muted[c]=!muted[c];paint(c);savePrefs();};cw.appendChild(d);});
function paint(c){const e=$('c-'+c);
  e.classList.toggle('off',!muted[c]);e.classList.toggle('hot',!!live[c]&&muted[c]);}

/* ---------- sliders ---------- */
const rg=$('r-gate'), rst=$('r-str'), rgn=$('r-gain');
rg.oninput=()=>{$('vg').textContent=(rg.value/100).toFixed(2);savePrefs();};
rst.oninput=()=>{$('vs').textContent=rst.value+'%';savePrefs();};
rgn.oninput=()=>{$('vgn').textContent=rgn.value+'x';savePrefs();};
['r-hop','r-rate','c-prot'].forEach(i=>$(i).onchange=savePrefs);

let prefT=null;
function savePrefs(){clearTimeout(prefT);prefT=setTimeout(()=>{
  fetch('/api/prefs',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({gate:+rg.value,strength:+rst.value,gain:+rgn.value,
    hop:$('r-hop').value,rate:$('r-rate').value,protect:$('c-prot').checked,
    muted:muted,mic:$('sel-in').value,out:$('sel-out').value})});},500);}

async function loadPrefs(){
  try{const p=await (await fetch('/api/prefs')).json();
   if(p.gate){rg.value=p.gate;rg.oninput();}
   if(p.strength){rst.value=p.strength;rst.oninput();}
   if(p.gain){rgn.value=p.gain;rgn.oninput();}
   if(p.hop)$('r-hop').value=p.hop;
   if(p.rate)$('r-rate').value=p.rate;
   if(p.protect!==undefined)$('c-prot').checked=p.protect;
   if(p.muted){Object.assign(muted,p.muted);CLASSES.forEach(paint);}
   log('preferences restored');
  }catch(e){}
}

/* ---------- boot: fetch models from the server ---------- */
function spin(on){const m=document.querySelector('.mk');if(m)m.classList.toggle('busy',on);}
function banner(txt,kind){const b=$('banner');if(!b)return;
  if(!txt){b.style.display='none';return;}
  b.style.display='';b.className='banner'+(kind?' '+kind:'');b.innerHTML=txt;}
function setOrb(s,t,sub){
  const o=$('orb');o.textContent=s==='ok'?'✓':s==='live'?'●':s==='load'?'◍':'◌';
  o.className='orb'+(s==='ok'?' ok':s==='live'?' live':'');
  if(t)document.querySelector('h1').innerHTML=t;
  if(sub)$('boot').textContent=sub;
  $('nled').className='led'+(s==='ok'?' go':s==='live'?' live':'');
  $('nstat').textContent=s==='ok'?'ready':s==='live'?'listening':s==='load'?'loading':'no model';
}
async function mk(buf){return ort.InferenceSession.create(buf,
  {executionProviders:['wasm'],graphOptimizationLevel:'all',executionMode:'parallel'});}

async function fetchModel(slot,onProg){
  const r=await fetch('/models/'+slot+'.onnx');
  if(!r.ok) throw new Error(slot+' not on server');
  const total=+r.headers.get('content-length')||0;
  const rd=r.body.getReader(); const parts=[]; let got=0;
  for(;;){const {done,value}=await rd.read(); if(done)break;
    parts.push(value); got+=value.length; if(total)onProg(got/total);}
  const out=new Uint8Array(got); let o=0;
  for(const p of parts){out.set(p,o);o+=p.length;}
  return out.buffer;
}

async function boot(){
  await loadPrefs();
  let info;
  try{info=await (await fetch('/api/models')).json();}
  catch(e){setOrb('','Server <em>unreachable</em>.','Is server.py running?');return;}
  if(!info.ready){
    const found=info.onnx_files_found||[],miss=info.missing||[];
    setOrb('','Install the <em>model</em> once.',
      found.length?('Found in models/: '+found.join(', ')+' — but no '+miss.join(' or ')+' could be matched.')
                  :'The models folder is empty.');
    $('firstrun').style.display='';$('go').disabled=true;
    banner(found.length
      ? 'Files in your <code>models</code> folder: <b>'+found.join('</b>, <b>')+'</b>. Still missing: <b>'+miss.join(', ')+'</b>. Rename so the name contains "det" or "sep" and nothing of the other.'
      : 'The <code>models</code> folder is empty. Copy your two .onnx files into it and refresh.','warn');
    log('models folder: '+(found.join(', ')||'(empty)'),'bad');return;
  }
  $('firstrun').style.display='none';
  setOrb('load','Loading your <em>model</em>…','Streaming from the server');
  spin(true);$('bp').style.display='';
  try{
    const db=await fetchModel('detector',p=>$('bpi').style.width=(p*70)+'%');
    det=await mk(db); $('bpi').style.width='85%';
    const sb=await fetchModel('separator',p=>$('bpi').style.width=(85+p*10)+'%');
    sep=await mk(sb); $('bpi').style.width='100%';
    setTimeout(()=>$('bp').style.display='none',400);
    log(`detector in:[${det.inputNames}] out:[${det.outputNames}]`,'ok');
    log(`separator in:[${sep.inputNames}] out:[${sep.outputNames}]`,'ok');
    const mb=(info.models.detector.bytes/1e6).toFixed(0);
    setOrb('ok','Turn on the <em>microphone</em>.',
      `Model ready — ${info.models.detector.filename} (${mb} MB) + ${info.models.separator.filename}, loaded from the server.`);
    spin(false);
    $('go').disabled=false;$('selftest').disabled=false;
    banner('Model loaded. Press <b>Self-test</b> first — it proves the model works in about two seconds, no microphone needed.');
  }catch(e){
    spin(false);
    setOrb('','Model <em>failed</em> to load.',e.message);
    log('load failed: '+e.message,'bad');
  }
}

/* ---------- first-run upload ---------- */
function upload(slot,file){
  return new Promise((res,rej)=>{
    const fd=new FormData();fd.append('file',file);
    const x=new XMLHttpRequest();x.open('POST','/api/models/'+slot);
    $('up').style.display='';
    x.upload.onprogress=e=>{if(e.lengthComputable)
      $('upi').style.width=(e.loaded/e.total*100).toFixed(0)+'%';};
    x.onload=()=>x.status<300?res():rej(new Error('HTTP '+x.status));
    x.onerror=()=>rej(new Error('network'));
    x.send(fd);});
}
let upD=false,upS=false;
async function tryUp(slot,f,flag){
  log('uploading '+f.name+' ('+(f.size/1e6).toFixed(0)+' MB)…');
  try{await upload(slot,f);log(slot+' installed on server','ok');
    if(flag==='d')upD=true;else upS=true;
    if(upD&&upS){log('both models installed — reloading','ok');setTimeout(()=>location.reload(),600);}
  }catch(e){log('upload failed: '+e.message,'bad');}
}
$('f-det').onchange=e=>e.target.files[0]&&tryUp('detector',e.target.files[0],'d');
$('f-sep').onchange=e=>e.target.files[0]&&tryUp('separator',e.target.files[0],'s');
$('reinstall').onclick=async()=>{
  if(!confirm('Remove the model from the server and upload again?'))return;
  await fetch('/api/models',{method:'DELETE'});location.reload();};

/* ---------- devices ---------- */
$('devs').onclick=()=>{$('dev-box').open=true;$('dev-box').scrollIntoView({block:'center'});};
$('perm').onclick=async()=>{
  try{const s=await navigator.mediaDevices.getUserMedia({audio:true});
    s.getTracks().forEach(t=>t.stop());await listD();}
  catch(e){log('permission denied: '+e.message,'bad');}};
async function listD(){
  const ds=await navigator.mediaDevices.enumerateDevices();
  const si=$('sel-in'),so=$('sel-out');si.innerHTML='';so.innerHTML='';
  ds.filter(d=>d.kind==='audioinput').forEach(d=>si.add(new Option(d.label||'microphone',d.deviceId)));
  ds.filter(d=>d.kind==='audiooutput').forEach(d=>so.add(new Option(d.label||'output',d.deviceId)));
  log(si.length+' inputs / '+so.length+' outputs');
  const p=await (await fetch('/api/prefs')).json();
  if(p.mic)[...si.options].forEach(o=>{if(o.value===p.mic)si.value=p.mic;});
  if(p.out)[...so.options].forEach(o=>{if(o.value===p.out)so.value=p.out;});
  si.onchange=so.onchange=savePrefs;
}
navigator.mediaDevices&&navigator.mediaDevices.addEventListener&&
 navigator.mediaDevices.addEventListener('devicechange',listD);

/* ---------- test tone ---------- */
$('tone').onclick=async()=>{
  const oid=$('sel-out').value;
  const a=new (window.AudioContext||window.webkitAudioContext)();await a.resume();
  if(oid&&a.setSinkId){try{await a.setSinkId(oid);}catch(e){}}
  const o=a.createOscillator(),g=a.createGain();o.frequency.value=440;g.gain.value=.14;
  o.connect(g);g.connect(a.destination);o.start();
  log('440 Hz tone for 2 s');setTimeout(()=>{o.stop();a.close();},2000);};

/* ---------- self-test ---------- */
$('selftest').onclick=async()=>{
  if(!det||!sep)return;
  const b=$('selftest');b.disabled=true;$('stat').textContent='Self-testing…';
  spin(true);banner('Running the self-test…');
  log('\n=== SELF-TEST ===');
  try{
    const x=new Float32Array(WINLEN);
    for(let i=0;i<WINLEN;i++){x[i]=0.25*Math.sin(2*Math.PI*250*i/SR);const t=i/SR;
      if(t>0.9&&t<1.3)x[i]+=0.55*Math.sin(Math.PI*(t-0.9)/0.4)*(Math.random()*2-1);}
    const a0=performance.now();
    const df={};df[det.inputNames[0]]=new ort.Tensor('float32',x,[1,WINLEN]);
    const dout=await det.run(df);const dt=dout[det.outputNames[0]],DT=dt.dims[1],DC=dt.dims[2];
    const dms=performance.now()-a0;
    let mx=0,mi=0;for(let t=0;t<DT;t++)for(let c=0;c<DC;c++){
      const v=dt.data[t*DC+c];if(v>mx){mx=v;mi=c;}}
    log(`detector ${dms.toFixed(0)} ms · peak ${CLASSES[mi]} ${mx.toFixed(3)}`,dms>1?'ok':'bad');
    const a1=performance.now();
    const {mag,ph,T,B}=stftJS(x);
    const cond=new Float32Array(T*7);
    for(let t=0;t<T;t++){const si=Math.min(DT-1,Math.floor(t*DT/T));
      for(let c=0;c<7;c++)cond[t*7+c]=dt.data[si*DC+c];}
    const so=await sep.run({mag:new ort.Tensor('float32',mag,[1,B,T]),
      cond:new ort.Tensor('float32',cond,[1,T,7])});
    const mk2=so[sep.outputNames[0]].data;const sms=performance.now()-a1;
    let mkMax=0,mkAvg=0;for(let i=0;i<mk2.length;i++){mkAvg+=mk2[i];if(mk2[i]>mkMax)mkMax=mk2[i];}
    mkAvg/=mk2.length;
    log(`separator ${sms.toFixed(0)} ms · mask avg ${mkAvg.toFixed(3)} max ${mkMax.toFixed(3)}`,'ok');
    const tm=new Float32Array(B*T);for(let i=0;i<B*T;i++)tm[i]=mag[i]*mk2[i];
    const tr=istftJS(tm,ph,T,B,WINLEN);
    const cl=new Float32Array(WINLEN);for(let i=0;i<WINLEN;i++)cl[i]=x[i]-tr[i];
    const sg=(a,s0,s1)=>{let e=0;for(let i=s0;i<s1;i++)e+=a[i]*a[i];return Math.sqrt(e/(s1-s0));};
    const bd=20*Math.log10(sg(x,.95*SR,1.25*SR)/Math.max(sg(cl,.95*SR,1.25*SR),1e-9));
    const td=20*Math.log10(sg(x,.1*SR,.7*SR)/Math.max(sg(cl,.1*SR,.7*SR),1e-9));
    log(`burst -${bd.toFixed(2)} dB · tone -${td.toFixed(2)} dB`,bd>2&&td<bd?'ok':'bad');
    const good=dms>1&&mkMax>0.05&&bd>2&&td<bd;
    log(good?'✓ PIPELINE VERIFIED':'✗ pipeline problem',good?'ok':'bad');
    $('stat').textContent=good?'Self-test passed':'Self-test failed';
    banner(good?'<b>Self-test passed</b> — detector '+dms.toFixed(0)+' ms, burst cut by '+bd.toFixed(1)+' dB while the tone stayed. Play the three clips below, then press Start listening.'
      :'<b>Self-test failed</b> — see the Log section.',good?'':'bad');
    fetch('/api/selftest',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({passed:good,det_ms:dms,sep_ms:sms,burst_db:bd,tone_db:td,
        top_class:CLASSES[mi],top_p:mx})});
    const wv=a=>{const n=a.length,bf=new ArrayBuffer(44+n*2),v=new DataView(bf);
      const w=(o,t)=>{for(let i=0;i<t.length;i++)v.setUint8(o+i,t.charCodeAt(i));};
      w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVEfmt ');v.setUint32(16,16,true);
      v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,SR,true);
      v.setUint32(28,SR*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
      w(36,'data');v.setUint32(40,n*2,true);
      for(let i=0;i<n;i++){let q=Math.max(-1,Math.min(1,a[i]));
        v.setInt16(44+i*2,q<0?q*0x8000:q*0x7FFF,true);}
      return URL.createObjectURL(new Blob([bf],{type:'audio/wav'}));};
    $('sp').innerHTML=`<div class="sp"><span style="font-size:13px;color:var(--ink2)">before</span>
      <audio controls src="${wv(x)}"></audio>
      <span style="font-size:13px;color:var(--ink2)">after</span>
      <audio controls src="${wv(cl)}"></audio>
      <span style="font-size:13px;color:var(--ink2)">extracted</span>
      <audio controls src="${wv(tr)}"></audio></div>`;
  }catch(e){log('self-test error: '+e.message,'bad');
    banner('Self-test error: '+e.message,'bad');}
  spin(false);b.disabled=false;
};

/* ---------- live ---------- */
$('ab').onclick=e=>{bypass=!bypass;
  e.target.textContent=bypass?'A/B: ORIGINAL':'A/B';e.target.className=bypass?'r sm':'g sm';};
$('go').onclick=()=>running?stopLive():startLive();

async function startLive(){
  if(!det||!sep)return;
  const inId=$('sel-in').value,outId=$('sel-out').value;
  const base={echoCancellation:false,noiseSuppression:false,
              autoGainControl:false,channelCount:1};
  /* Try the saved device, then fall back. A stale deviceId from a previous
     session throws OverconstrainedError with an empty message. */
  const attempts=[];
  if(inId) attempts.push({label:'saved device (exact)',c:{audio:Object.assign({deviceId:{exact:inId}},base)}});
  if(inId) attempts.push({label:'saved device (preferred)',c:{audio:Object.assign({deviceId:inId},base)}});
  attempts.push({label:'system default',c:{audio:base}});
  attempts.push({label:'any microphone',c:{audio:true}});
  stream=null;
  for(const a of attempts){
    try{ stream=await navigator.mediaDevices.getUserMedia(a.c);
      log('mic opened via '+a.label,'ok'); break; }
    catch(e){
      const nm=e.name||'Error', ms=e.message||'(no message)';
      log('mic attempt "'+a.label+'" failed: '+nm+' — '+ms,'bad');
      if(nm==='NotAllowedError'||nm==='SecurityError'){
        banner('<b>Microphone permission denied.</b> Click the padlock in the address bar, set Microphone to Allow, then reload the page.','bad');
        return;}
    }
  }
  if(!stream){
    banner('<b>No microphone could be opened.</b> Another app may be using it exclusively — close Zoom, Teams or Meet and try again. See the Log for the exact error.','bad');
    return;}
  const micLabel=stream.getAudioTracks()[0].label;
  log('mic: '+micLabel,'ok');
  if(!$('sel-in').value)await listD();
  AC=new (window.AudioContext||window.webkitAudioContext)({sampleRate:SR,latencyHint:'interactive'});
  await AC.resume();
  let outLabel='default';
  if(outId&&AC.setSinkId){try{await AC.setSinkId(outId);
    outLabel=$('sel-out').selectedOptions[0].text;log('output routed','ok');}catch(e){}}
  const srcN=AC.createMediaStreamSource(stream);
  const blob=new Blob([WORKLET],{type:'application/javascript'});
  try{await AC.audioWorklet.addModule(URL.createObjectURL(blob));
    node=new AudioWorkletNode(AC,'io',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    log('worklet active','ok');}
  catch(e){
    node=AC.createScriptProcessor(2048,1,1);node._q=[];node._cur=null;node._ci=0;
    node.port={postMessage:m=>{if(m.play){node._q.push(m.play);
      while(node._q.length>2)node._q.shift();}},onmessage:null};
    node.onaudioprocess=ev=>{const inp=ev.inputBuffer.getChannelData(0),
      out=ev.outputBuffer.getChannelData(0);
      if(node.port.onmessage)node.port.onmessage({data:{chunk:new Float32Array(inp)}});
      for(let k=0;k<out.length;k++){if(!node._cur||node._ci>=node._cur.length){
        node._cur=node._q.shift()||null;node._ci=0;}
        out[k]=node._cur?node._cur[node._ci++]:0;}};
    log('ScriptProcessor fallback','ok');}
  const g=AC.createGain();g.gain.value=1;
  srcN.connect(node);node.connect(g);g.connect(AC.destination);
  HOPOUT=parseInt($('r-hop').value,10)*1024;
  ring=new Float32Array(WINLEN);rw=0;pending=[];pendN=0;events=0;busy=false;
  lastDet=null;cycN=0;dbSum=0;dbN=0;evQueue=[];
  $('v-ev').textContent='0';

  try{const r=await (await fetch('/api/session',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({mic:micLabel,out:outLabel,gate:+rg.value/100,
        strength:+rst.value/100,hop_ms:HOPOUT/16})})).json();
    sessionId=r.session_id;log('session #'+sessionId+' recording','ok');}
  catch(e){sessionId=null;log('history unavailable: '+e.message,'bad');}
  t0Session=performance.now();

  node.port.onmessage=e=>{
    let c=e.data.chunk;if(!c)return;
    const G=parseInt(rgn.value,10);
    if(G>1){const q=new Float32Array(c.length);
      for(let i=0;i<c.length;i++)q[i]=Math.max(-1,Math.min(1,c[i]*G));c=q;}
    for(let i=0;i<c.length;i++){ring[rw]=c[i];rw=(rw+1)%WINLEN;}
    pending.push(c);pendN+=c.length;
    let s2=0;for(let i=0;i<c.length;i++)s2+=c[i]*c[i];
    micMeter=micMeter*.8+Math.sqrt(s2/c.length)*.2;
    const el=$('v-mic');el.textContent=(micMeter*100).toFixed(1)+'%';
    el.style.color=micMeter<.003?'var(--bad)':'var(--ok)';
    if(pendN>=HOPOUT&&!busy)cycle();};

  bypass=true;$('ab').textContent='A/B: ORIGINAL';$('ab').className='r sm';
  let cd=4;
  banner('Warming up — you are hearing <b>unprocessed</b> audio. Suppression starts in <span class="cd">'+cd+'</span>s…','warn');
  const cdt=setInterval(()=>{cd--;
    if(cd>0){const e=document.querySelector('.cd');if(e)e.textContent=cd;}
    else{clearInterval(cdt);}},1000);
  setTimeout(()=>{if(!running)return;bypass=false;
    $('ab').textContent='A/B';$('ab').className='g sm';log('processing engaged','ok');
    banner('<b>Suppression is ON.</b> Type on your keyboard or cough — watch the Detection number and the chips light up.');},4000);
  running=true;
  $('go').textContent='Stop';$('go').className='r';$('ab').disabled=false;
  $('led').className='led live';$('stat').textContent='Listening';
  $('vh').style.display='none';setOrb('live',null,'Listening — triggers are being removed.');
  draw();flushLoop();
}

async function stopLive(){
  running=false;
  try{if(node){node.onaudioprocess=null;node.disconnect();}}catch(e){}
  stream&&stream.getTracks().forEach(t=>t.stop());AC&&AC.close();
  $('go').textContent='Start listening';$('go').className='';$('ab').disabled=true;
  $('led').className='led go';$('stat').textContent='Stopped';
  $('vh').style.display='grid';CLASSES.forEach(c=>{live[c]=false;paint(c);});
  banner('Session saved. Open <b>History</b> to see it.');
  setOrb('ok','Turn on the <em>microphone</em>.','Session saved to history.');
  await flushEvents();
  if(sessionId){
    const secs=(performance.now()-t0Session)/1000;
    await fetch('/api/session/'+sessionId,{method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({seconds:secs,events:events,mean_db:dbN?dbSum/dbN:0})});
    log(`session #${sessionId} saved — ${secs.toFixed(0)} s, ${events} events`,'ok');
    sessionId=null;}
}
async function flushEvents(){
  if(!sessionId||!evQueue.length)return;
  const batch=evQueue.splice(0,evQueue.length);
  try{await fetch('/api/session/'+sessionId+'/events',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({events:batch})});}
  catch(e){}
}
function flushLoop(){if(!running)return;flushEvents();setTimeout(flushLoop,5000);}

async function cycle(){
  busy=true;cycN++;
  const raw=new Float32Array(HOPOUT);let n=0;
  while(n<HOPOUT&&pending.length){const c=pending[0],take=Math.min(c.length,HOPOUT-n);
    raw.set(c.subarray(0,take),n);n+=take;
    if(take===c.length)pending.shift();else pending[0]=c.subarray(take);}
  pendN-=n;
  if(bypass){node.port.postMessage({play:raw});busy=false;return;}
  const t0=performance.now();
  try{
    const EVERY=parseInt($('r-rate').value,10);
    if((cycN-1)%EVERY===0||!lastDet){
      const ctx=new Float32Array(WINLEN);
      for(let i=0;i<WINLEN;i++)ctx[i]=ring[(rw+i)%WINLEN];
      const df={};df[det.inputNames[0]]=new ort.Tensor('float32',ctx,[1,WINLEN]);
      lastDet=(await det.run(df))[det.outputNames[0]];}
    const dt=lastDet,DT=dt.dims[1],DC=dt.dims[2];
    const peak=new Float32Array(7);
    for(let t=Math.floor(DT*0.75);t<DT;t++)for(let c=0;c<7;c++)
      peak[c]=Math.max(peak[c],dt.data[t*DC+c]);
    let dbgMax=0;for(let i=0;i<7;i++)if(peak[i]>dbgMax)dbgMax=peak[i];
    const pe=$('v-peak');pe.textContent=dbgMax.toFixed(2);
    pe.style.color=dbgMax>.5?'var(--bad)':dbgMax>.3?'#C9A227':'var(--ink)';
    const GATEv=parseInt(rg.value,10)/100;
    let anyHot=false;
    CLASSES.forEach((c,i)=>{
      const was=live[c];live[c]=peak[i]>Math.max(.25,GATEv);
      if(live[c]&&!was&&muted[c]){events++;$('v-ev').textContent=events;
        evQueue.push({t:(performance.now()-t0Session)/1000,class:c,p:peak[i],db:lastDb});}
      if(live[c]&&muted[c])anyHot=true;
      const b=document.querySelector('#c-'+c+' i');if(b)b.style.width=(peak[i]*100).toFixed(0)+'%';
      paint(c);});
    if(cycN%2===0&&!bypass){
      if(micMeter<0.003)
        banner('<b>Microphone is silent</b> ('+(micMeter*100).toFixed(2)+'%). Pick the Intel mic under Devices, or raise Input gain under Advanced.','bad');
      else if(dbgMax<0.15)
        banner('Listening — no trigger yet (confidence '+dbgMax.toFixed(2)+'). Try <b>typing</b>: it is the strongest class.');
      else if(!anyHot)
        banner('Something close: confidence <b>'+dbgMax.toFixed(2)+'</b>, gate is '+GATEv.toFixed(2)+'. Lower the gate under Advanced to catch it.','warn');
      else
        banner('<b>Suppressing now</b> — removing '+Math.max(0,lastDb).toFixed(1)+' dB.');
    }
    let outBuf=raw;
    if(anyHot){
      const PAD=NFFT,seg=new Float32Array(HOPOUT+2*PAD);
      for(let i=0;i<seg.length;i++){const idx=rw-HOPOUT-PAD+i;
        seg[i]=ring[((idx%WINLEN)+WINLEN)%WINLEN];}
      const {mag,ph,T,B}=stftJS(seg);
      const STR=parseInt(rst.value,10)/100,PROT=$('c-prot').checked;
      const frac=1-HOPOUT/WINLEN;
      const cond=new Float32Array(T*7),act=new Float32Array(T);
      for(let t=0;t<T;t++){
        const si=Math.min(DT-1,Math.floor(DT*frac+t*(DT*(1-frac))/T));
        let mx=0;
        for(let c=0;c<7;c++){const v=muted[CLASSES[c]]?dt.data[si*DC+c]:0;
          cond[t*7+c]=v;if(v>mx)mx=v;}
        act[t]=mx>=GATEv?1:Math.max(0,(mx-GATEv*.6)/(GATEv*.4));}
      const sm=new Float32Array(T);
      for(let t=0;t<T;t++){let a=0,q=0;
        for(let k=-2;k<=2;k++){const z=t+k;if(z>=0&&z<T){a+=act[z];q++;}}sm[t]=a/q;}
      const bLo=Math.floor(300/(SR/NFFT)),bHi=Math.ceil(3400/(SR/NFFT));
      const so=await sep.run({mag:new ort.Tensor('float32',mag,[1,B,T]),
        cond:new ort.Tensor('float32',cond,[1,T,7])});
      const mk2=so[sep.outputNames[0]].data,tm=new Float32Array(B*T);
      for(let b=0;b<B;b++){const voice=(PROT&&b>=bLo&&b<=bHi)?.75:1;
        for(let t=0;t<T;t++){const i=b*T+t;tm[i]=mag[i]*mk2[i]*sm[t]*STR*voice;}}
      const tr=istftJS(tm,ph,T,B,seg.length);
      const cl=new Float32Array(HOPOUT);
      for(let i=0;i<HOPOUT;i++)cl[i]=seg[PAD+i]-tr[PAD+i];
      outBuf=cl;
      const rr=a=>{let s=0;for(let i=0;i<a.length;i++)s+=a[i]*a[i];return Math.sqrt(s/a.length);};
      const d=20*Math.log10(Math.max(rr(raw),1e-9)/Math.max(rr(cl),1e-9));
      lastDb=lastDb*.7+d*.3;dbSum+=d;dbN++;
      $('v-db').textContent=lastDb.toFixed(1)+' dB';}
    node.port.postMessage({play:outBuf});
    let s2=0;for(let i=0;i<outBuf.length;i++)s2+=outBuf[i]*outBuf[i];
    outAvg=outAvg*.6+Math.sqrt(s2/outBuf.length)*.4;
    $('v-out').textContent=(outAvg*100).toFixed(1)+'%';
    $('v-inf').textContent=(performance.now()-t0).toFixed(0)+' ms';
  }catch(e){log('cycle: '+e.message,'bad');node.port.postMessage({play:raw});}
  busy=false;
  if(pendN>HOPOUT*3){let d=pendN-HOPOUT;
    while(d>0&&pending.length){const c=pending[0];
      if(c.length<=d){d-=c.length;pendN-=c.length;pending.shift();}
      else{pending[0]=c.subarray(d);pendN-=d;d=0;}}}
  if(pendN>=HOPOUT)cycle();
}

/* ---------- viz ---------- */
const cv=$('cv'),cx=cv.getContext('2d');
function draw(){
  if(!running)return;
  const w=cv.width=cv.clientWidth*devicePixelRatio,h=cv.height=cv.clientHeight*devicePixelRatio;
  cx.clearRect(0,0,w,h);
  const hot=CLASSES.some(c=>live[c]&&muted[c]),N=150;
  for(let i=0;i<N;i++){
    const s=ring[Math.floor((rw+i*WINLEN/N)%WINLEN)];
    const bh=Math.max(2,Math.abs(s)*h*3.4);
    const g=cx.createLinearGradient(0,h/2-bh/2,0,h/2+bh/2);
    g.addColorStop(0,hot?'#D0876B':'#7E9B84');g.addColorStop(1,hot?'#F8E6DC':'#E2EBE2');
    cx.fillStyle=g;cx.fillRect(i*w/N+w/N*.2,h/2-bh/2,w/N*.6,bh);}
  requestAnimationFrame(draw);
}
addEventListener('beforeunload',()=>{if(running&&sessionId)
  navigator.sendBeacon('/api/session/'+sessionId,new Blob([JSON.stringify({})],
    {type:'application/json'}));});
boot();
