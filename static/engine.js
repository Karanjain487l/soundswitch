/* self-contained: these must NOT depend on app.js load order */
var SR=16000, WINLEN=32000, NFFT=1024, HOP=256;
var HW=(function(){var w=new Float32Array(NFFT);
  for(var i=0;i<NFFT;i++)w[i]=.5-.5*Math.cos(2*Math.PI*i/NFFT);return w;})();
function fft(re,im){const n=re.length;
  for(let i=1,j=0;i<n;i++){let b=n>>1;for(;j&b;b>>=1)j^=b;j^=b;
    if(i<j){let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}}
  for(let len=2;len<=n;len<<=1){const a=-2*Math.PI/len,wr=Math.cos(a),wi=Math.sin(a);
    for(let i=0;i<n;i+=len){let cr=1,ci=0;
      for(let k=0;k<len/2;k++){const ur=re[i+k],ui=im[i+k];
        const vr=re[i+k+len/2]*cr-im[i+k+len/2]*ci, vi=re[i+k+len/2]*ci+im[i+k+len/2]*cr;
        re[i+k]=ur+vr;im[i+k]=ui+vi;re[i+k+len/2]=ur-vr;im[i+k+len/2]=ui-vi;
        const t=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=t;}}}}
function stftJS(x){const T=Math.floor((x.length-NFFT)/HOP)+1,B=NFFT/2+1;
  const mag=new Float32Array(B*T),ph=new Float32Array(B*T);
  const re=new Float32Array(NFFT),im=new Float32Array(NFFT);
  for(let t=0;t<T;t++){for(let i=0;i<NFFT;i++){re[i]=x[t*HOP+i]*HW[i];im[i]=0;}
    fft(re,im);
    for(let b=0;b<B;b++){mag[b*T+t]=Math.hypot(re[b],im[b]);ph[b*T+t]=Math.atan2(im[b],re[b]);}}
  return{mag,ph,T,B};}
function istftJS(mag,ph,T,B,len){
  const out=new Float32Array(len),ws=new Float32Array(len);
  const re=new Float32Array(NFFT),im=new Float32Array(NFFT);
  for(let t=0;t<T;t++){re.fill(0);im.fill(0);
    for(let b=0;b<B;b++){const m=mag[b*T+t],p=ph[b*T+t];
      re[b]=m*Math.cos(p);im[b]=m*Math.sin(p);
      if(b>0&&b<B-1){re[NFFT-b]=re[b];im[NFFT-b]=-im[b];}}
    for(let i=0;i<NFFT;i++)im[i]=-im[i];
    fft(re,im);
    for(let i=0;i<NFFT;i++){const q=t*HOP+i;if(q>=len)break;
      out[q]+=re[i]/NFFT*HW[i];ws[q]+=HW[i]*HW[i];}}
  for(let i=0;i<len;i++)if(ws[i]>1e-8)out[i]/=ws[i];
  return out;}
const WORKLET=`
class IO extends AudioWorkletProcessor{
  constructor(){super();
    this.inBuf=new Float32Array(48000*4); this.inW=0;
    this.out=[]; this.cur=null; this.curI=0; this.under=0;
    this.port.onmessage=e=>{ if(e.data.play){ this.out.push(e.data.play);
      while(this.out.length>2) this.out.shift(); } };
  }
  process(inputs,outputs){
    const i=inputs[0][0], o=outputs[0][0];
    if(i){ for(let k=0;k<i.length;k++){ this.inBuf[this.inW++]=i[k];
             if(this.inW>=this.inBuf.length) this.inW=0; }
           this.port.postMessage({chunk:i.slice(0)}); }
    if(o){
      for(let k=0;k<o.length;k++){
        if(!this.cur||this.curI>=this.cur.length){ this.cur=this.out.shift()||null; this.curI=0; }
        o[k]= this.cur? this.cur[this.curI++] : 0;
      }
    }
    this.n=(this.n||0)+1;
    if(this.n%100===0) this.port.postMessage({alive:this.out.length});
    return true;
  }
}
registerProcessor('io',IO);`;