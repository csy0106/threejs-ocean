// Shared wave field: surface shading and the refracted-sun light map use the
// same time, wavelengths and gradients, keeping caustics attached to the waves.
export const common = /* glsl */`
uniform float uTime;
uniform float uWave;
uniform float uDepth;
uniform float uClarity;
uniform float uCaustics;
uniform float uFoam;
uniform float uWarmth;
uniform vec3 uSun;
uniform sampler2D uSwellMap;
uniform sampler2D uRippleMap;
uniform sampler2D uDisplacementMap;
uniform sampler2D uJacobianMap;
const float PI = 3.14159265359;
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i),hash21(i+vec2(1,0)),f.x),mix(hash21(i+vec2(0,1)),hash21(i+1.0),f.x),f.y);
}
float simplexNoise(vec2 p){
  const float F=0.36602540378,G=0.21132486540;
  vec2 cell=floor(p+(p.x+p.y)*F);
  vec2 a=p-cell+(cell.x+cell.y)*G;
  vec2 stepCorner=a.x>a.y?vec2(1,0):vec2(0,1);
  vec2 b=a-stepCorner+G,c=a-1.0+2.0*G;
  vec3 angle=vec3(hash21(cell),hash21(cell+stepCorner),hash21(cell+1.0))*2.0*PI;
  vec3 support=max(vec3(0.5-dot(a,a),0.5-dot(b,b),0.5-dot(c,c)),0.0);
  vec3 projection=vec3(dot(vec2(cos(angle.x),sin(angle.x)),a),dot(vec2(cos(angle.y),sin(angle.y)),b),dot(vec2(cos(angle.z),sin(angle.z)),c));
  support*=support;
  return clamp(0.5+35.0*dot(support*support,projection),0.0,1.0);
}
float fbm(vec2 p) {
  float n = 0.0, a = 0.5;
  mat2 m = mat2(1.63,1.17,-1.17,1.63);
  for(int i=0;i<4;i++){n+=noise(p)*a;p=m*p+3.7;a*=0.5;}
  return n;
}
vec4 waves(vec2 p, float footprint) {
  float swellLod=max(0.0,log2(max(footprint,0.0001)*512.0/64.0));
  float rippleLod=max(0.0,log2(max(footprint,0.0001)*512.0/11.7));
  vec4 swell=textureLod(uSwellMap,p/64.0+0.5,swellLod);
  vec4 ripple=textureLod(uRippleMap,p/11.7+0.5,rippleLod);
  vec4 capillary=textureLod(uRippleMap,p*2.73/11.7+vec2(0.21,0.63),rippleLod+1.45);
  return swell*uWave+(ripple+capillary*vec4(0.30/2.73,0.30,0.30,0.30))*sqrt(uWave)*0.85;
}
void surfaceGeometry(vec2 p,float footprint,out vec3 surface,out vec3 normal,out float compression,out float crest){
  vec4 w=waves(p,footprint);
  float lod=max(0.0,log2(max(footprint,0.0001)*512.0/64.0));
  vec4 displacement=textureLod(uDisplacementMap,p/64.0+0.5,lod);
  vec2 derivativeZ=textureLod(uJacobianMap,p/64.0+0.5,lod).xy;
  // Saturate steepness before intersecting crests. Strength still increases
  // height, while horizontal compression stays below the practical fold limit.
  float choppiness=0.85*uWave/(1.0+0.6*uWave);
  float jxx=1.0+choppiness*displacement.z;
  float jxz=choppiness*displacement.w;
  float jzx=choppiness*derivativeZ.x;
  float jzz=1.0+choppiness*derivativeZ.y;
  float determinant=jxx*jzz-jxz*jzx;
  surface=vec3(p.x+choppiness*displacement.x,w.x,p.y+choppiness*displacement.y);
  // Cross product of the two displaced surface tangents, not a height-field
  // normal: horizontal compression changes the visible slope at the crest.
  normal=normalize(vec3(jzx*w.z-jzz*w.y,max(determinant,0.06),jxz*w.y-jxx*w.z));
  compression=clamp(1.0-determinant,0.0,1.0);
  crest=w.w;
}
float bedDepth(vec2 p) {
  float slope = 0.17*(5.0-p.y);
  float dune = 0.09*sin(p.x*0.42+p.y*0.23)+0.06*sin(p.y*0.61-p.x*0.17);
  return max(0.28,uDepth+slope+dune);
}
vec3 bottomHit(vec3 origin, vec3 ray) {
  float t = (bedDepth(origin.xz)+origin.y)/max(0.1,-ray.y);
  for(int i=0;i<3;i++){
    vec3 p=origin+ray*t;
    t=(bedDepth(p.xz)+origin.y)/max(0.1,-ray.y);
  }
  return origin+ray*max(t,0.0);
}
vec3 skyColor(vec3 r, bool disk) {
  float up = max(r.y,0.0);
  vec3 horizon = mix(vec3(0.42,0.64,0.87),vec3(0.85,0.64,0.43),uWarmth);
  vec3 zenith = mix(vec3(0.045,0.20,0.49),vec3(0.28,0.41,0.58),uWarmth);
  vec3 col = mix(horizon,zenith,pow(up,0.48));
  float sd=max(dot(r,uSun),0.0);
  vec3 sunlight=mix(vec3(1.0,0.91,0.72),vec3(1.0,0.56,0.22),uWarmth);
  col+=sunlight*pow(sd,10.0)*0.11;
  col+=sunlight*pow(sd,90.0)*0.23;
  if(disk) col+=sunlight*smoothstep(0.99965,0.99988,sd)*5.0;
  // Broad, faint high-altitude haze. Reflections sample the same sky.
  vec2 cp=r.xz/max(r.y+0.14,0.06)*1.7+vec2(uTime*0.002,0);
  float cloud=smoothstep(0.52,0.81,fbm(cp*1.3))*smoothstep(0.03,0.25,up);
  col=mix(col,mix(vec3(0.89,0.94,0.96),vec3(0.94,0.79,0.63),uWarmth),cloud*0.32);
  return col;
}
`;

