/*
 * 生產部看板｜畫面與邏輯
 * ---------------------------------------------------------------
 * 雲端資料（PDStore，見 cloud-store.js）：
 *   notices：各部門要給生產部的通知
 *     { id, dept, type, title, body, items(相關品項), qty(數量／規格), date(發布日 YYYY-MM-DD，決定分檔),
 *       due(需處理日), dueEnd(結束日，檔期或期間才有), priority: 'urgent'|'high'|'normal',
 *       status: 'new'(待確認)|'ack'(已確認)|'doing'(處理中)|'done'(已完成), onCal(顯示在行事曆，預設 true),
 *       owner(生產部負責人), reply(生產部回覆), rev(重新通知的次數),
 *       by, byEmail, at, upBy, upByEmail, upAt, ackBy, ackAt, doneBy, doneAt, replyBy, replyAt, demo }
 *   events：行事曆行程
 *     { id, title, etype, dept(''＝生產部自己的), date(開始日，決定分檔), end(結束日), allDay, time, endTime,
 *       repeat: 'none'|'weekly'|'biweekly'|'monthly', until, place, note, remind(提前幾分鐘提醒，-1＝不提醒；全天行程以 8:00 計),
 *       proj(投影顯示，預設 true), by, byEmail, at, upBy, upAt, demo }
 *   settings（一筆 id = main）：{ rotateSec(投影輪播秒數), popupSec(投影跳出通知秒數), doneDays(已完成保留天數), types: { 部門: [類別…] }, demo }
 * 這台裝置自己的設定（localStorage，pd_ 開頭）：
 *   pd_prefs（提示音、系統通知、投影要顯示的部門）、pd_seen（看過的通知，用來判斷「新通知」）、pd_fired（已提醒過的行程）
 * 權限代號（PDAuth.can）：purchase / store / warehouse / material / channel / meeting＝可發布該部門的通知、新增該部門的行程；
 *   production＝確認收到、更新狀態、回覆、管理全部行程。管理員全部為真。沒有任何權限＝只能看（投影用電腦）。
 * 提醒：新通知（別人發的、12 小時內）與行程提醒（依 remind）會跳出卡片＋提示音；投影模式改成全螢幕大字跳出。
 *   App 必須開著（可以在背景）才會提醒；勾「系統通知」後，在背景也會跳 Windows／手機的系統通知。
 */
