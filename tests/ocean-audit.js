import * as THREE from 'three';
import {common} from '../src/shaders.js';
import {surfaceHeightAt} from '../src/wave-model.js';

const frame=document.querySelector('#demo'),status=document.querySelector('#status'),report=document.querySelector('#report');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=10000){const start=performance.now();while(!predicate()){if(performance.now()-start>timeout)throw new Error('Timed out waiting for scene');await wait(50);}}
const ready=(async()=>{await until(()=>frame.contentWindow.oceanDemo?.getState().ready,30000);status.textContent='场景就绪';return frame.contentWindow.oceanDemo;})();

function makeProbe(app){
  const target=new THREE.WebGLRenderTarget(128,128,{type:THREE.FloatType,depthBuffer:false});
  const geometry=new THREE.PlaneGeometry(2,2);
  for(const attribute of Object.values(geometry.attributes))attribute.array=new frame.contentWindow.Float32Array(attribute.array);
  geometry.index.array=new frame.contentWindow.Uint16Array(geometry.index.array);
  const output={value:0};
  const material=new THREE.ShaderMaterial({uniforms:{...app.uniforms,uProbeOutput:output},depthTest:false,depthWrite:false,
    vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader:`${common}
      varying vec2 vUv;
      uniform float uProbeOutput;
      void main(){vec3 p,n;float compression,crest;
        surfaceGeometry((vUv-.5)*vec2(48.,40.),.03,p,n,compression,crest);
        gl_FragColor=uProbeOutput>0.5?vec4(p,1.):vec4(bedDepth(p.xz)+p.y,p.y,1.-compression,length(n));}`});
  const scene=new THREE.Scene(),camera=new THREE.Camera();scene.add(new THREE.Mesh(geometry,material));
  function read(){
    app.render();app.renderer.setRenderTarget(target);app.renderer.render(scene,camera);
    const data=new Float32Array(128*128*4);app.renderer.readRenderTargetPixels(target,0,0,128,128,data);app.renderer.setRenderTarget(null);
    return data;
  }
  return {sample(){
    output.value=0;const data=read();
    let minClearance=Infinity,maxHeight=-Infinity,minHeight=Infinity,minArea=Infinity,penetrations=0,invalid=0,normalError=0;
    for(let i=0;i<data.length;i+=4){minClearance=Math.min(minClearance,data[i]);maxHeight=Math.max(maxHeight,data[i+1]);minHeight=Math.min(minHeight,data[i+1]);minArea=Math.min(minArea,data[i+2]);if(data[i]<0)penetrations++;if(!Number.isFinite(data[i]+data[i+1]+data[i+2]+data[i+3]))invalid++;normalError=Math.max(normalError,Math.abs(data[i+3]-1));}
    return {minClearance,maxHeight,minHeight,minArea,penetrations,invalid,normalError};
  },compareCPU(){
    output.value=1;const data=read();output.value=0;let maximumError=0,samples=0;
    for(let row=4;row<128;row+=12)for(let col=4;col<128;col+=12){
      const i=(row*128+col)*4;
      const cpu=surfaceHeightAt(data[i],data[i+2],app.uniforms.uTime.value,app.uniforms.uWave.value,app.uniforms.uDepth.value);
      maximumError=Math.max(maximumError,Math.abs(cpu-data[i+1]));samples++;
    }
    return {maximumError,samples};
  },dispose(){target.dispose();geometry.dispose();material.dispose();}};
}

async function boundaries(app){
  const probe=makeProbe(app),results=[];
  try{
    for(const depth of [.45,1.2,4])for(const strength of [.15,.65,1.5]){
      app.uniforms.uDepth.value=depth;app.uniforms.uWave.value=strength;
      for(const time of [0,8,16,32]){app.setTime(time);results.push({depth,strength,time,...probe.sample()});}
      status.textContent=`波面 ${depth} m / ${strength}`;await wait(0);
    }
    return results;
  }finally{probe.dispose();}
}

async function begin(){const app=await ready;app.pause();app.controls.enableDamping=false;app.applyPreset('coast');app.setView('coast',true);return app;}
async function runProbe(){
  const app=await begin();try{const boundary=await boundaries(app);app.applyPreset('coast');app.setTime(8);
    const before=app.renderer.info.render.frame;await wait(400);const pausedFrames=app.renderer.info.render.frame-before;
    report.textContent=JSON.stringify({boundary,pausedFrames},null,2);status.textContent='边界检查完成';
  }catch(error){report.textContent=error.stack;status.textContent='检查失败';}
}
let running=false;
for(const [id,fn]of [['probe',runProbe],['run',runFull]])document.querySelector('#'+id).onclick=async()=>{
  if(running)return;running=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);
  report.textContent='';document.querySelector('#captures').replaceChildren();
  try{await fn();}catch(error){report.textContent=JSON.stringify({passed:false,error:error.stack});status.textContent='检查失败';}
  finally{running=false;document.querySelectorAll('button').forEach(b=>b.disabled=false);}
};

