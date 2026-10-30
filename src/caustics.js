import * as THREE from 'three';
import { causticVertex, causticFragment } from './shaders.js';

// Camera-fitted caustic cascades. Rectangles move in WORLD space: changing the
// camera changes the sampled area, never the wavelengths or phase of the light.
function rayGrid(segments) {
  const geometry=new THREE.PlaneGeometry(1,1,segments,segments);
  const positions=geometry.attributes.position;
  for(let row=1;row<segments;row++)for(let column=1;column<segments;column++){
    const index=row*(segments+1)+column;
    const jitter=Math.sin(row*127.1+column*311.7)*43758.5453;
    positions.setX(index,positions.getX(index)+((row%2)*0.44+(jitter-Math.floor(jitter)-0.5)*0.18)/segments);
  }
  return geometry;
}

export function createAdaptiveCaustics(renderer,camera,uniforms) {
  const scene=new THREE.Scene(),lightCamera=new THREE.Camera();
  const material=new THREE.ShaderMaterial({
    vertexShader:causticVertex,fragmentShader:causticFragment,
    uniforms:{...uniforms,uCausticTargetRect:{value:new THREE.Vector4()},uCausticSourceRect:{value:new THREE.Vector4()},uCausticFootprint:{value:0.065},uCausticSmoothFlux:{value:0.25}},
    side:THREE.DoubleSide,depthTest:false,depthWrite:false,transparent:true,
    blending:THREE.AdditiveBlending,toneMapped:false
  });
  const mesh=new THREE.Mesh(undefined,material);mesh.frustumCulled=false;scene.add(mesh);
  const cascades=[{name:'near',rect:new THREE.Vector4(0,0,32,32)},{name:'far',rect:new THREE.Vector4(0,0,128,128)}];
  uniforms.uCausticNearRect={value:cascades[0].rect};
  uniforms.uCausticFarRect={value:cascades[1].rect};
  uniforms.uCausticFarMap={value:null};
  const ray=new THREE.Vector3(),screenSize=new THREE.Vector2();
  let maximumDistance=200;

  function depth(x,z){return Math.max(0.28,uniforms.uDepth.value+0.17*(5-z)+0.09*Math.sin(x*.42+z*.23)+0.06*Math.sin(z*.61-x*.17));}

  function fit(cascade,index) {
    let minX=Infinity,minZ=Infinity,maxX=-Infinity,maxZ=-Infinity;
    // For a downward view, preserve detail across the entire viewport. With a
    // visible horizon, reserve the fine cascade for the foreground seabed.
    ray.set(0,1,0.5).unproject(camera).sub(camera.position).normalize();
    const top=index===0&&ray.y>-.08?0.2:1.08;
    const reach=index===0?Math.max(30,camera.position.y*2.6):maximumDistance;
    for(let row=0;row<=12;row++)for(let column=0;column<=12;column++){
      ray.set(-1.08+column*2.16/12,-1.08+row*(top+1.08)/12,0.5).unproject(camera).sub(camera.position).normalize();
      if(ray.y>=-0.0001)continue;
      const distance=Math.min(-camera.position.y/ray.y,reach);
      const x=camera.position.x+ray.x*distance,z=camera.position.z+ray.z*distance;
      minX=Math.min(minX,x);maxX=Math.max(maxX,x);minZ=Math.min(minZ,z);maxZ=Math.max(maxZ,z);
    }
    if(!Number.isFinite(minX)){
      minX=camera.position.x-16;maxX=camera.position.x+16;
      minZ=camera.position.z-16;maxZ=camera.position.z+16;
    }
    const minimum=index===0?24:96,margin=index===0?8:20;
    // Breathing room includes refraction from the view ray and a wide blend zone.
    const width=Math.max(minimum,(maxX-minX)*1.28+margin);
    const height=Math.max(minimum,(maxZ-minZ)*1.28+margin);
    const texelX=width/cascade.resolution,texelZ=height/cascade.resolution;
    const cx=Math.round((minX+maxX)*0.5/texelX)*texelX;
    const cz=Math.round((minZ+maxZ)*0.5/texelZ)*texelZ;
    cascade.rect.set(cx,cz,width,height);

    const centerDepth=depth(cx,cz);
    const sun=uniforms.uSun.value;
    const underwaterY=Math.sqrt(1-(1-sun.y*sun.y)/(1.333*1.333));
    const offsetX=-sun.x/1.333/underwaterY*centerDepth;
    const offsetZ=-sun.z/1.333/underwaterY*centerDepth;
    const largestDepth=Math.max(depth(cx-width/2,cz-height/2),depth(cx+width/2,cz-height/2),centerDepth);
    // The source grid extends beyond the displayed rectangle. Otherwise oblique
    // sunlight leaves a dark rim even when the output texture covers the camera.
    const padding=4+Math.min(24,largestDepth)*1.2;
    cascade.source.set(cx-offsetX,cz-offsetZ,width+padding*2,height+padding*2);
    cascade.footprint=Math.max(0.045,Math.max(cascade.source.z,cascade.source.w)/cascade.segments*1.15);
  }

  return {
    setQuality(q){
      for(let i=0;i<cascades.length;i++){
        const cascade=cascades[i];
        cascade.target?.dispose();cascade.geometry?.dispose();
        cascade.resolution=i===0?q.map:Math.max(768,Math.round(q.map*2/3));
        cascade.segments=i===0?q.grid:Math.round(q.grid*.60);
        cascade.source=new THREE.Vector4();
        cascade.geometry=rayGrid(cascade.segments);
        cascade.target=new THREE.WebGLRenderTarget(cascade.resolution,cascade.resolution,{
          type:THREE.HalfFloatType,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,
          depthBuffer:false,generateMipmaps:true
        });
      }
      uniforms.uCausticMap.value=cascades[0].target.texture;
      uniforms.uCausticFarMap.value=cascades[1].target.texture;
    },
    render(){
      camera.updateMatrixWorld();
      renderer.getDrawingBufferSize(screenSize);
      maximumDistance=Math.max(120,Math.min(360,screenSize.y*.24/(2*Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()/2)))));
      for(let i=0;i<cascades.length;i++){
        const cascade=cascades[i];fit(cascade,i);
        material.uniforms.uCausticTargetRect.value.copy(cascade.rect);
        material.uniforms.uCausticSourceRect.value.copy(cascade.source);
        material.uniforms.uCausticFootprint.value=cascade.footprint;
        // Distant light already has mip filtering; reserve the four extra
        // differential ray traces for the fine foreground cascade.
        material.uniforms.uCausticSmoothFlux.value=i===0?0.25:0;
        mesh.geometry=cascade.geometry;
        renderer.setRenderTarget(cascade.target);
        renderer.setClearColor(0x000000,0);renderer.clear();
        renderer.render(scene,lightCamera);
      }
    },
    getState(){return {maximumDistance,cascades:cascades.map(c=>({name:c.name,rect:c.rect.toArray(),source:c.source.toArray(),footprint:c.footprint,resolution:c.resolution}))};},
    dispose(){for(const c of cascades){c.geometry.dispose();c.target.dispose();}material.dispose();}
  };
}
