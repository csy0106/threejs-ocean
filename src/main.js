import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { waterVertex, waterFragment, skyVertex, skyFragment } from './shaders.js';
import { createWaveSpectrum } from './wave-spectrum.js';
import { createAdaptiveCaustics } from './caustics.js';
import { createFoamSimulation } from './foam.js';
import { surfaceHeightAt } from './wave-model.js';

const $ = id => document.getElementById(id);
const canvas = $('ocean');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, powerPreference:'high-performance', preserveDrawingBuffer:true});
  if(!renderer.extensions.has('EXT_color_buffer_float'))throw new Error('Floating-point render targets are unavailable');
} catch(error) {
  $('loading').innerHTML='<p>当前设备无法启动海面渲染</p><small>需要 WebGL 2 与浮点渲染目标支持，请开启浏览器硬件加速。</small>';
  throw error;
}
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.setClearColor(0x90bbd2);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(49,1,0.08,10000);
camera.position.set(0,3.15,8.8);
const controls = new OrbitControls(camera,canvas);
controls.target.set(0,0,-2.8);
controls.enableDamping = true;
controls.dampingFactor = 0.065;
controls.minDistance = 3;
controls.maxDistance = 65;
controls.minPolarAngle = 0.05;
controls.maxPolarAngle = Math.PI/2-0.07;
controls.enablePan = false;
controls.rotateSpeed = 0.45;
controls.zoomSpeed = 0.65;
controls.update();

const uniforms = {
  uTime:{value:0}, uWave:{value:0.65}, uDepth:{value:1.2},
  uClarity:{value:0.82}, uCaustics:{value:1.1}, uFoam:{value:1},
  uWarmth:{value:0}, uSun:{value:new THREE.Vector3()}, uCausticMap:{value:null}
};
function setSun(degrees){
  const h=THREE.MathUtils.degToRad(degrees);
  uniforms.uSun.value.set(Math.cos(h)*0.32,Math.sin(h),-Math.cos(h)*0.947).normalize();
  uniforms.uWarmth.value=1-THREE.MathUtils.smoothstep(degrees,8,32);
}
setSun(48);
const waveSpectrum=createWaveSpectrum(renderer,uniforms);
const foamSimulation=createFoamSimulation(renderer,uniforms);
const caustics=createAdaptiveCaustics(renderer,camera,uniforms);

const sky = new THREE.Mesh(new THREE.SphereGeometry(1,32,16),new THREE.ShaderMaterial({
  vertexShader:skyVertex,fragmentShader:skyFragment,uniforms,
  side:THREE.BackSide,depthWrite:false,depthTest:false
}));
sky.frustumCulled=false;
sky.renderOrder=-10;
scene.add(sky);

// Exponentially spaced grid: fine geometry around the viewer, kilometre scale
// coverage at the horizon. All displacement stays on the GPU.
function oceanGeometry(segments){
  const geometry=new THREE.PlaneGeometry(2,2,segments,segments);
  const pos=geometry.attributes.position;
  for(let i=0;i<pos.count;i++){
    const x=pos.getX(i), z=pos.getY(i);
    const stretch=v=>Math.sign(v)*(Math.exp(Math.abs(v)*7.5)-1)*2.8;
    pos.setXYZ(i,stretch(x),0,stretch(-z));
  }
  geometry.computeBoundingSphere();
  return geometry;
}
const water=new THREE.Mesh(oceanGeometry(512),new THREE.ShaderMaterial({
  vertexShader:waterVertex,fragmentShader:waterFragment,uniforms,side:THREE.DoubleSide
}));
water.frustumCulled=false;
scene.add(water);

let quality=null,needsRender=true,contextLost=false,renderCount=0;
const qualityOptions={high:{pixelRatio:1.6,map:2048,grid:760},balanced:{pixelRatio:1.1,map:1536,grid:600},low:{pixelRatio:0.75,map:768,grid:380}};
function setQuality(level){
  if(!Object.hasOwn(qualityOptions,level))throw new RangeError('Unknown quality: '+level);
  if(quality===level)return;
  quality=level;
  const q=qualityOptions[level];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,q.pixelRatio));
  foamSimulation.setQuality(level);
  caustics.setQuality(q);
  resize();
}
function resize(){
  renderer.setSize(window.innerWidth,window.innerHeight);
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  needsRender=true;
}
setQuality('balanced');
window.addEventListener('resize',resize);
$('quality').addEventListener('change',e=>setQuality(e.target.value));