export const waterVertex = /* glsl */`
${common}
varying vec3 vWorld;
varying vec2 vParam;
void main() {
  vec3 p=position;
  p.xz+=floor(cameraPosition.xz/2.0)*2.0;
  float distanceToCamera=length(p.xz-cameraPosition.xz);
  vParam=p.xz;
  vec3 surface,normal;float compression,crest;
  float cellWidth=(max(abs(position.x),abs(position.z))+2.8)*15.0/512.0;
  surfaceGeometry(p.xz,cellWidth*1.8,surface,normal,compression,crest);
  p=mix(p,surface,1.0-smoothstep(120.0,1400.0,distanceToCamera));
  vWorld=p;
  gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
}
`;

export const waterFragment = /* glsl */`
${common}
uniform sampler2D uCausticMap;
uniform sampler2D uCausticFarMap;
uniform sampler2D uFoamMap;
uniform vec4 uCausticNearRect;
uniform vec4 uCausticFarRect;
varying vec3 vWorld;
varying vec2 vParam;
vec3 sand(vec2 p,float footprint) {
  float broad=fbm(p*0.32);
  float fine=noise(p*18.0);
  float grain=hash21(floor(p*270.0));
  float warp=noise(p*0.85)*1.8+noise(p*2.6)*0.3;
  float ripple=sin(p.y*26.0+p.x*4.0+warp*5.0);
  ripple*=1.0-smoothstep(0.01,0.2,footprint);
  vec3 col=mix(vec3(0.37,0.32,0.22),vec3(0.68,0.61,0.44),broad);
  col*=0.77+fine*0.28+grain*0.24+ripple*0.1;
  float flecks=smoothstep(0.88,0.99,noise(p*54.0));
  col=mix(col,vec3(0.24,0.26,0.22),flecks*0.34);
  return col;
}
void main() {
  vec3 viewDir=normalize(cameraPosition-vWorld);
  float distanceToCamera=length(cameraPosition-vWorld);
  float footprint=max(length(dFdx(vParam)),length(dFdy(vParam)));
  vec3 surface,n;float compression,crest;
  surfaceGeometry(vParam,footprint,surface,n,compression,crest);
  float NoV=max(dot(n,viewDir),0.001);
  float fresnel=0.02037+(1.0-0.02037)*pow(1.0-NoV,5.0);
  vec3 reflection=skyColor(reflect(-viewDir,n),false)*vec3(0.34,0.48,0.66);
  vec3 refractionDir=refract(-viewDir,n,1.0/1.333);
  vec3 bed=bottomHit(vWorld,refractionDir);
  float travel=length(bed-vWorld);
  vec3 absorption=mix(vec3(0.65,0.31,0.19),vec3(0.27,0.12,0.065),uClarity);
  vec3 transmission=exp(-absorption*travel);
  vec3 waterColor=mix(vec3(0.004,0.045,0.065),vec3(0.0035,0.072,0.115),uClarity);
  vec2 nearUV=(bed.xz-uCausticNearRect.xy)/uCausticNearRect.zw+0.5;
  vec2 farUV=(bed.xz-uCausticFarRect.xy)/uCausticFarRect.zw+0.5;
  vec2 nearInset=min(nearUV,1.0-nearUV),farInset=min(farUV,1.0-farUV);
  float nearWeight=smoothstep(0.04,0.20,min(nearInset.x,nearInset.y));
  float farWeight=smoothstep(0.0,0.06,min(farInset.x,farInset.y));
  float nearLight=texture2D(uCausticMap,clamp(nearUV,0.001,0.999)).r*4.0;
  float farLight=texture2D(uCausticFarMap,clamp(farUV,0.001,0.999)).r*4.0;
  float c=mix(mix(1.0,farLight,farWeight),nearLight,nearWeight);
  // At extreme grazing distances the caustic pattern is smaller than a pixel;
  // fade its contrast by screen footprint, not by a fixed square world border.
  float bedFootprint=max(length(dFdx(bed.xz)),length(dFdy(bed.xz)));
  c=mix(c,1.0,smoothstep(0.28,0.8,bedFootprint))*exp(-bedDepth(bed.xz)*0.10);
  vec3 sunTint=mix(vec3(1.0,0.96,0.83),vec3(1.0,0.66,0.34),uWarmth);
  float focused=min(max(c-0.7,0.0),4.0)*exp(-max(bedDepth(bed.xz)-1.0,0.0)*0.13);
  vec3 bottom=sand(bed.xz,footprint)*(0.44+focused*uCaustics*0.48)*sunTint;
  vec3 refracted=bottom*transmission+waterColor*(1.0-transmission);
  vec3 color=mix(refracted,reflection,fresnel);
  // Sun glints use an energy-bounded GGX distribution, with distance roughening.
  vec3 halfway=normalize(viewDir+uSun);
  float NoH=max(dot(n,halfway),0.0);
  float NoL=max(dot(n,uSun),0.0);
  float normalVariance=dot(dFdx(n),dFdx(n))+dot(dFdy(n),dFdy(n));
  // A narrow sun lobe produces discrete glints; pixel-footprint variance widens
  // unresolved highlights instead of letting them flicker as single pixels.
  float a2=0.00008+min(normalVariance*0.025,0.00055);
  float denom=NoH*NoH*(a2-1.0)+1.0;
  float D=a2/(PI*denom*denom);
  float specF=0.02037+0.97963*pow(1.0-max(dot(viewDir,halfway),0.0),5.0);
  float Gv=2.0*NoV/(NoV+sqrt(a2+(1.0-a2)*NoV*NoV));
  float Gl=2.0*NoL/max(NoL+sqrt(a2+(1.0-a2)*NoL*NoL),0.0001);
  float spec=min(70.0,D*specF*Gv*Gl/max(4.0*NoV,0.02));
  color+=sunTint*spec*2.5;
  vec2 history=texture2D(uFoamMap,vParam/64.0+0.5).rg;
  vec2 foamFlow=vParam-vec2(0.035,0.075)*uTime;
  vec2 wind=normalize(vec2(0.38,0.92)),across=vec2(wind.y,-wind.x);
  // Soft, stretched filaments modulate density; no thresholded white dots.
  vec2 strands=vec2(dot(foamFlow,across)*4.0,dot(foamFlow,wind)*15.0);
  float lace=simplexNoise(strands)*0.65+simplexNoise(foamFlow*31.0)*0.35;
  lace=mix(lace,0.5,smoothstep(0.01,0.09,footprint));
  float detail=mix(0.12,1.55,smoothstep(0.26,0.74,lace));
  float density=(max(history.r-0.012,0.0)+history.g*0.25)*detail;
  float foam=(1.0-exp(-density*1.4))*uFoam*(1.0-smoothstep(35.0,140.0,distanceToCamera));
  vec3 foamNormal=normalize(mix(vec3(0,1,0),n,0.45));
  vec3 foamLight=vec3(0.60,0.65,0.63)*(0.34+0.66*max(dot(foamNormal,uSun),0.0))*mix(vec3(1.0),sunTint,0.6);
  float freshness=history.r/max(history.r+history.g,0.001);
  vec3 foamColor=mix(mix(refracted,foamLight,0.55),foamLight,freshness);
  color=mix(color,foamColor,foam);
  float haze=1.0-exp(-distanceToCamera*0.0003);
  color=mix(color,skyColor(normalize(vec3(-viewDir.x,0.012,-viewDir.z)),false),haze);
  gl_FragColor=vec4(color,1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const skyVertex = /* glsl */`
