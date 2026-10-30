import * as THREE from 'three';

// A deterministic random spectrum, evaluated on the GPU once per frame.
// Integer wave vectors make both the height and its derivatives tile seamlessly.
// The two incommensurate patch sizes keep the combined pattern from repeating
// within the visible nearshore area.
const COUNT = 48;
function randomGenerator(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t ^= t + Math.imul(t ^ t >>> 7, 61 | t);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function spectrum(size, minLength, maxLength, seed, detail) {
  const random = randomGenerator(seed), modes = [], frequencies = [], seen = new Set();
  for (let i = 0; i < COUNT; i++) {
    const fraction = (i + random()) / COUNT;
    const wavelength = minLength * (maxLength / minLength) ** fraction;
    // Swell has a prevailing wind; small ripples have a broader angular spread.
    const angle = detail ? random() * Math.PI * 2 : 1.18 + (random() + random() + random() - 1.5) * 0.9;
    let nx = Math.round(Math.cos(angle) * size / wavelength);
    let nz = Math.round(Math.sin(angle) * size / wavelength);
    while (seen.has(`${nx},${nz}`) || (!nx && !nz)) nz++;
    seen.add(`${nx},${nz}`);
    const kx = 2 * Math.PI * nx / size, kz = 2 * Math.PI * nz / size;
    const k = Math.hypot(kx,kz), length = 2*Math.PI/k;
    const amplitude = (detail ? 0.0048 : 0.010) * length ** (detail ? 1.14 : 0.92) * (0.65 + random() * 0.7);
    modes.push(new THREE.Vector4(kx,kz,amplitude,random()*Math.PI*2));
    frequencies.push(Math.sqrt(9.81*k) * (detail ? 0.86 : 1));
  }
  return {modes,frequencies};
}

const vertexShader = /* glsl */`
varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}
`;
const fragmentShader = /* glsl */`
uniform float uTime;
uniform float uSize;
uniform float uDetail;
uniform vec4 uModes[48];
uniform float uFrequencies[48];
varying vec2 vUv;
layout(location=0) out vec4 outWave;
layout(location=1) out vec4 outDisplacement;
layout(location=2) out vec4 outJacobian;
const float TAU=6.28318530718;
void main(){
  vec2 p=(vUv-0.5)*uSize;
  // Periodic, smoothly evolving Fourier noise warps wave phases and envelopes.
  // Derivatives use the chain rule, so the displaced height, normals, and
  // refracted sunlight continue to describe the same continuous water surface.
  vec2 warp=vec2(0.0);
  vec2 dx=vec2(0.0),dz=vec2(0.0);
  for(int i=0;i<6;i++){
    float fi=float(i);
    vec2 k=vec2(float(i%3)+1.0,float((i*2+1)%5)-2.0)*TAU/uSize;
    float phase=dot(k,p)+fi*2.39996+uTime*(0.045+fi*0.012);
    vec2 weight=vec2(sin(fi*3.73+1.1),cos(fi*2.19))*mix(0.36,0.055,uDetail);
    warp+=weight*sin(phase);
    dx+=weight*cos(phase)*k.x;
    dz+=weight*cos(phase)*k.y;
  }
  vec2 q=p+warp;
  float height=0.0,crest=0.0;
  vec2 gradient=vec2(0.0),horizontal=vec2(0.0);
  vec4 horizontalDerivative=vec4(0.0);
  for(int i=0;i<48;i++){
    vec4 mode=uModes[i];
    float phase=dot(mode.xy,q)-uFrequencies[i]*uTime+mode.w;
    float s=sin(phase),c=cos(phase);
    // Weak harmonic asymmetry creates sharper crests and rounder troughs.
    float harmonic=mix(0.09,0.025,uDetail);
    height+=mode.z*(s-harmonic*(c*c-s*s));
    vec2 dPhase=vec2(mode.x+dot(mode.xy,dx),mode.y+dot(mode.xy,dz));
    gradient+=mode.z*(c+4.0*harmonic*s*c)*dPhase;
    vec2 direction=normalize(mode.xy);
    horizontal+=direction*mode.z*c;
    horizontalDerivative-=mode.z*s*vec4(direction.x*dPhase.x,direction.x*dPhase.y,direction.y*dPhase.x,direction.y*dPhase.y);
    crest+=mode.z*length(mode.xy)*s;
  }
  outWave=vec4(height,gradient,crest);
  outDisplacement=vec4(horizontal,horizontalDerivative.xy);
  outJacobian=vec4(horizontalDerivative.zw,0.0,0.0);
}
`;

export function createWaveSpectrum(renderer, sharedUniforms) {
  const scene=new THREE.Scene(),camera=new THREE.Camera();
  const geometry=new THREE.PlaneGeometry(2,2);
  const mesh=new THREE.Mesh(geometry);mesh.frustumCulled=false;scene.add(mesh);
  const layers=[
    {size:64,detail:false,min:0.95,max:14.5,seed:92117,resolution:512},
    {size:11.7,detail:true,min:0.19,max:1.65,seed:58221,resolution:512}
  ].map(config=>{
    const values=spectrum(config.size,config.min,config.max,config.seed,config.detail);
    const material=new THREE.ShaderMaterial({vertexShader,fragmentShader,glslVersion:THREE.GLSL3,
      uniforms:{uTime:sharedUniforms.uTime,uSize:{value:config.size},uDetail:{value:config.detail?1:0},uModes:{value:values.modes},uFrequencies:{value:values.frequencies}},
      depthTest:false,depthWrite:false,toneMapped:false});
    const target=new THREE.WebGLRenderTarget(config.resolution,config.resolution,{
      type:THREE.HalfFloatType,wrapS:THREE.RepeatWrapping,wrapT:THREE.RepeatWrapping,
      minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,
      generateMipmaps:true,depthBuffer:false,count:3
    });
    return {...config,material,target};
  });
  sharedUniforms.uSwellMap={value:layers[0].target.texture};
  sharedUniforms.uRippleMap={value:layers[1].target.texture};
  sharedUniforms.uDisplacementMap={value:layers[0].target.textures[1]};
  sharedUniforms.uJacobianMap={value:layers[0].target.textures[2]};
  let lastTime=NaN;
  return {
    update(){
      if(lastTime===sharedUniforms.uTime.value)return;
      lastTime=sharedUniforms.uTime.value;
      for(const layer of layers){mesh.material=layer.material;renderer.setRenderTarget(layer.target);renderer.render(scene,camera);}
    },
    dispose(){geometry.dispose();for(const layer of layers){layer.material.dispose();layer.target.dispose();}}
  };
}
