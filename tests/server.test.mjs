import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createStaticServer} from '../server.mjs';

test('static server serves assets but excludes private paths and traversal',async()=>{
  const output=path.resolve('output');await mkdir(output,{recursive:true});
  const root=await mkdtemp(path.join(output,'server-test-'));
  await mkdir(path.join(root,'.git'));await writeFile(path.join(root,'.git','config'),'test fixture, not credentials');
  await writeFile(path.join(root,'.env'),'TEST_FIXTURE=1');await writeFile(path.join(root,'index.html'),'<h1>test ocean</h1>');
  const server=createStaticServer(root);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(url,method='GET')=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:url,method},res=>{
      let body='';res.setEncoding('utf8');res.on('data',data=>body+=data);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end();
  });
  try{
    const index=await request('/');assert.equal(index.status,200);assert.match(index.headers['content-type'],/text\/html/);
    const head=await request('/','HEAD');assert.equal(head.status,200);assert.equal(head.body,'');
    for(const url of ['/.git/config','/.env','/%2egit/config','/..%5c..%5cREADME.md','/index.html%3Asecret'])assert.equal((await request(url)).status,403,url);
    assert.equal((await request('/%ZZ')).status,400);
    assert.equal((await request('/missing.js')).status,404);
    assert.equal((await request('/','POST')).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
