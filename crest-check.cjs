const {chromium,launchOptions}=require('./test-browser.cjs');
const fs=require('node:fs');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch(launchOptions);
 try{
  const page=await browser.newPage({viewport:{width:1600,height:1000},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  await page.goto('http://127.0.0.1:4173');
  await page.waitForFunction(()=>window.oceanDemo?.getState().ready);
  await page.waitForTimeout(1200);
  await page.evaluate(()=>{oceanDemo.pause();document.body.classList.add('ui-hidden');});
  await page.waitForTimeout(450);
  const set=async values=>page.evaluate(values=>{for(const [id,v]of Object.entries(values)){const el=document.getElementById(id);el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));}},values);
  await set({wave:1.5,depth:1.75,clarity:.85});
  for(const t of [8,8.6,16]){
   await page.evaluate(t=>oceanDemo.setTime(t),t);
   await page.waitForTimeout(150);
   await page.screenshot({path:`output/crests-shallow-${t}.png`});
  }
  await set({depth:4,caustics:0});
  await page.evaluate(()=>oceanDemo.setTime(8));
  await page.screenshot({path:'output/crests-deep.png'});
  await set({wave:.65});
  await page.screenshot({path:'output/crests-calm.png'});
  await page.evaluate(()=>{oceanDemo.setView('shallow',true);});
  await set({wave:1.5,depth:1.75,caustics:1.1});
  await page.screenshot({path:'output/crests-close.png'});
  await page.evaluate(()=>{document.body.classList.remove('ui-hidden');oceanDemo.setView('coast',true);});
  await page.click('#pause');
  const intervals=await page.evaluate(()=>new Promise(resolve=>{
    let previous=performance.now();const data=[];function frame(now){data.push(now-previous);previous=now;if(data.length>=90)resolve(data);else requestAnimationFrame(frame);}requestAnimationFrame(frame);
  }));
  assert.deepEqual(errors,[]);
  const report={passed:true,errors,simulationChecks:['calm and maximum strength','shallow and deep water','three animation times','active motion without shader errors'],frameTimeMs:Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length*10)/10};
  fs.writeFileSync('output/crest-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
