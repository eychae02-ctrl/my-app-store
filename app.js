'use strict';
const $ = (id) => document.getElementById(id);
const state = {apps:[], filter:'전체', query:'', admin:false, configured:true, modal:null};
const moneySafe = (x)=>String(x ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const catIcon={게임:'🎮',도구:'🛠️',교육:'📚',생활:'☀️',기타:'✨'};
let toastTimer;
function toast(message){const t=$('toast');t.textContent=message;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),3400);}
async function request(url, opts={}){
  const response=await fetch(url,{credentials:'same-origin',...opts});
  let result;try{result=await response.json();}catch{result={};}
  if(!response.ok)throw new Error(result.error||`요청 실패 (${response.status})`);
  return result;
}
function counts(){
  $('statApps').textContent=state.apps.length.toLocaleString('ko-KR');
  $('statGames').textContent=state.apps.filter(a=>a.kind==='web').length.toLocaleString('ko-KR');
  $('statAndroid').textContent=state.apps.filter(a=>a.kind==='android').length.toLocaleString('ko-KR');
}
function displayDate(s){const d=new Date(s);return isNaN(d)?'최근':d.toLocaleDateString('ko-KR',{year:'numeric',month:'short',day:'numeric'});}
function cardMarkup(app){
  const icon=app.iconUrl?`<img class="app-icon" alt="" src="${moneySafe(app.iconUrl)}" loading="lazy">`:`<div class="app-icon" aria-hidden="true">${catIcon[app.category]||'✨'}</div>`;
  const isWeb=app.kind==='web';
  return `<article class="app-card"><div class="card-head">${icon}<div class="app-meta"><h3 title="${moneySafe(app.title)}">${moneySafe(app.title)}</h3><p>${moneySafe(app.author)}</p></div></div>
    <div class="app-badge ${isWeb?'':'android'}">${isWeb?'▶ 웹에서 실행':'↓ 안드로이드 APK'}</div>
    <p class="app-desc">${moneySafe(app.description||'직접 만든 새로운 앱을 만나보세요!')}</p>
    <div class="card-footer"><small>${moneySafe(app.category)} · ${displayDate(app.createdAt)}</small><div class="card-actions">
      ${state.admin?`<button class="card-action delete-action" type="button" data-delete="${app.id}" aria-label="${moneySafe(app.title)} 삭제">삭제</button>`:''}
      <button class="card-action share-action" type="button" data-share="${app.id}" aria-label="${moneySafe(app.title)} 공유">공유</button>
      <a class="card-action" ${isWeb?`href="${moneySafe(app.playUrl)}" target="_blank" rel="noopener"`:`href="${moneySafe(app.downloadUrl)}" download`}>${isWeb?'실행 ↗':'받기 ↓'}</a>
    </div></div></article>`;
}
function render(){
  counts();
  const query=state.query.trim().toLowerCase();
  const filtered=state.apps.filter(app=>(state.filter==='전체'||app.category===state.filter)&&(!query||[app.title,app.author,app.description].some(s=>String(s||'').toLowerCase().includes(query))));
  $('appGrid').innerHTML=filtered.map(cardMarkup).join('');
  $('emptyState').hidden=filtered.length!==0;
  if(!state.apps.length){$('emptyTitle').textContent='아직 등록된 앱이 없어요';$('emptyText').textContent='첫 번째 앱을 올리고 나만의 스토어를 시작해 봐요!';$('emptyUpload').hidden=false;}
  else if(!filtered.length){$('emptyTitle').textContent='검색 결과가 없어요';$('emptyText').textContent='다른 키워드나 카테고리로 다시 찾아보세요.';$('emptyUpload').hidden=true;}
  $('adminButton').title=state.admin?'관리자 설정 / 로그아웃':'관리자 로그인';
  $('adminButton').setAttribute('aria-label',$('adminButton').title);
}
async function reload(){
  const result=await request('/api/apps');
  state.apps=result.apps||[];
  render();
}
async function session(){
  const result=await request('/api/session');
  state.admin=!!result.admin;state.configured=!!result.configured;render();
}
function modal(title,eyebrow,html){
  $('modalTitle').textContent=title;$('modalEyebrow').textContent=eyebrow;
  $('modalBody').innerHTML=html;
  $('modalBackdrop').hidden=false;document.body.classList.add('modal-open');
  state.modal=title;
  setTimeout(()=>$('modalBody').querySelector('input:not([type="file"])')?.focus(),20);
}
function closeModal(){ $('modalBackdrop').hidden=true;document.body.classList.remove('modal-open');state.modal=null;}
function showLogin(next='upload'){
  const warning=!state.configured?`<p class="alert">서버에 관리자 비밀번호가 아직 설정되지 않았어요. Railway의 Variables에서 <strong>ADMIN_PASSWORD</strong>를 추가한 뒤 재배포해 주세요.</p>`:'';
  modal('관리자 로그인','OWNER ACCESS',`<div class="modal-content"><div class="login-lock" aria-hidden="true">🔐</div><p class="big-note">앱을 올리거나 삭제하는 기능은 관리자만 사용할 수 있어요. 방문자는 로그인 없이 앱을 둘러보고 실행할 수 있습니다.</p>${warning}
    <form id="loginForm"><div class="form-row"><label for="password">관리자 비밀번호</label><input type="password" id="password" required minlength="1" placeholder="비밀번호를 입력하세요" autocomplete="current-password" ${state.configured?'':'disabled'}></div><p class="error-text" id="loginError" hidden></p><div class="form-buttons"><button class="secondary-button" type="button" data-close>취소</button><button type="submit" class="primary-button" id="loginSubmit" ${state.configured?'':'disabled'}>로그인 →</button></div></form></div>`);
  $('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();const btn=$('loginSubmit');btn.disabled=true;btn.textContent='확인 중…';$('loginError').hidden=true;
    try{await request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});state.admin=true;render();toast('관리자로 로그인했어요!');if(next==='upload')showUpload();else showOwner();}
    catch(err){$('loginError').textContent=err.message;$('loginError').hidden=false;btn.disabled=false;btn.textContent='로그인 →';}
  });
}
function showOwner(){
  if(!state.admin)return showLogin('owner');
  modal('관리자 설정','OWNER SETTINGS',`<div class="modal-content"><div class="logged-in-box">✅ 관리자 모드입니다.<br>앱 목록의 <strong>삭제</strong> 버튼으로 등록한 앱을 관리할 수 있어요.</div><div class="form-buttons"><button type="button" class="secondary-button" data-close>닫기</button><button type="button" class="primary-button" id="logoutButton">로그아웃</button></div></div>`);
  $('logoutButton').addEventListener('click',async()=>{try{await request('/api/logout',{method:'POST'});state.admin=false;render();closeModal();toast('로그아웃했어요.');}catch(e){toast(e.message);}});
}
function showUpload(){
  if(!state.admin)return showLogin('upload');
  modal('내 앱 올리기','PUBLISH YOUR APP',`<div class="modal-content"><form id="uploadForm" enctype="multipart/form-data">
    <div class="form-row"><label for="appTitle">앱 이름 *</label><input id="appTitle" name="title" maxlength="60" placeholder="예: 우주 탐험 게임" required></div>
    <div class="upload-two"><div class="form-row"><label for="appAuthor">제작자</label><input id="appAuthor" name="author" maxlength="40" placeholder="예: 나의 게임 스튜디오"></div><div class="form-row"><label for="appCategory">카테고리</label><select id="appCategory" name="category"><option>게임</option><option>도구</option><option>교육</option><option>생활</option><option>기타</option></select></div></div>
    <div class="form-row"><label for="appDescription">앱 소개</label><textarea name="description" id="appDescription" maxlength="600" placeholder="어떤 앱인지 간단히 설명해주세요."></textarea></div>
    <div class="form-row"><label>앱 파일 * <span class="form-hint">(HTML / ZIP / APK)</span></label><label class="file-drop" for="appFile"><span class="file-emoji">📦</span><strong id="appFileName">클릭해서 앱 파일 선택하기</strong><small>최대 65MB · HTML / ZIP / APK</small><input id="appFile" type="file" name="app" accept=".html,.zip,.apk" required></label><div class="form-hint">여러 파일로 된 웹게임은 index.html을 포함한 ZIP 파일로 올려주세요.</div></div>
    <div class="form-row"><label>앱 아이콘 (선택)</label><label class="file-drop" for="appIcon" style="min-height:76px;padding:12px"><strong id="appIconName">🖼 아이콘 이미지 선택하기</strong><small>PNG / JPG / WEBP · 최대 3MB</small><input id="appIcon" type="file" name="icon" accept=".png,.jpg,.jpeg,.webp"></label></div>
    <div class="alert">업로드한 앱은 누구나 볼 수 있어요. 본인이 제작했거나 배포할 권한이 있는 파일만 올려주세요.</div>
    <p class="error-text" id="uploadError" hidden></p><div id="progressArea" hidden><div class="upload-progress"><span id="progressFill"></span></div><small class="upload-progress-label" id="progressLabel">업로드 중…</small></div>
    <div class="form-buttons"><button type="button" data-close class="secondary-button" id="uploadCancel">취소</button><button type="submit" class="primary-button" id="uploadSubmit">🚀 앱 공개하기</button></div>
  </form></div>`);
  $('appFile').addEventListener('change',()=>{const f=$('appFile').files[0];$('appFileName').textContent=f?`✓ ${f.name}`:'클릭해서 앱 파일 선택하기';});
  $('appIcon').addEventListener('change',()=>{const f=$('appIcon').files[0];$('appIconName').textContent=f?`✓ ${f.name}`:'🖼 아이콘 이미지 선택하기';});
  $('uploadForm').addEventListener('submit',sendUpload);
}
function sendUpload(e){
  e.preventDefault();const f=$('appFile').files[0],icon=$('appIcon').files[0];
  const error=$('uploadError');error.hidden=true;
  if(!f)return;
  if(f.size>65*1024*1024){error.textContent='앱 파일이 65MB를 초과했어요.';error.hidden=false;return;}
  if(icon&&icon.size>3*1024*1024){error.textContent='아이콘은 3MB 이하로 선택해 주세요.';error.hidden=false;return;}
  const form=new FormData($('uploadForm'));
  const btn=$('uploadSubmit');btn.disabled=true;btn.textContent='업로드 중…';$('uploadCancel').disabled=true;
  $('progressArea').hidden=false;
  const xhr=new XMLHttpRequest();xhr.open('POST','/api/upload');
  xhr.upload.onprogress=ev=>{if(ev.lengthComputable){const percent=Math.min(99,Math.round(ev.loaded/ev.total*100));$('progressFill').style.width=percent+'%';$('progressLabel').textContent=`전송 중 ${percent}%`;}};
  xhr.onload=async()=>{
    let result;try{result=JSON.parse(xhr.responseText);}catch{result={};}
    if(xhr.status>=200&&xhr.status<300){$('progressFill').style.width='100%';closeModal();toast('🎉 앱이 등록되었어요!');state.query='';state.filter='전체';$('searchInput').value='';document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active',c.dataset.filter==='전체'));try{await reload();}catch(e){toast('등록됐지만 목록을 다시 불러오지 못했어요.');}location.hash='apps';}
    else {error.textContent=result.error||'업로드하지 못했어요.';error.hidden=false;btn.disabled=false;btn.textContent='🚀 다시 시도하기';$('uploadCancel').disabled=false;$('progressArea').hidden=true;}
  };
  xhr.onerror=()=>{error.textContent='네트워크 연결을 확인해 주세요.';error.hidden=false;btn.disabled=false;btn.textContent='🚀 다시 시도하기';$('uploadCancel').disabled=false;$('progressArea').hidden=true;};
  xhr.send(form);
}
async function share(id){
  const app=state.apps.find(a=>a.id===id);if(!app)return;
  const address=new URL(app.kind==='web'?app.playUrl:app.downloadUrl,location.origin).href;
  try{if(navigator.share){await navigator.share({title:app.title,url:address});return;}
    if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(address);
    else{const el=document.createElement('textarea');el.value=address;document.body.appendChild(el);el.select();document.execCommand('copy');el.remove();}
    toast('공유 링크를 복사했어요!');
  }catch(e){if(e.name!=='AbortError')toast('공유할 수 없어요. 다시 시도해 주세요.');}
}
async function removeApp(id){
  const app=state.apps.find(a=>a.id===id);if(!app||!state.admin)return;
  if(!confirm(`"${app.title}" 앱을 정말 삭제할까요?\n삭제한 파일은 복구할 수 없어요.`))return;
  try{await request('/api/apps/'+id,{method:'DELETE'});await reload();toast('앱을 삭제했어요.');}catch(e){toast(e.message);}
}
function bind(){
  ['navUpload','heroUpload','sectionUpload','emptyUpload'].forEach(id=>$(id).addEventListener('click',showUpload));
  $('adminButton').addEventListener('click',()=>state.admin?showOwner():showLogin('owner'));
  $('searchInput').addEventListener('input',e=>{state.query=e.target.value;render();});
  document.querySelectorAll('.chip').forEach(chip=>chip.addEventListener('click',()=>{state.filter=chip.dataset.filter;document.querySelectorAll('.chip').forEach(c=>c.classList.toggle('active',c===chip));render();}));
  $('appGrid').addEventListener('click',e=>{const b=e.target.closest('[data-share],[data-delete]');if(!b)return;if(b.dataset.share)share(b.dataset.share);if(b.dataset.delete)removeApp(b.dataset.delete);});
  $('modalClose').addEventListener('click',closeModal);
  $('modalBackdrop').addEventListener('click',e=>{if(e.target===$('modalBackdrop')||e.target.closest('[data-close]'))closeModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('modalBackdrop').hidden)closeModal();});
}
async function init(){
  bind();
  $('appGrid').innerHTML='<div class="loading">앱 목록을 불러오는 중…</div>';
  try{await Promise.all([session(),reload()]);}
  catch(e){$('appGrid').innerHTML='';$('emptyState').hidden=false;$('emptyTitle').textContent='서버 연결에 실패했어요';$('emptyText').textContent='잠시 후 새로고침해 주세요.';$('emptyUpload').hidden=true;toast(e.message);}
}
init();
if ('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
