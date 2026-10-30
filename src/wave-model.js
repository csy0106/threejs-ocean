// Shared deterministic spectrum data and a CPU surface query for camera safety.
// The GPU evaluates these same modes in wave-spectrum.js.
export const SPECTRUM_CONFIGS=[
  {size:64,detail:false,min:0.95,max:14.5,seed:92117,resolution:512},
  {size:11.7,detail:true,min:0.13,max:1.45,seed:58221,resolution:512}
];
function randomGenerator(seed){return ()=>{
  seed|=0;seed=seed+0x6D2B79F5|0;
  let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;
  return ((t^t>>>14)>>>0)/4294967296;
};}
export function createSpectrum({size,min,max,seed,detail}){
  const random=randomGenerator(seed),modes=[],frequencies=[],seen=new Set();
  for(let i=0;i<48;i++){
    const fraction=(i+random())/48,wavelength=min*(max/min)**fraction;
    const angle=detail?random()*Math.PI*2:1.18+(random()+random()+random()-1.5)*.9;
    let nx=Math.round(Math.cos(angle)*size/wavelength),nz=Math.round(Math.sin(angle)*size/wavelength);
    while(seen.has(`${nx},${nz}`)||(!nx&&!nz))nz++;
    seen.add(`${nx},${nz}`);
    const kx=2*Math.PI*nx/size,kz=2*Math.PI*nz/size,k=Math.hypot(kx,kz),length=2*Math.PI/k;
    const amplitude=(detail?.0076:.010)*length**(detail?1.08:.92)*(.65+random()*.7);
    modes.push([kx,kz,amplitude,random()*Math.PI*2]);
    frequencies.push(Math.sqrt(9.81*k)*(detail?.86:1));
  }
  return {modes,frequencies};
}
export const SPECTRA=SPECTRUM_CONFIGS.map(config=>({...config,...createSpectrum(config)}));
export function bedDepth(x,z,depth){return Math.max(.28,depth+.17*(5-z)+.09*Math.sin(x*.42+z*.23)+.06*Math.sin(z*.61-x*.17));}

function sampleLayer(layer,x,z,time){
  let wx=0,wz=0;
  for(let i=0;i<6;i++){
    const kx=(i%3+1)*2*Math.PI/layer.size,kz=((i*2+1)%5-2)*2*Math.PI/layer.size;
    const phase=kx*x+kz*z+i*2.39996+time*(.045+i*.012),weight=layer.detail?.055:.36;
    wx+=Math.sin(i*3.73+1.1)*weight*Math.sin(phase);wz+=Math.cos(i*2.19)*weight*Math.sin(phase);
  }
  let height=0,dx=0,dz=0;
  for(let i=0;i<48;i++){
    const [kx,kz,a,phase0]=layer.modes[i],phase=kx*(x+wx)+kz*(z+wz)-layer.frequencies[i]*time+phase0;
    const s=Math.sin(phase),c=Math.cos(phase),k=Math.hypot(kx,kz);
    height+=a*(s-(layer.detail?.025:.09)*(c*c-s*s));dx+=kx/k*a*c;dz+=kz/k*a*c;
  }
  return {height,dx,dz};
}

export function surfaceHeightAt(x,z,time,strength,depth){
  const chop=.85*strength/(1+.6*strength);
  // Invert horizontal displacement to query WORLD coordinates, not grid UVs.
  let px=x,pz=z;
  for(let i=0;i<7;i++){
    const s=sampleLayer(SPECTRA[0],px,pz,time);px=x-chop*s.dx;pz=z-chop*s.dz;
  }
  const swell=sampleLayer(SPECTRA[0],px,pz,time);
  const ripple=sampleLayer(SPECTRA[1],px,pz,time);
  const fine=sampleLayer(SPECTRA[1],px*2.73-.29*11.7,pz*2.73+.13*11.7,time);
  const h=swell.height*strength+(ripple.height+fine.height*.45/2.73)*Math.sqrt(strength)*.85;
  const limit=.8*bedDepth(x,z,depth);
  return limit*Math.tanh(h/limit);
}