varying vec3 vDirection;
void main(){vDirection=position;vec4 p=projectionMatrix*mat4(mat3(viewMatrix))*vec4(position,1.0);gl_Position=p.xyww;}
`;
export const skyFragment = /* glsl */`
${common}
varying vec3 vDirection;
void main(){gl_FragColor=vec4(skyColor(normalize(vDirection),true),1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Refract sunlight through the wave normals, project onto the sloping seabed,
// and rasterize the irradiance. The area ratio is a Jacobian of that mapping;
// folds add their energy in the light-map pass rather than being painted on.
export const causticVertex = /* glsl */`
${common}
uniform vec4 uCausticTargetRect;
uniform vec4 uCausticSourceRect;
uniform float uCausticFootprint;
uniform float uCausticSmoothFlux;
varying float vFlux;
varying vec2 vSource;
varying vec2 vHit;
vec3 photonHit(vec2 xz){
  // Match the ray grid's sampling bandwidth so sub-grid ripples do not alias.
  vec3 p,n;float compression,crest;
  surfaceGeometry(xz,uCausticFootprint,p,n,compression,crest);
  vec3 ray=refract(-uSun,n,1.0/1.333);
  return bottomHit(p,ray);
}
void main(){
  vec2 xz=uCausticSourceRect.xy+position.xy*uCausticSourceRect.zw;
  vec3 surface,n;float compression,crest;
  surfaceGeometry(xz,uCausticFootprint,surface,n,compression,crest);
  vec3 hit=bottomHit(surface,refract(-uSun,n,1.0/1.333));
  vSource=surface.xz;
  vHit=hit.xz;
  // A continuous, vertex-sampled Jacobian replaces a constant irradiance per
  // rasterized triangle, which previously exposed rectangular mesh cells.
  vFlux=1.0;
  if(uCausticSmoothFlux>0.0){
    float epsilon=max(0.016,uCausticFootprint*0.42);
    vec2 dx=(photonHit(xz+vec2(epsilon,0)).xz-photonHit(xz-vec2(epsilon,0)).xz)/(2.0*epsilon);
    vec2 dz=(photonHit(xz+vec2(0,epsilon)).xz-photonHit(xz-vec2(0,epsilon)).xz)/(2.0*epsilon);
    float determinant=abs(dx.x*dz.y-dx.y*dz.x);
    vFlux=min((1.0-compression)/max(determinant,0.10),10.0);
  }
  gl_Position=vec4((hit.xz-uCausticTargetRect.xy)/uCausticTargetRect.zw*2.0,0.0,1.0);
}
`;
export const causticFragment = /* glsl */`
uniform float uCausticSmoothFlux;
varying float vFlux;
varying vec2 vSource;
varying vec2 vHit;
float projectedArea(vec2 a,vec2 b){return abs(a.x*b.y-a.y*b.x);}
void main(){
  float sourceArea=projectedArea(dFdx(vSource),dFdy(vSource));
  float hitArea=projectedArea(dFdx(vHit),dFdy(vHit));
  float conservedFlux=min(sourceArea/max(hitArea,0.0000001),12.0);
  gl_FragColor=vec4(vec3(mix(conservedFlux,vFlux,uCausticSmoothFlux)*0.25),1.0);
}
`;