// Added checks below exercise actual GPU output and public controls, rather
// than asserting that a source string contains the intended implementation.
async function runFull(){
  const checks=[],details={},errors=[];const app=await begin();
  const child=frame.contentWindow,dom=frame.contentDocument;
  const check=(name,condition,detail)=>{checks.push({name,passed:!!condition,...(detail===undefined?{}:{detail})});};
  const capture=name=>{app.render();const img=document.createElement('img');img.id='audit-'+name;img.alt=name;img.src=app.renderer.domElement.toDataURL();document.querySelector('#captures').append(img);};
  const set=(id,value)=>{const el=dom.getElementById(id);el.value=value;el.dispatchEvent(new child.Event('input',{bubbles:true}));};
  const pixels=()=>{app.render();const gl=app.renderer.getContext(),data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;};
  const eventError=event=>errors.push(event.message||String(event.reason));child.addEventListener('error',eventError);child.addEventListener('unhandledrejection',eventError);
  try{
    details.boundary=await boundaries(app);
    check('36 parameter/time combinations stay above the seabed',details.boundary.every(x=>x.minClearance>=.05));
    check('GPU field contains finite, unit normals and no folded horizontal surface',details.boundary.every(x=>!x.invalid&&x.normalError<.001&&x.minArea>.05));
    app.uniforms.uDepth.value=.45;app.uniforms.uWave.value=1.5;app.setTime(8);
    const probe=makeProbe(app);details.cpu=probe.compareCPU();probe.dispose();
    check('Independent CPU camera query agrees with GPU within the 0.35 m safety margin',details.cpu.maximumError<.12,details.cpu);
    let leastCameraGap=Infinity;
    for(const time of [0,8,16,32])for(const [x,z]of [[0,-8],[12,-4],[-7,-16],[1,5]]){
      app.camera.position.set(x,.8,z);app.controls.target.set(x,0,z-10);app.setTime(time);
      leastCameraGap=Math.min(leastCameraGap,app.camera.position.y-surfaceHeightAt(x,z,time,1.5,.45));
    }
    check('Camera remains above local crests',leastCameraGap>=.349,leastCameraGap);

    app.applyPreset('coast');app.setView('coast',true);app.setTime(8);app.render();
    const before=app.getState().caustics.updates;for(let i=0;i<5;i++)app.render();
    check('Repeated paused renders reuse caustic maps',app.getState().caustics.updates===before);
    set('clarity',.5);app.render();check('Clarity changes do not rerun geometric caustics',app.getState().caustics.updates===before);
    set('depth',1.7);app.render();check('Depth changes invalidate caustics',app.getState().caustics.updates===before+1);
    const changed=app.getState().caustics.updates;app.camera.position.x+=.01;app.render();
    check('Camera movement invalidates caustics',app.getState().caustics.updates===changed+1);
    // Commit the scripted camera edit to OrbitControls before measuring idle;
    // its first change notification is a legitimate final frame, not a leak.
    app.controls.update();app.render();
    const stillFrames=app.getState().renderCount;await wait(1200);
    check('Idle paused scene stops drawing',app.getState().renderCount===stillFrames,{before:stillFrames,after:app.getState().renderCount});
    set('clarity',.82);await until(()=>app.getState().renderCount>stillFrames);
    check('Paused controls request a new frame',app.getState().renderCount>stillFrames);
    const pausedTime=app.getState().time;await wait(150);check('Pause freezes simulation time',app.getState().time===pausedTime);
    dom.querySelector('#pause').click();await until(()=>app.getState().time>pausedTime);dom.querySelector('#pause').click();
    check('Animation resumes through the actual button',app.getState().time>pausedTime);
    dom.querySelector('#toggle-panel').click();
    check('Collapsed panel is excluded from input and accessibility',dom.querySelector('#panel').inert&&dom.querySelector('#panel').getAttribute('aria-hidden')==='true');
    dom.querySelector('#toggle-panel').click();
    child.dispatchEvent(new child.KeyboardEvent('keydown',{code:'KeyH',key:'h',bubbles:true}));
    check('Immersive mode disables invisible controls',dom.querySelector('#panel').inert&&dom.querySelector('.footer').inert);
    dom.querySelector('#toggle-panel').click();
    check('Panel button exits immersive mode',!dom.body.classList.contains('ui-hidden')&&!dom.querySelector('#panel').inert&&!dom.querySelector('.footer').inert);

    for(const [name,strength]of [['coast',.65],['breeze',1.22],['golden',.65]]){
      dom.querySelector(`[data-preset="${name}"]`).click();app.setView('coast',true);app.setTime(8);capture(name);
      check(name+' preset',app.uniforms.uWave.value===strength);
    }
    app.applyPreset('coast');app.setView('shallow',true);app.setTime(8);capture('shallow');
    const withCaustics=pixels();set('caustics',0);const noCaustics=pixels();
    check('Caustic control changes actual GPU pixels',withCaustics.some((v,i)=>v!==noCaustics[i]));set('caustics',1.1);
    for(const id of ['wave','depth','clarity','caustics','sun','speed']){
      const input=dom.getElementById(id);
      for(const value of [input.min,input.max]){set(id,value);app.render();check(id+' endpoint '+value,!app.getState().shaderError&&app.renderer.getContext().getError()===0);}
    }
    set('wave',1.5);set('depth',.45);set('sun',8);set('clarity',1);app.setTime(16);capture('extreme');
    check('Stress image contains water, not an empty framebuffer',pixels().some((v,i)=>i%4!==3&&v>10));

    status.textContent='检查缩放覆盖';app.applyPreset('coast');
    details.coverage=[];
    const cases=[['near',[0,3.15,8.8],[0,0,-2.8]],['far',[0,17,59.9],[0,0,-2.8]],['rotate',[-24,14,30],[0,0,-2.8]],['overhead',[0,64.8,4],[0,0,3.5]]];
    for(const [name,pos,target]of cases){
      app.camera.position.set(...pos);app.controls.target.set(...target);app.controls.update();app.render();
      const state=app.getState().caustics,rect=state.cascades[1].rect,ray=new THREE.Vector3();let examined=0,missed=0;
      const depth=(x,z)=>Math.max(.28,app.uniforms.uDepth.value+.17*(5-z)+.09*Math.sin(x*.42+z*.23)+.06*Math.sin(z*.61-x*.17));
      for(let row=0;row<29;row++)for(let col=0;col<43;col++){
        ray.set(-.98+col*1.96/42,-.98+row*1.5/28,.5).unproject(app.camera).sub(app.camera.position).normalize();
        if(ray.y>=0)continue;const distance=-app.camera.position.y/ray.y;if(distance>state.maximumDistance*.75)continue;
        const x=app.camera.position.x+ray.x*distance,z=app.camera.position.z+ray.z*distance;if(depth(x,z)>10)continue;
        const rx=ray.x/1.333,rz=ray.z/1.333,ry=-Math.sqrt(1-rx*rx-rz*rz);let t=depth(x,z)/-ry;
        for(let i=0;i<3;i++)t=depth(x+rx*t,z+rz*t)/-ry;
        const margin=Math.min(.5-Math.abs((x+rx*t-rect[0])/rect[2]),.5-Math.abs((z+rz*t-rect[1])/rect[3]));
        examined++;if(margin<.06)missed++;
      }
      details.coverage.push({name,examined,missed});check(name+' caustic coverage',examined>50&&missed===0);capture('zoom-'+name);await wait(0);
    }
    status.textContent='检查画质资源与手机布局';
    app.setView('coast',true);const memory=[];
    for(let cycle=0;cycle<3;cycle++)for(const quality of ['low','high','balanced']){
      app.setQuality(quality);app.setTime(8);app.setTime(8.025);
      memory.push({cycle,quality,...app.renderer.info.memory});await wait(0);
    }
    details.memory=memory;
    check('Quality cycling does not accumulate GPU textures or geometries',memory.slice(3).every(x=>{const first=memory.find(y=>y.quality===x.quality);return x.textures===first.textures&&x.geometries===first.geometries;}));
    frame.style.width='390px';frame.style.height='844px';
    await until(()=>child.innerWidth===390&&child.innerHeight===844&&app.camera.aspect===390/844);
    app.render();const bounds=dom.querySelector('#panel').getBoundingClientRect();
    check('390 px layout stays inside the viewport',dom.documentElement.scrollWidth===390&&bounds.left>=0&&bounds.right<=390);
    check('Canvas resizes with viewport',app.camera.aspect===390/844,{width:child.innerWidth,height:child.innerHeight,aspect:app.camera.aspect});capture('mobile');
    frame.style.width='1000px';frame.style.height='700px';await until(()=>child.innerWidth===1000&&app.camera.aspect===1000/700);

    status.textContent='检查显卡上下文恢复';app.applyPreset('coast');app.setView('coast',true);app.setTime(8);
    if(app.renderer.getContext().getExtension('WEBGL_lose_context')){
      app.renderer.forceContextLoss();await until(()=>app.getState().contextLost);await wait(150);
      check('Context loss is exposed and rendering stops',!app.getState().ready);
      app.renderer.forceContextRestore();await until(()=>app.getState().ready&&!app.getState().contextLost,20000);
      const restored=makeProbe(app);details.restored=restored.sample();restored.dispose();
      check('Paused context restoration rebuilds non-flat wave data',details.restored.maxHeight>.05&&details.restored.normalError<.001);
      check('Restored rendering has no GL errors',app.renderer.getContext().getError()===0&&!app.getState().shaderError);
    }else checks.push({name:'Context loss extension unavailable',passed:null});
    capture('final');check('No app runtime errors',errors.length===0,errors);
    report.textContent=JSON.stringify({passed:checks.every(c=>c.passed!==false),checks,details},null,2);status.textContent='完整检查完成';
  }catch(error){report.textContent=JSON.stringify({passed:false,checks,details,error:error.stack},null,2);status.textContent='检查中断';}
  finally{child.removeEventListener('error',eventError);child.removeEventListener('unhandledrejection',eventError);}
}
