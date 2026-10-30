import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const projectRoot=path.dirname(fileURLToPath(import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
const privatePath=relative=>relative.split(/[\\/]/).some(part=>part.startsWith('.')||part.toLowerCase()==='node_modules'||part.includes(':'));
const outside=relative=>relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative);

export function createStaticServer(root=projectRoot){
  const canonicalRoot=realpath(root);
  return http.createServer(async(req,res)=>{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'}).end();return;}
    let pathname;
    try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}
    catch{res.writeHead(400).end('Invalid URL');return;}
    if(pathname.includes('\0')||privatePath(pathname)){res.writeHead(403).end('Forbidden');return;}
    try{
      const base=await canonicalRoot;
      const requested=path.resolve(base,'.'+(pathname==='/'?'/index.html':pathname));
      if(outside(path.relative(base,requested))){res.writeHead(403).end('Forbidden');return;}
      // Resolve links as well as '..': a link inside the project must not expose
      // another directory or hidden files outside the intended static root.
      const file=await realpath(requested),relative=path.relative(base,file);
      if(outside(relative)||privatePath(relative)){res.writeHead(403).end('Forbidden');return;}
      const data=await readFile(file);
      res.writeHead(200,{'Content-Type':types[path.extname(file).toLowerCase()]||'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:data);
    }catch(error){res.writeHead(error.code==='EACCES'?403:404).end('Not found');}
  });
}

if(process.argv[1]&&path.resolve(process.argv[1]).toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()){
  const port=Number(process.env.PORT||4173),server=createStaticServer();
  server.listen(port,'127.0.0.1',()=>console.log(`PELAGIC is running at http://127.0.0.1:${port}`));
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
}
