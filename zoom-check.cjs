const {chromium,launchOptions}=require('./test-browser.cjs');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch(launchOptions);
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const errors=[],results=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.goto('http://127.0.0.1:4173');await page.waitForFunction(()=>window.oceanDemo?.getState().ready);
  await page.evaluate(()=>{oceanDemo.pause();oceanDemo.setTime(8);document.body.classList.add('ui-hidden');});
  await page.waitForTimeout(500);
  const cases=[
   {name:'near',position:[0,3.15,8.8],target:[0,0,-2.8]},
   {name:'zoom-out',position:[0,9.45,32],target:[0,0,-2.8]},
   {name:'maximum-zoom-out',position:[0,17,59.9],target:[0,0,-2.8]},
   {name:'shore-rotation',position:[-24,14,30],target:[0,0,-2.8]},
   {name:'overhead-max',position:[0,64.8,4],target:[0,0,3.5]},
   {name:'ultrawide',position:[0,10,31],target:[0,0,-2.8],viewport:{width:2100,height:800}},
   {name:'portrait',position:[0,10,31],target:[0,0,-2.8],viewport:{width:480,height:900}}
  ];
  for(const test of cases){
   await page.setViewportSize(test.viewport||{width:1440,height:900});
   await page.evaluate(test=>{
    oceanDemo.controls.enableDamping=false;
    oceanDemo.camera.position.set(...test.position);oceanDemo.controls.target.set(...test.target);oceanDemo.controls.update();oceanDemo.render();
   },test);
   await page.waitForTimeout(180);
   const coverage=await page.evaluate(async()=>{
    const {Vector3}=await import('/vendor/three.module.js');
    const state=oceanDemo.getState().caustics;
    const camera=oceanDemo.camera,rect=state.cascades[1].rect;
    let examined=0,missed=0,minimumMargin=1;const ray=new Vector3();
    // Independent dense screen-ray check. Include underwater travel to the
    // sloping floor, rather than checking only the fitting grid's own samples.
    const depth=(x,z)=>Math.max(.28,oceanDemo.uniforms.uDepth.value+.17*(5-z)+.09*Math.sin(x*.42+z*.23)+.06*Math.sin(z*.61-x*.17));
    for(let row=0;row<29;row++)for(let col=0;col<43;col++){
     ray.set(-.98+col*1.96/42,-.98+row*1.5/28,.5).unproject(camera).sub(camera.position).normalize();
     if(ray.y>=0)continue;
     const distance=-camera.position.y/ray.y;
     if(distance>state.maximumDistance*.75)continue;
     const x=camera.position.x+ray.x*distance,z=camera.position.z+ray.z*distance;
     if(depth(x,z)>10)continue;
     const rx=ray.x/1.333,rz=ray.z/1.333,ry=-Math.sqrt(1-rx*rx-rz*rz);
     let travel=depth(x,z)/-ry;
     for(let i=0;i<3;i++)travel=depth(x+rx*travel,z+rz*travel)/-ry;
     const bx=x+rx*travel,bz=z+rz*travel;
     const margin=Math.min(.5-Math.abs((bx-rect[0])/rect[2]),.5-Math.abs((bz-rect[1])/rect[3]));
     examined++;minimumMargin=Math.min(minimumMargin,margin);if(margin<.06)missed++;
    }
    return {...state,examined,missed,minimumMargin};
   });
   assert.ok(coverage.examined>50,test.name+' no visible shallow points tested');
   assert.equal(coverage.missed,0,test.name+' misses visible shallow seabed');
   await page.screenshot({path:`output/caustics-${test.name}.png`});
   results.push({name:test.name,...coverage});
  }
  const nearArea=r=>r.cascades[0].rect[2]*r.cascades[0].rect[3];
  assert.ok(nearArea(results[2])>nearArea(results[0]),'near cascade expands when zoomed out');
  assert.ok(Math.abs(results[3].cascades[0].rect[0])>5,'cascade follows orbit away from origin');
  assert.deepEqual(errors,[]);
  const report={passed:true,errors,cases:results};fs.writeFileSync('output/zoom-verification.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,errors,cases:results.map(r=>({name:r.name,examined:r.examined,missed:r.missed,nearRect:r.cascades[0].rect,farRect:r.cascades[1].rect}))},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
