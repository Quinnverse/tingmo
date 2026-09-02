'use strict';

/* ============================================================
 * 听墨 · 纯前端文字转语音听读工具
 * - IndexedDB 存内容 / 听读记录 / 录音
 * - Web Speech API 免费中文 TTS，逐句朗读 + 同步文稿高亮
 * - 支持 .txt/.md/.pdf/.docx 导入（pdf.js / mammoth 已本地化）
 * - 每句可录音自背、标记「会了」；听读记录按日/周/月统计
 * ============================================================ */

const DB_NAME = 'tingmo';
const DB_VERSION = 2;
const STORE_ITEMS = 'items';
const STORE_LOGS = 'listen_logs';
const STORE_REC = 'recordings';
let _db = null;

/* ---------------- IndexedDB ---------------- */
function openDB() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      for (const s of [STORE_ITEMS, STORE_LOGS, STORE_REC]) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}
async function dbAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}
async function dbPut(item, store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function dbDelete(id, store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------------- 工具 ---------------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function fmtDate(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function escapeHTML(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function splitSentences(text) {
  const raw = (text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const parts = raw.split(/(?<=[。！？!?；;…\n])/);
  const out = [];
  for (const p of parts) { const t = p.trim(); if (t) out.push(t); }
  return out.length ? out : [raw];
}

/* ---------------- TTS ---------------- */
const synth = window.speechSynthesis;
// iOS 对 Web Speech API 限制最多：首次 speak 易被丢、pause/resume 失效、静音键会静音
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let zhVoice = null;
// 每次播放前都重新挑一次中文嗓音：移动端 getVoices() 常延迟加载，缓存一次会拿到空
function pickZhVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  return voices.find(v => /^(zh|cmn|zh-CN|zh-TW)/i.test(v.lang) || /中文|普通话|国语|Chinese/i.test(v.name)) || null;
}
function loadVoices() { zhVoice = pickZhVoice(); }
if (synth) {
  loadVoices();
  synth.onvoiceschanged = loadVoices;
  setTimeout(loadVoices, 300);   // 移动端首次常为空，延迟再取
  setTimeout(loadVoices, 1500);
}
if (window.pdfjsLib) {
  try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.js'; } catch (e) {}
}

const player = {
  item: null, sentences: [], idx: 0, rate: 1, loop: false, state: 'idle',
  mastered: {}, recMap: {},
};

function buildUtterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN'; u.rate = player.rate;
  const v = pickZhVoice() || zhVoice; if (v) u.voice = v;
  return u;
}

function speakCurrent() {
  if (!synth || player.idx < 0 || player.idx >= player.sentences.length) return;
  if (player.state === 'playing') logListen(player.item.id, player.item.title); // 记一句
  const u = buildUtterance(player.sentences[player.idx]);
  let started = false;
  u.onstart = () => { started = true; hidePlayerNote(); };
  u.onend = () => {
    if (player.state !== 'playing') return;
    if (player.loop) { speakCurrent(); return; }
    player.idx++;
    if (player.idx < player.sentences.length) { renderCurrent(); speakCurrent(); }
    else finishPlayback();
  };
  u.onerror = (e) => {
    if (e.error === 'interrupted') return; // 主动切句/暂停，非故障
    console.warn('TTS error:', e.error);
    if (e.error === 'not-allowed' || e.error === 'audio-busy')
      showPlayerNote('朗读被系统拦截，请再点一次播放试试。', true);
    else if (e.error === 'synthesis-failed' || e.error === 'text-too-long')
      showPlayerNote('该句朗读失败：可能未安装中文语音包。可在手机「设置 → 语言与输入法 → 文字转语音(TTS)」中安装中文语音后重试。', true);
    else
      showPlayerNote('朗读出错（' + (e.error || '未知') + '），换句或重试点播放试试。', true);
  };
  synth.speak(u);
  // iOS 兜底：若 1.2s 还没出声，多半是静音键 / 未授权，给提示
  if (isIOS) {
    setTimeout(() => {
      if (player.state !== 'playing') return;
      if (started || synth.speaking || synth.pending) return; // 其实在播，不打扰
      showPlayerNote('iPhone 没出声？请确认：① 侧边静音键已关闭；② 再点一次播放。iOS 对网页朗读较敏感。', true);
    }, 1200);
  }
}

function startPlayback(fromIdx) {
  if (!synth) { showPlayerNote('当前浏览器不支持语音朗读，请用 Chrome / Edge / Safari 打开。', true); return; }
  player.idx = (fromIdx != null) ? fromIdx : (player.idx || 0);
  player.state = 'playing';
  updatePlayBtn(); renderCurrent();
  // iOS 大坑：cancel 后立刻 speak 会被丢弃；首次播放本就没在播，绝不取消，直接 speak
  if (synth.speaking || synth.pending) {
    try { synth.cancel(); } catch (e) {}
    setTimeout(speakCurrent, isIOS ? 80 : 30); // 等一拍再读，移动端更稳
  } else {
    speakCurrent();
  }
}
function pausePlayback() {
  if (player.state === 'playing' && synth) {
    if (isIOS) { try { synth.cancel(); } catch (e) {} } // iOS 的 pause/resume 不可靠，改用取消+重读
    else synth.pause();
    player.state = 'paused'; updatePlayBtn();
  }
}
function resumePlayback() {
  if (player.state === 'paused' && synth) {
    player.state = 'playing'; updatePlayBtn();
    if (isIOS) speakCurrent(); // 重新朗读当前句（从头）
    else synth.resume();
  }
}
function togglePlay() {
  if (player.state === 'playing') pausePlayback();
  else if (player.state === 'paused') resumePlayback();
  else startPlayback(0);
}
function finishPlayback() {
  if (synth) synth.cancel();
  player.state = 'idle'; player.idx = 0; updatePlayBtn(); renderCurrent();
}
function replayCurrent() { if (player.sentences.length) startPlayback(player.idx); } // 重读当前句
function nextSentence() {
  if (player.idx < player.sentences.length - 1) {
    const was = player.state === 'playing'; player.idx++; renderCurrent();
    if (was) startPlayback(player.idx);
  }
}
function prevSentence() {
  if (player.idx > 0) {
    const was = player.state === 'playing'; player.idx--; renderCurrent();
    if (was) startPlayback(player.idx);
  }
}
function jumpTo(i) {
  if (i < 0 || i >= player.sentences.length) return;
  const was = player.state === 'playing' || player.state === 'paused';
  player.idx = i; renderCurrent();
  if (was) startPlayback(i); else { player.state = 'idle'; updatePlayBtn(); }
}

/* ---------------- 听读记录 ---------------- */
async function logListen(itemId, itemTitle) {
  try { await dbPut({ id: uid(), itemId, itemTitle, ts: Date.now(), n: 1 }, STORE_LOGS); } catch (e) {}
}
async function renderStats() {
  const [logs, items] = await Promise.all([dbAll(STORE_LOGS), dbAll(STORE_ITEMS)]);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dow = (now.getDay() + 6) % 7;
  const weekStart = startOfDay - dow * 86400000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  let today = 0, week = 0, month = 0, mastered = 0;
  const daySet = new Set();
  for (const l of logs) {
    if (l.ts >= startOfDay) today += l.n;
    if (l.ts >= weekStart) week += l.n;
    if (l.ts >= monthStart) month += l.n;
    daySet.add(new Date(l.ts).toDateString());
  }
  for (const it of items) if (it.mastered) mastered += Object.keys(it.mastered).filter(k => it.mastered[k]).length;
  $('stat-today').textContent = today;
  $('stat-week').textContent = week;
  $('stat-month').textContent = month;
  $('stat-items').textContent = items.length;
  $('stat-days').textContent = daySet.size;
  $('stat-mastered').textContent = mastered;
  // 最近 7 天
  const daily = [];
  for (let d = 6; d >= 0; d--) {
    const ds = startOfDay - d * 86400000, de = ds + 86400000; let n = 0;
    for (const l of logs) if (l.ts >= ds && l.ts < de) n += l.n;
    daily.push(n);
  }
  const maxN = Math.max(1, ...daily);
  const list = $('stat-week-list'); list.innerHTML = '';
  for (let d = 6; d >= 0; d--) {
    const dt = new Date(startOfDay - d * 86400000);
    const label = d === 0 ? '今天' : d === 1 ? '昨天' : `${dt.getMonth() + 1}/${dt.getDate()}`;
    const row = document.createElement('div'); row.className = 'week-row';
    row.innerHTML = `<span class="week-day">${label}</span>` +
      `<span class="week-bar"><span class="week-fill" style="width:${daily[6 - d] / maxN * 100}%"></span></span>` +
      `<span class="week-num">${daily[6 - d]} 句</span>`;
    list.appendChild(row);
  }
}

/* ---------------- 录音自背 ---------------- */
let mediaRecorder = null, recChunks = [], recIdx = -1, recStream = null;
async function toggleRecord(idx, btn) {
  if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showHint('当前环境不支持录音（需 https 或 localhost，且允许麦克风权限）。', true); return;
  }
  try { recStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { showHint('无法访问麦克风，请在浏览器允许麦克风权限。', true); return; }
  recChunks = [];
  let mime = '';
  if (window.MediaRecorder) {
    if (MediaRecorder.isTypeSupported('audio/webm')) mime = 'audio/webm';
    else if (MediaRecorder.isTypeSupported('audio/mp4')) mime = 'audio/mp4';
  }
  mediaRecorder = new MediaRecorder(recStream, mime ? { mimeType: mime } : undefined);
  recIdx = idx;
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    await dbPut({ id: player.item.id + '#' + idx, itemId: player.item.id, idx, blob, createdAt: Date.now() }, STORE_REC);
    if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
    mediaRecorder = null; recIdx = -1;
    const play = el.transcript.querySelector('.s-play[data-idx="' + idx + '"]');
    if (play) { play.hidden = false; }
    btn.classList.remove('recording'); btn.textContent = '🎤';
    showHint('录音已保存，点 ▶ 听自己背的，和原文对照～', false);
  };
  mediaRecorder.start();
  btn.classList.add('recording'); btn.textContent = '🔴';
}
function playOwn(btn) {
  if (!btn._url && btn._blob) btn._url = URL.createObjectURL(btn._blob);
  if (btn._url) new Audio(btn._url).play();
}
async function toggleMastered(i, btn) {
  player.mastered[i] = !player.mastered[i];
  btn.classList.toggle('done', player.mastered[i]);
  btn.textContent = player.mastered[i] ? '✓' : '○';
  player.item.mastered = player.mastered;
  await dbPut(player.item, STORE_ITEMS);
}

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const views = { library: $('view-library'), import: $('view-import'), stats: $('view-stats'), player: $('view-player') };
const el = {
  itemList: $('item-list'), emptyState: $('empty-state'),
  importTitle: $('import-title'), importText: $('import-text'), importFile: $('import-file'), importHint: $('import-hint'),
  playerTitle: $('player-title'), playerSub: $('player-sub'),
  progressBar: $('progress-bar'), progressFill: $('progress-fill'), transcript: $('transcript'), playBtn: $('btn-play'),
  playerNote: $('player-note'),
};
function showView(name) { Object.values(views).forEach(v => v.hidden = true); views[name].hidden = false; window.scrollTo(0, 0); }

/* ---------------- 文库 ---------------- */
const COVER_GRADS = ['grad-0', 'grad-1', 'grad-2', 'grad-3', 'grad-4', 'grad-5'];
function coverClass(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COVER_GRADS[h % COVER_GRADS.length];
}
function firstGlyph(title) { return (title && title.trim()[0]) || '墨'; }
async function getTodayCount() {
  const logs = await dbAll(STORE_LOGS);
  const s = new Date(); s.setHours(0, 0, 0, 0); const t0 = s.getTime();
  return logs.filter(l => l.ts >= t0).reduce((a, l) => a + (l.n || 0), 0);
}
async function renderLibrary() {
  const items = (await dbAll(STORE_ITEMS)).sort((a, b) => b.createdAt - a.createdAt);
  el.itemList.innerHTML = '';
  const today = await getTodayCount();
  $('home-today').textContent = '今日 ' + today + ' 句';
  $('lib-count').textContent = items.length + ' 篇';
  const has = items.length > 0;
  $('hero').hidden = has;
  $('features').hidden = has;
  $('lib-head').hidden = !has;
  $('resume').hidden = !has;
  $('empty-state').hidden = true;
  if (!has) return;

  // 继续听：取最近一篇
  const last = items[0];
  const rc = $('resume-cover');
  rc.textContent = firstGlyph(last.title); rc.className = 'resume-cover ' + coverClass(last.id);
  $('resume-title').textContent = last.title;
  const lsn = (last.sentences && last.sentences.length) || 0;
  const ldone = last.mastered ? Object.keys(last.mastered).filter(k => last.mastered[k]).length : 0;
  $('resume-meta').textContent = lsn + ' 句 · 已会 ' + ldone;
  $('resume-card').onclick = () => openPlayer(last);

  // 列表
  for (const it of items) {
    const card = document.createElement('div'); card.className = 'card';
    const sn = (it.sentences && it.sentences.length) || 0;
    const done = it.mastered ? Object.keys(it.mastered).filter(k => it.mastered[k]).length : 0;
    const pct = sn ? Math.round(done / sn * 100) : 0;
    card.innerHTML = `<div class="card-cover ${coverClass(it.id)}">${escapeHTML(firstGlyph(it.title))}</div>
      <div class="card-body">
        <div class="card-title">${escapeHTML(it.title)}</div>
        <div class="card-meta">${sn} 句 · 已会 ${done}</div>
        <div class="card-prog"><span style="width:${pct}%"></span></div>
      </div>
      <div class="card-play">▶</div>`;
    card.addEventListener('click', () => openPlayer(it));
    el.itemList.appendChild(card);
  }
}

/* 一键载入示例内容 */
async function loadDemo() {
  const DEMO_TITLE = '示例 · 听墨使用说明';
  let item = (await dbAll(STORE_ITEMS)).find(i => i.title === DEMO_TITLE);
  if (!item) {
    const text = '学习，是一场与自己的对话。把要记的内容读出来，让耳朵先熟悉它。'
      + '反复听，再试着背出来，记忆会更深。听墨陪你，把每一段文字，都变成可以听见的陪伴。';
    item = { id: uid(), title: DEMO_TITLE, text, sentences: splitSentences(text), mastered: {}, createdAt: Date.now() };
    await dbPut(item, STORE_ITEMS);
  }
  openPlayer(item);
}

/* ---------------- 播放器 ---------------- */
async function openPlayer(item) {
  player.item = item;
  player.sentences = (item.sentences && item.sentences.length) ? item.sentences : splitSentences(item.text);
  player.idx = 0; player.state = 'idle'; player.mastered = item.mastered || {};
  el.playerTitle.textContent = item.title;
  const recs = await dbAll(STORE_REC);
  player.recMap = {};
  for (const r of recs) if (r.itemId === item.id) player.recMap[r.idx] = r.blob;
  renderTranscript(); renderCurrent(); updatePlayBtn(); showView('player');
  hidePlayerNote();
  if (isIOS && !pickZhVoice()) {
    showPlayerNote('iPhone 使用提示：首次朗读请保持未静音；若没声音，再点一次播放即可。', false);
  }
}
function renderTranscript() {
  el.transcript.innerHTML = '';
  player.sentences.forEach((s, i) => {
    const p = document.createElement('div'); p.className = 'sentence'; p.dataset.idx = i;
    const text = document.createElement('span'); text.className = 's-text'; text.textContent = s;
    const tools = document.createElement('span'); tools.className = 's-tools';
    const rec = document.createElement('button'); rec.className = 's-rec'; rec.dataset.idx = i; rec.title = '录音背这句'; rec.textContent = '🎤';
    const play = document.createElement('button'); play.className = 's-play'; play.dataset.idx = i; play.title = '听自己的录音'; play.textContent = '▶';
    if (player.recMap[i]) { play.hidden = false; play._blob = player.recMap[i]; } else play.hidden = true;
    const done = document.createElement('button');
    done.className = 's-done' + (player.mastered[i] ? ' done' : '');
    done.dataset.idx = i; done.title = '标记会了'; done.textContent = player.mastered[i] ? '✓' : '○';
    tools.append(rec, play, done);
    p.append(text, tools);
    p.addEventListener('click', (e) => { if (e.target.closest('.s-tools')) return; jumpTo(i); });
    rec.addEventListener('click', (e) => { e.stopPropagation(); toggleRecord(i, rec); });
    play.addEventListener('click', (e) => { e.stopPropagation(); playOwn(play); });
    done.addEventListener('click', (e) => { e.stopPropagation(); toggleMastered(i, done); });
    el.transcript.appendChild(p);
  });
}
function renderCurrent() {
  const len = player.sentences.length, i = player.idx;
  el.playerSub.textContent = `${len ? i + 1 : 0} 句 / ${len} 句`;
  el.progressFill.style.width = len ? `${(i / len) * 100}%` : '0%';
  const nodes = el.transcript.querySelectorAll('.sentence');
  nodes.forEach(n => n.classList.toggle('current', Number(n.dataset.idx) === i));
  const cur = nodes[i];
  if (cur) cur.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function updatePlayBtn() { el.playBtn.textContent = player.state === 'playing' ? '⏸' : '▶'; }

/* ---------------- 导入 + 文件解析 ---------------- */
function showHint(msg, isError) {
  el.importHint.hidden = false; el.importHint.textContent = msg;
  el.importHint.style.color = isError ? 'var(--accent-deep)' : 'var(--ink-2)';
}
/* 播放器内的状态/错误提示条 */
function showPlayerNote(msg, isError) {
  if (!el.playerNote) return;
  el.playerNote.hidden = false; el.playerNote.textContent = msg;
  el.playerNote.classList.toggle('error', !!isError);
}
function hidePlayerNote() { if (el.playerNote) el.playerNote.hidden = true; }
async function parsePDF(file) {
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
  }
  return text;
}
async function parseDOCX(file) {
  const buf = await file.arrayBuffer();
  const res = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return res.value;
}
async function saveAndPlay() {
  const title = el.importTitle.value.trim();
  const text = el.importText.value.trim();
  if (!title) { showHint('请先给这段内容起个名字～'); el.importTitle.focus(); return; }
  if (!text) { showHint('请粘贴或导入要听的文字～'); el.importText.focus(); return; }
  const sentences = splitSentences(text);
  if (!sentences.length) { showHint('没识别到有效文字，换段内容试试～'); return; }
  const item = { id: uid(), title, text, sentences, mastered: {}, createdAt: Date.now() };
  await dbPut(item, STORE_ITEMS);
  el.importTitle.value = ''; el.importText.value = ''; el.importHint.hidden = true;
  openPlayer(item);
}
el.importFile.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  showHint('正在解析文件…', false);
  try {
    let text = '';
    if (ext === 'txt' || ext === 'md' || ext === 'markdown') text = await file.text();
    else if (ext === 'pdf') { if (!window.pdfjsLib) throw new Error('PDF 解析库未加载'); text = await parsePDF(file); }
    else if (ext === 'docx') { if (!window.mammoth) throw new Error('Word 解析库未加载'); text = await parseDOCX(file); }
    else throw new Error('暂不支持该格式，请用 .txt / .md / .pdf / .docx');
    text = text.trim();
    if (!text) throw new Error('没提取到文字，可能文件是图片扫描版（暂不支持）');
    el.importText.value = text;
    if (!el.importTitle.value.trim()) el.importTitle.value = file.name.replace(/\.[^.]+$/, '');
    showHint('解析成功，共 ' + splitSentences(text).length + ' 句，可以保存了～', false);
  } catch (err) { showHint('解析失败：' + err.message, true); }
});