const bindings={wave:'uWave',depth:'uDepth',clarity:'uClarity',caustics:'uCaustics'};
let speed=1, paused=false, transition=null, ready=false;
const format={wave:v=>v.toFixed(2),speed:v=>v.toFixed(2)+' ×',depth:v=>v.toFixed(2)+' m',clarity:v=>Math.round(v*100)+'%',caustics:v=>v.toFixed(2),sun:v=>Math.round(v)+'°'};
function updateControl(id,value){
  needsRender=true;
  const el=$(id);
  el.value=value;
  const v=Number(el.value);
  $(id+'-value').value=format[id](v);
  el.style.setProperty('--fill',((v-Number(el.min))/(Number(el.max)-Number(el.min))*100)+'%');
  if(bindings[id])uniforms[bindings[id]].value=v;
  if(id==='speed')speed=v;
  if(id==='sun')setSun(v);
}
for(const id of Object.keys(format)){
  updateControl(id,Number($(id).value));
  $(id).addEventListener('input',e=>{
    updateControl(id,Number(e.target.value));
    document.querySelectorAll('[data-preset]').forEach(el=>el.classList.remove('active'));
  });
}
$('foam').addEventListener('change',e=>{uniforms.uFoam.value=e.target.checked?1:0;needsRender=true;});
const presets={
  coast:{wave:0.65,speed:1,depth:1.2,clarity:0.82,caustics:1.1,sun:48},
  breeze:{wave:1.22,speed:1.15,depth:1.8,clarity:0.72,caustics:0.85,sun:38},
  golden:{wave:0.65,speed:0.8,depth:1.2,clarity:0.88,caustics:0.95,sun:12}
};
function applyPreset(name){
  for(const [key,val] of Object.entries(presets[name]))updateControl(key,val);
  document.querySelectorAll('[data-preset]').forEach(el=>el.classList.toggle('active',el.dataset.preset===name));
}
document.querySelectorAll('[data-preset]').forEach(el=>el.addEventListener('click',()=>applyPreset(el.dataset.preset)));
const views={
  coast:{pos:[0,3.15,8.8],target:[0,0,-2.8],title:'风有形，光有迹。',description:'远处是蔚蓝，脚下是流动的光。',number:'01 / 03'},
  shallow:{pos:[1.5,4.5,9.0],target:[-0.5,0,4],title:'看见光的流动。',description:'穿过波纹的阳光，在沙底交织成网。',number:'02 / 03'},
  overhead:{pos:[0,14,4.8],target:[0,0,3.5],title:'每一道波纹，都在呼吸。',description:'换一个角度，观察水面之下的秩序。',number:'03 / 03'}
};
let currentView='coast';
function setView(name,instant=false){
  if(!Object.hasOwn(views,name))throw new RangeError('Unknown view: '+name);
  needsRender=true;
  currentView=name;
  const v=views[name];
  transition={start:performance.now(),from:camera.position.clone(),fromTarget:controls.target.clone(),to:new THREE.Vector3(...v.pos),toTarget:new THREE.Vector3(...v.target)};
  if(instant){camera.position.copy(transition.to);controls.target.copy(transition.toTarget);transition=null;controls.update();}
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===name));
  $('view-title').textContent=v.title;
  $('view-description').textContent=v.description;
  document.querySelector('.panel-number').textContent=v.number;
}
document.querySelectorAll('[data-view]').forEach(el=>el.addEventListener('click',()=>setView(el.dataset.view)));
controls.addEventListener('start',()=>transition=null);
controls.addEventListener('change',()=>needsRender=true);
function togglePause(){
  paused=!paused;
  needsRender=true;
  if(paused)$('fps').textContent='—';
  $('pause').setAttribute('aria-label',paused?'播放动画':'暂停动画');
  $('pause').innerHTML=paused?'<svg viewBox="0 0 24 24"><path d="m9 5 10 7-10 7z"/></svg>':'<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>';
  document.querySelector('.live').innerHTML=paused?'<i style="background:#a99a6c"></i> 时间已暂停':'<i></i> 实时海洋';
}
$('pause').addEventListener('click',togglePause);
function syncInterface(){
  const immersive=document.body.classList.contains('ui-hidden');
  const panelHidden=immersive||$('panel').classList.contains('hidden');
  $('panel').inert=panelHidden;
  $('panel').setAttribute('aria-hidden',String(panelHidden));
  $('toggle-panel').setAttribute('aria-expanded',String(!panelHidden));
  for(const selector of ['.footer','.brand','.live']){
    const element=document.querySelector(selector);element.inert=immersive;element.setAttribute('aria-hidden',String(immersive));
  }
}
$('toggle-panel').addEventListener('click',()=>{
  if(document.body.classList.contains('ui-hidden')){
    document.body.classList.remove('ui-hidden');$('panel').classList.remove('hidden');
  }else $('panel').classList.toggle('hidden');
  syncInterface();
});
$('reset').addEventListener('click',()=>{applyPreset('coast');setView('coast');$('foam').checked=true;uniforms.uFoam.value=1;toast('已恢复清澈浅海');});
let toastTimeout;
function toast(message){$('toast').textContent=message;$('toast').classList.add('visible');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>$('toast').classList.remove('visible'),2400);}
$('capture').addEventListener('click',()=>{
  render();
  canvas.toBlob(blob=>{
    if(!blob){toast('保存画面失败，请重试');return;}
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`pelagic-${currentView}-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),3000);toast('已保存纯净海面画面');
  });
});
window.addEventListener('keydown',e=>{
  if(['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))return;
  if(e.code==='Space'&&document.activeElement.tagName!=='BUTTON'){e.preventDefault();togglePause();}
  if(e.code==='KeyH'){document.body.classList.toggle('ui-hidden');syncInterface();}
});
if(window.innerWidth<600)$('panel').classList.add('hidden');
syncInterface();
let shaderError=false;
renderer.debug.onShaderError=(gl,program,vertex,fragment)=>{
  shaderError=true;
  console.error('Shader error:',gl.getProgramInfoLog(program),gl.getShaderInfoLog(vertex),gl.getShaderInfoLog(fragment));
  $('loading').classList.remove('hide');
  $('loading').setAttribute('aria-hidden','false');
  $('loading').innerHTML='<p>海面着色器未能启动</p><small>请使用支持 WebGL 2 的浏览器，并开启硬件加速。</small>';
};
function protectCamera(){
  const height=surfaceHeightAt(camera.position.x,camera.position.z,uniforms.uTime.value,uniforms.uWave.value,uniforms.uDepth.value);
  const minimum=Math.max(0.8,height+0.35);
  if(camera.position.y<minimum){camera.position.y=minimum;camera.lookAt(controls.target);needsRender=true;}
}
function render(){
  if(contextLost)return;
  protectCamera();
  waveSpectrum.update();
  foamSimulation.update();
  caustics.render();
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x90bbd2,1);
  renderer.render(scene,camera);
  renderCount++;needsRender=false;
}
canvas.addEventListener('webglcontextlost',event=>{
  event.preventDefault();contextLost=true;ready=false;
  document.body.dataset.ready='false';$('loading').classList.remove('hide');
  $('loading').setAttribute('aria-hidden','false');
  $('loading').innerHTML='<p>正在恢复海面渲染</p><small>显卡连接暂时中断，请稍候。</small>';
});
canvas.addEventListener('webglcontextrestored',()=>{
  contextLost=false;shaderError=false;
  waveSpectrum.invalidate();foamSimulation.invalidate();caustics.invalidate();needsRender=true;
  previous=performance.now();lastFps=previous;frames=0;
});
let previous=performance.now(),lastFps=previous,frames=0;
function animate(now){
  requestAnimationFrame(animate);
  const dt=Math.min((now-previous)/1000,0.25);previous=now;
  if(document.hidden||contextLost)return;
  if(!paused)uniforms.uTime.value+=dt*speed;
  if(transition){
    const t=Math.min(1,(now-transition.start)/1500),ease=t*t*(3-2*t);
    camera.position.lerpVectors(transition.from,transition.to,ease);
    controls.target.lerpVectors(transition.fromTarget,transition.toTarget,ease);
    if(t>=1)transition=null;
  }
  controls.update();
  if(!paused||transition||needsRender){render();frames++;}
  if(now-lastFps>800){$('fps').textContent=paused?'—':Math.round(frames*1000/(now-lastFps));frames=0;lastFps=now;}
  if(!ready&&!shaderError){ready=true;$('loading').classList.add('hide');$('loading').setAttribute('aria-hidden','true');document.body.dataset.ready='true';}
}
requestAnimationFrame(animate);
document.addEventListener('visibilitychange',()=>{previous=performance.now();lastFps=previous;frames=0;needsRender=true;});

// Local diagnostics for reproducible browser checks and still captures.
window.oceanDemo={
  renderer,scene,camera,controls,uniforms,foamSimulation,
  setView,setQuality,applyPreset,render,
  getState:()=>({paused,quality,currentView,time:uniforms.uTime.value,shaderError,ready,contextLost,renderCount,triangles:renderer.info.render.triangles,caustics:caustics.getState(),foam:foamSimulation.getState()}),
  setTime(t){uniforms.uTime.value=t;render();},
  pause(){if(!paused)togglePause();}
};
