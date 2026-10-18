'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const inflateRaw = promisify(zlib.inflateRaw);

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STORAGE = process.env.STORAGE_DIR || (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'storage'));
const APPS_DIR = path.join(STORAGE, 'apps');
const DB = path.join(STORAGE, 'apps.json');
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update(`${PASSWORD}|${process.env.SESSION_SECRET || 'app-store-session-v1'}`).digest();
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD = 65 * 1024 * 1024;
const MAX_ICON = 3 * 1024 * 1024;
const MAX_EXTRACT = 130 * 1024 * 1024;
const MAX_FILES = 500;
const JSON_LIMIT = 16 * 1024;
const MIME = {
  '.html':'text/html; charset=utf-8', '.htm':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif',
  '.svg':'image/svg+xml', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.mp4':'video/mp4', '.webm':'video/webm',
  '.wasm':'application/wasm', '.txt':'text/plain; charset=utf-8', '.xml':'application/xml',
  '.bin':'application/octet-stream', '.data':'application/octet-stream', '.apk':'application/vnd.android.package-archive', '.webmanifest':'application/manifest+json'
};

async function prepare() {
  await fsp.mkdir(APPS_DIR, {recursive:true});
  try { await fsp.access(DB); } catch { await fsp.writeFile(DB, '[]'); }
}
function respond(res, status, data, headers={}) {
  const body=Buffer.from(JSON.stringify(data));
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});
  res.end(body);
}
function err(res, status, message){ respond(res,status,{error:message}); }
function cookie(req,name) {const match=(req.headers.cookie||'').match(new RegExp('(?:^|;\\s*)'+name+'=([^;]*)'));return match?match[1]:'';}
function signedToken() {const expiry=String(Date.now()+7*24*3600*1000);return `${expiry}.${crypto.createHmac('sha256',SECRET).update(expiry).digest('hex')}`;}
function validToken(token){
  if(!PASSWORD || !/^\d+\.[a-f0-9]{64}$/.test(token))return false;
  const [expiry,mac]=token.split('.');
  if(Number(expiry)<Date.now())return false;
  const expected=crypto.createHmac('sha256',SECRET).update(expiry).digest();
  return crypto.timingSafeEqual(Buffer.from(mac,'hex'),expected);
}
function admin(req){ return validToken(cookie(req,'apphub_session')); }
function isSecure(req){ return req.socket.encrypted || req.headers['x-forwarded-proto']==='https'; }
async function readJSON(req){
  let text='';
  for await(const chunk of req) {text+=chunk.toString('utf8');if(Buffer.byteLength(text)>JSON_LIMIT)throw new Error('요청이 너무 큽니다.');}
  try{return JSON.parse(text);}catch{throw new Error('올바르지 않은 요청입니다.');}
}
async function readDB(){try{const data=JSON.parse(await fsp.readFile(DB,'utf8'));return Array.isArray(data)?data:[];}catch{return [];}}
async function writeDB(apps){const tmp=`${DB}.${process.pid}.${crypto.randomUUID()}.tmp`;await fsp.writeFile(tmp,JSON.stringify(apps,null,2));await fsp.rename(tmp,DB);}
let lock=Promise.resolve();
function mutate(fn){const next=lock.then(async()=>{const arr=await readDB();const value=await fn(arr);await writeDB(arr);return value;});lock=next.catch(()=>{});return next;}
function safeSegment(s){return /^[a-f0-9-]{36}$/.test(s);}
function isAllowedFile(filename) { const ext=path.extname(filename).toLowerCase();return ['.html','.zip','.apk'].includes(ext)?ext:null; }
function safeRel(entry){
  const p=entry.replaceAll('\\','/');
  if(!p || p.startsWith('/') || p.includes('\0') || /^[a-zA-Z]:/.test(p))return null;
  const bits=p.split('/');
  if(bits.some(x=>x==='..'||x==='.' || !x && p!=='' && !p.endsWith('/')))return null;
  return bits.filter(Boolean).join('/');
}
async function unzip(zipFile,dest){
  const buf=await fsp.readFile(zipFile);
  const eocdSignature=0x06054b50;
  let eocd=-1;
  for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--){
    if(buf.readUInt32LE(i)===eocdSignature && i+22+buf.readUInt16LE(i+20)===buf.length){eocd=i;break;}
  }
  if(eocd<0)throw new Error('올바른 ZIP 파일이 아닙니다.');
  const count=buf.readUInt16LE(eocd+10);
  const centralSize=buf.readUInt32LE(eocd+12);
  const centralOffset=buf.readUInt32LE(eocd+16);
  if(count>MAX_FILES || count===65535 || centralSize===0xffffffff || centralOffset===0xffffffff)throw new Error('ZIP의 파일 수가 너무 많거나 ZIP64 방식입니다.');
  if(buf.readUInt16LE(eocd+8)!==count || buf.readUInt16LE(eocd+4)!==0 || buf.readUInt16LE(eocd+6)!==0)throw new Error('분할 ZIP은 지원하지 않습니다.');
  if(centralOffset+centralSize>eocd)throw new Error('ZIP 데이터가 손상되었습니다.');
  let off=centralOffset,total=0;
  for(let i=0;i<count;i++){
    if(off+46>buf.length || buf.readUInt32LE(off)!==0x02014b50)throw new Error('ZIP 파일 목록이 잘못되었습니다.');
    const flags=buf.readUInt16LE(off+8);
    const method=buf.readUInt16LE(off+10);
    const packed=buf.readUInt32LE(off+20);
    const unpacked=buf.readUInt32LE(off+24);
    const nameLen=buf.readUInt16LE(off+28);
    const extraLen=buf.readUInt16LE(off+30);
    const commentLen=buf.readUInt16LE(off+32);
    const attrs=buf.readUInt32LE(off+38);
    const localOff=buf.readUInt32LE(off+42);
    if(off+46+nameLen+extraLen+commentLen>buf.length)throw new Error('ZIP 파일 목록이 손상되었습니다.');
    const filename=buf.toString('utf8',off+46,off+46+nameLen);
    off+=46+nameLen+extraLen+commentLen;
    const rel=safeRel(filename);
    if(!rel)throw new Error('ZIP에 안전하지 않은 경로가 있습니다.');
    if(flags&1 || (method!==0&&method!==8))throw new Error('암호화되거나 지원하지 않는 ZIP 방식입니다.');
    if(((attrs>>>16)&0o170000)===0o120000)throw new Error('심볼릭 링크는 지원하지 않습니다.');
    const target=path.join(dest,rel);
    if(!target.startsWith(dest+path.sep))throw new Error('ZIP 경로가 잘못되었습니다.');
    if(filename.endsWith('/')){await fsp.mkdir(target,{recursive:true});continue;}
    total+=unpacked;
    if(total>MAX_EXTRACT || unpacked>MAX_EXTRACT)throw new Error('압축 해제 용량이 너무 큽니다.');
    if(localOff+30>buf.length || buf.readUInt32LE(localOff)!==0x04034b50)throw new Error('ZIP 내부 파일 정보가 손상되었습니다.');
    const localNameLen=buf.readUInt16LE(localOff+26);
    const localExtraLen=buf.readUInt16LE(localOff+28);
    const dataOff=localOff+30+localNameLen+localExtraLen;
    if(dataOff+packed>buf.length)throw new Error('ZIP 내부 파일이 손상되었습니다.');
    const compressed=buf.subarray(dataOff,dataOff+packed);
    const data=method===0?compressed:await inflateRaw(compressed,{maxOutputLength:Math.min(MAX_EXTRACT,unpacked+1)});
    if(data.length!==unpacked)throw new Error('ZIP 파일 크기가 올바르지 않습니다.');
    await fsp.mkdir(path.dirname(target),{recursive:true});
    await fsp.writeFile(target,data,{flag:'wx'});
  }
}
async function parseMultipart(req){
  const ctype=req.headers['content-type']||'';
  const match=ctype.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if(!match)throw new Error('파일 업로드 형식이 올바르지 않습니다.');
  const b=match[1]||match[2];
  if(!b||b.length>150)throw new Error('잘못된 업로드 경계입니다.');
  const boundary=Buffer.from('--'+b,'latin1');
  const delimiter=Buffer.from('\r\n--'+b,'latin1');
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>MAX_UPLOAD+MAX_ICON+200*1024)throw new Error('업로드 파일이 너무 큽니다.');chunks.push(chunk);}
  const body=Buffer.concat(chunks,size);
  if(!body.subarray(0,boundary.length).equals(boundary))throw new Error('업로드 데이터가 올바르지 않습니다.');
  const fields={}, files={};let cursor=boundary.length,fieldCount=0,fileCount=0;
  while(cursor<body.length){
    if(body.toString('ascii',cursor,cursor+2)==='--')break;
    if(body.toString('ascii',cursor,cursor+2)!=='\r\n')throw new Error('업로드 구분자가 잘못되었습니다.');
    cursor+=2;
    const headerEnd=body.indexOf(Buffer.from('\r\n\r\n'),cursor);
    if(headerEnd<0 || headerEnd-cursor>8192)throw new Error('파일 헤더가 잘못되었습니다.');
    const headers=body.toString('latin1',cursor,headerEnd);
    const disposition=headers.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if(!disposition)throw new Error('파일 정보가 잘못되었습니다.');
    const key=disposition[1];
    const valueStart=headerEnd+4;
    const next=body.indexOf(delimiter,valueStart);
    if(next<0)throw new Error('파일 업로드가 중단되었습니다.');
    const data=body.subarray(valueStart,next);
    if(disposition[2]!==undefined){
      if(++fileCount>2 || !['app','icon'].includes(key) || files[key])throw new Error('앱 파일과 아이콘을 하나씩 선택해 주세요.');
      files[key]={filename:disposition[2],data};
    }else{
      if(++fieldCount>8 || data.length>3000)throw new Error('입력 내용이 너무 깁니다.');
      fields[key]=data.toString('utf8');
    }
    cursor=next+2+boundary.length;
  }
  return {fields,files};
}
async function prepareBrowserApp(zipPath,outputDir){
  await fsp.mkdir(outputDir,{recursive:true});
  await unzip(zipPath,outputDir);
  let index=path.join(outputDir,'index.html');
  if(fs.existsSync(index))return;
  const names=await fsp.readdir(outputDir,{withFileTypes:true});
  const dirs=names.filter(x=>x.isDirectory());
  if(names.length===1&&dirs.length===1){
    const inner=path.join(outputDir,dirs[0].name);
    if(fs.existsSync(path.join(inner,'index.html'))){
      for(const name of await fsp.readdir(inner))await fsp.rename(path.join(inner,name),path.join(outputDir,name));
      await fsp.rmdir(inner);return;
    }
  }
  throw new Error('ZIP 파일 최상위에 index.html이 있어야 합니다.');
}
function validIcon(buf,ext){
  if(ext==='.png')return buf.length>=8&&buf.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if(ext==='.jpg'||ext==='.jpeg')return buf.length>=3&&buf.subarray(0,3).equals(Buffer.from('ffd8ff','hex'));
  if(ext==='.webp')return buf.length>=12&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP';
  return false;
}
let activeUploads=0;
async function upload(req,res){
  if(!PASSWORD)return err(res,503,'서버에 ADMIN_PASSWORD를 설정해야 앱을 올릴 수 있어요.');
  if(!admin(req))return err(res,401,'먼저 관리자 로그인을 해주세요.');
  if(activeUploads>=2)return err(res,429,'다른 업로드가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
  activeUploads++;
  const id=crypto.randomUUID();
  const dir=path.join(APPS_DIR,id);
  try{
    const {fields,files}=await parseMultipart(req);
    if(!files.app)throw new Error('업로드할 앱 파일을 선택해 주세요.');
    const title=(fields.title||'').trim();
    const author=(fields.author||'').trim();
    const description=(fields.description||'').trim();
    const category=(fields.category||'기타').trim();
    const ext=isAllowedFile(files.app.filename);
    if(!ext)throw new Error('HTML, ZIP, APK 파일만 올릴 수 있어요.');
    if(files.app.data.length>MAX_UPLOAD||!files.app.data.length)throw new Error('앱 크기는 1바이트~65MB여야 합니다.');
    if(title.length<1||title.length>60)throw new Error('앱 이름은 1~60자로 적어주세요.');
    if(author.length>40||description.length>600)throw new Error('제작자/설명이 너무 깁니다.');
    if(!['게임','도구','교육','생활','기타'].includes(category))throw new Error('올바른 카테고리를 선택해 주세요.');
    let iconName=null;
    if(files.icon){
      const e=path.extname(files.icon.filename).toLowerCase();
      if(!['.png','.jpg','.jpeg','.webp'].includes(e)||files.icon.data.length>MAX_ICON||!validIcon(files.icon.data,e))throw new Error('아이콘은 3MB 이하의 PNG/JPG/WEBP 이미지로 올려주세요.');
      iconName='icon'+e;
    }
    await fsp.mkdir(dir,{recursive:true});
    if(iconName)await fsp.writeFile(path.join(dir,iconName),files.icon.data);
    const kind=ext==='.apk'?'android':'web';
    if(ext==='.zip'){
      const source=path.join(dir,'incoming.zip');
      await fsp.writeFile(source,files.app.data);
      await prepareBrowserApp(source,path.join(dir,'site'));
      await fsp.rm(source);
    }else if(ext==='.html'){
      await fsp.mkdir(path.join(dir,'site'),{recursive:true});
      await fsp.writeFile(path.join(dir,'site','index.html'),files.app.data);
    }else await fsp.writeFile(path.join(dir,'download.apk'),files.app.data);
    const record={id,title,author:author||'익명 개발자',description,category,kind,icon:iconName,
      size:files.app.data.length,createdAt:new Date().toISOString(),downloads:0};
    await mutate(arr=>{arr.unshift(record);});
    respond(res,201,{app:publicApp(record)});
  }catch(e){
    await fsp.rm(dir,{recursive:true,force:true}).catch(()=>{});
    if(!res.headersSent)err(res,400,e.message||'업로드에 실패했습니다.');
  }finally{activeUploads--;}
}
function publicApp(app){return {...app,playUrl:app.kind==='web'?`/play/${app.id}`:null,downloadUrl:app.kind==='android'?`/download/${app.id}`:null,iconUrl:app.icon?`/icons/${app.id}`:null};}
const badLogin=new Map();
function loginAllowed(req){const ip=(req.socket.remoteAddress||'unknown').slice(0,80);const now=Date.now();const rec=badLogin.get(ip)||{n:0,at:now};if(now-rec.at>15*60*1000){badLogin.set(ip,{n:0,at:now});return true;}return rec.n<15;}
function loginFailed(req){const ip=(req.socket.remoteAddress||'unknown').slice(0,80);const now=Date.now();const rec=badLogin.get(ip)||{n:0,at:now};badLogin.set(ip,{n:rec.n+1,at:rec.at});if(badLogin.size>1000)badLogin.clear();}
function equalText(a,b){const x=crypto.createHash('sha256').update(String(a)).digest();const y=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(x,y);}
async function staticFile(res,full,headers={}){
  let s;
  try{s=await fsp.stat(full);if(!s.isFile())throw new Error('Not file');}catch{return err(res,404,'파일을 찾을 수 없어요.');}
  res.writeHead(200,{'Content-Type':MIME[path.extname(full).toLowerCase()]||'application/octet-stream',
    'Content-Length':s.size,'X-Content-Type-Options':'nosniff',...headers});
  fs.createReadStream(full).on('error',()=>res.destroy()).pipe(res);
}
function escapeHTML(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function handler(req,res){
  const u=new URL(req.url,'http://localhost');
  const pathname=decodeURIComponent(u.pathname);
  const parts=pathname.split('/').filter(Boolean);
  if(req.method==='GET'&&pathname==='/api/apps'){
    const arr=await readDB();return respond(res,200,{apps:arr.map(publicApp)});
  }
  if(req.method==='GET'&&pathname==='/api/session')return respond(res,200,{admin:admin(req),configured:!!PASSWORD});
  if(req.method==='POST'&&pathname==='/api/login'){
    if(!PASSWORD)return err(res,503,'먼저 서버에 ADMIN_PASSWORD를 설정해 주세요.');
    if(!loginAllowed(req))return err(res,429,'로그인 시도가 너무 많아요. 15분 후 다시 시도해 주세요.');
    let body;try{body=await readJSON(req);}catch(e){return err(res,400,e.message);}
    if(!equalText(body.password||'',PASSWORD)){loginFailed(req);return err(res,401,'비밀번호가 맞지 않아요.');}
    const ip=(req.socket.remoteAddress||'unknown').slice(0,80);badLogin.delete(ip);
    return respond(res,200,{admin:true},{'Set-Cookie':`apphub_session=${signedToken()}; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800${isSecure(req)?'; Secure':''}`});
  }
  if(req.method==='POST'&&pathname==='/api/logout')return respond(res,200,{admin:false},{'Set-Cookie':`apphub_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${isSecure(req)?'; Secure':''}`});
  if(req.method==='POST'&&pathname==='/api/upload')return upload(req,res);
  if(req.method==='DELETE'&&parts[0]==='api'&&parts[1]==='apps'&&parts.length===3&&safeSegment(parts[2])){
    if(!admin(req))return err(res,401,'관리자 로그인이 필요합니다.');
    const id=parts[2];let removed=false;
    await mutate(arr=>{const index=arr.findIndex(a=>a.id===id);if(index>=0){arr.splice(index,1);removed=true;}});
    if(!removed)return err(res,404,'앱을 찾을 수 없어요.');
    await fsp.rm(path.join(APPS_DIR,id),{recursive:true,force:true});return respond(res,200,{ok:true});
  }
  if(req.method==='GET'&&parts[0]==='icons'&&parts.length===2&&safeSegment(parts[1])){
    const app=(await readDB()).find(a=>a.id===parts[1]);
    if(!app||!app.icon)return err(res,404,'아이콘이 없습니다.');
    return staticFile(res,path.join(APPS_DIR,app.id,app.icon),{'Cache-Control':'public, max-age=86400'});
  }
  if(req.method==='GET'&&parts[0]==='download'&&parts.length===2&&safeSegment(parts[1])){
    const id=parts[1],app=(await readDB()).find(a=>a.id===id);
    if(!app||app.kind!=='android')return err(res,404,'앱을 찾을 수 없어요.');
    const file=path.join(APPS_DIR,id,'download.apk');
    if(!fs.existsSync(file))return err(res,404,'파일을 찾을 수 없어요.');
    mutate(arr=>{const a=arr.find(x=>x.id===id);if(a)a.downloads=(a.downloads||0)+1;}).catch(()=>{});
    return staticFile(res,file,{'Content-Disposition':`attachment; filename="application-${id}.apk"`,'Cache-Control':'no-store'});
  }
  if(req.method==='GET'&&parts[0]==='play'&&parts.length===2&&safeSegment(parts[1])){
    const app=(await readDB()).find(a=>a.id===parts[1]);
    if(!app||app.kind!=='web')return err(res,404,'게임을 찾을 수 없어요.');
    const title=escapeHTML(app.title),id=app.id;
    const html=`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title} - 내 앱 광장</title><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:#0c1020;color:#f7f9ff}.top{height:54px;display:flex;align-items:center;justify-content:space-between;padding:0 16px;gap:16px}a{color:#c9c5ff;text-decoration:none;font-weight:700}span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}iframe{width:100%;height:calc(100dvh - 54px);border:0;background:#fff}</style></head><body><div class="top"><a href="/">← 앱 광장</a><span>${title}</span><a href="/content/${id}/index.html" target="_blank" rel="noopener noreferrer">새 창 ↗</a></div><iframe title="${title}" sandbox="allow-scripts allow-forms allow-pointer-lock allow-downloads" allow="fullscreen; autoplay" src="/content/${id}/index.html"></iframe></body></html>`;
    const buf=Buffer.from(html);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':buf.length,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});return res.end(buf);
  }
  if(req.method==='GET'&&parts[0]==='content'&&parts.length>=3&&safeSegment(parts[1])){
    const app=(await readDB()).find(a=>a.id===parts[1]);
    if(!app||app.kind!=='web')return err(res,404,'앱을 찾을 수 없어요.');
    const rel=parts.slice(2).join('/');
    const normalized=safeRel(rel);
    if(!normalized)return err(res,400,'잘못된 경로입니다.');
    const base=path.join(APPS_DIR,app.id,'site');
    const full=path.resolve(base,normalized);
    if(!full.startsWith(base+path.sep))return err(res,403,'허용되지 않은 경로입니다.');
    return staticFile(res,full,{
      'Access-Control-Allow-Origin':'*',
      'Cross-Origin-Resource-Policy':'cross-origin',
      'Content-Security-Policy':'sandbox allow-scripts allow-forms allow-downloads; default-src * data: blob: \'unsafe-inline\' \'unsafe-eval\'; connect-src * data: blob:; img-src * data: blob:; media-src * data: blob:',
      'Cache-Control':'public, max-age=600'
    });
  }
  if(req.method==='OPTIONS'&&parts[0]==='content'){
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'*'});return res.end();
  }
  if(req.method!=='GET')return err(res,404,'주소를 찾을 수 없어요.');
  const allowed={'/':'index.html','/index.html':'index.html','/style.css':'style.css','/app.js':'app.js','/favicon.svg':'favicon.svg','/manifest.webmanifest':'manifest.webmanifest','/sw.js':'sw.js', '/icon-192.png':'icon-192.png', '/icon-512.png':'icon-512.png'};
  if(allowed[pathname])return staticFile(res,path.join(PUBLIC,allowed[pathname]),{'Cache-Control':'no-cache','X-Frame-Options':'DENY'});
  return err(res,404,'페이지를 찾을 수 없어요.');
}
prepare().then(()=>http.createServer((req,res)=>{
  handler(req,res).catch(e=>{console.error('request error',e);if(!res.headersSent)err(res,500,'서버에 문제가 생겼어요.');else res.destroy();});
}).listen(PORT,'0.0.0.0',()=>{console.log(`내 앱 광장 실행: http://localhost:${PORT}`);if(!PASSWORD)console.warn('주의: ADMIN_PASSWORD가 없어서 앱 업로드를 사용할 수 없습니다.');})).catch(e=>{console.error(e);process.exit(1);});