(() => {
  'use strict';
  const A = window.PDAuth, S = window.PDStore;

  // ================= 基本設定 =================
  const DEPTS = [
    { id: 'purchase', name: '採購', types: ['原物料到貨', '缺料／延遲', '替代料／規格變更', '價格異動', '樣品／新供應商'] },
    { id: 'store', name: '門市', types: ['門市訂單／團購', '品質回饋／客訴', '銷售異常', '活動需求'] },
    { id: 'warehouse', name: '倉管', types: ['庫存不足', '即期／過期', '倉位空間', '出貨異常'] },
    { id: 'material', name: '物管', types: ['物料需求', '包材／標示', '安全庫存警示', '配方／BOM 變更'] },
    { id: 'channel', name: '通路', types: ['通路訂單', '檔期活動', '新品上架', '規格／標示要求', '退貨'] },
    { id: 'meeting', name: '產銷會議', types: ['會議決議', '待辦追蹤', '排程調整', '新品開發'] }
  ];
  // 從夥伴交接看板帶進來、指派給生產部夥伴的任務（雲端後端每 5 分鐘同步；只能在這裡處理與標示完成，不能發布）
  const HANDOVER = { id: 'handover', name: '夥伴交接', types: [] };
  const DEPT = Object.fromEntries(DEPTS.concat([HANDOVER]).map(d => [d.id, d]));
  const PERMS = DEPTS.map(d => ({ id: d.id, name: d.name + '發布' })).concat([{ id: 'production', name: '生產部處理' }]);
  const PRIO = { urgent: { name: '緊急', rank: 0 }, high: { name: '重要', rank: 1 }, normal: { name: '一般', rank: 2 } };
  const STATUS = { new: '待確認', ack: '已確認', doing: '處理中', done: '已完成', ext: '進行中' };   // ext：其他部門在夥伴交接看板的任務
  const ETYPE = { meeting: '會議', arrival: '到貨', production: '生產排程', promo: '檔期活動', audit: '稽核／檢查', off: '停工／休假', other: '其他' };
  const REPEAT = { none: '不重複', weekly: '每週', biweekly: '每兩週', monthly: '每月' };
  const REMIND_TIMED = [[-1, '不提醒'], [0, '開始時'], [10, '10 分鐘前'], [30, '30 分鐘前'], [60, '1 小時前'], [1440, '前一天同一時間']];
  const REMIND_ALLDAY = [[-1, '不提醒'], [0, '當天 8:00'], [1440, '前一天 8:00']];
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const DEFAULT_SET = { rotateSec: 12, popupSec: 25, doneDays: 3, types: {} };
  const NEW_POPUP_HOURS = 12;   // 超過這個時間才收到的新通知（例如電腦關機一整天）不再跳出，只在看板標示「待確認」

  // ================= 小工具 =================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const today = () => ymd(new Date());
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
  const diff = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);   // b 比 a 晚幾天
  const md = s => { const d = parse(s); return d ? `${d.getMonth() + 1}/${d.getDate()}` : ''; };
  const wk = s => { const d = parse(s); return d ? WEEK[d.getDay()] : ''; };
  const mdw = s => s ? `${md(s)}（${wk(s)}）` : '';
  const hm = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const stamp = ms => { if (!ms) return ''; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${hm(ms)}`; };
  const uid = p => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 私密視窗等情況存不了，不影響使用 */ } };
  const deptCls = id => 'd-' + (DEPT[id] ? id : 'none');
  const deptName = id => DEPT[id] ? DEPT[id].name : '';
  const dtag = id => DEPT[id] ? `<span class="dtag ${deptCls(id)}">${esc(DEPT[id].name)}</span>` : '';
  const prioPill = n => n.priority && n.priority !== 'normal' && PRIO[n.priority] ? `<span class="pill p-${n.priority}">${PRIO[n.priority].name}</span>` : '';
  const statusPill = n => `<span class="pill s-${esc(n.status)}">${STATUS[n.status] || ''}</span>`;
  const startMsOf = (ev, day) => {
    const d = parse(day);
    if (ev.allDay || !ev.time) d.setHours(8, 0, 0, 0);
    else { const [h, m] = ev.time.split(':').map(Number); d.setHours(h || 0, m || 0, 0, 0); }
    return d.getTime();
  };

  // ================= 權限 =================
  const can = p => !!A && A.can(p);
  const isAdmin = () => !!A && A.isAdmin();
  const myEmail = () => String(A ? A.email() : '').toLowerCase();
  const myName = () => (A && A.name()) || '';
  const postDepts = () => DEPTS.filter(d => can(d.id));
  const canHandle = () => can('production');
  const canEditNotice = n => n.src !== 'pb' && (isAdmin() || can(n.dept) || (!!n.byEmail && n.byEmail === myEmail()));
  const canAddEvent = () => canHandle() || postDepts().length > 0;
  const canEditEvent = e => isAdmin() || canHandle() || (!!e.dept && can(e.dept)) || (!!e.byEmail && e.byEmail === myEmail());
  const permName = p => (PERMS.find(x => x.id === p) || { name: p }).name;

  // ================= 資料 =================
  const notices = () => S.list('notices').concat(pbNotices());
  const getNotice = id => String(id || '').startsWith('pb-') ? pbNotices().find(n => n.id === id) || null : S.get('notices', id);

  // 夥伴交接看板的任務 → 看板通知的格式（內容以夥伴交接看板為準；生產部的處理紀錄存在 pbstate）
  const hasPb = () => S.list('pbtasks').length > 0;
  const laneDepts = () => (hasPb() ? [HANDOVER] : []).concat(DEPTS);
  let pbMemo = { t: null, s: null, out: [] };
  function pbNotices() {
    const t = S.list('pbtasks'), s = S.list('pbstate');
    if (pbMemo.t === t && pbMemo.s === s) return pbMemo.out;
    const st = Object.fromEntries(s.map(x => [x.id, x]));
    const out = t.filter(x => x && x.id && x.taskId).map(x => pbToNotice(x, st[x.id] || {}));
    pbMemo = { t, s, out };
    return out;
  }
  function pbToNotice(t, s) {
    // 依負責人的部門放進各部門欄；生產部以外的任務只顯示（ro），狀態照夥伴交接看板，由負責人自己在那邊勾完成
    const dept = DEPT[t.dept] ? t.dept : 'handover', ro = dept !== 'handover';
    if (ro) s = {};
    // 生產部按了完成／取消，但夥伴交接看板還沒收到（pushedAt 比較舊）→ 先照生產部的決定顯示，標「回報中」
    const decided = typeof s.want === 'boolean';
    const pending = decided && (Number(t.pushedAt) || 0) < (Number(s.wantAt) || 0);
    const done = pending ? s.want : !!t.done;
    const status = done ? 'done' : ro ? 'ext' : (s.status && s.status !== 'done' ? s.status : (s.ackAt ? 'ack' : 'new'));
    const seen = Number(t.seenAt) || 0, content = String(t.content || '').trim();
    const title = t.title || content.split('\n')[0] || '（沒有內容）';
    // 夥伴交接看板的標題就是內容的第一行：說明只放第一行之後的部分，避免重複
    const body = content.startsWith(title) ? content.slice(title.length).trim() : content;
    return {
      id: t.id, src: 'pb', dept, type: ro ? '夥伴交接任務' : '交辦任務', title,
      body, items: '', qty: '',
      date: seen > 1 ? ymd(new Date(seen)) : '', due: t.dueDate || '', dueEnd: '', priority: 'normal', status, onCal: true,
      owner: t.partner || '', reply: s.reply || '', replyBy: s.replyBy, replyAt: s.replyAt,
      by: '夥伴交接看板', at: seen, ackBy: s.ackBy, ackAt: s.ackAt,
      doneBy: done ? (s.doneBy || t.partner) : '', doneAt: done ? (s.doneAt || Date.parse(t.completedAt) || seen) : 0,
      pb: { ro, role: t.role || '', partner: t.partner, taskId: t.taskId, platformDone: !!t.done, pending, want: s.want, feedback: t.feedback, proposerNote: t.proposerNote, attachments: Number(t.attachments) || 0, status: t.status, completedAt: t.completedAt }
    };
  }
  const events = () => S.list('events');
  const settings = () => { const s = S.get('settings', 'main') || {}; return Object.assign({}, DEFAULT_SET, s, { types: Object.assign({}, s.types || {}) }); };
  const typesOf = dept => { const t = settings().types[dept]; return Array.isArray(t) && t.length ? t : (DEPT[dept] ? DEPT[dept].types : []); };
  const saveSettings = patch => S.save('settings', Object.assign({}, S.get('settings', 'main') || {}, patch, { id: 'main', upBy: myName(), upAt: Date.now() }));
  const prefs = () => Object.assign({ sound: true, desk: false, projDepts: null }, lsGet('pd_prefs', {}));
  const setPrefs = p => lsSet('pd_prefs', Object.assign(prefs(), p));

  // 到期狀態：over 逾期、today 今天（或期間進行中）、soon 7 天內、later 之後、done 已完成
  function dueInfo(n, t = today()) {
    if (!n.due) return null;
    const end = n.dueEnd && n.dueEnd > n.due ? n.dueEnd : '';
    const ref = end || n.due, d = diff(t, n.due);
    if (n.status === 'done') return { cls: 'done', text: '', d };
    if (end && n.due <= t && t <= end) return { cls: 'today', text: '期間中', d: 0 };
    if (ref < t) return { cls: 'over', text: `逾期 ${diff(ref, t)} 天`, d };
    if (d === 0) return { cls: 'today', text: '今天', d };
    if (d === 1) return { cls: 'soon', text: '明天', d };
    if (d <= 7) return { cls: 'soon', text: `${d} 天後`, d };
    return { cls: 'later', text: `${d} 天後`, d };
  }
  const dueRange = n => n.dueEnd && n.dueEnd > n.due ? `${mdw(n.due)}～${mdw(n.dueEnd)}` : mdw(n.due);
  const dueHtml = n => { const di = dueInfo(n); return di ? `<span class="due ${di.cls}">${esc(di.text)}<span class="dd">${esc(dueRange(n))}</span></span>` : ''; };
  const bucket = n => { const di = dueInfo(n); return di ? { over: 0, today: 1, soon: 2, later: 3, done: 5 }[di.cls] : 4; };
  const dueGroup = n => n.status === 'done' ? 'done' : ((dueInfo(n) || { cls: 'none' }).cls);
  // 排序：未完成在前 → 緊急 → 逾期／今天／7 天內／之後／沒日期 → 重要 → 到期日 → 新發布
  const sortKey = n => [n.status === 'done' ? 1 : 0, n.priority === 'urgent' ? 0 : 1, bucket(n), (PRIO[n.priority] || PRIO.normal).rank, n.due || '9999-99-99', -(n.at || 0)];
  function cmpNotice(a, b) {
    const ka = sortKey(a), kb = sortKey(b);
    for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
    return 0;
  }
  const isRecentDone = n => n.status === 'done' && (Date.now() - (n.doneAt || 0)) < (Number(settings().doneDays) || 0) * 86400000;

  // 行程在 from～to 之間的每一次（含重複、跨天）
  function occurrences(e, from, to) {
    if (!e.date) return [];
    const span = e.end && e.end > e.date ? diff(e.date, e.end) : 0;
    const rep = e.repeat || 'none', out = [];
    const push = s => { const en = addDays(s, span); if (s <= to && en >= from) out.push({ start: s, end: en }); };
    if (rep === 'weekly' || rep === 'biweekly') {
      const step = rep === 'weekly' ? 7 : 14;
      let i = Math.max(0, Math.floor((diff(e.date, from) - span) / step));
      for (let n = 0; n < 500; n++, i++) {
        const s = addDays(e.date, i * step);
        if (s > to || (e.until && s > e.until)) break;
        push(s);
      }
    } else if (rep === 'monthly') {
      const d0 = parse(e.date), dom = d0.getDate(), f = parse(from);
      let y = f.getFullYear(), m = f.getMonth() - 1;
      if (y * 12 + m < d0.getFullYear() * 12 + d0.getMonth()) { y = d0.getFullYear(); m = d0.getMonth(); }
      for (let j = 0; j < 500; j++) {
        const dt = new Date(y, m + j, dom);
        if (dt.getDate() !== dom) continue;   // 這個月沒有這一天（例如 31 日）
        const s = ymd(dt);
        if (s > to || (e.until && s > e.until)) break;
        if (s >= e.date) push(s);
      }
    } else push(e.date);
    return out;
  }

  // 日期 → 那天的行程與到期通知
  function entriesBetween(from, to, opt = {}) {
    const map = {}, depts = opt.depts || null;
    const add = (day, x) => { (map[day] = map[day] || []).push(x); };
    const each = (s, e, fn) => { let d = s < from ? from : s; const last = e > to ? to : e; for (let i = 0; d <= last && i < 400; i++, d = addDays(d, 1)) fn(d); };
    events().forEach(ev => {
      if (opt.proj && ev.proj === false) return;
      if (depts && ev.dept && !depts.includes(ev.dept)) return;
      occurrences(ev, from, to).forEach(o => each(o.start, o.end, day => add(day, { kind: 'event', ev, day, start: o.start, end: o.end, first: day === o.start })));
    });
    notices().forEach(n => {
      if (!n.due || n.onCal === false) return;
      if (opt.proj && (n.status === 'done' || !projAllowed(n.dept))) return;
      if (!opt.proj && depts && !depts.includes(n.dept)) return;
      const end = n.dueEnd && n.dueEnd > n.due ? n.dueEnd : n.due;
      each(n.due, end, day => add(day, { kind: 'notice', n, day, start: n.due, end }));
    });
    Object.keys(map).forEach(k => map[k].sort(cmpEntry));
    return map;
  }
  function cmpEntry(a, b) {
    const r = x => x.kind === 'event' ? (x.ev.allDay || !x.ev.time || !x.first ? 0 : 1) : 2;
    const ra = r(a), rb = r(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return a.ev.time.localeCompare(b.ev.time);
    if (ra === 2) return cmpNotice(a.n, b.n);
    return String(a.ev.title || '').localeCompare(String(b.ev.title || ''));
  }
  const evTimeLabel = x => {
    const ev = x.ev;
    if (ev.allDay || !ev.time) return x.start !== x.end ? '期間' : '全天';
    return x.first ? ev.time : '持續';
  };

  // ================= 畫面狀態 =================
  let view = '';
  const B = { status: 'open', group: 'dept', q: '', dept: '', quick: '' };   // 看板篩選
  const C = { month: today().slice(0, 7), sel: today(), mode: 'month' };      // 行事曆
  let drawerRef = null;   // 目前打開的詳細資料 { kind, id, day }
  let rq = false;
  const queueRender = () => { if (rq) return; rq = true; requestAnimationFrame(() => { rq = false; renderAll(); }); };
  function renderAll() {
    renderSide();
    if (view === 'board') renderBoardBody();
    else if (view === 'calendar') renderCalendar();
    else if (view === 'manage') renderManageLive();
    if (proj.on) projRender();
    refreshDrawer();
  }

  function route() {
    const h = (location.hash || '').slice(1);
    const v = ['board', 'calendar', 'manage', 'projector'].includes(h) ? h : 'board';
    if (v === 'projector') { projEnter(); return; }
    if (proj.on) projExit(true);
    view = v;
    $$('.nav-btn').forEach(a => a.classList.toggle('on', a.dataset.view === v));
    ['board', 'calendar', 'manage'].forEach(k => { $('#view-' + k).hidden = k !== v; });
    renderSide();
    if (v === 'board') renderBoard();
    else if (v === 'calendar') renderCalendar();
    else renderManage();
    window.scrollTo(0, 0);
  }

  // ================= 側邊欄 =================
  function renderSide() {
    const all = notices(), open = all.filter(n => n.status !== 'done');
    const newCnt = open.filter(n => n.status === 'new').length;
    const nb = $('#navNew'); nb.hidden = !newCnt; nb.textContent = newCnt;
    document.title = (newCnt ? `(${newCnt}) ` : '') + '生產部看板';
    $('#deptList').innerHTML = laneDepts().map(d => {
      const mine = open.filter(n => n.dept === d.id), nw = mine.filter(n => n.status === 'new').length;
      return `<button type="button" class="dept-row ${deptCls(d.id)} ${B.dept === d.id && view === 'board' ? 'on' : ''}" data-act="dept-filter" data-dept="${d.id}"><span class="sw"></span>${esc(d.name)}${nw ? `<span class="new">${nw} 新</span>` : ''}<span class="cnt">${mine.length}</span></button>`;
    }).join('');
    renderSync();
  }
  function syncText(st) {
    return ({ loading: '讀取中…', syncing: st.detail || '同步中…', synced: '已同步' + (st.lastSync ? ' ' + hm(st.lastSync) : ''), pending: '等待上傳…', offline: st.detail || '離線中', error: st.detail || '同步失敗' })[st.state] || st.state;
  }
  function renderSync() {
    const st = S.status(), el = $('#syncBox'), txt = syncText(st);
    el.dataset.state = st.state;
    $('#syncText').textContent = txt.length > 22 ? txt.slice(0, 21) + '…' : txt;
    el.title = txt + '（點一下立即同步）';
    const ps = $('#pSync'); if (ps) { ps.dataset.state = st.state; ps.title = txt; }
    const ms = $('#mSync'); if (ms) ms.textContent = txt + (st.dirty ? `（${st.dirty} 類修改等待上傳）` : '');
  }
  function roleText() {
    if (isAdmin()) return '管理員';
    if (canHandle()) return '生產部';
    const p = postDepts();
    return p.length ? p.slice(0, 2).map(d => d.name).join('、') + (p.length > 2 ? '…' : '') : '檢視';
  }
  function renderMe() {
    const box = $('#meBox');
    box.innerHTML = A && A.user() ? `<b>${esc(myName())}</b><span class="role">${esc(roleText())}</span><button type="button" data-act="logout">登出</button>` : '';
  }
  function applyPerms() {
    const b = document.body;
    b.classList.toggle('is-admin', isAdmin());
    b.classList.toggle('can-production', canHandle());
    b.classList.toggle('can-post', postDepts().length > 0);
    b.classList.toggle('can-event', canAddEvent());
  }

  // ================= 看板總覽 =================
  function renderBoard() {
    const el = $('#view-board');
    if (!el.dataset.built) {
      el.innerHTML = `
        <header class="vh">
          <div><h1>看板總覽</h1><p class="sub" id="bSub"></p></div>
          <div class="vh-actions">
            <button type="button" class="btn need-event" data-act="new-event">＋ 新增行程</button>
            <button type="button" class="btn primary need-post" data-act="new-notice">＋ 新增通知</button>
          </div>
        </header>
        <div id="bBanner"></div>
        <div class="stats" id="bStats"></div>
        <div class="todaybar" id="bToday"></div>
        <div class="toolbar">
          <div class="seg" role="group" aria-label="狀態" id="bStatus">${[['open', '未完成'], ['new', '待確認'], ['done', '已完成'], ['all', '全部']].map(([k, t]) => `<button type="button" data-act="b-status" data-v="${k}">${t}</button>`).join('')}</div>
          <div class="seg" role="group" aria-label="分組方式" id="bGroup">${[['dept', '依部門'], ['due', '依到期日']].map(([k, t]) => `<button type="button" data-act="b-group" data-v="${k}">${t}</button>`).join('')}</div>
          <input class="search" id="bSearch" type="search" placeholder="搜尋標題、品項、說明…" aria-label="搜尋通知">
          <span class="toolbar" id="bFilters"></span>
        </div>
        <div id="bLanes" class="lanes"></div>`;
      el.dataset.built = '1';
      $('#bSearch').addEventListener('input', e => { B.q = e.target.value.trim(); renderBoardBody(); });
    }
    renderBoardBody();
  }
  const QUICK = {
    new: ['待確認', n => n.status === 'new'],
    over: ['逾期', n => n.status !== 'done' && bucket(n) === 0],
    today: ['今天到期', n => n.status !== 'done' && bucket(n) === 1],
    week: ['7 天內到期', n => n.status !== 'done' && (bucket(n) === 1 || bucket(n) === 2)],
    urgent: ['緊急', n => n.status !== 'done' && n.priority === 'urgent']
  };
  function renderBoardBody() {
    if (!$('#bLanes')) return;
    const t = today(), all = notices(), st = S.status(), set = settings();
    $('#bSub').textContent = `${t.replace(/-/g, '/')}（${wk(t)}）・採購、門市、倉管、物管、通路、產銷會議要給生產部的事`;
    $('#bBanner').innerHTML = set.demo
      ? `<div class="banner"><span>目前看到的是<b>示範資料</b>，方便試用各項功能；正式使用前請清除。</span><button type="button" class="btn sm need-admin" data-act="clear-demo">清除示範資料</button></div>`
      : (!st.loaded && !all.length ? `<div class="banner">正在讀取雲端資料…</div>` : '');
    // 統計（點一下篩選）
    $('#bStats').innerHTML = Object.keys(QUICK).map(k => {
      const v = all.filter(QUICK[k][1]).length;
      return `<button type="button" class="stat k-${k} ${B.quick === k ? 'on' : ''}" data-act="quick" data-k="${k}" aria-pressed="${B.quick === k}"><span class="lb">${QUICK[k][0]}</span><span class="v ${v ? '' : 'zero'}">${v}</span></button>`;
    }).join('');
    // 今日行程
    const evs = (entriesBetween(t, t)[t] || []).filter(x => x.kind === 'event');
    $('#bToday').innerHTML = `<span class="lb">今日行程</span>` +
      (evs.length ? evs.map(x => `<button type="button" class="chip ${deptCls(x.ev.dept)}" data-act="open-event" data-id="${esc(x.ev.id)}" data-day="${t}"><span class="t">${esc(evTimeLabel(x))}</span><span>${esc(x.ev.title)}</span></button>`).join('') : '<span class="hint">今天沒有排定的行程</span>') +
      `<a class="btn sm ghost end" href="#calendar">開啟行事曆 →</a>`;
    $$('#bStatus button').forEach(b => b.classList.toggle('on', b.dataset.v === B.status));
    $$('#bGroup button').forEach(b => b.classList.toggle('on', b.dataset.v === B.group));
    $('#bFilters').innerHTML = [
      B.quick ? `<button type="button" class="filter-chip" data-act="quick" data-k="${B.quick}">篩選：${QUICK[B.quick][0]} ×</button>` : '',
      B.dept ? `<button type="button" class="filter-chip" data-act="dept-filter" data-dept="${B.dept}">只看：${esc(deptName(B.dept))} ×</button>` : ''
    ].join('');
    // 篩選
    let list = all.slice();
    if (B.quick) list = list.filter(QUICK[B.quick][1]);
    else if (B.status === 'open') list = list.filter(n => n.status !== 'done' || isRecentDone(n));
    else if (B.status === 'new') list = list.filter(n => n.status === 'new');
    else if (B.status === 'done') list = list.filter(n => n.status === 'done');
    if (B.dept) list = list.filter(n => n.dept === B.dept);
    if (B.q) {
      const q = B.q.toLowerCase();
      list = list.filter(n => [n.title, n.body, n.items, n.qty, n.type, n.owner, n.reply, deptName(n.dept), n.by].join(' ').toLowerCase().includes(q));
    }
    list.sort(B.status === 'done' && !B.quick ? (a, b) => (b.doneAt || 0) - (a.doneAt || 0) : cmpNotice);
    // 分欄
    let lanes;
    if (B.group === 'due') {
      lanes = [['over', '逾期'], ['today', '今天'], ['soon', '7 天內'], ['later', '之後'], ['none', '未訂日期'], ['done', '已完成']]
        .map(([k, title]) => ({ title, cls: 'g-' + k, items: list.filter(n => dueGroup(n) === k) }))
        .filter(l => l.items.length);
    } else {
      lanes = (B.dept ? laneDepts().filter(d => d.id === B.dept) : laneDepts()).map(d => ({
        dept: d.id, title: d.id === 'handover' ? '交辦給生產部的任務（夥伴交接看板）' : d.name,
        cls: d.id === 'handover' && !B.dept ? 'wide' : '', items: list.filter(n => n.dept === d.id)
      }));
    }
    const box = $('#bLanes');
    box.className = 'lanes' + (B.dept && B.group === 'dept' ? ' one' : '');
    box.innerHTML = lanes.length ? lanes.map(laneHtml).join('') : `<div class="empty panel">${st.loaded || all.length ? '沒有符合條件的通知' : '讀取中…'}</div>`;
  }
  function laneHtml(l) {
    const nw = l.items.filter(n => n.status === 'new').length;
    const head = `<span class="dtag ${l.dept ? deptCls(l.dept) : 'd-none'}">${esc(l.title)}</span>`;
    const add = l.dept && DEPTS.some(d => d.id === l.dept) && can(l.dept) ? `<button type="button" class="icon-btn" data-act="new-notice" data-dept="${l.dept}" title="新增${esc(l.title)}通知" aria-label="新增${esc(l.title)}通知">＋</button>` : '';
    const empty = S.status().loaded || notices().length
      ? (B.status === 'open' && !B.quick && !B.q ? (l.dept === 'handover' ? '目前沒有交辦給生產部的任務' : '目前沒有未完成的事項') : '沒有符合條件的通知')
      : '讀取中…';
    return `<section class="lane ${l.cls || ''}"><div class="lane-h">${head}<span class="cnt">${l.items.length}</span>${nw ? `<span class="new">${nw} 待確認</span>` : ''}${add}</div>
      <div class="cards">${l.items.length ? l.items.map(cardHtml).join('') : `<div class="empty">${empty}</div>`}</div></section>`;
  }
  function cardHtml(n) {
    const cls = ['card', deptCls(n.dept), n.priority === 'urgent' && n.status !== 'done' ? 'urgent' : '', n.status === 'new' ? 'is-new' : '', n.status === 'done' ? 'done' : ''].join(' ');
    const meta = [dueHtml(n), n.items ? `<span class="it">品項：${esc(n.items)}</span>` : '', n.qty ? `<span class="it">數量：${esc(n.qty)}</span>` : ''].filter(Boolean).join('');
    return `<div class="${cls}" role="button" tabindex="0" data-act="open-notice" data-id="${esc(n.id)}">
      <div class="c-top">${B.group === 'due' ? dtag(n.dept) : ''}<span class="c-type">${esc(n.type || '')}</span>${prioPill(n)}${statusPill(n)}</div>
      <div class="c-title">${esc(n.title)}</div>
      ${meta ? `<div class="c-meta">${meta}</div>` : ''}
      <div class="c-foot">${n.src === 'pb'
        ? `<span>夥伴交接看板</span>${n.pb.attachments ? `<span>附件 ${n.pb.attachments} 張</span>` : ''}${n.pb.pending ? '<span class="pending">回報中</span>' : ''}`
        : `<span>${esc(n.by || '')} · ${esc(stamp(n.at))}</span>`}${n.owner ? `<span>負責：${esc(n.owner)}</span>` : ''}${n.reply ? '<span class="rp">已回覆</span>' : ''}</div>
    </div>`;
  }

  // ================= 詳細資料（右側）=================
  function openDrawer(ref) {
    drawerRef = ref;
    $('#drawer').hidden = false; $('#drawerScrim').hidden = false;
    renderDrawer();
    setTimeout(() => { const b = $('#drawer .dr-h .icon-btn'); if (b) b.focus(); }, 30);
  }
  function closeDrawer() { drawerRef = null; $('#drawer').hidden = true; $('#drawerScrim').hidden = true; $('#drawer').innerHTML = ''; }
  function refreshDrawer() {
    if (!drawerRef) return;
    const a = document.activeElement;
    if (a && $('#drawer').contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;   // 正在打字就先不重畫
    renderDrawer();
  }
  function renderDrawer() {
    const r = drawerRef;
    const rec = r.kind === 'notice' ? getNotice(r.id) : S.get('events', r.id);
    if (!rec) { closeDrawer(); return; }
    $('#drawer').innerHTML = r.kind === 'notice' ? noticeDrawer(rec) : eventDrawer(rec, r.day);
  }
  function noticeDrawer(n) {
    const di = dueInfo(n), pb = n.src === 'pb';
    const rows = [
      [pb ? '預交日' : '需處理日', n.due ? dueRange(n) + (di && di.text ? `　${di.text}` : '') : '未訂'],
      ['相關品項', n.items], ['數量／規格', n.qty], [pb ? '任務內容' : '說明', n.body], [pb ? '負責人' : '生產部負責', n.owner]
    ].concat(pb ? [
      ['提案人備註', n.pb.proposerNote], ['夥伴回饋', n.pb.feedback],
      ['附件', n.pb.attachments ? `${n.pb.attachments} 張（請到夥伴交接看板查看）` : ''],
      ['夥伴交接看板', (n.pb.platformDone ? '已完成' : '未完成') + (n.pb.status ? `（${n.pb.status}）` : '')]
    ] : []).filter(r => r[1]);
    const prod = pb && n.pb.ro
      ? `<div class="box"><p class="hint">這是「${esc(n.owner || '其他部門')}」在夥伴交接看板的任務，只顯示給生產部參考；完成要由負責人在夥伴交接看板勾選，這裡最慢 5 分鐘會跟著更新。</p></div>`
      : canHandle() ? `
      <div class="box prod"><h3>生產部處理</h3>
        <div class="btn-row">
          ${n.status === 'new' ? '<button type="button" class="btn primary" data-act="n-status" data-v="ack">確認收到</button>' : ''}
          ${n.status !== 'doing' && n.status !== 'done' ? '<button type="button" class="btn" data-act="n-status" data-v="doing">處理中</button>' : ''}
          ${n.status !== 'done' ? `<button type="button" class="btn" data-act="n-status" data-v="done">${pb ? '標示完成並回報' : '標示完成'}</button>` : '<button type="button" class="btn" data-act="n-status" data-v="reopen">改回未完成</button>'}
        </div>
        ${pb ? '<p class="hint">標示完成會回報到夥伴交接看板，並通知提案人；改回未完成也會同步取消。</p>' : `<label class="field"><span>生產部負責人</span><input id="drOwner" maxlength="30" value="${esc(n.owner || '')}" placeholder="例：早班 陳組長"></label>`}
        <label class="field"><span>${pb ? '生產部備註（只留在生產部看板）' : '回覆給' + esc(deptName(n.dept))}</span><textarea id="drReply" rows="3" maxlength="500" placeholder="${pb ? '例：等模具到貨後週四處理' : '例：已調整排程，先改用替代品牌試做一批'}">${esc(n.reply || '')}</textarea></label>
        <div class="btn-row"><button type="button" class="btn" data-act="n-reply">${pb ? '儲存備註' : '儲存回覆'}</button></div>
      </div>` : '';
    const pbNote = pb && n.pb.pending
      ? `<div class="banner">${n.pb.want ? '已標示完成，正在回報夥伴交接看板' : '已改回未完成，正在通知夥伴交接看板'}。如果一直沒有更新，系統每 5 分鐘會自動重試。</div>` : '';
    return `<div class="dr-h">${dtag(n.dept)}<span class="c-type">${esc(n.type || '')}</span><button type="button" class="icon-btn" data-act="close-drawer" aria-label="關閉">×</button></div>
      <div class="dr-b">
        <h2 id="drTitle">${esc(n.title)}</h2>
        <div class="dr-pills">${prioPill(n)}${statusPill(n)}${n.due && n.onCal !== false ? '<span class="pill">在行事曆上</span>' : ''}</div>
        ${pbNote}
        <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        ${n.reply ? `<div class="reply">${esc(n.reply)}<small>${pb ? '生產部備註' : '生產部回覆'} · ${esc(n.replyBy || '')} ${esc(stamp(n.replyAt))}</small></div>` : ''}
        ${prod}
        <div class="log">
          <span>${pb ? '來源：夥伴交接看板' + (n.at > 1 ? ' · 帶進看板 ' + esc(stamp(n.at)) : '') : `發布：${esc(n.by || '')} · ${esc(stamp(n.at))}`}</span>
          ${n.upAt ? `<span>修改：${esc(n.upBy || '')} · ${esc(stamp(n.upAt))}</span>` : ''}
          ${n.ackAt ? `<span>確認收到：${esc(n.ackBy || '')} · ${esc(stamp(n.ackAt))}</span>` : ''}
          ${n.status === 'done' && n.doneAt ? `<span>完成：${esc(n.doneBy || '')} · ${esc(stamp(n.doneAt))}</span>` : ''}
        </div>
      </div>
      ${canEditNotice(n) ? `<div class="dr-f"><button type="button" class="btn" data-act="edit-notice" data-id="${esc(n.id)}">編輯</button><button type="button" class="btn danger" data-act="del-notice" data-id="${esc(n.id)}">刪除</button></div>` : ''}`;
  }
  function eventWhen(e, day) {
    let s = e.end && e.end > e.date ? `${mdw(day || e.date)} 起，共 ${diff(e.date, e.end) + 1} 天` : mdw(day || e.date);
    s += e.allDay || !e.time ? '　全天' : `　${e.time}${e.endTime ? '–' + e.endTime : ''}`;
    return s;
  }
  function eventDrawer(e, day) {
    const remind = (e.allDay || !e.time ? REMIND_ALLDAY : REMIND_TIMED).find(r => r[0] === (e.remind == null ? -1 : +e.remind));
    const rows = [
      ['時間', eventWhen(e, day)],
      ['重複', e.repeat && e.repeat !== 'none' ? `${REPEAT[e.repeat]}（${mdw(e.date)} 起${e.until ? '，到 ' + mdw(e.until) : ''}）` : ''],
      ['類型', ETYPE[e.etype] || ''], ['地點', e.place], ['說明', e.note],
      ['提醒', remind ? remind[1] : ''], ['投影', e.proj === false ? '不顯示' : '顯示']
    ].filter(r => r[1]);
    return `<div class="dr-h">${e.dept ? dtag(e.dept) : '<span class="dtag d-none">生產部</span>'}<span class="c-type">行程</span><button type="button" class="icon-btn" data-act="close-drawer" aria-label="關閉">×</button></div>
      <div class="dr-b">
        <h2 id="drTitle">${esc(e.title)}</h2>
        <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <div class="log"><span>建立：${esc(e.by || '')} · ${esc(stamp(e.at))}</span>${e.upAt ? `<span>修改：${esc(e.upBy || '')} · ${esc(stamp(e.upAt))}</span>` : ''}</div>
      </div>
      ${canEditEvent(e) ? `<div class="dr-f"><button type="button" class="btn" data-act="edit-event" data-id="${esc(e.id)}">編輯</button><button type="button" class="btn danger" data-act="del-event" data-id="${esc(e.id)}">刪除</button></div>` : ''}`;
  }
  // 交辦任務的處理紀錄（pbstate，一筆對應一個任務）
  function savePbState(id, patch) {
    const cur = S.get('pbstate', id) || { id };
    S.save('pbstate', Object.assign({}, cur, patch, { id, upBy: myName(), upAt: Date.now() }));
  }
  function setPbStatus(n, v) {
    const now = Date.now(), who = myName(), patch = {};
    if (v !== 'reopen' && !n.ackAt) { patch.ackBy = who; patch.ackAt = now; }
    if (v === 'ack' || v === 'doing') {
      patch.status = v;
      savePbState(n.id, patch);
      toast(v === 'ack' ? '已確認收到' : '已標示處理中');
      return;
    }
    // 完成／改回未完成：記下決定（回報失敗時後端會依這筆重試），並立刻回報夥伴交接看板
    const want = v === 'done';
    Object.assign(patch, { status: want ? 'done' : 'ack', want, wantAt: now }, want ? { doneBy: who, doneAt: now } : {});
    savePbState(n.id, patch);
    toast(want ? '已標示完成，正在回報夥伴交接看板…' : '已改回未完成，正在通知夥伴交接看板…');
    A.api('pbDone', { id: n.id, want, wantAt: now })
      .then(() => { toast(want ? `已回報夥伴交接看板：「${n.title}」完成` : `已在夥伴交接看板取消完成：「${n.title}」`); S.syncNow().catch(() => {}); })
      .catch(e => toast(`回報夥伴交接看板失敗：${e.message}（之後每 5 分鐘會自動重試）`, true));
  }
  function setNoticeStatus(n, v) {
    if (n.src === 'pb') { setPbStatus(n, v); return; }
    const now = Date.now(), who = myName(), patch = {};
    if (v === 'reopen') patch.status = 'ack';
    else patch.status = v;
    if (v !== 'reopen' && !n.ackAt) { patch.ackBy = who; patch.ackAt = now; }
    if (v === 'done') { patch.doneBy = who; patch.doneAt = now; }
    S.save('notices', Object.assign({}, n, patch));
    toast({ ack: '已確認收到', doing: '已標示處理中', done: '已標示完成', reopen: '已改回未完成' }[v]);
  }
  // 刪除要按兩次（不跳視窗）
  function armDelete(btn, run) {
    if (btn.classList.contains('armed')) { run(); return; }
    btn.classList.add('armed'); btn.textContent = '再按一次確認刪除';
    setTimeout(() => { if (btn.isConnected) { btn.classList.remove('armed'); btn.textContent = '刪除'; } }, 4000);
  }

  // ================= 表單 =================
  function openModal(html, onSubmit, onReady) {
    $('#modalBox').innerHTML = html;
    $('#modal').hidden = false;
    const f = $('#modalBox form');
    f.addEventListener('submit', ev => { ev.preventDefault(); onSubmit(f); });
    if (onReady) onReady(f);
    setTimeout(() => { const first = f.querySelector('[data-first]') || f.querySelector('input:not([type=checkbox]):not([type=radio]),select,textarea'); if (first) first.focus(); }, 30);
  }
  function closeModal() { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; }
  const formMsg = t => { const m = $('#modalBox .msg'); if (m) m.textContent = t || ''; };
  const modalShell = (title, body, submit) => `<form novalidate>
      <div class="md-h"><h2 id="mdTitle">${title}</h2><button type="button" class="icon-btn" data-act="close-modal" aria-label="關閉">×</button></div>
      <div class="md-b">${body}</div>
      <div class="md-f"><span class="msg" role="alert"></span><button type="button" class="btn" data-act="close-modal">取消</button><button type="submit" class="btn primary">${submit}</button></div>
    </form>`;

  function openNoticeForm(n, presetDept) {
    const editing = !!n;
    let depts = postDepts();
    if (editing && !depts.some(d => d.id === n.dept) && DEPT[n.dept]) depts = depts.concat([DEPT[n.dept]]);
    if (!depts.length) { toast('你還沒有發布通知的權限，請管理員在「設定與人員」幫你開啟', true); return; }
    const v = n || { dept: depts.some(d => d.id === presetDept) ? presetDept : depts[0].id, priority: 'normal', onCal: true };
    const typeOpts = dept => {
      const ts = typesOf(dept).slice();
      if (v.type && v.dept === dept && !ts.includes(v.type)) ts.push(v.type);
      return ts.map(t => `<option ${t === v.type ? 'selected' : ''}>${esc(t)}</option>`).join('') + `<option value="">其他</option>`;
    };
    const body = `
      <label class="field"><span>發布部門 <b class="req">*</b></span><select id="nfDept">${depts.map(d => `<option value="${d.id}" ${d.id === v.dept ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
      <label class="field"><span>類別</span><select id="nfType">${typeOpts(v.dept)}</select></label>
      <label class="field full"><span>標題 <b class="req">*</b></span><input id="nfTitle" data-first maxlength="80" value="${esc(v.title || '')}" placeholder="一句話說清楚，例：奶油乳酪 11/20 到貨延後至 11/24"></label>
      <label class="field full"><span>說明</span><textarea id="nfBody" rows="3" maxlength="1000" placeholder="原因、影響、需要生產部做什麼">${esc(v.body || '')}</textarea></label>
      <label class="field"><span>相關品項</span><input id="nfItems" maxlength="120" value="${esc(v.items || '')}" placeholder="例：6 吋原味、小原"></label>
      <label class="field"><span>數量／規格</span><input id="nfQty" maxlength="80" value="${esc(v.qty || '')}" placeholder="例：120 盒、每箱 12 入"></label>
      <label class="field"><span>需處理日期</span><input id="nfDue" type="date" value="${esc(v.due || '')}"></label>
      <label class="field"><span>結束日期 <span class="hint">（檔期、期間才填）</span></span><input id="nfEnd" type="date" value="${esc(v.dueEnd || '')}"></label>
      <div class="field full"><span>優先程度</span><div class="radios">${['normal', 'high', 'urgent'].map(p => `<label class="r-${p}"><input type="radio" name="nfPrio" value="${p}" ${v.priority === p ? 'checked' : ''}>${PRIO[p].name}</label>`).join('')}</div></div>
      <label class="check full"><input type="checkbox" id="nfCal" ${v.onCal !== false ? 'checked' : ''}>有日期時，顯示在行事曆和投影的「7 天內到期」</label>
      ${editing && n.status !== 'new' ? '<label class="check full"><input type="checkbox" id="nfRenotify" checked>改回「待確認」，重新通知生產部（投影會再跳出一次）</label>' : ''}`;
    openModal(modalShell(editing ? '編輯通知' : '新增給生產部的通知', body, editing ? '儲存修改' : '發布通知'), () => {
      const g = id => $('#' + id).value.trim();
      const rec = {
        dept: g('nfDept'), type: g('nfType'), title: g('nfTitle'), body: g('nfBody'), items: g('nfItems'), qty: g('nfQty'),
        due: g('nfDue'), dueEnd: g('nfEnd'), priority: ($('input[name=nfPrio]:checked') || { value: 'normal' }).value, onCal: $('#nfCal').checked
      };
      if (!rec.title) { formMsg('請填標題'); $('#nfTitle').focus(); return; }
      if (rec.dueEnd && !rec.due) { formMsg('有結束日期時，也請填需處理日期'); return; }
      if (rec.dueEnd && rec.dueEnd < rec.due) { formMsg('結束日期不能早於需處理日期'); return; }
      if (rec.dueEnd === rec.due) rec.dueEnd = '';
      const now = Date.now();
      if (editing) {
        const next = Object.assign({}, n, rec, { upBy: myName(), upByEmail: myEmail(), upAt: now });
        const re = $('#nfRenotify');
        if (re && re.checked) { next.status = 'new'; next.rev = (n.rev || 0) + 1; }
        S.save('notices', next);
        toast('已儲存');
      } else {
        S.save('notices', Object.assign({ id: uid('n'), date: today(), status: 'new', by: myName(), byEmail: myEmail(), at: now }, rec));
        toast('已發布，生產部的看板和投影會立刻顯示');
      }
      closeModal();
    }, () => {
      $('#nfDept').addEventListener('change', e => { v.dept = e.target.value; $('#nfType').innerHTML = typeOpts(v.dept); });
    });
  }

  function openEventForm(e, presetDay) {
    const editing = !!e, all = canHandle();
    let depts = all ? DEPTS : postDepts();
    if (editing && e.dept && !depts.some(d => d.id === e.dept) && DEPT[e.dept]) depts = depts.concat([DEPT[e.dept]]);
    if (!all && !depts.length) { toast('你還沒有新增行程的權限，請管理員在「設定與人員」幫你開啟', true); return; }
    const v = e || { date: presetDay || today(), allDay: false, time: '09:00', endTime: '', etype: all ? 'production' : 'other', dept: all ? '' : depts[0].id, remind: 30, repeat: 'none', proj: true };
    const remindOpts = allDay => (allDay ? REMIND_ALLDAY : REMIND_TIMED).map(([m, t]) => `<option value="${m}" ${+v.remind === m ? 'selected' : ''}>${t}</option>`).join('');
    const body = `
      <label class="field full"><span>行程名稱 <b class="req">*</b></span><input id="efTitle" data-first maxlength="60" value="${esc(v.title || '')}" placeholder="例：產銷會議、奶油乳酪到貨、聖誕禮盒包裝"></label>
      <label class="field"><span>類型</span><select id="efType">${Object.keys(ETYPE).map(k => `<option value="${k}" ${k === v.etype ? 'selected' : ''}>${ETYPE[k]}</option>`).join('')}</select></label>
      <label class="field"><span>相關部門</span><select id="efDept">${all ? `<option value="">生產部（不屬於其他部門）</option>` : ''}${depts.map(d => `<option value="${d.id}" ${d.id === v.dept ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
      <label class="field"><span>日期 <b class="req">*</b></span><input id="efDate" type="date" value="${esc(v.date || '')}"></label>
      <label class="field"><span>結束日期 <span class="hint">（連續多天才填）</span></span><input id="efEnd" type="date" value="${esc(v.end || '')}"></label>
      <label class="check full"><input type="checkbox" id="efAllDay" ${v.allDay ? 'checked' : ''}>全天</label>
      <label class="field ef-time"><span>開始時間</span><input id="efTime" type="time" value="${esc(v.time || '')}"></label>
      <label class="field ef-time"><span>結束時間</span><input id="efEndTime" type="time" value="${esc(v.endTime || '')}"></label>
      <label class="field"><span>重複</span><select id="efRepeat">${Object.keys(REPEAT).map(k => `<option value="${k}" ${k === (v.repeat || 'none') ? 'selected' : ''}>${REPEAT[k]}</option>`).join('')}</select></label>
      <label class="field" id="efUntilWrap"><span>重複到 <span class="hint">（空白＝一直重複）</span></span><input id="efUntil" type="date" value="${esc(v.until || '')}"></label>
      <label class="field"><span>地點</span><input id="efPlace" maxlength="40" value="${esc(v.place || '')}" placeholder="例：2F 會議室、B 線"></label>
      <label class="field"><span>提醒</span><select id="efRemind">${remindOpts(v.allDay)}</select></label>
      <label class="field full"><span>說明</span><textarea id="efNote" rows="2" maxlength="500">${esc(v.note || '')}</textarea></label>
      <label class="check full"><input type="checkbox" id="efProj" ${v.proj !== false ? 'checked' : ''}>顯示在投影畫面，並在投影上跳出提醒</label>`;
    openModal(modalShell(editing ? '編輯行程' : '新增行程', body, editing ? '儲存修改' : '加入行事曆'), () => {
      const g = id => $('#' + id).value.trim();
      const allDay = $('#efAllDay').checked || !g('efTime');
      const rec = {
        title: g('efTitle'), etype: g('efType'), dept: g('efDept'), date: g('efDate'), end: g('efEnd'), allDay,
        time: allDay ? '' : g('efTime'), endTime: allDay ? '' : g('efEndTime'), repeat: g('efRepeat'), until: g('efRepeat') === 'none' ? '' : g('efUntil'),
        place: g('efPlace'), note: g('efNote'), remind: Number(g('efRemind')), proj: $('#efProj').checked
      };
      if (!rec.title) { formMsg('請填行程名稱'); $('#efTitle').focus(); return; }
      if (!rec.date) { formMsg('請選日期'); return; }
      if (rec.end && rec.end < rec.date) { formMsg('結束日期不能早於開始日期'); return; }
      if (rec.end === rec.date) rec.end = '';
      if (rec.endTime && rec.time && rec.endTime <= rec.time && !rec.end) { formMsg('結束時間要晚於開始時間'); return; }
      if (rec.until && rec.until < rec.date) { formMsg('「重複到」不能早於開始日期'); return; }
      if (!all && !rec.dept) { formMsg('請選相關部門'); return; }
      const now = Date.now();
      if (editing) S.save('events', Object.assign({}, e, rec, { upBy: myName(), upAt: now }));
      else S.save('events', Object.assign({ id: uid('e'), by: myName(), byEmail: myEmail(), at: now }, rec));
      toast(editing ? '已儲存' : '已加入行事曆');
      C.sel = rec.date; C.month = rec.date.slice(0, 7);
      closeModal();
    }, () => {
      const sync = () => {
        const ad = $('#efAllDay').checked;
        $$('.ef-time', $('#modalBox')).forEach(x => { x.hidden = ad; });
        const cur = $('#efRemind').value;
        $('#efRemind').innerHTML = remindOpts(ad);
        if ($$('#efRemind option').some(o => o.value === cur)) $('#efRemind').value = cur;
        $('#efUntilWrap').hidden = $('#efRepeat').value === 'none';
      };
      $('#efAllDay').addEventListener('change', sync);
      $('#efRepeat').addEventListener('change', sync);
      sync();
    });
  }

  // ================= 行事曆 =================
  function renderCalendar() {
    const el = $('#view-calendar'), t = today();
    const [y, m] = C.month.split('-').map(Number);
    const first = new Date(y, m - 1, 1), dim = new Date(y, m, 0).getDate();
    const start = addDays(ymd(first), -first.getDay()), weeks = Math.ceil((first.getDay() + dim) / 7);
    const end = addDays(start, weeks * 7 - 1);
    const legend = laneDepts().map(d => `<span class="dtag ${deptCls(d.id)}">${esc(d.name)}</span>`).join('') + '<span class="dtag d-none">生產部</span><span class="k"><i class="lg-ev"></i>行程</span><span class="k"><i class="lg-nt"></i>通知到期</span>';
    let main;
    if (C.mode === 'month') {
      const map = entriesBetween(start, end);
      const cells = [];
      for (let i = 0; i < weeks * 7; i++) {
        const day = addDays(start, i), list = map[day] || [];
        const cls = ['cell', day.slice(0, 7) !== C.month ? 'out' : '', day === t ? 'today' : '', day === C.sel ? 'sel' : ''].join(' ');
        cells.push(`<div class="${cls}" role="button" tabindex="0" data-act="cal-day" data-day="${day}" aria-label="${md(day)}，${list.length} 筆">
          <div class="dn"><b>${parse(day).getDate()}</b><span class="dots">${list.slice(0, 4).map(x => `<i class="${deptCls(x.kind === 'event' ? x.ev.dept : x.n.dept)}"></i>`).join('')}</span></div>
          ${list.slice(0, 3).map(ceHtml).join('')}${list.length > 3 ? `<span class="more">還有 ${list.length - 3} 筆</span>` : ''}
        </div>`);
      }
      const selList = entriesBetween(C.sel, C.sel)[C.sel] || [];
      main = `<div class="cal-wrap">
          <div class="cal">${WEEK.map((w, i) => `<div class="wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}${cells.join('')}</div>
          <aside class="dayp panel">${dayPanel(C.sel, selList)}</aside>
        </div>`;
    } else {
      const from = C.month === t.slice(0, 7) ? t : ymd(first), to = addDays(from, 44);
      const map = entriesBetween(from, to);
      const days = Object.keys(map).sort();
      main = `<div class="panel agenda">${days.length ? days.map(d => `<div class="ag-day ${d === t ? 'today' : ''}"><span>${mdw(d)}</span>${d === t ? '<span>今天</span>' : ''}</div>${map[d].map(agHtml).join('')}`).join('') : '<div class="empty">接下來 45 天沒有行程或到期的通知</div>'}</div>`;
    }
    el.innerHTML = `
      <header class="vh"><div><h1>行事曆</h1><p class="sub">各部門的行程，以及通知的需處理日期</p></div>
        <div class="vh-actions"><button type="button" class="btn primary need-event" data-act="new-event" data-day="${C.sel}">＋ 新增行程</button></div></header>
      <div class="cal-head">
        <button type="button" class="icon-btn" data-act="cal-prev" aria-label="上個月">‹</button>
        <div class="month">${y} 年 ${m} 月</div>
        <button type="button" class="icon-btn" data-act="cal-next" aria-label="下個月">›</button>
        <button type="button" class="btn sm" data-act="cal-today">今天</button>
        <div class="seg" role="group" aria-label="顯示方式">${[['month', '月曆'], ['list', '清單']].map(([k, n]) => `<button type="button" data-act="cal-mode" data-v="${k}" class="${C.mode === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      </div>
      <div class="legend">${legend}</div>
      ${main}`;
  }
  function ceHtml(x) {
    if (x.kind === 'event') {
      const ev = x.ev, tm = !ev.allDay && ev.time && x.first ? ev.time : '';
      return `<span class="ce ${deptCls(ev.dept)}" data-act="open-event" data-id="${esc(ev.id)}" data-day="${x.day}">${tm ? `<span class="t">${esc(tm)}</span>` : ''}<span class="x">${esc(ev.title)}</span></span>`;
    }
    const n = x.n;
    return `<span class="ce nt ${deptCls(n.dept)} ${n.priority === 'urgent' && n.status !== 'done' ? 'urgent' : ''} ${n.status === 'done' ? 'done' : ''}" data-act="open-notice" data-id="${esc(n.id)}"><span class="x">${esc(deptName(n.dept))}｜${esc(n.title)}</span></span>`;
  }
  function dayPanel(day, list) {
    return `<h2>${mdw(day)}${day === today() ? '<span class="pill s-new">今天</span>' : ''}<button type="button" class="btn sm need-event" data-act="new-event" data-day="${day}">＋ 行程</button></h2>
      <div class="agenda">${list.length ? list.map(agHtml).join('') : '<div class="empty">這天沒有行程或到期的通知</div>'}</div>`;
  }
  function agHtml(x) {
    if (x.kind === 'event') {
      const ev = x.ev, timed = !ev.allDay && ev.time && x.first;
      const sub = [esc(ETYPE[ev.etype] || ''), ev.dept ? dtag(ev.dept) : '', ev.place ? '地點：' + esc(ev.place) : '', x.start !== x.end ? `${md(x.start)}～${md(x.end)}` : '', ev.repeat && ev.repeat !== 'none' ? REPEAT[ev.repeat] : ''].filter(Boolean);
      return `<div class="ag ${deptCls(ev.dept)}" role="button" tabindex="0" data-act="open-event" data-id="${esc(ev.id)}" data-day="${x.day}">
        <div class="tm">${esc(evTimeLabel(x))}${timed && ev.endTime ? `<small>到 ${esc(ev.endTime)}</small>` : ''}</div>
        <div class="bd"><span class="ti">${esc(ev.title)}</span><span class="sb">${sub.join('<span aria-hidden="true">·</span>')}</span></div></div>`;
    }
    const n = x.n;
    return `<div class="ag nt ${n.status === 'done' ? 'done' : ''}" role="button" tabindex="0" data-act="open-notice" data-id="${esc(n.id)}">
      <div class="tm">${x.start !== x.end ? '期間' : '到期'}<small>通知</small></div>
      <div class="bd"><span class="ti">${esc(n.title)}</span><span class="sb">${dtag(n.dept)}${n.type ? `<span>${esc(n.type)}</span>` : ''}${prioPill(n)}${statusPill(n)}</span></div></div>`;
  }

  // ================= 設定與人員 =================
  const notifPerm = () => ('Notification' in window) ? Notification.permission : 'unsupported';
  function deskHint() {
    const p = notifPerm();
    if (p === 'unsupported') return '這個瀏覽器不支援系統通知。';
    if (p === 'denied') return '瀏覽器已封鎖這個網站的通知：請按網址列左邊的圖示，把「通知」改成允許，再回來勾選。';
    return '看板要保持開著（可以縮到背景或切到別的分頁），才收得到提醒。';
  }
  function renderManage() {
    const el = $('#view-manage'), p = prefs(), set = settings();
    const projUrl = location.href.split('#')[0] + '#projector';
    el.innerHTML = `
      <header class="vh"><div><h1>設定與人員</h1><p class="sub">這台裝置的提醒方式、投影設定、人員權限與資料備份</p></div></header>
      <div class="mgrid">
        <section class="panel"><h2>這台裝置的提醒 <small>只影響目前這台電腦或手機</small></h2>
          <div class="toggles">
            <label class="check"><input type="checkbox" id="pfSound" ${p.sound ? 'checked' : ''}>提示音（新通知、行程提醒時響兩聲，緊急響三聲）</label>
            <label class="check"><input type="checkbox" id="pfDesk" ${p.desk && notifPerm() === 'granted' ? 'checked' : ''} ${notifPerm() === 'unsupported' ? 'disabled' : ''}>系統通知（看板在背景時，也會跳出 Windows／手機通知）</label>
            <p class="hint">${esc(deskHint())}</p>
            <div class="btn-row"><button type="button" class="btn sm" data-act="test-alert">測試提醒</button></div>
          </div>
        </section>
        <section class="panel"><h2>投影設定 <small>只影響這台裝置</small></h2>
          <div class="mlist">
            <div class="field"><span>投影要顯示的部門</span><div class="deptchecks">${hasPb() ? `<label class="check"><input type="checkbox" id="pfHandover" ${p.projHideHandover ? '' : 'checked'}><span class="dtag d-handover">夥伴交接任務</span></label>` : ''}${DEPTS.map(d => `<label class="check"><input type="checkbox" data-pd="${d.id}" ${!p.projDepts || p.projDepts.includes(d.id) ? 'checked' : ''}><span class="dtag ${deptCls(d.id)}">${esc(d.name)}</span></label>`).join('')}</div></div>
            <div class="field"><span>投影網址（電視或投影機用的電腦開這個網址，登入一次之後就會一直顯示）</span><div class="kbd-url"><input class="inp" id="projUrl" readonly value="${esc(projUrl)}"><button type="button" class="btn sm" data-act="copy-url">複製</button></div></div>
            <div class="btn-row"><a class="btn primary" href="#projector">開啟投影模式</a></div>
          </div>
        </section>
        <section class="panel need-admin wide"><h2>看板設定 <small>所有人共用，只有管理員能改</small></h2>
          <form id="setForm" class="mlist" novalidate>
            <div class="row3">
              <label class="field"><span>投影每頁停留（秒）</span><input id="sfRotate" type="number" min="5" max="120" value="${esc(set.rotateSec)}"></label>
              <label class="field"><span>投影跳出通知顯示（秒）<span class="hint">緊急會加倍</span></span><input id="sfPopup" type="number" min="5" max="300" value="${esc(set.popupSec)}"></label>
              <label class="field"><span>已完成的事項留在看板（天）</span><input id="sfDone" type="number" min="0" max="30" value="${esc(set.doneDays)}"></label>
            </div>
            <div class="field"><span>各部門的通知類別（一行一個，發布通知時可選）</span>
              <div class="types-grid">${DEPTS.map(d => `<label class="field"><span class="dtag ${deptCls(d.id)}">${esc(d.name)}</span><textarea data-types="${d.id}" rows="5">${esc(typesOf(d.id).join('\n'))}</textarea></label>`).join('')}</div></div>
            <div class="btn-row"><button type="submit" class="btn primary">儲存看板設定</button><button type="button" class="btn" data-act="reset-types">類別恢復預設</button></div>
          </form>
        </section>
        <section class="panel need-admin wide" id="usersPanel"></section>
        <section class="panel need-admin wide" id="pbPanel"></section>
        <section class="panel need-admin"><h2>資料備份</h2>
          <div class="mlist">
            <p class="hint">雲端每天凌晨會自動備份（保留 30 天）。需要時也可以手動匯出一份 JSON。</p>
            <div class="btn-row"><button type="button" class="btn" data-act="export">匯出 JSON 備份</button><button type="button" class="btn" data-act="import">匯入 JSON 備份</button></div>
            <p class="hint">示範資料會標示「示範」，可以隨時一鍵清除，不影響正式資料。</p>
            <div class="btn-row"><button type="button" class="btn" data-act="load-demo">載入示範資料</button><button type="button" class="btn danger" data-act="wipe-all">清除全部通知與行程</button></div>
          </div>
        </section>
        <section class="panel"><h2>同步狀態</h2>
          <div class="mlist"><p id="mSync"></p>
            <p class="hint">登入身分：${esc(myName())}（${esc(A ? A.email() : '')}）・${esc(roleText())}</p>
            <div class="btn-row"><button type="button" class="btn" data-act="sync-now">立即同步</button><button type="button" class="btn" data-act="logout">登出</button></div></div>
        </section>
      </div>`;
    $('#pfSound').addEventListener('change', e => { setPrefs({ sound: e.target.checked }); if (e.target.checked) { unlockAudio(); chime(2); } });
    $('#pfDesk').addEventListener('change', e => {
      if (!e.target.checked) { setPrefs({ desk: false }); return; }
      if (notifPerm() === 'granted') { setPrefs({ desk: true }); toast('已開啟系統通知'); return; }
      Notification.requestPermission().then(r => { setPrefs({ desk: r === 'granted' }); toast(r === 'granted' ? '已開啟系統通知' : '瀏覽器沒有允許通知', r !== 'granted'); renderManage(); });
    });
    const hv = $('#pfHandover');
    if (hv) hv.addEventListener('change', () => setPrefs({ projHideHandover: !hv.checked }));
    $$('[data-pd]', el).forEach(c => c.addEventListener('change', () => {
      const on = $$('[data-pd]', el).filter(x => x.checked).map(x => x.dataset.pd);
      setPrefs({ projDepts: on.length === DEPTS.length ? null : on });
    }));
    $('#setForm').addEventListener('submit', ev => {
      ev.preventDefault();
      const num = (id, lo, hi, d) => { const n = Math.round(Number($('#' + id).value)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
      const types = {};
      $$('[data-types]', el).forEach(t => {
        const list = t.value.split(/\n/).map(s => s.trim()).filter(Boolean).slice(0, 30);
        const def = DEPT[t.dataset.types].types;
        if (list.length && JSON.stringify(list) !== JSON.stringify(def)) types[t.dataset.types] = list;
      });
      saveSettings({ rotateSec: num('sfRotate', 5, 120, 12), popupSec: num('sfPopup', 5, 300, 25), doneDays: num('sfDone', 0, 30, 3), types });
      toast('已儲存看板設定');
    });
    if (isAdmin()) { renderUsers(); if (!U.loaded) loadUsers(); renderPb(); loadPb(); }
    renderSync();
  }

  // 夥伴交接看板串接狀態（管理員）
  const PBS = { data: null, error: '', loading: false };
  async function loadPb() {
    PBS.loading = true; renderPb();
    try { const j = await A.api('pbStatus'); PBS.data = j.pb || null; PBS.error = ''; }
    catch (e) { PBS.error = e.message; }
    PBS.loading = false; renderPb();
  }
  // 夥伴交接看板的部門（role）→ 看板的哪一欄
  const PB_TARGETS = [['', '不帶入'], ['handover', '交辦給生產部（可回報完成）'], ['purchase', '採購'], ['store', '門市'], ['warehouse', '倉管'], ['material', '物管'], ['channel', '通路'], ['meeting', '產銷會議']];
  function renderPb() {
    const box = $('#pbPanel'); if (!box) return;
    const d = PBS.data, last = (d && d.last) || {};
    const partners = (last.partners || []).filter(p => p && typeof p === 'object');
    const roles = [];
    partners.forEach(p => {
      let r = roles.find(x => x.role === p.role);
      if (!r) { r = { role: p.role, dept: p.dept || '', names: [] }; roles.push(r); }
      r.names.push(p.name);
    });
    const rows = d ? [
      ['設定', d.configured ? '已設定網址與金鑰' : '尚未設定（雲端後端的指令碼屬性要有 PB_URL、PB_KEY）'],
      ['定時同步', d.scheduled ? '每 5 分鐘' : '尚未啟用（設定好後在 Apps Script 執行 setupPartnerBoard）'],
      ['上次同步', last.at ? `${stamp(last.at)}　${last.ok ? '成功' : '有問題'}，帶進 ${last.count || 0} 筆（未完成 ${last.open || 0} 筆）` : '還沒有同步過'],
      ['問題', last.error || '']
    ].filter(r => r[1]) : [];
    box.innerHTML = `<h2>夥伴交接看板串接 <small>依負責人的部門把任務帶進各部門欄；交辦給生產部的任務，生產部按完成會回報並通知提案人</small></h2>
      ${PBS.error ? `<p class="err">讀取串接狀態失敗：${esc(PBS.error)}</p>` : ''}
      ${PBS.loading && !d ? '<p class="hint">讀取中…</p>' : `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`}
      ${roles.length ? `<div class="field"><span>部門對應（夥伴交接看板的部門 → 生產部看板的哪一欄）</span>
        <div class="tbl-wrap"><table class="tbl pbmap"><thead><tr><th>夥伴交接看板的部門</th><th>夥伴</th><th>放進看板的</th></tr></thead><tbody>
        ${roles.map((r, i) => `<tr><td>${esc(r.role || '（沒有部門）')}</td><td>${esc(r.names.join('、'))}</td>
          <td><select class="inp" data-pbrole="${i}">${PB_TARGETS.map(([v, t]) => `<option value="${v}" ${v === r.dept ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`).join('')}
        </tbody></table></div>
        <p class="hint">其他部門的任務只顯示給生產部參考，完成由負責人在夥伴交接看板勾選；只有「交辦給生產部」的任務能在這裡按完成並回報。</p></div>` : ''}
      <div class="btn-row">
        ${roles.length ? '<button type="button" class="btn sm primary" data-act="pb-savemap">儲存部門對應並立即同步</button>' : ''}
        <button type="button" class="btn sm" data-act="pb-sync" ${d && d.configured ? '' : 'disabled'}>立即同步</button>
        <button type="button" class="btn sm" data-act="pb-refresh">重新整理狀態</button>
      </div>`;
    box.dataset.roles = JSON.stringify(roles.map(r => r.role));
  }
  async function pbSyncNow(msg) {
    PBS.loading = true;
    try {
      await S.syncNow().catch(() => {});        // 先把剛改的設定送上雲端，後端才讀得到
      const j = await A.api('pbSync');
      PBS.data = j.pb || PBS.data; PBS.error = '';
      await S.syncNow().catch(() => {});        // 把同步結果拿回來
      toast(msg || '已同步夥伴交接看板');
    } catch (e) { toast('同步失敗：' + e.message, true); }
    PBS.loading = false; renderPb();
  }
  function pbSaveMap() {
    const box = $('#pbPanel'); if (!box) return;
    const roles = JSON.parse(box.dataset.roles || '[]'), map = {};
    $$('[data-pbrole]', box).forEach(s => { const r = roles[Number(s.dataset.pbrole)]; if (r != null) map[r] = s.value; });
    saveSettings({ pbMap: map });
    pbSyncNow('已儲存部門對應，各部門欄已更新');
  }
  function renderManageLive() { renderSync(); }

  // 人員與權限（管理員）
  const U = { list: [], admins: [], error: '', loading: false, loaded: false, edit: null };
  async function loadUsers() {
    U.loading = true; renderUsers();
    try { const j = await A.api('users'); U.list = j.users || []; U.admins = j.admins || []; U.error = ''; U.loaded = true; }
    catch (e) { U.error = e.message; }
    U.loading = false; renderUsers();
  }
  function renderUsers() {
    const box = $('#usersPanel'); if (!box) return;
    const ed = U.edit;
    box.innerHTML = `<h2>人員與權限 <small>名單內的 Gmail 才能登入；沒勾任何權限＝只能看。投影用的電腦要能在畫面上按「完成」，請勾「生產部處理」</small></h2>
      <form id="userForm" class="user-form" novalidate>
        <label class="field"><span>Gmail</span><input id="ufEmail" type="email" maxlength="120" ${ed ? 'readonly' : ''} value="${esc(ed ? ed.email : '')}" placeholder="name@gmail.com"></label>
        <label class="field"><span>名字（顯示用）</span><input id="ufName" maxlength="30" value="${esc(ed ? ed.name : '')}" placeholder="例：採購 林雅婷"></label>
        <div class="btn-row"><button type="submit" class="btn primary">${ed ? '儲存' : '加入名單'}</button>${ed ? '<button type="button" class="btn" data-act="user-cancel">取消</button>' : ''}</div>
        <div class="field permfield"><span>權限</span><div class="permbox">${PERMS.map(p => `<label class="check"><input type="checkbox" data-perm="${p.id}" ${ed && (ed.pages || []).includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</div></div>
      </form>
      ${U.error ? `<p class="err">讀取人員名單失敗：${esc(U.error)}</p>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>名字</th><th>Gmail</th><th>權限</th><th>最後登入</th><th></th></tr></thead><tbody>
        ${U.admins.map(a => `<tr><td>管理員</td><td>${esc(a)}</td><td><span class="pill s-new">全部權限</span></td><td>—</td><td></td></tr>`).join('')}
        ${U.list.map(u => `<tr class="${u.enabled ? '' : 'off'}"><td>${esc(u.name || '')}</td><td>${esc(u.email)}</td>
          <td><div class="perm-chips">${(u.pages || []).length ? u.pages.map(p => `<span class="pill">${esc(permName(p))}</span>`).join('') : '<span class="hint">只能看</span>'}${u.enabled ? '' : '<span class="pill p-high">已停用</span>'}</div></td>
          <td>${u.lastLogin ? esc(stamp(u.lastLogin)) : '尚未登入'}</td>
          <td class="acts"><button type="button" class="btn sm" data-act="user-edit" data-email="${esc(u.email)}">編輯</button> <button type="button" class="btn sm" data-act="user-toggle" data-email="${esc(u.email)}">${u.enabled ? '停用' : '啟用'}</button> <button type="button" class="btn sm danger" data-act="user-del" data-email="${esc(u.email)}">刪除</button></td></tr>`).join('')}
        ${U.loading ? '<tr><td colspan="5" class="hint">讀取中…</td></tr>' : (!U.list.length ? '<tr><td colspan="5" class="hint">還沒有加入任何人。先加入各部門的 Gmail，再勾選他們可以發布的部門。</td></tr>' : '')}
      </tbody></table></div>`;
    $('#userForm').addEventListener('submit', async ev => {
      ev.preventDefault();
      const email = $('#ufEmail').value.trim(), name = $('#ufName').value.trim();
      const pages = $$('[data-perm]', box).filter(c => c.checked).map(c => c.dataset.perm);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast('請輸入正確的 Gmail 地址', true); return; }
      try {
        const j = await A.api('userSave', { email, name, pages, enabled: ed ? ed.enabled !== false : true });
        U.list = j.users || U.list; U.edit = null; renderUsers();
        toast(ed ? '已更新' : `已加入 ${email}，請他用這個 Gmail 登入`);
      } catch (e) { toast(e.message, true); }
    });
  }
  async function userAction(act, email) {
    const u = U.list.find(x => x.email === email); if (!u) return;
    if (act === 'user-edit') { U.edit = u; renderUsers(); $('#ufName').focus(); return; }
    try {
      let j;
      if (act === 'user-toggle') j = await A.api('userSave', { email: u.email, name: u.name, pages: u.pages || [], enabled: !u.enabled });
      else { if (!confirm(`要把 ${email} 移出名單嗎？他將無法再登入。`)) return; j = await A.api('userDelete', { email }); }
      U.list = j.users || U.list; renderUsers();
      toast(act === 'user-del' ? '已移出名單' : (u.enabled ? '已停用，他的登入會立刻失效' : '已啟用'));
    } catch (e) { toast(e.message, true); }
  }

  // 備份、示範資料
  function exportJson() {
    // 夥伴交接任務以夥伴交接看板為準，不放進備份（只備份生產部的處理紀錄 pbstate）
    const data = { app: 'production-board', version: 1, exportedAt: new Date().toISOString(), notices: S.list('notices'), events: events(), settings: S.list('settings'), pbstate: S.list('pbstate') };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
    a.download = `生產部看板備份_${today()}.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function importJson(file) {
    const r = new FileReader();
    r.onload = () => {
      let d; try { d = JSON.parse(r.result); } catch (e) { toast('檔案不是正確的 JSON', true); return; }
      if (!d || d.app !== 'production-board' || !Array.isArray(d.notices) || !Array.isArray(d.events)) { toast('這不是生產部看板的備份檔', true); return; }
      if (!confirm(`要用這份備份（${d.notices.length} 則通知、${d.events.length} 個行程）取代目前全部資料嗎？`)) return;
      S.replaceKinds(Object.assign({ notices: d.notices, events: d.events, settings: Array.isArray(d.settings) ? d.settings : [] }, Array.isArray(d.pbstate) ? { pbstate: d.pbstate } : {}));
      toast('已匯入備份');
    };
    r.readAsText(file);
  }
  function demoData() {
    const t = today(), D = n => addDays(t, n), now = Date.now(), H = h => now - h * 3600000;
    const N = o => Object.assign({ id: uid('n'), date: t, status: 'new', priority: 'normal', onCal: true, byEmail: 'demo@example.com', at: now, demo: true }, o);
    const dow = parse(t).getDay(), lastTue = D(-((dow - 2 + 7) % 7));
    const ns = [
      N({ dept: 'purchase', type: '缺料／延遲', title: '奶油乳酪到貨延後 4 天，安全庫存只剩 3 天', body: `供應商船期延誤。現有庫存約可撐到 ${md(D(3))}，建議先排 6 吋原味，小原暫緩。`, items: '奶油乳酪 1kg', qty: '120 箱', due: D(3), priority: 'urgent', by: '採購 林雅婷', at: H(2) }),
      N({ dept: 'purchase', type: '替代料／規格變更', title: '鮮奶油改用替代品牌，請先試做一批', body: '原品牌缺貨到月底，替代品乳脂 35%，規格書已放共用雲端。', items: '動物性鮮奶油', due: D(5), priority: 'high', status: 'ack', ackBy: '生產部 陳組長', ackAt: H(20), by: '採購 林雅婷', at: H(26) }),
      N({ dept: 'purchase', type: '價格異動', title: '下個月起低筋麵粉單價調漲 6%', by: '採購 林雅婷', at: H(50), date: D(-2) }),
      N({ dept: 'store', type: '品質回饋／客訴', title: '門市反映小原表面龜裂 3 件', body: '照片已傳群組，請生產部確認當天的烘烤溫度紀錄。', items: '小原', qty: '3 件', due: D(1), priority: 'urgent', by: '門市 張店長', at: H(1) }),
      N({ dept: 'store', type: '門市訂單／團購', title: '企業團購 6 吋原味 40 顆', body: `客戶指定 ${mdw(D(4))} 上午 10 點前到店取貨。`, items: '6 吋原味', qty: '40 顆', due: D(4), priority: 'high', by: '門市 張店長', at: H(5) }),
      N({ dept: 'store', type: '活動需求', title: '聖誕禮盒預購破 300 盒，請評估產能', due: D(10), priority: 'high', status: 'doing', ackBy: '生產部 陳組長', ackAt: H(28), owner: '陳組長', by: '門市營運 黃專員', at: H(30) }),
      N({ dept: 'warehouse', type: '倉位空間', title: '冷凍庫 B 區只剩 15% 空間，請先消化半成品', due: D(2), priority: 'high', by: '倉管 吳先生', at: H(8) }),
      N({ dept: 'warehouse', type: '即期／過期', title: `6 吋原味 24 顆將在 ${mdw(D(4))} 到期`, body: '請優先出貨，或安排轉做試吃品。', items: '6 吋原味', qty: '24 顆', due: D(4), by: '倉管 吳先生', at: H(12) }),
      N({ dept: 'warehouse', type: '出貨異常', title: '上週出貨短少 2 箱，已補寄', status: 'done', ackBy: '生產部 陳組長', ackAt: H(40), doneBy: '生產部 陳組長', doneAt: H(30), by: '倉管 吳先生', at: H(60), date: D(-2) }),
      N({ dept: 'material', type: '包材／標示', title: '聖誕禮盒外盒延後到貨，影響包裝排程', body: `外盒改 ${md(D(11))} 到，原定 ${md(D(9))} 的包裝需要順延。`, items: '聖誕禮盒外盒', qty: '1,500 個', due: D(9), priority: 'urgent', by: '物管 許小姐', at: H(3) }),
      N({ dept: 'material', type: '配方／BOM 變更', title: '過敏原標示貼紙更新，下週一起換用新版', due: D(6), status: 'ack', ackBy: '生產部 陳組長', ackAt: H(40), by: '物管 許小姐', at: H(48), date: D(-2) }),
      N({ dept: 'channel', type: '檔期活動', title: '量販通路檔期：小原備貨 1,200 盒', body: `第一批 ${md(D(8))} 進倉，檔期到 ${md(D(23))}。`, items: '小原', qty: '1,200 盒', due: D(8), dueEnd: D(23), priority: 'high', by: '通路 周經理', at: H(28) }),
      N({ dept: 'channel', type: '通路訂單', title: '電商雙 12 加量 30%，請確認能否支援', due: D(7), by: '通路 周經理', at: H(6) }),
      N({ dept: 'meeting', type: '會議決議', title: '下個月起每週六加開一班', body: '產銷會議決議：配合禮盒檔期，週六加開早班，人力由生產部安排。', due: D(12), priority: 'high', status: 'doing', ackBy: '生產部 陳組長', ackAt: H(70), owner: '陳組長', reply: '人力名單本週五前排好。', replyBy: '生產部 陳組長', replyAt: H(60), by: '產銷會議紀錄', at: H(75), date: D(-3) }),
      N({ dept: 'meeting', type: '新品開發', title: '新品抹茶巴斯克試產', due: D(9), by: '產銷會議紀錄', at: H(75), date: D(-3) })
    ];
    const E = o => Object.assign({ id: uid('e'), allDay: false, remind: 30, repeat: 'none', proj: true, by: '生產部 陳組長', byEmail: 'demo@example.com', at: now, demo: true }, o);
    const es = [
      E({ title: '產銷會議', etype: 'meeting', dept: 'meeting', date: addDays(lastTue, -14), time: '14:00', endTime: '15:30', repeat: 'weekly', place: '2F 會議室' }),
      E({ title: '禮盒包裝線調整', etype: 'production', dept: '', date: t, time: '10:30', endTime: '12:00', place: '包裝區' }),
      E({ title: '原物料盤點', etype: 'audit', dept: 'warehouse', date: t, time: '16:30', place: '原料倉' }),
      E({ title: '食安稽核', etype: 'audit', dept: '', date: D(2), time: '10:00', endTime: '12:00', place: '全廠', remind: 60 }),
      E({ title: '奶油乳酪到貨', etype: 'arrival', dept: 'purchase', date: D(4), time: '09:00', place: '冷藏倉', remind: 60 }),
      E({ title: '企業團購取貨', etype: 'other', dept: 'store', date: D(4), time: '10:00', remind: 60 }),
      E({ title: '冷凍庫除霜保養（停用半天）', etype: 'off', dept: '', date: D(6), allDay: true, time: '', remind: 1440 }),
      E({ title: '新品抹茶巴斯克試產', etype: 'production', dept: '', date: D(9), time: '08:30', endTime: '12:00', place: 'B 線' }),
      E({ title: '量販通路檔期', etype: 'promo', dept: 'channel', date: D(10), end: D(23), allDay: true, time: '', remind: -1 })
    ];
    return { ns, es };
  }
  function loadDemo() {
    if (notices().length || events().length) { if (!confirm('目前已經有資料。示範資料會加在現有資料之外（之後可以一鍵清除示範資料），要繼續嗎？')) return; }
    const { ns, es } = demoData();
    // 自己載入的示範資料不要跳「新通知」：先記成看過，再存（存檔時就會檢查新通知）
    if (seen) { ns.forEach(n => { seen.ids[n.id] = 0; }); lsSet('pd_seen', seen); }
    S.saveMany('notices', ns); S.saveMany('events', es);
    saveSettings({ demo: true });
    toast('已載入示範資料');
    location.hash = '#board';
  }
  function clearDemo() {
    S.removeMany('notices', notices().filter(n => n.demo).map(n => n.id));
    S.removeMany('events', events().filter(e => e.demo).map(e => e.id));
    saveSettings({ demo: false });
    toast('已清除示範資料');
  }

  // ================= 提醒：新通知、行程 =================
  let seen = lsGet('pd_seen', null);   // { ids: { 通知id: rev } }；null＝這台裝置還沒讀過資料
  function checkNew() {
    const st = S.status();
    if (!st.loaded) return;
    const list = notices(), me = myEmail();
    if (!seen) {   // 這台裝置第一次讀到雲端資料：全部當作看過，不跳通知
      if (st.state === 'syncing' || st.state === 'loading') return;
      seen = { ids: {} };
      list.forEach(n => { seen.ids[n.id] = n.rev || 0; });
      lsSet('pd_seen', seen);
      return;
    }
    const fresh = [];
    list.forEach(n => {
      const r = n.rev || 0;
      if (seen.ids[n.id] === r) return;
      const update = n.id in seen.ids;
      seen.ids[n.id] = r;
      if (n.status === 'done') return;
      if (n.src === 'pb' && n.pb.ro) return;   // 其他部門在夥伴交接看板的任務只顯示，不跳通知
      if ((update ? n.upByEmail : n.byEmail) === me) return;   // 自己發的不提醒自己
      const at = update ? (n.upAt || 0) : (n.at || 0);
      if (Date.now() - at > NEW_POPUP_HOURS * 3600000) return;
      fresh.push({ n, update });
    });
    const ids = new Set(list.map(n => n.id));
    Object.keys(seen.ids).forEach(k => { if (!ids.has(k)) delete seen.ids[k]; });
    lsSet('pd_seen', seen);
    fresh.sort((a, b) => cmpNotice(a.n, b.n));
    fresh.slice(0, 6).forEach(f => notify(noticeAlert(f.n, f.update)));
    if (fresh.length > 6) notify({ key: 'more:' + Date.now(), kind: 'more', kicker: '新通知', title: `另外還有 ${fresh.length - 6} 則新通知`, lines: ['請到看板總覽查看'] });
  }
  function noticeAlert(n, update) {
    const di = dueInfo(n);
    if (n.src === 'pb') {
      return {
        key: `n:${n.id}:0`, kind: 'notice', id: n.id, dept: n.dept, urgent: false, kicker: '新交辦任務', title: n.title, body: n.body || '',
        lines: [n.owner ? `負責：${n.owner}` : '', di ? `預交日：${mdw(n.due)}　${di.text}` : '', '來自夥伴交接看板'].filter(Boolean)
      };
    }
    return {
      key: `n:${n.id}:${n.rev || 0}`, kind: 'notice', id: n.id, dept: n.dept, urgent: n.priority === 'urgent',
      kicker: update ? '通知更新' : (n.priority === 'urgent' ? '緊急通知' : '新通知'), title: n.title, body: n.body || '',
      lines: [
        [n.type, n.items, n.qty].filter(Boolean).join('　'),
        di ? `需處理：${dueRange(n)}　${di.text}` : '',
        n.by ? `${update ? '修改' : '發布'}：${update ? (n.upBy || n.by) : n.by}` : ''
      ].filter(Boolean)
    };
  }
  function eventAlert(ev, occ, startMs) {
    const mins = Math.round((startMs - Date.now()) / 60000);
    let when;
    if (ev.allDay || !ev.time) when = occ.start === today() ? '今天（全天）' : `明天 ${mdw(occ.start)}（全天）`;
    else if (mins <= 0) when = `現在開始　${ev.time}${ev.endTime ? '–' + ev.endTime : ''}`;
    else if (mins < 120) when = `${mins} 分鐘後開始　${ev.time}${ev.endTime ? '–' + ev.endTime : ''}`;
    else when = `${occ.start === today() ? '今天' : '明天'} ${ev.time} 開始`;
    return {
      key: `e:${ev.id}@${occ.start}`, kind: 'event', id: ev.id, day: occ.start, dept: ev.dept, urgent: false, proj: ev.proj !== false,
      kicker: '行程提醒', title: ev.title, lines: [when, ev.place ? '地點：' + ev.place : '', ev.note || ''].filter(Boolean)
    };
  }
  function checkReminders() {
    if (!S.status().loaded) return;
    const now = Date.now(), t = today(), fired = lsGet('pd_fired', {});
    let changed = false;
    events().forEach(ev => {
      const rem = ev.remind == null ? -1 : Number(ev.remind);
      if (!(rem >= 0)) return;
      occurrences(ev, t, addDays(t, 1)).forEach(o => {
        const key = ev.id + '@' + o.start;
        if (fired[key]) return;
        const startMs = startMsOf(ev, o.start), fireAt = startMs - rem * 60000;
        const late = ev.allDay || !ev.time ? parse(o.start).getTime() + 86400000 : startMs + 30 * 60000;
        if (now >= fireAt && now <= late) { fired[key] = now; changed = true; notify(eventAlert(ev, o, startMs)); }
      });
    });
    Object.keys(fired).forEach(k => { if (now - fired[k] > 3 * 86400000) { delete fired[k]; changed = true; } });
    if (changed) lsSet('pd_fired', fired);
  }
  const projAllowed = dept => {
    const p = prefs();
    if (dept === 'handover') return !p.projHideHandover;
    return !p.projDepts || !dept || p.projDepts.includes(dept);
  };
  function notify(al) {
    const p = prefs();
    if (proj.on) {
      if (al.proj === false || !projAllowed(al.dept)) return;
      projPush(al);
    } else showNote(al);
    if (p.sound) chime(al.urgent ? 3 : 2);
    if (p.desk && notifPerm() === 'granted' && (document.hidden || !document.hasFocus())) sysNotify(al);
  }
  const targetOf = al => al.kind === 'notice' ? 'notice:' + al.id : al.kind === 'event' ? `event:${al.id}@${al.day}` : '';
  function openTarget(s) {
    const m = /^(notice|event):([^@]+)(?:@(.+))?$/.exec(s || '');
    if (!m) { if (!proj.on) location.hash = '#board'; return; }
    if (proj.on) return;   // 投影畫面不打開詳細資料
    openDrawer({ kind: m[1], id: m[2], day: m[3] });
  }
  let swReg = null;
  function sysNotify(al) {
    const title = al.kicker + (al.dept ? '｜' + deptName(al.dept) : '');
    const opt = { body: al.title + (al.lines.length ? '\n' + al.lines.slice(0, 2).join('\n') : ''), tag: al.key, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { hash: targetOf(al) }, requireInteraction: !!al.urgent };
    if (swReg && swReg.showNotification) { swReg.showNotification(title, opt).catch(() => {}); return; }
    try { const nn = new Notification(title, opt); nn.onclick = () => { window.focus(); openTarget(opt.data.hash); nn.close(); }; } catch (e) { /* 手機瀏覽器只能透過 service worker 跳通知 */ }
  }
  function showNote(al) {
    const box = $('#notes'), el = document.createElement('div');
    el.className = 'note' + (al.urgent ? ' urgent' : '');
    el.innerHTML = `<div class="nk">${al.dept ? dtag(al.dept) : ''}<span>${esc(al.kicker)}</span><button type="button" class="icon-btn" aria-label="關閉">×</button></div>
      <div class="nt">${esc(al.title)}</div>${al.lines.slice(0, 2).map(l => `<div class="nl">${esc(l)}</div>`).join('')}
      ${targetOf(al) ? '<div class="btn-row"><button type="button" class="btn sm">查看</button></div>' : ''}`;
    const close = () => el.remove();
    el.querySelector('.icon-btn').onclick = close;
    const go = el.querySelector('.btn-row .btn');
    if (go) go.onclick = () => { close(); openTarget(targetOf(al)); };
    box.appendChild(el);
    while (box.children.length > 4) box.firstElementChild.remove();
    setTimeout(close, al.urgent ? 60000 : 20000);
  }

  // 提示音（瀏覽器規定要使用者先點過畫面才能出聲）
  let audioCtx = null;
  function unlockAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) { try { audioCtx = new AC(); } catch (e) { return; } }
    if (audioCtx.state === 'suspended') audioCtx.resume().then(updateSoundHint, () => {});
    updateSoundHint();
  }
  function chime(times) {
    const c = audioCtx;
    if (!c || c.state !== 'running') return;
    const t0 = c.currentTime + 0.03;
    for (let i = 0; i < times; i++) {
      [[880, 0], [1318.5, 0.17]].forEach(([f, off]) => {
        const o = c.createOscillator(), g = c.createGain(), st = t0 + i * 0.6 + off;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, st);
        g.gain.exponentialRampToValueAtTime(0.32, st + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, st + 0.55);
        o.connect(g); g.connect(c.destination); o.start(st); o.stop(st + 0.6);
      });
    }
  }

  // ================= 投影模式 =================
  const proj = { on: false, page: 0, pages: 2, list: [], week: {}, rotT: null, clockT: null, queue: [], cur: null, popT: null, wake: null, idleT: null, armed: null, armT: null, zoom: null, zoomT: null, curDur: 0, pageSig: '', pageList: [] };
  const ARM_MS = 6000;   // 投影「完成」按第一次後，6 秒內再按一次才算
  const isArmed = id => !!proj.armed && proj.armed.id === id && Date.now() < proj.armed.until;
  function projEnter() {
    if (proj.on) { projRender(); return; }
    proj.on = true;
    closeDrawer(); closeModal();
    $('#notes').innerHTML = '';
    document.documentElement.classList.add('proj-on');
    const el = $('#proj');
    el.hidden = false;
    el.innerHTML = `
      <div class="p-top">
        <div class="p-brand"><div class="p-mark" aria-hidden="true">產</div><div><div class="p-name">生產部看板</div><div class="p-date" id="pDate"></div></div></div>
        <div class="p-stats" id="pStats"></div>
        <div class="p-clock"><span class="hm" id="pHM"></span><span class="s" id="pS"></span><span class="p-sync" id="pSync"></span></div>
      </div>
      <div class="p-main">
        <section class="p-col"><h2>今日行程 <small id="pTodayD"></small></h2><div class="p-list" id="pToday"></div><h3>明日</h3><div class="p-list" id="pTomorrow"></div></section>
        <section class="p-col"><div class="p-center-h"><h2 id="pCTitle">重點通知</h2><div class="p-pager" id="pPager"></div></div><div class="p-prog"><i id="pProg"></i></div><div class="p-center" id="pCenter"></div></section>
        <section class="p-col"><h2>7 天內到期</h2><div class="p-list" id="pDue"></div></section>
      </div>
      <div class="p-ticker"><span class="p-tk-label">最新</span><div class="p-tk-track" id="pTicker"></div><span class="p-tk-count" id="pTkCount"></span></div>
      <div class="p-ctl" id="pCtl">
        <button type="button" data-act="p-full">全螢幕</button>
        <button type="button" data-act="p-sound" id="pSoundBtn">提示音</button>
        <button type="button" data-act="p-test">測試通知</button>
        <button type="button" data-act="p-exit">離開投影</button>
      </div>
      <button type="button" class="p-hint" id="pHint" data-act="p-enable-sound" hidden>點一下畫面，開啟提示音</button>
      <div class="p-zoom" id="pZoom" data-act="p-zoom-close" hidden></div>
      <div class="p-pop" id="pPop" data-act="p-pop-close" hidden></div>`;
    proj.page = 0;
    projRender();
    projCenter();
    projClock();
    proj.clockT = setInterval(projClock, 1000);
    proj.tkT = setInterval(() => { proj.tkIdx = (proj.tkIdx || 0) + 1; projTicker(); }, 7000);
    projSchedule();
    requestWake();
    projActive();
    updateSoundHint();
  }
  function projExit(fromRoute) {
    proj.on = false;
    clearInterval(proj.clockT); clearInterval(proj.tkT); clearTimeout(proj.rotT); clearTimeout(proj.popT); clearTimeout(proj.idleT); clearTimeout(proj.zoomT);
    proj.queue = []; proj.cur = null; proj.zoom = null; proj.pageSig = '';
    const el = $('#proj'); el.hidden = true; el.innerHTML = ''; el.classList.remove('idle');
    document.documentElement.classList.remove('proj-on');
    releaseWake();
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    if (!fromRoute) location.hash = '#board';
  }
  function projRender() {
    if (!proj.on || !$('#pStats')) return;
    const t = today(), tm = addDays(t, 1), depts = prefs().projDepts;
    const open = notices().filter(n => n.status !== 'done' && projAllowed(n.dept)).sort(cmpNotice);
    $('#pDate').textContent = `${t.replace(/-/g, '/')}（${wk(t)}）`;
    $('#pTodayD').textContent = mdw(t);
    const st = [['待確認', open.filter(n => n.status === 'new').length, 'gold'], ['逾期', open.filter(n => bucket(n) === 0).length, 'hot'], ['今天到期', open.filter(n => bucket(n) === 1).length, 'warn'], ['緊急', open.filter(n => n.priority === 'urgent').length, 'hot']];
    $('#pStats').innerHTML = st.map(([lb, v, c]) => `<div class="p-stat ${v ? c : 'zero'}"><b>${v}</b><span>${lb}</span></div>`).join('');
    const map = entriesBetween(t, addDays(t, 6), { proj: true, depts });
    $('#pToday').innerHTML = projDayList(map[t] || [], true);
    $('#pTomorrow').innerHTML = projDayList(map[tm] || [], false);
    // 左欄放不下：先收明日，再收今日已結束的，最後收今日較晚的（文字一律完整顯示，不截斷）
    const lcol = $('#pToday').parentElement;
    let hm = 0, ht = 0;
    for (let guard = 0; guard < 80 && overflowing(lcol); guard++) {
      const tmEv = $$('#pTomorrow .p-ev'), tdEv = $$('#pToday .p-ev');
      if (tmEv.length) { tmEv[tmEv.length - 1].remove(); setMore($('#pTomorrow'), `還有 ${++hm} 個行程`, { kind: 'day', day: tm }); }
      else if (tdEv.length > 1) { const past = tdEv.filter(e => e.classList.contains('past')); (past[0] || tdEv[tdEv.length - 1]).remove(); setMore($('#pToday'), `還有 ${++ht} 個行程`, { kind: 'day', day: t }); }
      else break;
    }
    // 7 天內到期（含逾期）
    const dueList = open.filter(n => n.due && n.onCal !== false && bucket(n) <= 2);
    const groups = [];
    dueList.forEach(n => {
      const b = bucket(n), key = b === 0 ? 'over' : b === 1 ? t : n.due;
      let g = groups.find(x => x.key === key);
      if (!g) { g = { key, cls: b === 0 ? 'over' : b === 1 ? 'today' : '', label: b === 0 ? '已逾期' : b === 1 ? '今天' : (n.due === tm ? '明天 ' : '') + mdw(n.due), items: [] }; groups.push(g); }
      g.items.push(n);
    });
    groups.sort((a, b) => (a.key === 'over' ? '0' : a.key).localeCompare(b.key === 'over' ? '0' : b.key));
    $('#pDue').innerHTML = groups.length ? groups.map(g => `<div class="p-due-day"><div class="h ${g.cls}">${esc(g.label)}<span>${g.items.length} 項</span></div>${g.items.map(n =>
      `<div class="p-dn ${n.priority === 'urgent' ? 'urgent' : ''}" data-act="p-zoom" data-kind="notice" data-id="${esc(n.id)}">${dtag(n.dept)}<span class="x">${esc(n.title)}</span></div>`).join('')}</div>`).join('')
      : '<div class="p-empty">接下來 7 天沒有到期的事項</div>';
    const rcol = $('#pDue').parentElement;
    let hd = 0;
    for (let guard = 0; guard < 300 && overflowing(rcol); guard++) {
      const items = $$('#pDue .p-dn'); if (items.length <= 1) break;
      const it = items[items.length - 1], g = it.closest('.p-due-day');
      it.remove();
      if (g && !g.querySelector('.p-dn')) g.remove();
      setMore($('#pDue'), `還有 ${++hd} 項，請看看板`);
    }
    // 輪播頁
    proj.list = open; proj.week = map;
    projCenter();
    // 最新：不捲動，一次完整顯示一則，每 7 秒換下一則（最新發布的在前）
    const tk = open.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 10);
    const html = tk.length
      ? tk.map(n => `<div class="p-tk-item" data-act="p-zoom" data-kind="notice" data-id="${esc(n.id)}"><span class="tx">${dtag(n.dept)} <b>${esc(n.title)}</b>${n.due ? `（${esc(mdw(n.due))}）` : ''}</span></div>`).join('')
      : '<div class="p-tk-item"><span class="tx">目前沒有待處理的通知</span></div>';
    const track = $('#pTicker');
    if (track.dataset.sig !== html) { track.dataset.sig = html; track.innerHTML = html; proj.tkIdx = 0; }
    projTicker();
    if (proj.zoom) projZoomRender();
    renderSync();
  }
  // 「最新」列：顯示第 tkIdx 則，字太長就縮小到放得下（最多兩行）
  function projTicker() {
    const track = $('#pTicker'); if (!track) return;
    const items = $$('.p-tk-item', track); if (!items.length) return;
    proj.tkIdx = (proj.tkIdx || 0) % items.length;
    items.forEach((e, i) => e.classList.toggle('on', i === proj.tkIdx));
    const cur = items[proj.tkIdx], tx = cur.querySelector('.tx');
    for (let k = 1; k >= 0.6 - 0.001; k = Math.round((k - 0.05) * 100) / 100) {
      cur.style.setProperty('--k', String(k));
      if (tx.scrollHeight <= cur.clientHeight + 1) break;
    }
    const cnt = $('#pTkCount'); if (cnt) cnt.textContent = items.length > 1 ? `${proj.tkIdx + 1}／${items.length}` : '';
  }
  const overflowing = el => el.scrollHeight > el.clientHeight + 1;
  // 放不下的項目收起來後，在清單最後顯示「還有 N 項」（可以點開看全部）
  function setMore(list, text, zoom) {
    let m = list.querySelector(':scope > .p-more');
    if (!m) { m = document.createElement('div'); m.className = 'p-empty p-more'; list.appendChild(m); }
    m.textContent = text;
    if (zoom) { m.dataset.act = 'p-zoom'; m.dataset.kind = zoom.kind; m.dataset.day = zoom.day; }
  }
  function projDayList(list, isToday) {
    const evs = list.filter(x => x.kind === 'event'), now = Date.now();
    if (!evs.length) return `<div class="p-empty">${isToday ? '今天' : '明天'}沒有排定的行程</div>`;
    return evs.map(x => {
      const ev = x.ev, timed = !ev.allDay && ev.time && x.first;
      let cls = '';
      if (isToday && timed) {
        const s = startMsOf(ev, x.day), e = ev.endTime ? startMsOf({ time: ev.endTime }, x.day) : s + 3600000;
        cls = now >= e ? 'past' : now >= s ? 'now' : '';
      }
      const small = cls === 'now' ? '進行中' : timed && ev.endTime ? '到 ' + ev.endTime : '';
      return `<div class="p-ev ${deptCls(ev.dept)} ${cls}" data-act="p-zoom" data-kind="event" data-id="${esc(ev.id)}" data-day="${x.day}"><div class="tm">${esc(evTimeLabel(x))}${small ? `<small>${esc(small)}</small>` : ''}</div>
        <div><div class="ti">${esc(ev.title)}</div><div class="sb">${ev.dept ? dtag(ev.dept) : `<span>${esc(ETYPE[ev.etype] || '')}</span>`}${ev.place ? `<span>${esc(ev.place)}</span>` : ''}</div></div></div>`;
    }).join('');
  }

  // 重點通知卡片一律顯示全文：先縮小字，再減少每頁張數（4 → 2 → 1），單張還放不下就慢慢上下捲動。
  // 每種排法最多縮到多小（投影要遠看，張數多時不縮太小）
  const MIN_K = { 4: 0.86, 2: 0.8, 1: 0.72 };
  const projNarrow = () => window.matchMedia('(max-width: 1000px)').matches;   // 窄螢幕：卡片一欄、高度跟著內容，不用量
  function fitCard(c, minK) {
    const vp = c.querySelector('.p-viewport'); if (!vp) return true;
    for (let k = 1; k >= minK - 0.001; k = Math.round((k - 0.04) * 100) / 100) {
      c.style.setProperty('--k', String(k));
      if (vp.scrollHeight <= vp.clientHeight + 1) return true;
    }
    return false;
  }
  const cardsHtml = (items, n) => `<div class="p-cards n${n}">${items.map(projCard).join('')}</div>`;
  function projPages() {
    const box = $('#pCenter'), list = proj.list;
    if (!box || !list.length) return [];
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h || projNarrow()) { const out = []; for (let i = 0; i < list.length; i += 4) out.push({ items: list.slice(i, i + 4), n: 4 }); return out; }
    const sig = `${w}x${h}|${canHandle()}|` + list.map(n => [n.id, n.title, n.body, n.items, n.qty, n.owner, n.reply, n.status, n.priority, n.due, n.dueEnd, n.type].join('\u0001')).join('\u0002');
    if (proj.pageSig === sig) return proj.pageList;
    const meas = document.createElement('div');
    meas.className = 'p-center';
    meas.setAttribute('aria-hidden', 'true');
    meas.style.cssText = `position:absolute;left:-20000px;top:0;visibility:hidden;width:${w}px;height:${h}px`;
    $('#proj').appendChild(meas);
    const fits = (items, n) => { meas.innerHTML = cardsHtml(items, n); return $$('.p-card', meas).every(c => fitCard(c, MIN_K[n])); };
    // 依排序逐頁裝：每頁從最前面那張開始，往後找放得下的一起放（最多 4 張）；
    // 放不下的長卡片留到後面的頁，短的不會因為後面有一張長的就自己佔一整頁
    const pages = [], left = list.slice();
    const layoutOf = k => k >= 3 ? 4 : k;
    while (left.length) {
      const page = [left.shift()];
      for (let j = 0; j < left.length && j < 8 && page.length < 4; j++) {
        const trial = page.concat([left[j]]);
        if (fits(trial, layoutOf(trial.length))) { page.push(left[j]); left.splice(j, 1); j--; }
      }
      pages.push({ items: page, n: layoutOf(page.length) });
    }
    meas.remove();
    proj.pageSig = sig; proj.pageList = pages;
    return pages;
  }
  function projCenter() {
    const box = $('#pCenter'); if (!box) return;
    const pages = projPages();
    proj.pages = Math.max(1, pages.length) + 1;
    if (proj.page >= proj.pages) proj.page = 0;
    const pg = proj.page, last = proj.pages - 1;
    proj.curDur = 0;
    $('#pPager').innerHTML = Array.from({ length: proj.pages }, (_, i) => `<i class="${i === pg ? 'on' : ''}"></i>`).join('');
    if (pg < last) {
      const page = pages[pg];
      $('#pCTitle').textContent = pages.length > 1 ? `重點通知 ${pg + 1}／${pages.length}` : '重點通知';
      if (!page) { box.innerHTML = '<div class="p-allclear"><div><b>目前沒有待處理的通知</b>各部門發布新通知時，會立刻跳出來</div></div>'; return; }
      box.innerHTML = cardsHtml(page.items, page.n);
      if (!projNarrow()) $$('.p-card', box).forEach(c => {
        if (fitCard(c, page.n === 1 ? MIN_K[1] : Math.min(MIN_K[page.n], MIN_K[1]))) return;
        if (fitCard(c, 0.6)) return;   // 單張字很多：再縮小一點
        // 還是放不下（不用捲動的方式）：顯示到放得下的地方，下方標示「點一下看全文」，點一下就放大顯示全部
        c.classList.add('clip');
      });
    } else {
      const t = today();
      $('#pCTitle').textContent = '本週行事曆';
      box.innerHTML = `<div class="p-week">${Array.from({ length: 7 }, (_, i) => {
        const d = addDays(t, i), list = proj.week[d] || [];
        return `<div class="p-wd ${i === 0 ? 'today' : ''}" data-day="${d}"><div class="h" data-act="p-zoom" data-kind="day" data-day="${d}"><b>${esc(md(d))}</b><span>${i === 0 ? '今天' : '週' + wk(d)}</span></div>
          ${list.map(x => x.kind === 'event'
            ? `<div class="p-we ${deptCls(x.ev.dept)}" data-act="p-zoom" data-kind="event" data-id="${esc(x.ev.id)}" data-day="${d}">${!x.ev.allDay && x.ev.time && x.first ? `<span class="t">${esc(x.ev.time)}</span>` : ''}${esc(x.ev.title)}</div>`
            : `<div class="p-we nt ${deptCls(x.n.dept)} ${x.n.priority === 'urgent' ? 'urgent' : ''}" data-act="p-zoom" data-kind="notice" data-id="${esc(x.n.id)}">${esc(deptName(x.n.dept))}｜${esc(x.n.title)}</div>`).join('')}</div>`;
      }).join('')}</div>`;
      $$('.p-wd', box).forEach(wd => {
        let hid = 0;
        for (let guard = 0; guard < 60 && overflowing(wd); guard++) {
          const es = $$('.p-we', wd); if (!es.length) break;
          es[es.length - 1].remove();
          setMore(wd, `還有 ${++hid} 筆，點一下看`, { kind: 'day', day: wd.dataset.day });
        }
      });
    }
  }
  function projCard(n) {
    const di = dueInfo(n);
    const tags = (n.priority === 'urgent' ? '<span class="p-pill urgent">緊急</span>' : n.priority === 'high' ? '<span class="p-pill high">重要</span>' : '') +
      (n.status === 'new' ? '<span class="p-pill new">待確認</span>' : `<span class="p-pill">${STATUS[n.status] || ''}</span>`);
    const meta = [n.items ? `<span>品項 <b>${esc(n.items)}</b></span>` : '', n.qty ? `<span>數量 <b>${esc(n.qty)}</b></span>` : '', n.owner ? `<span>負責 <b>${esc(n.owner)}</b></span>` : ''].join('');
    return `<article class="p-card ${deptCls(n.dept)} ${n.priority === 'urgent' ? 'urgent' : ''}" data-act="p-zoom" data-kind="notice" data-id="${esc(n.id)}">
      <div class="top">${dtag(n.dept)}<span class="ty">${esc(n.type || '')}</span><span class="tg">${tags}</span></div>
      <div class="p-viewport"><div class="p-scroll">
        <div class="ti">${esc(n.title)}</div>
        ${n.body ? `<div class="bd">${esc(n.body)}</div>` : ''}
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${n.reply ? `<div class="rp">${n.src === 'pb' ? '生產部備註' : '生產部回覆'}：${esc(n.reply)}</div>` : ''}
      </div></div>
      <div class="p-foot">
        ${di ? `<div class="due ${di.cls}">${esc(di.text)}<small>${esc(dueRange(n))}</small></div>` : '<div class="due"><small>未訂日期</small></div>'}
        ${projDoneBtn(n)}
      </div>
    </article>`;
  }
  const projDoneBtn = n => !canHandle() || n.status === 'done' || (n.pb && n.pb.ro) ? '' : isArmed(n.id)
    ? `<button type="button" class="p-done armed" data-act="p-done" data-id="${esc(n.id)}">再按一次確認完成</button>`
    : `<button type="button" class="p-done" data-act="p-done" data-id="${esc(n.id)}">✓ 完成</button>`;

  // 投影上點一下任何一項：放大顯示完整內容（點外面或「關閉」收起來，90 秒沒動作自動收起）
  function projZoom(kind, id, day) {
    proj.zoom = { kind, id, day };
    projZoomRender();
    clearTimeout(proj.zoomT);
    proj.zoomT = setTimeout(() => { projZoomClose(); projSchedule(); }, 90000);
    projSchedule();
  }
  function projZoomClose() {
    proj.zoom = null; clearTimeout(proj.zoomT);
    const b = $('#pZoom'); if (b) { b.hidden = true; b.innerHTML = ''; }
  }
  function projZoomRender() {
    const z = proj.zoom, box = $('#pZoom');
    if (!z || !box) return;
    const kv = rows => `<dl class="p-zoom-kv">${rows.filter(r => r[1]).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    let head = '', body = '', foot = '', cls = 'd-none';
    if (z.kind === 'notice') {
      const n = getNotice(z.id);
      if (!n) { projZoomClose(); return; }
      const di = dueInfo(n), pb = n.src === 'pb';
      cls = deptCls(n.dept) + (n.priority === 'urgent' && n.status !== 'done' ? ' urgent' : '');
      head = `${dtag(n.dept)}<span class="ty">${esc(n.type || '')}</span><span class="tg">${n.priority === 'urgent' ? '<span class="p-pill urgent">緊急</span>' : n.priority === 'high' ? '<span class="p-pill high">重要</span>' : ''}${n.status === 'new' ? '<span class="p-pill new">待確認</span>' : `<span class="p-pill">${STATUS[n.status] || ''}</span>`}</span>`;
      body = `<div class="p-zoom-t">${esc(n.title)}</div>${n.body ? `<div class="p-zoom-b">${esc(n.body)}</div>` : ''}` + kv([
        [pb ? '預交日' : '需處理', n.due ? dueRange(n) + (di && di.text ? '　' + di.text : '') : '未訂'],
        ['品項', n.items], ['數量', n.qty], [pb ? '負責人' : '生產部負責', n.owner], [pb ? '生產部備註' : '生產部回覆', n.reply]
      ].concat(pb
        ? [['提案人備註', n.pb.proposerNote], ['夥伴回饋', n.pb.feedback], ['附件', n.pb.attachments ? `${n.pb.attachments} 張（請到夥伴交接看板查看）` : ''], ['來源', '夥伴交接看板']]
        : [['發布', n.by ? `${n.by}　${stamp(n.at)}` : '']]));
      foot = projDoneBtn(n);
    } else if (z.kind === 'event') {
      const e = S.get('events', z.id);
      if (!e) { projZoomClose(); return; }
      cls = deptCls(e.dept);
      head = `${e.dept ? dtag(e.dept) : '<span class="dtag d-none">生產部</span>'}<span class="ty">行程・${esc(ETYPE[e.etype] || '')}</span>`;
      body = `<div class="p-zoom-t">${esc(e.title)}</div>` + kv([['時間', eventWhen(e, z.day)], ['重複', e.repeat && e.repeat !== 'none' ? REPEAT[e.repeat] : ''], ['地點', e.place], ['說明', e.note]]);
    } else {
      const list = proj.week[z.day] || entriesBetween(z.day, z.day, { proj: true })[z.day] || [];
      head = `<span class="ty">${z.day === today() ? '今天' : '行事曆'}</span>`;
      body = `<div class="p-zoom-t">${esc(mdw(z.day))}　共 ${list.length} 筆</div>` + (list.length ? list.map(x => x.kind === 'event'
        ? `<div class="p-zoom-item ${deptCls(x.ev.dept)}" data-act="p-zoom" data-kind="event" data-id="${esc(x.ev.id)}" data-day="${z.day}"><span class="t">${esc(evTimeLabel(x))}</span>${x.ev.dept ? dtag(x.ev.dept) : ''}<span class="x">${esc(x.ev.title)}</span></div>`
        : `<div class="p-zoom-item nt ${deptCls(x.n.dept)}" data-act="p-zoom" data-kind="notice" data-id="${esc(x.n.id)}"><span class="t">到期</span>${dtag(x.n.dept)}<span class="x">${esc(x.n.title)}</span></div>`).join('')
        : '<div class="p-empty">這天沒有行程或到期的事項</div>');
    }
    box.innerHTML = `<div class="p-zoom-box ${cls}" data-act="p-noop" role="dialog" aria-modal="true">
        <div class="p-zoom-k">${head}</div>
        <div class="p-zoom-body">${body}</div>
        <div class="p-zoom-f">${foot}<button type="button" class="p-zoom-x" data-act="p-zoom-close">關閉</button></div>
      </div>`;
    box.hidden = false;
    // 字很多：先縮小到 60%，還是放不下就讓內容區上下捲動（滑鼠滾輪或手指滑）
    const zb = box.firstElementChild, zbody = zb.querySelector('.p-zoom-body');
    for (let k = 1; k >= 0.6 - 0.001; k = Math.round((k - 0.05) * 100) / 100) {
      zb.style.setProperty('--k', String(k));
      if (zbody.scrollHeight <= zbody.clientHeight + 1) break;
    }
  }
  function projSchedule() {
    clearTimeout(proj.rotT);
    const sec = Math.max(5, Number(settings().rotateSec) || 12, proj.curDur || 0);
    const bar = $('#pProg');
    if (bar) { bar.classList.remove('run'); void bar.offsetWidth; bar.style.animationDuration = sec + 's'; bar.classList.add('run'); }
    proj.rotT = setTimeout(() => {
      if (!proj.on) return;
      if (!proj.cur && !proj.zoom) { proj.page = (proj.page + 1) % proj.pages; projCenter(); }   // 有通知跳出或放大檢視時先不翻頁
      projSchedule();
    }, sec * 1000);
  }
  function projClock() {
    const d = new Date(), el = $('#pHM'); if (!el) return;
    el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $('#pS').textContent = pad(d.getSeconds());
    if (d.getSeconds() === 0) projRender();   // 每分鐘更新「進行中」、到期天數、換日
  }
  function projPush(al) { proj.queue.push(al); if (!proj.cur) projNext(); else projPopCount(); }
  function projPopCount() { const c = $('#pPop .cnt'); if (c) c.textContent = proj.queue.length ? `還有 ${proj.queue.length} 則` : ''; }
  function projNext() {
    clearTimeout(proj.popT);
    const pop = $('#pPop'); if (!pop) return;
    const al = proj.queue.shift();
    proj.cur = al || null;
    if (!al) { pop.hidden = true; pop.innerHTML = ''; return; }
    const sec = Math.max(5, Number(settings().popupSec) || 25) * (al.urgent ? 2 : 1);
    pop.innerHTML = `<div class="p-pop-box ${al.urgent ? 'urgent' : ''}" role="alert">
        <div class="p-pop-k"><span>${esc(al.kicker)}</span>${al.dept ? dtag(al.dept) : ''}<span class="cnt"></span></div>
        <div class="p-pop-t">${esc(al.title)}</div>
        ${al.body ? `<div class="p-pop-b">${esc(al.body)}</div>` : ''}
        <div class="p-pop-l">${al.lines.map(l => `<span>${esc(l)}</span>`).join('')}</div>
        <div class="p-pop-f"><span>點一下關閉</span><span class="bar"><i style="animation-duration:${sec}s"></i></span></div>
      </div>`;
    pop.hidden = false;
    const pb = pop.firstElementChild;
    for (let k = 1; k >= 0.5 - 0.001; k = Math.round((k - 0.05) * 100) / 100) { pb.style.setProperty('--k', String(k)); if (pb.scrollHeight <= pop.clientHeight * 0.92) break; }
    projPopCount();
    proj.popT = setTimeout(projNext, sec * 1000);
  }
  async function requestWake() {
    try {
      if (proj.on && !proj.wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        proj.wake = await navigator.wakeLock.request('screen');
        proj.wake.addEventListener('release', () => { proj.wake = null; });
      }
    } catch (e) { /* 不支援或被拒絕：請把電腦的螢幕保護程式關掉 */ }
  }
  function releaseWake() { try { if (proj.wake) proj.wake.release(); } catch (e) { /* 已釋放 */ } proj.wake = null; }
  function projActive() {
    const el = $('#proj'); if (!proj.on) return;
    el.classList.remove('idle');
    clearTimeout(proj.idleT);
    proj.idleT = setTimeout(() => el.classList.add('idle'), 3500);
  }
  function updateSoundHint() {
    const p = prefs(), h = $('#pHint'), b = $('#pSoundBtn');
    if (h) h.hidden = !p.sound || (!!audioCtx && audioCtx.state === 'running');
    if (b) { b.textContent = '提示音：' + (p.sound ? '開' : '關'); b.classList.toggle('on', p.sound); }
  }

  // ================= 操作 =================
  function onAction(el, ev) {
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case 'new-notice': openNoticeForm(null, el.dataset.dept); break;
      case 'new-event': openEventForm(null, el.dataset.day); break;
      case 'open-notice': ev.stopPropagation(); openDrawer({ kind: 'notice', id }); break;
      case 'open-event': ev.stopPropagation(); openDrawer({ kind: 'event', id, day: el.dataset.day }); break;
      case 'close-drawer': closeDrawer(); break;
      case 'close-modal': closeModal(); break;
      case 'edit-notice': { const n = S.get('notices', id); closeDrawer(); if (n) openNoticeForm(n); break; }
      case 'del-notice': armDelete(el, () => { S.remove('notices', id); closeDrawer(); toast('已刪除'); }); break;
      case 'edit-event': { const e = S.get('events', id); closeDrawer(); if (e) openEventForm(e); break; }
      case 'del-event': armDelete(el, () => { S.remove('events', id); closeDrawer(); toast('已刪除'); }); break;
      case 'n-status': { const n = getNotice(drawerRef && drawerRef.id); if (n) setNoticeStatus(n, el.dataset.v); break; }
      case 'n-reply': {
        const n = getNotice(drawerRef && drawerRef.id); if (!n) break;
        const reply = $('#drReply').value.trim(), ownerEl = $('#drOwner');
        const patch = {};
        if (ownerEl) patch.owner = ownerEl.value.trim();
        if (reply !== (n.reply || '')) Object.assign(patch, { reply, replyBy: myName(), replyAt: Date.now() });
        if (n.status === 'new') Object.assign(patch, { status: 'ack', ackBy: myName(), ackAt: Date.now() });
        document.activeElement.blur();
        if (n.src === 'pb') savePbState(n.id, patch);
        else S.save('notices', Object.assign({}, n, patch));
        toast(n.src === 'pb' ? '已儲存備註' : '已儲存回覆');
        break;
      }
      case 'pb-refresh': loadPb(); break;
      case 'pb-sync': pbSyncNow(); break;
      case 'pb-savemap': pbSaveMap(); break;
      case 'b-status': B.status = el.dataset.v; B.quick = ''; renderBoardBody(); break;
      case 'b-group': B.group = el.dataset.v; renderBoardBody(); break;
      case 'quick': B.quick = B.quick === el.dataset.k ? '' : el.dataset.k; renderBoardBody(); break;
      case 'dept-filter':
        B.dept = B.dept === el.dataset.dept && view === 'board' ? '' : el.dataset.dept;
        if (view !== 'board') location.hash = '#board'; else { renderSide(); renderBoardBody(); }
        break;
      case 'cal-prev': case 'cal-next': {
        const [y, m] = C.month.split('-').map(Number), d = new Date(y, m - 1 + (act === 'cal-next' ? 1 : -1), 1);
        C.month = ymd(d).slice(0, 7); C.sel = C.month === today().slice(0, 7) ? today() : ymd(d);
        renderCalendar(); break;
      }
      case 'cal-today': C.month = today().slice(0, 7); C.sel = today(); renderCalendar(); break;
      case 'cal-mode': C.mode = el.dataset.v; renderCalendar(); break;
      case 'cal-day': C.sel = el.dataset.day; if (C.sel.slice(0, 7) !== C.month) C.month = C.sel.slice(0, 7); renderCalendar(); break;
      case 'sync-now': S.syncNow().then(ok => toast(ok ? '已同步' : '目前連不上雲端，修改會先存在這台裝置', !ok)); break;
      case 'logout': A.logout(); break;
      case 'test-alert': unlockAudio(); setTimeout(() => notify({ key: 'test:' + Date.now(), kind: 'test', dept: 'purchase', kicker: '測試提醒', title: '這是一則測試通知', lines: ['看到這張卡片、聽到提示音，就表示提醒正常'] }), 60); break;
      case 'copy-url': {
        const inp = $('#projUrl');
        const fallback = () => { inp.select(); toast('已選取網址，請按 Ctrl+C 複製'); };
        if (navigator.clipboard) navigator.clipboard.writeText(inp.value).then(() => toast('已複製投影網址'), fallback); else fallback();
        break;
      }
      case 'export': exportJson(); break;
      case 'import': $('#importFile').click(); break;
      case 'load-demo': loadDemo(); break;
      case 'clear-demo': clearDemo(); break;
      case 'wipe-all':
        if (confirm('要清除全部通知與行程嗎？所有人的看板都會一起清空（雲端每日備份仍保留 30 天）。')) { S.replaceKinds({ notices: [], events: [] }); saveSettings({ demo: false }); toast('已清除'); }
        break;
      case 'reset-types': $$('[data-types]').forEach(t => { t.value = DEPT[t.dataset.types].types.join('\n'); }); toast('已恢復預設類別，按「儲存看板設定」才會生效'); break;
      case 'user-edit': case 'user-toggle': case 'user-del': userAction(act, el.dataset.email); break;
      case 'user-cancel': U.edit = null; renderUsers(); break;
      case 'p-full':
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('這個瀏覽器不能切換全螢幕，請按 F11', true));
        break;
      case 'p-sound': setPrefs({ sound: !prefs().sound }); unlockAudio(); updateSoundHint(); break;
      case 'p-test': unlockAudio(); setTimeout(() => notify({ key: 'test:' + Date.now(), kind: 'test', dept: 'store', urgent: false, kicker: '測試通知', title: '各部門發布新通知時，會像這樣跳出來', lines: ['同時會響提示音；緊急通知會閃紅框、停留時間加倍', '點一下畫面就能關閉'] }), 60); break;
      case 'p-done': {
        // 投影畫面標示完成：按兩次才算（避免誤觸），第一次按時暫停翻頁
        const n = getNotice(id);
        if (!n || !canHandle()) break;
        if (!isArmed(id)) {
          proj.armed = { id, until: Date.now() + ARM_MS };
          projSchedule();       // 重新計時，確認前不會翻頁
          projCenter();
          if (proj.zoom) projZoomRender();
          clearTimeout(proj.armT);
          proj.armT = setTimeout(() => { proj.armed = null; if (proj.on) { projCenter(); if (proj.zoom) projZoomRender(); } }, ARM_MS);
          break;
        }
        proj.armed = null; clearTimeout(proj.armT);
        if (proj.zoom) projZoomClose();
        setNoticeStatus(n, 'done');
        if (n.src !== 'pb') toast(`已標示完成：${n.title}（要改回可到看板總覽）`);
        break;
      }
      case 'p-zoom': projZoom(el.dataset.kind, el.dataset.id, el.dataset.day); break;
      case 'p-zoom-close': projZoomClose(); projSchedule(); break;
      case 'p-noop': break;
      case 'p-exit': projExit(false); break;
      case 'p-pop-close': projNext(); break;
      case 'p-enable-sound': unlockAudio(); break;
      default: break;
    }
  }

  let toastT = null;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2600);
  }

  // ================= 啟動 =================
  function start() {
    applyPerms(); renderMe();
    document.addEventListener('click', ev => {
      const el = ev.target.closest('[data-act]');
      if (el) onAction(el, ev);
    });
    document.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') {
        if (!$('#modal').hidden) closeModal();
        else if (drawerRef) closeDrawer();
        else if (proj.on && proj.zoom) { projZoomClose(); projSchedule(); }
        else if (proj.on && proj.cur) projNext();
        return;
      }
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches && ev.target.matches('[role=button][data-act]')) { ev.preventDefault(); ev.target.click(); }
    });
    // 第一次點畫面時啟用提示音
    document.addEventListener('pointerdown', unlockAudio, true);
    document.addEventListener('keydown', unlockAudio, true);
    $('#proj').addEventListener('mousemove', projActive);
    window.addEventListener('resize', () => { if (proj.on) { clearTimeout(proj.rzT); proj.rzT = setTimeout(projRender, 250); } });
    $('#proj').addEventListener('pointerdown', projActive);
    $('#importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importJson(f); e.target.value = ''; });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { requestWake(); checkReminders(); } });

    S.on((type, payload) => {
      if (type === 'status') { renderSync(); checkNew(); }
      else if (type === 'change') { queueRender(); checkNew(); }
      else if (type === 'conflict') toast(`有人同時修改了「${payload.join('、')}」，已自動合併（同一欄位以你的修改為準）`);
    });
    A.on(() => { applyPerms(); renderMe(); if (view === 'manage') renderManage(); queueRender(); });
    window.addEventListener('hashchange', route);
    route();
    checkNew();
    setTimeout(checkReminders, 2000);
    setInterval(checkReminders, 20000);
    let lastDay = today();
    setInterval(() => { if (today() !== lastDay) { lastDay = today(); C.month = lastDay.slice(0, 7); C.sel = lastDay; queueRender(); } }, 60000);

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('service-worker.js').then(r => { swReg = r; }).catch(() => {});
      navigator.serviceWorker.addEventListener('message', ev => { if (ev.data && ev.data.type === 'open') openTarget(ev.data.target); });
    }
  }

  if (!A || !S) { console.error('缺少 auth.js 或 cloud-store.js'); return; }
  A.ready.then(start);
})();