/* ---------------- 事件 ---------------- */
$('btn-new').addEventListener('click', () => { el.importHint.hidden = true; showView('import'); });
$('btn-new-hero').addEventListener('click', () => { el.importHint.hidden = true; showView('import'); });
$('btn-demo').addEventListener('click', loadDemo);
$('btn-import-back').addEventListener('click', () => renderLibrary().then(() => showView('library')));
$('btn-save').addEventListener('click', saveAndPlay);
$('btn-stats').addEventListener('click', () => renderStats().then(() => showView('stats')));
$('btn-stats-back').addEventListener('click', () => showView('library'));
$('btn-player-back').addEventListener('click', () => { finishPlayback(); renderLibrary().then(() => showView('library')); });
$('btn-player-del').addEventListener('click', async () => {
  if (!player.item) return;
  if (!confirm(`确定删除「${player.item.title}」？相关录音也会一并删除。`)) return;
  await dbDelete(player.item.id, STORE_ITEMS);
  const recs = await dbAll(STORE_REC);
  for (const r of recs) if (r.itemId === player.item.id) await dbDelete(r.id, STORE_REC);
  finishPlayback(); renderLibrary().then(() => showView('library'));
});
$('btn-play').addEventListener('click', togglePlay);
$('btn-prev').addEventListener('click', prevSentence);
$('btn-next').addEventListener('click', nextSentence);
$('btn-replay').addEventListener('click', replayCurrent);
$('btn-loop').addEventListener('click', () => {
  player.loop = !player.loop;
  $('btn-loop').classList.toggle('active', player.loop);
});
document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    player.rate = parseFloat(btn.dataset.rate);
    if (player.state === 'playing') startPlayback(player.idx);
  });
});
el.progressBar.addEventListener('click', (e) => {
  const rect = el.progressBar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const target = Math.floor(ratio * player.sentences.length);
  jumpTo(Math.min(target, player.sentences.length - 1));
});

/* ---------------- 启动 ---------------- */
renderLibrary().then(() => showView('library'));
