import * as THREE from 'three';
import { common } from './shaders.js';

// Persistent foam in the wave's material coordinates. The displaced geometry
// supplies orbital motion; a gentle current transports the remaining foam.
const vertexShader=/* glsl */`
varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}
`;
const fragmentShader=/* glsl */`
${common}
uniform sampler2D uHistory;
uniform vec2 uTexel;
uniform float uDelta;
uniform float uReset;
uniform float uEmission;
varying vec2 vUv;
float tileNoise(vec2 p,vec2 period){
  vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash21(mod(i,period)),hash21(mod(i+vec2(1,0),period)),f.x),
             mix(hash21(mod(i+vec2(0,1),period)),hash21(mod(i+1.0,period)),f.x),f.y);
}
void main(){
  vec4 swell=texture2D(uSwellMap,vUv);
  vec4 d=texture2D(uDisplacementMap,vUv);
  vec2 dz=texture2D(uJacobianMap,vUv).xy;
  float chop=0.85*uWave/(1.0+0.6*uWave);
  float compression=max(0.0,1.0-((1.0+chop*d.z)*(1.0+chop*dz.y)-chop*chop*d.w*dz.x));
  vec2 drift=vec2(0.035,0.075);
  vec2 oldUv=vUv-drift*uDelta/64.0;
  vec4 old=texture2D(uHistory,oldUv);
  vec2 neighbours=texture2D(uHistory,oldUv+vec2(uTexel.x,0)).rg
    +texture2D(uHistory,oldUv-vec2(uTexel.x,0)).rg
    +texture2D(uHistory,oldUv+vec2(0,uTexel.y)).rg
    +texture2D(uHistory,oldUv-vec2(0,uTexel.y)).rg;
  // Slight spreading softens the residue, without blurring active crest lines.
  vec2 transported=mix(old.rg,neighbours*0.25,min(0.15,uDelta*1.8));
  float rising=uReset>0.5?1.0:smoothstep(-0.02,0.55,(compression-old.b)/max(uDelta,0.001));
  float ridge=exp(-pow(dot(swell.yz,normalize(vec2(0.38,0.92)))*uWave/0.14,2.0));
  float patches=tileNoise(vUv*vec2(32,112),vec2(32,112))*0.65
    +tileNoise(vUv*vec2(80,224),vec2(80,224))*0.35;
  float source=smoothstep(0.16,0.36,compression)*smoothstep(0.16,0.42,swell.w*uWave);
  source*=ridge*smoothstep(0.32,0.76,patches)*smoothstep(0.28,1.08,uWave)*rising*uEmission;
  float fresh=transported.r*exp(-uDelta*2.4);
  float residue=transported.g*exp(-uDelta*1.05)+transported.r*(1.0-exp(-uDelta*2.4))*0.45;
  fresh=1.0-(1.0-fresh)*exp(-source*uDelta*7.0);
  if(uReset>0.5){fresh=source*0.35;residue=0.0;}
  gl_FragColor=vec4(clamp(vec2(fresh,residue),0.0,1.0),compression,1.0);
}
`;

export function createFoamSimulation(renderer,uniforms){
  const scene=new THREE.Scene(),camera=new THREE.Camera();
  const empty=new THREE.DataTexture(new Uint8Array(4),1,1);empty.needsUpdate=true;
  const geometry=new THREE.PlaneGeometry(2,2);
  const material=new THREE.ShaderMaterial({vertexShader,fragmentShader,
    uniforms:{...uniforms,uHistory:{value:null},uTexel:{value:new THREE.Vector2()},
      uDelta:{value:0},uReset:{value:1},uEmission:{value:1}},
    depthTest:false,depthWrite:false,toneMapped:false});
  const mesh=new THREE.Mesh(geometry,material);mesh.frustumCulled=false;scene.add(mesh);
  uniforms.uFoamMap={value:null};
  let targets=[],read=0,lastTime=NaN,lastWave=NaN,updates=0;
  return {
    setQuality(level){
      for(const t of targets)t.dispose();
      const size=level==='high'?1024:level==='low'?512:768;
      targets=Array.from({length:2},()=>new THREE.WebGLRenderTarget(size,size,{
        type:THREE.HalfFloatType,wrapS:THREE.RepeatWrapping,wrapT:THREE.RepeatWrapping,
        minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,
        generateMipmaps:true,depthBuffer:false}));
      material.uniforms.uTexel.value.set(1/size,1/size);
      read=0;lastTime=NaN;uniforms.uFoamMap.value=targets[read].texture;
    },
    update(){
      const time=uniforms.uTime.value,wave=uniforms.uWave.value;
      if(time===lastTime&&wave===lastWave)return;
      const elapsed=time-lastTime;
      const reset=!Number.isFinite(lastTime)||elapsed<0||elapsed>0.25||wave!==lastWave;
      material.uniforms.uDelta.value=reset?0:Math.min(0.1,elapsed);
      material.uniforms.uReset.value=reset?1:0;
      material.uniforms.uHistory.value=reset?empty:targets[read].texture;
      const write=1-read;
      renderer.setRenderTarget(targets[write]);renderer.render(scene,camera);
      read=write;uniforms.uFoamMap.value=targets[read].texture;
      lastTime=time;lastWave=wave;updates++;
    },
    getState(){return {updates,time:lastTime,resolution:targets[read].width};},
    // Diagnostics can stop new production to measure the stored foam's lifetime.
    setEmission(value){material.uniforms.uEmission.value=value;},
    dispose(){for(const t of targets)t.dispose();empty.dispose();geometry.dispose();material.dispose();}
  };
}
