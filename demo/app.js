"use strict";
/* =========================================================
 * 陪伴 · 计划 —— 最小原型
 * 核心闭环：排今日计划 → 打卡 → 空余时间建议
 * 数据存 localStorage；纯前端、零依赖。
 * ========================================================= */

const STORE_KEY = "companion-plan-v2";
const APP_VERSION = "v5"; // 反馈报告里会带上；改代码时和 sw.js 的 CACHE 版本号一起 +1
const MS_DAY = 86400000;
function todayStr(){
  const d = new Date(); // 本地时区的"现在"
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
const DAY_START = "06:25";   // 可支配日窗口（起床后）
const DAY_END = "22:00";     // 熄灯
const MIN_FRAG = 10;         // 小于 10 分钟的碎片忽略
const DAY_NAMES = ["一","二","三","四","五","六","日"];

function pad(n){ return String(n).padStart(2, "0"); }
function hhmmToMin(s){ const [h,m] = s.split(":").map(Number); return h*60 + m; }
function minToHHMM(n){ return pad(Math.floor(n/60) % 24) + ":" + pad(n % 60); }
function nowMin(){ const d = new Date(); return d.getHours()*60 + d.getMinutes(); } // 现在几点（分钟数）
function daysUntil(deadline){ return Math.round((new Date(deadline+"T00:00:00") - new Date(todayStr()+"T00:00:00")) / MS_DAY); }
function daysSince(lastDone){ return Math.round((new Date(todayStr()+"T00:00:00") - new Date(lastDone+"T00:00:00")) / MS_DAY); }
/* 习惯"欠了多久"：从没做过 = Infinity（一直欠着）。新建条目就是这种状态，不是"今天做过了"。 */
function habitGap(b){ return b.lastDone ? daysSince(b.lastDone) : Infinity; }

/* ---------- 时长账：完成任务不等于"这段时间还给你" ----------
   已完成 → 按上报的实际耗时算（没上报就按预计算）；未完成 → 按预计时长占着。
   于是"读书一小时"实际做了 60 分钟 = 盈余 0；"背 30 个单词"预计 30 实际 20 = 盈余 10 分钟。
   做得比预计久就如实扣减，不假装没发生。 */
function spentMin(t){ return t.done ? (t.actual == null ? t.min : Math.max(0, t.actual)) : t.min; }
function usedMin(d){ return d.tasks.reduce((s,t) => s + spentMin(t), 0); }
/* 从现在到熄灯，还剩多少空闲（已过去的那部分不算） */
function futureFreeMin(d){
  const now = nowMin(), dayEnd = hhmmToMin(DAY_END);
  let future = 0;
  for(const f of d.fragments){
    const s = Math.max(hhmmToMin(f.start), now);
    const e = Math.min(hhmmToMin(f.end), dayEnd);
    if(e > s) future += e - s;
  }
  return future;
}
/* 可支配 = 今天累积还没用掉的时间，但不能超过"从现在到熄灯"还剩的空闲。
   前半句保留了"提前完成省下的时间会回到可支配"（已完成按实际耗时算）；
   后半句保证晚上做完不会自称还有一上午可支配。 */
function freeMinOf(d){
  const accum = d.fragments.reduce((s,f) => s + fragMin(f), 0) - usedMin(d);
  return Math.max(0, Math.min(accum, futureFreeMin(d)));
}
/* 已完成的任务只占到"实际耗时"为止，省下的那截时间要能被新任务用上 */
function effEnd(t){
  if(!t.done || t.actual == null || !t.start) return t.end;
  return addMin(t.start, Math.max(0, t.actual));
}
function weekdayOf(dateStr){ const d = new Date(dateStr+"T00:00:00").getDay(); return d === 0 ? 7 : d; } // 1=周一…7=周日
function isRestDay(dateStr){ return settings.restDays.includes(weekdayOf(dateStr)); }
function bucketOf(days){ // 工作日 / 休息日 / 每天 / 其他
  const rest = settings.restDays;
  if(days.length === 7) return "both";
  if(days.length && days.every(d => rest.includes(d))) return "rest";
  if(days.length && days.every(d => !rest.includes(d))) return "work";
  return "mixed";
}
function fragMin(f){ return hhmmToMin(f.end) - hhmmToMin(f.start); }
function fmtDur(min){ const h=Math.floor(min/60), m=min%60; return h>0 ? (m>0? h+"h"+m+"m" : h+"h") : m+"m"; }
function daysLabel(days){
  if(!days || !days.length) return "";
  const all=[1,2,3,4,5,6,7], wd=[1,2,3,4,5];
  const eq=(a,b)=>a.length===b.length && a.every(v=>b.includes(v));
  if(eq(days, all)) return "每天";
  if(eq(days, wd)) return "工作日";
  return days.map(d=>"周"+DAY_NAMES[d-1]).join("、");
}
function addMin(timeStr, m){ return minToHHMM(hhmmToMin(timeStr) + m); }
function addDaysStr(dateStr, n){
  const d = new Date(dateStr+"T00:00:00");
  d.setDate(d.getDate()+n);
  return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
}

/* ---------- 从固定占用反推空闲碎片 ---------- */
function genFromSchedule(schedule, dateStr){
  const wd = weekdayOf(dateStr);
  const occ = schedule.filter(s => s.days.includes(wd)).sort((a,b)=>a.start.localeCompare(b.start));
  const frags = [];
  let cursor = DAY_START;
  for(const o of occ){
    if(o.start > cursor) frags.push({start:cursor, end:o.start});
    if(o.end > cursor) cursor = o.end;
  }
  if(DAY_END > cursor) frags.push({start:cursor, end:DAY_END});
  return frags.filter(f => fragMin(f) >= MIN_FRAG);
}

/* ---------- 种子数据：空模板（默认不预置任何内容） ---------- */
function seedState(){
  const schedule = [];
  const backlog = [];
  const days = {};
  const notes = [];
  return { schedule, backlog, days, notes };
}

/* ---------- 状态 ---------- */
let state = load();
function load(){
  try {
    const s = localStorage.getItem(STORE_KEY);
    if(s) return repairLegacy(Object.assign(seedState(), JSON.parse(s))); // 旧数据缺 notes 时自动补默认值
  } catch(e){}
  return seedState();
}
/* 兼容旧数据：以前新建习惯时会把 lastDone 写成"今天"（那是个 bug），于是当天新加的习惯
   永远进不了"今天该做的"。凡是"写着今天做过、但今天并没有完成记录"的习惯，改回"从没做过"。 */
function repairLegacy(st){
  const today = todayStr();
  const doneToday = new Set();
  const d = st.days && st.days[today];
  if(d && d.tasks) d.tasks.forEach(t => { if(t.done && t.backlogId) doneToday.add(t.backlogId); });
  (st.backlog || []).forEach(b => {
    if(b.type === "habit" && b.lastDone === today && !doneToday.has(b.id)) b.lastDone = null;
  });
  return st;
}
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
function dayData(){
  let d = state.days[state.date];
  if(!d) d = state.days[state.date] = {fragments:[], tasks:[], skipped:[]};
  if(!d.skipped) d.skipped = []; // 旧数据补默认值
  return d;
}

/* 每天打开时，把"今天到期"的日常习惯自动列进今日计划（只列任务、不排具体时间段） */
function autoGenHabits(){
  if(state.date !== todayStr()) return; // 只对"今天"自动生成，历史/未来不塞
  const d = dayData();
  let changed = false;
  state.backlog.forEach(b => {
    if(b.type !== "habit") return;
    if(!b.lastDone) return;                                      // 从没做过的：等你手动导入/安排，不自动塞
    const gap = daysSince(b.lastDone);
    if(gap < (b.interval || 1)) return;                          // 还没到该做的日子
    if(d.skipped.includes(b.id)) return;                         // 今天手动删过，别再塞回来
    if(d.tasks.some(t => t.backlogId === b.id)) return;          // 已经列在今日计划里了
    d.tasks.push({ id: uid(), backlogId: b.id, title: b.name, min: b.min, done: false, kind: "habit" });
    changed = true;
  });
  if(changed) save();
}

state.date = todayStr(); // 每次打开都回到今天，不管上次停在哪
let view = "today";
let energy = "高", scene = "可外出";
let noteType = "todo"; // 记事本当前输入类型：todo=清单 / note=文字
let lastSugg = null; // 最近一次建议结果，render 后仍保留

/* ---------- 主题皮肤 ---------- */
const THEME_NAMES = { violet:"紫藤", teal:"青竹", amber:"暖阳", ink:"墨蓝" };
const THEME_META = { violet:"#16171F", teal:"#0F1415", amber:"#17130F", ink:"#12131C" };
function applyTheme(t){
  if(!THEME_NAMES[t]) t = "violet"; // 旧存的 auto 或非法值，统一归到紫藤
  document.body.dataset.theme = t;
  const meta = document.querySelector('meta[name="theme-color"]');
  if(meta) meta.content = THEME_META[t] || "#16171F";
  localStorage.setItem("companion-theme", t);
}
applyTheme(localStorage.getItem("companion-theme") || "violet");

/* ---------- 设置（鼓励提醒频率 / 皮肤入口） ---------- */
const SETTINGS_KEY = "companion-settings";
const DEFAULT_SETTINGS = { cheerEvery: true, cheerMilestone: 0, cheerDone: true, restDays: [6,7], importMode: null };
let settings = loadSettings();
function loadSettings(){
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if(s) return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(s));
  } catch(e){}
  return Object.assign({}, DEFAULT_SETTINGS);
}
function saveSettings(){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

/* ---------- 休息日设置 ---------- */
function syncRestDaysUI(){
  document.querySelectorAll("#restDays input").forEach(cb => { cb.checked = settings.restDays.includes(+cb.value); });
  updateRestSummary();
}
function updateRestSummary(){
  const arr = settings.restDays.slice().sort((a,b)=>a-b);
  $("restSummary").textContent = arr.length ? "当前休息日：" + arr.map(d=>"周"+DAY_NAMES[d-1]).join("、") : "还没选休息日（每天都按工作日算）";
}
function setRestDays(days){
  document.querySelectorAll("#restDays input").forEach(cb => { cb.checked = days.includes(+cb.value); });
  syncRestDays();
}
function syncRestDays(){
  settings.restDays = [...document.querySelectorAll("#restDays input:checked")].map(x=>+x.value);
  saveSettings();
  updateRestSummary();
  render();
}

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function uid(){ return "id"+Math.random().toString(36).slice(2,9); }

/* ---------- 渲染 ---------- */
function render(){
  autoGenHabits();
  syncRestDaysUI();
  $("datePicker").value = state.date;
  $("tabToday").classList.toggle("on", view==="today");
  $("tabBacklog").classList.toggle("on", view==="backlog");
  $("tabSchedule").classList.toggle("on", view==="schedule");
  $("tabWeek").classList.toggle("on", view==="week");
  $("tabNotes").classList.toggle("on", view==="notes");
  $("tabSprint").classList.toggle("on", view==="sprint");
  $("viewToday").classList.toggle("on", view==="today");
  $("viewBacklog").classList.toggle("on", view==="backlog");
  $("viewSchedule").classList.toggle("on", view==="schedule");
  $("viewWeek").classList.toggle("on", view==="week");
  $("viewNotes").classList.toggle("on", view==="notes");
  $("viewSprint").classList.toggle("on", view==="sprint");
  renderOverview(); renderFrags(); renderTasks(); renderBacklog(); renderSchedule(); renderSuggList(); renderWeek(); renderNotes(); renderSprint();
}

function renderOverview(){
  const d = dayData();
  const totalMin = d.fragments.reduce((s,f)=>s+fragMin(f),0);
  const plannedMin = d.tasks.reduce((s,t)=>s+t.min,0); // 只用来画"排布密度"进度条
  const doneCount = d.tasks.filter(t=>t.done).length;
  const freeMin = freeMinOf(d);                        // 可支配：已完成按实际耗时算，提前完成才会变多
  $("ovTitle").textContent = state.date === todayStr() ? "今天" : state.date;
  $("ovRest").style.display = isRestDay(state.date) ? "" : "none";
  $("ovFree").textContent = fmtDur(freeMin);
  $("ovDone").textContent = doneCount + "/" + d.tasks.length;
  $("ovMeter").style.width = (totalMin ? Math.min(100, plannedMin/totalMin*100) : 0) + "%";
}

function renderFrags(){
  const d = dayData();
  const el = $("fragList");
  if(!d.fragments.length){ el.innerHTML = '<div class="empty">还没有空闲时间段。点"从作息生成"，或手动"＋ 添加"。</div>'; return; }
  el.innerHTML = d.fragments.map((f,i)=>{
    const inner = d.tasks
      .filter(t => t.start && t.end && t.start >= f.start && t.end <= f.end)
      .sort((a,b)=> a.start.localeCompare(b.start));
    const tasksHtml = inner.map(t=>`
      <div class="frag-task ${t.done?'done':''}">
        <span class="ft-time">${t.start}–${effEnd(t)}</span>
        <span class="ft-name">${esc(t.title)}</span>
      </div>`).join("");
    return `
      <div class="frag-group">
        <div class="frag">
          <span class="time">${f.start}–${f.end}</span>
          <span class="dur">${fmtDur(fragMin(f))}</span>
          <span class="del" data-del-frag="${i}">✕</span>
        </div>
        ${tasksHtml}
      </div>`;
  }).join("");
}

function renderTasks(){
  const d = dayData();
  const el = $("taskList");
  if(!d.tasks.length){ el.innerHTML = '<div class="empty">还没安排任务，点"＋ 安排任务"。</div>'; return; }
  const dupCount = {}; // 同一事项今天导入了多次时标出来，免得看着像 bug
  d.tasks.forEach(t => { if(t.backlogId) dupCount[t.backlogId] = (dupCount[t.backlogId]||0) + 1; });
  el.innerHTML = d.tasks.map((t,i)=>{
    const tag = t.kind === "habit"
      ? '<span class="t-tag">日常</span>'
      : '<span class="t-tag t-tag-tmp">临时</span>';
    const dup = (t.backlogId && dupCount[t.backlogId] > 1) ? `<span class="t-dup">×${dupCount[t.backlogId]}</span>` : "";
    // 已完成：显示实际耗时（可点开改）和实际占用的时间段，让"省下的那截时间"看得见
    const spent = t.done
      ? (t.actual == null
          ? `<span class="t-spent" data-actual="${i}" title="点这里补上报实际耗时">${fmtDur(t.min)}（按预计）</span>`
          : `<span class="t-spent" data-actual="${i}" title="点这里改实际耗时">实际 ${fmtDur(t.actual)}${t.actual !== t.min ? `（预计 ${fmtDur(t.min)}）` : ""}</span>`)
      : `<span>${fmtDur(t.min)}</span>`;
    const range = (t.start && t.end)
      ? `<span class="t-time">${t.start}–${t.done ? effEnd(t) : t.end}</span>`
      : "";
    return `
    <div class="task ${t.done?'done':''}">
      <div class="cb" data-check="${i}">${t.done?'✓':''}</div>
      <div class="t-body">
        <div class="t-title">${tag}${esc(t.title)}${dup}</div>
        <div class="t-meta">${spent}${range}</div>
      </div>
      <span class="t-del" data-del-task="${i}">✕</span>
    </div>`;
  }).join("");
}

function renderBacklog(){
  const el = $("backlogList");
  if(!state.backlog.length){ el.innerHTML = '<div class="empty">事项池为空，点"＋ 添加"。</div>'; return; }
  el.innerHTML = state.backlog.map((b,i)=>{
    let meta = "";
    if(b.type==="deadline"){ const dd=daysUntil(b.deadline); meta = `截止 ${b.deadline} · 剩 ${dd} 天`; }
    else { meta = b.lastDone ? `习惯 · ${daysSince(b.lastDone)} 天没做` : "习惯 · 还没开始"; }
    const must = !!b.must;
    return `<div class="blk" draggable="true" data-idx="${i}">
      <span class="grip" title="拖动排序">⠿</span>
      <span class="tag ${must?'must':''}">${must?'⭐ ':''}${esc(b.cat||"其他")}</span>
      <div class="b-main">
        <div class="b-name">${esc(b.name)}</div>
        <div class="b-desc">${esc(b.desc||"")}</div>
        <div class="b-flags">
          <span class="flag pri">第 ${i+1} 优先</span>
          <span class="flag">≥${b.min}分钟</span>
          <span class="flag">精力${b.energy}</span>
          <span class="flag">${b.scene}</span>
          <span class="flag">${meta}</span>
        </div>
      </div>
      <span class="t-del" data-del-backlog="${i}">✕</span>
    </div>`;
  }).join("");
}

function renderSchedule(){
  const el = $("occList");
  if(!state.schedule.length){ el.innerHTML = '<div class="empty">还没有固定占用。点下方"＋ 添加占用"。</div>'; return; }
  const occHtml = (o,i)=>`
    <div class="occ">
      <span class="o-days">${daysLabel(o.days)}</span>
      <div class="o-body">
        <div class="o-label">${esc(o.label||"占用")}</div>
        <div class="o-time">${o.start}–${o.end}</div>
      </div>
      <span class="del" data-del-occ="${i}">✕</span>
    </div>`;
  const groups = [
    { key:"work",  label:"工作日" },
    { key:"rest",  label:"休息日" },
    { key:"both",  label:"每天" },
    { key:"mixed", label:"其他" },
  ];
  const parts = [];
  for(const g of groups){
    const items = state.schedule.map((o,i)=>({o,i})).filter(x => bucketOf(x.o.days) === g.key);
    if(!items.length) continue;
    parts.push(`<div class="occ-group-hd">${g.label}</div>` + items.map(x=>occHtml(x.o,x.i)).join(""));
  }
  el.innerHTML = parts.join("");
}

function renderSuggList(){
  const el = $("suggList");
  if(!lastSugg){ el.innerHTML = ""; return; }
  const s = lastSugg;
  let html = "";
  if(isRestDay(state.date)) html += `<div class="rest-note">今天是休息日，时间宽裕，挑一件想做的慢慢做就好。</div>`;

  // 一、事项池建议（还有没安排的才显示）
  if(s.singles.length || s.combos.length){
    html += `<div style="font-size:12px;color:var(--sub);margin-top:12px">当前可支配 <b style="color:var(--brand)">${fmtDur(s.remaining)}</b>，建议：</div>`;
    html += s.singles.map((c,i)=>`
      <div class="sugg-card">
        <div class="rank">建议 ${i+1}</div>
        <div class="s-name">${esc(c.item.name)}<span class="s-fit">${c.fit}</span></div>
        <div class="s-reason">${esc(c.reason)} · 用 ${fmtDur(c.item.min)} 左右</div>
        <button class="sched-btn" data-sugg-single="${i}">放进空闲时间</button>
      </div>`).join("");
    if(s.combos.length){
      html += `<div class="combo-hd">组合建议 · 一次做两件</div>`;
      html += s.combos.map((c,i)=>`
        <div class="sugg-card combo">
          <div class="rank">组合 ${i+1}</div>
          <div class="s-name">${c.items.map(x=>esc(x.name)).join(" + ")}<span class="s-fit">${fmtDur(c.totalMin)}</span></div>
          <div class="s-reason">${esc(c.reason)} · 正好用满 ${fmtDur(c.totalMin)}</div>
          <button class="sched-btn" data-sugg-combo="${i}">一起放进去</button>
        </div>`).join("");
    }
  } else if(!s.rest){
    html += `<div class="empty" style="padding-top:14px">${esc(s.note || "暂时没有合适的事项。")}</div>`;
  }

  // 二、今日清空后的"恢复类"建议（不带目标，也不给按钮）
  if(s.rest) html += restBlock(s.rest);
  el.innerHTML = html;
}
function restBlock(rest){
  const line = !rest.items.length
    ? "时间刚好用满"
    : (rest.earned > 0
        ? `今天提前省下 ${fmtDur(rest.earned)}，今天的空闲还剩 <b>${fmtDur(rest.remaining)}</b>`
        : `今天的空闲还剩 <b>${fmtDur(rest.remaining)}</b>`);
  const items = rest.items.length
    ? rest.items.map(t => `<div class="rest-item">${esc(t)}</div>`).join("")
    : `<div class="rest-item rest-none">没什么要往里塞的了，今天到此为止。</div>`;
  return `
    <div class="rest-block">
      <div class="rest-hd">今天的都做完了</div>
      <div class="rest-sub">${line}</div>
      ${items}
    </div>`;
}

/* ---------- 建议引擎 ---------- */
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function sceneAllow(it){ return scene === "可外出" || it.scene !== "室外"; }

/* 恢复类建议：今日计划全部完成后，按"此刻空着的时间"给的不带目标的建议。
   跟事项池建议的区别是这些不进计划、不排时间段，也不该被当成任务。
   scene / energy 只用于筛选能不能做（跟事项池一套规则），不参与文案。 */
const REST_TIERS = [
  { max: 10, items: [
    { t:"站起来转转肩颈，伸个懒腰", scene:"室内", energy:"低" },
    { t:"做套眼保健操，或者往窗外远处看 30 秒", scene:"室内", energy:"低" },
    { t:"倒杯水，顺手把杯子洗了", scene:"室内", energy:"低" },
  ]},
  { max: 25, items: [
    { t:"泡杯茶坐着发会儿呆", scene:"室内", energy:"低" },
    { t:"冲个热水澡，把今天的劲儿卸下来", scene:"室内", energy:"中" },
    { t:"下楼走两圈，透透气", scene:"室外", energy:"中" },
    { t:"把桌面收一小块，看着舒服点", scene:"室内", energy:"中" },
  ]},
  { max: 45, items: [
    { t:"出门散散步，别戴耳机，听听外面的声音", scene:"室外", energy:"中" },
    { t:"听一张专辑，或者一期播客，躺着就行", scene:"不限", energy:"低" },
    { t:"小睡 20 分钟，设个闹钟，别超过 30", scene:"室内", energy:"低" },
  ]},
  { max: 75, items: [
    { t:"读几页书，不为读完，困了就放下", scene:"室内", energy:"中" },
    { t:"看一集纪录片，挑一直想看的那部", scene:"室内", energy:"低" },
    { t:"写点不给人看的东西，今天是怎么过的", scene:"室内", energy:"中" },
  ]},
  { max: 120, items: [
    { t:"看一部电影，中间不刷手机那种", scene:"室内", energy:"低" },
    { t:"骑车或者走远一点，去个平时不去的地方", scene:"室外", energy:"高" },
    { t:"给自己做顿想吃的，不赶时间", scene:"室内", energy:"中" },
    { t:"给家里或者老朋友打个电话，聊久一点", scene:"不限", energy:"低" },
    { t:"去超市或者菜市场慢慢逛，顺便把冰箱填满", scene:"室外", energy:"中" },
  ]},
  { max: Infinity, items: [
    { t:"这么长的一段时间，够做一件你一直想做、却一直没做的事", scene:"不限", energy:"中" },
    { t:"去个平时总说「下次去」的地方，公园、展、书店都行", scene:"室外", energy:"中" },
    { t:"今天该做的都做完了，剩下的时间全归你，想休息就休息", scene:"不限", energy:"低" },
  ]},
];
function restIdeas(remaining){
  const tier = REST_TIERS.find(t => remaining <= t.max) || REST_TIERS[REST_TIERS.length - 1];
  let fits = tier.items.filter(sceneAllow).filter(it => energyAllow(energy, it.energy));
  if(!fits.length) fits = tier.items; // 这一档全被场景/精力筛掉了就退回原样，别给空
  const left = fits.slice(), out = [];
  while(out.length < 2 && left.length) out.push(left.splice(Math.floor(Math.random()*left.length), 1)[0].t);
  return out;
}
function suggest(){
  const d = dayData();
  const baseFree = freeMinOf(d); // 已完成按实际耗时算：提前完成省下的时间会体现在这里
  const extra = parseInt($("extraMin").value,10) || 0;
  const remaining = baseFree + extra;

  // 候选 = 事项池里"今天还没排进计划、也还没做过"的。已经排了 / 做过的再推一遍就是废话。
  const today = todayStr();
  const inPlan = new Set(d.tasks.map(t => t.backlogId).filter(Boolean));
  const poolLeft = state.backlog.filter(b => !inPlan.has(b.id) && b.lastDone !== today);
  const cands = poolLeft
    .filter(b => b.min <= remaining)
    .filter(sceneAllow)
    .filter(b => energyAllow(energy, b.energy))
    .map(b => {
      let dyn = 0, reason = "";
      if(b.type === "deadline" && b.deadline){
        const dd = daysUntil(b.deadline);
        dyn = Math.max(0, 14 - dd) * 15; // 越接近截止越急，≤0 天最高 210
        reason = pick([
          `${b.unit||"截止"} 还剩 ${dd} 天，做一点就少一点`,
          `${b.unit||"截止"} 剩 ${dd} 天了，今天啃一小块就松一点`,
          `离 ${b.unit||"截止"} 还有 ${dd} 天，来得及，别攒到最后`,
          `${b.unit||"截止"} 还有 ${dd} 天，一天一点点就够`,
        ]);
      } else if(b.type === "habit"){
        const gap = habitGap(b);
        const due = b.interval || 1;
        if(gap >= due){
          dyn = isFinite(gap) ? (gap - due + 1) * 10 : 20; // 到期后每多欠一天 +10；从没做过的给一点紧迫度
          reason = isFinite(gap) ? pick([
            `「${b.name}」断了 ${gap} 天，今天做一点就接上了`,
            `「${b.name}」歇了 ${gap} 天，没关系，今天补一小份就回来`,
            `「${b.name}」空窗 ${gap} 天了，现在接回来刚刚好`,
            `「${b.name}」有 ${gap} 天没碰，今天先做 5 分钟，别让它继续断`,
          ]) : pick([
            `「${b.name}」还没开始，今天开个头`,
            `「${b.name}」一直没动过，先做 5 分钟试试`,
            `「${b.name}」是你新加进来的，今天就动一下`,
          ]);
        } else {
          dyn = -1000; // 还没到点 / 今天做过了：压到末尾
          reason = pick([
            `「${b.name}」最近有在做，保持住`,
            `「${b.name}」这几天的节奏不错，别松`,
            `「${b.name}」你在坚持，很好，继续保持`,
          ]);
        }
      }
      if(b.hint) reason = reason ? reason + " · " + b.hint : b.hint;
      else if(!reason && b.must) reason = pick([
        "这是你的主线，今天守住它",
        "这条对你最重要，今天别落下",
        "你的主线，今天就把它做完，别拖",
      ]);
      const over = remaining - b.min;
      const fit = over <= 15 ? 1.5 : (over <= 45 ? 0.8 : 0.2);
      const pri = state.backlog.length - state.backlog.indexOf(b); // 位置越靠前优先级越高
      const score = pri * 10 + dyn + fit; // pri 只做轻微影响，让"越紧急 / 越该做"真正主导
      const fitTag = over <= 15 ? "刚刚好" : (over <= 45 ? "合适" : "时间有余");
      return { item:b, score, reason, fit:fitTag };
    })
    .sort((a,b)=> b.score - a.score);

  const singles = cands.slice(0,3);

  // 组合建议：从排名靠前的候选里两两配对，总时长能塞进 remaining 就成组
  const combos = [];
  const pool = cands.slice(0,6);
  for(let i=0;i<pool.length;i++){
    for(let j=i+1;j<pool.length;j++){
      const a = pool[i], b = pool[j];
      const total = a.item.min + b.item.min;
      if(total > remaining) continue;
      combos.push({ items:[a.item, b.item], totalMin: total, score: a.score + b.score, reason: a.reason });
    }
  }
  combos.sort((a,b)=> b.score - a.score);
  const topCombos = combos.slice(0,2);

  // 空的时候要说清楚"为什么没有"，而不是笼统一句"没有合适的事项"
  let note = "";
  if(!cands.length){
    if(!state.backlog.length){
      note = "事项池还是空的，先去「事项池」页添加几件想做的事。";
    } else if(!poolLeft.length){
      note = "事项池里的事项今天都已经在今日计划里了，去把它们做掉吧。";
    } else {
      const shortest = Math.min.apply(null, poolLeft.map(b => b.min));
      note = (shortest > remaining)
        ? `当前可支配 ${fmtDur(remaining)}，还有 ${poolLeft.length} 件没安排，但最短的一件也要 ${fmtDur(shortest)}。`
        : "剩下这几件在当下的精力 / 环境下都不合适，换个精力档位，或者去室外试试。";
    }
  }

  // 今日计划全部完成 → 附上"恢复类"建议，按此刻空着的时间分档
  const allDone = d.tasks.length > 0 && d.tasks.every(t => t.done);
  let rest = null;
  if(allDone){
    const earned = d.tasks.reduce((s,t) => s + (t.min - spentMin(t)), 0); // 提前省下的总和；做超时就是负数
    rest = { earned, remaining, items: remaining >= 5 ? restIdeas(remaining) : [] };
  }
  lastSugg = { remaining, singles, combos: topCombos, empty: cands.length === 0, note, rest };
  renderSuggList();
}

function energyAllow(user, need){
  const rank = {低:1, 中:2, 高:3};
  return rank[need] <= rank[user];
}

/* ---------- 排程：把建议落进具体时间块 ---------- */
function freeSlots(){
  const d = dayData();
  const slots = [];
  const now = nowMin();
  for(const f of d.fragments){
    if(hhmmToMin(f.end) <= now) continue; // 这一段已经过去了，排不进去
    const inner = d.tasks
      .filter(t => t.start && t.end && t.start >= f.start && t.end <= f.end)
      .sort((a,b)=> a.start.localeCompare(b.start));
    let cursor = hhmmToMin(f.start) < now ? minToHHMM(now) : f.start; // 只排此刻之后的空档
    for(const t of inner){
      if(t.start > cursor) slots.push({start:cursor, end:t.start});
      const end = effEnd(t); // 已完成的任务只占到实际耗时为止，省下的尾巴让出来给新任务
      if(end > cursor) cursor = end;
    }
    if(f.end > cursor) slots.push({start:cursor, end:f.end});
  }
  return slots.filter(s => fragMin(s) >= MIN_FRAG);
}
function scheduleItems(list){
  const d = dayData();
  const placed = [], failed = [];
  for(const {item, min} of list){
    const slot = freeSlots().find(s => fragMin(s) >= min);
    if(!slot){ failed.push(item.name); continue; }
    const start = slot.start, end = addMin(start, min);
    d.tasks.push({ id:uid(), backlogId:item.id, title:item.name, min, start, end, done:false });
    placed.push(`${item.name} ${start}–${end}`);
  }
  lastSugg = null; // 排完清掉，重新点"给我一点建议"拿最新空闲
  save(); render();
  if(placed.length) toast("已放进：" + placed.join("、"));
  if(failed.length) toast("放不下：" + failed.join("、") + "（空闲时间不够）");
}

/* ---------- 周视图 ---------- */
function weekDates(){
  const wd = new Date(todayStr()+"T00:00:00").getDay(); // 0=周日
  const mondayOffset = wd === 0 ? -6 : 1 - wd;
  const out = [];
  for(let i=0;i<7;i++) out.push(addDaysStr(todayStr(), mondayOffset + i));
  return out;
}
function dayHasDone(ds){
  const d = state.days[ds];
  return !!(d && d.tasks.some(t => t.done));
}
function streakDays(){
  let n = 0;
  let ds = todayStr();
  if(!dayHasDone(ds)) ds = addDaysStr(ds, -1); // 今天还没打卡，从昨天往前算（今天没结束，不算断）
  while(dayHasDone(ds)){ n++; ds = addDaysStr(ds, -1); }
  return n;
}
function weekStats(){
  const dates = weekDates();
  let done=0, total=0;
  const byCat = {};
  for(const ds of dates){
    const d = state.days[ds];
    if(!d) continue;
    for(const t of d.tasks){
      total++;
      if(t.done){
        done++;
        const b = state.backlog.find(x=>x.id===t.backlogId);
        const cat = b ? (b.cat||"其他") : "其他";
        byCat[cat] = (byCat[cat]||0) + (t.min||0);
      }
    }
  }
  return {done, total, byCat, streak: streakDays()};
}
function cheerLine(streak, rate, total){
  if(streak >= 3) return `连续打卡 ${streak} 天，比上周更稳。`;
  if(streak >= 1) return `已经连续 ${streak} 天，今天也别断。`;
  if(total && rate >= 60) return `本周完成率 ${rate}%，节奏不错。`;
  if(total && rate > 0) return `本周开了个头，接着往下走。`;
  return `今天还没打卡，先做一件小的。`;
}
function renderWeek(){
  const st = weekStats();
  const cats = Object.entries(st.byCat).sort((a,b)=>b[1]-a[1]);
  const rate = st.total ? Math.round(st.done/st.total*100) : 0;
  $("weekStats").innerHTML = `
    <div class="cheer">${cheerLine(st.streak, rate, st.total)}</div>
    <div class="stat-row">
      <div class="stat"><div class="stat-n">${st.streak} 天</div><div class="stat-l">连续打卡</div></div>
      <div class="stat"><div class="stat-n">${st.done}/${st.total}</div><div class="stat-l">本周完成</div></div>
      <div class="stat"><div class="stat-n">${rate}%</div><div class="stat-l">完成率</div></div>
    </div>
    ${cats.length ? `<div class="stat-cats">${cats.map(([k,v])=>`<span class="scat"><b>${esc(k)}</b> ${fmtDur(v)}</span>`).join("")}</div>` : ""}`;

  const today = todayStr();
  let html = "";
  for(let i=0;i<7;i++){
    const ds = addDaysStr(today, i);
    const wd = "周" + DAY_NAMES[weekdayOf(ds)-1];
    const rest = isRestDay(ds);
    const isToday = i===0;
    const items = [];
    for(const b of state.backlog){
      if(b.type==="deadline" && b.deadline && b.deadline === ds){
        items.push(`<span class="wk-deadline">${esc(b.name)} 截止</span>`);
      } else if(b.type==="habit"){
        const gap = habitGap(b);
        const interval = b.interval || 1;
        const dueOffset = gap >= interval ? 0 : interval - gap; // 已逾期就归到今天，否则算还差几天
        if(dueOffset === i){
          const txt = !isFinite(gap) ? "还没开始" : (gap >= interval ? "逾期" + gap + "天" : "该做了");
          items.push(`<span class="wk-habit">${esc(b.name)} ${txt}</span>`);
        }
      }
    }
    const label = isToday ? "今天" : (i===1 ? "明天" : ds.slice(5));
    html += `
      <div class="wk-day ${isToday?'today':''}">
        <div class="wk-hd"><div class="wk-date">${label}</div><div class="wk-wd">${wd}${rest ? '<span class="wk-rest">休</span>' : ''}</div></div>
        <div class="wk-body">${items.length ? items.join("") : '<span class="wk-none">—</span>'}</div>
      </div>`;
  }
  $("weekList").innerHTML = html;
}

/* ---------- 记事本 ---------- */
function fmtNoteTime(ts){
  const d = new Date(ts), now = new Date();
  const md = (d.getMonth()+1) + "-" + pad(d.getDate());
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  return d.getFullYear() === now.getFullYear() ? md + " " + hm : d.getFullYear() + "-" + md + " " + hm;
}
function renderNotes(){
  const el = $("noteList");
  if(!state.notes.length){ el.innerHTML = '<div class="empty">还没记任何东西——上面输入框随手记一条，回车即存。</div>'; return; }
  el.innerHTML = state.notes.map((n,i)=>{
    const time = fmtNoteTime(n.ts);
    const del = `<span class="t-del" data-note-del="${i}">✕</span>`;
    if(n.type === "note"){
      return `<div class="note-item note-text">
        <div class="n-body"><div class="n-text">${esc(n.text)}</div><div class="n-time">${time}</div></div>
        ${del}
      </div>`;
    }
    return `<div class="note-item ${n.done?'done':''}">
      <div class="cb" data-note-check="${i}">${n.done?'✓':''}</div>
      <div class="n-body"><div class="n-text">${esc(n.text)}</div><div class="n-time">${time}</div></div>
      ${del}
    </div>`;
  }).join("");
}

/* ---------- 事件 ---------- */
function openModal(id){ $(id).classList.add("on"); }
function closeModal(id){ $(id).classList.remove("on"); }

$("datePicker").addEventListener("change", e => { state.date = e.target.value; save(); render(); });

/* 设置面板 */
$("settingsBtn").addEventListener("click", openSettings);
$("mSettingsClose").addEventListener("click", ()=> closeModal("mSettings"));
function openSettings(){
  $("setCheerEvery").checked = settings.cheerEvery;
  $("setCheerDone").checked = settings.cheerDone;
  const ms = settings.cheerMilestone;
  [...$("setCheerMilestone").children].forEach(x => x.classList.toggle("on", +x.dataset.v === ms));
  const im = settings.importMode;
  [...$("setImportMode").children].forEach(x => x.classList.toggle("on", x.dataset.v === im));
  $("setImportModeHint").style.display = im ? "none" : "";
  renderThemeSwatches();
  openModal("mSettings");
}
function renderThemeSwatches(){
  const cur = document.body.dataset.theme;
  document.querySelectorAll("[data-set-theme]").forEach(b => b.classList.toggle("on", b.dataset.setTheme === cur));
}
$("setCheerEvery").addEventListener("change", e => { settings.cheerEvery = e.target.checked; saveSettings(); });
$("setCheerDone").addEventListener("change", e => { settings.cheerDone = e.target.checked; saveSettings(); });
$("setCheerMilestone").addEventListener("click", e => {
  const b = e.target.closest("button"); if(!b) return;
  settings.cheerMilestone = +b.dataset.v; saveSettings();
  [...$("setCheerMilestone").children].forEach(x => x.classList.toggle("on", x === b));
});
$("setImportMode").addEventListener("click", e => {
  const b = e.target.closest("button"); if(!b) return;
  settings.importMode = b.dataset.v; saveSettings();
  [...$("setImportMode").children].forEach(x => x.classList.toggle("on", x === b));
  $("setImportModeHint").style.display = "none";
});
$("mSettings").addEventListener("click", e => {
  const b = e.target.closest("[data-set-theme]");
  if(!b) return;
  applyTheme(b.dataset.setTheme);
  renderThemeSwatches();
  toast("皮肤：" + THEME_NAMES[b.dataset.setTheme]);
});
$("tabToday").addEventListener("click", ()=>{ view="today"; render(); });
$("tabBacklog").addEventListener("click", ()=>{ view="backlog"; render(); });
$("tabSchedule").addEventListener("click", ()=>{ view="schedule"; render(); });
$("tabWeek").addEventListener("click", ()=>{ view="week"; render(); });
$("tabNotes").addEventListener("click", ()=>{ view="notes"; render(); });
$("tabSprint").addEventListener("click", ()=>{ view="sprint"; render(); });

/* 从作息生成今日空闲 */
$("genFrag").addEventListener("click", ()=>{
  if(!state.schedule.length){ alert("先到「作息」页添加固定占用。"); return; }
  const has = dayData().fragments.length > 0;
  if(has && !confirm("用固定作息覆盖当前的空闲时间段？")) return;
  dayData().fragments = genFromSchedule(state.schedule, state.date);
  save(); render(); toast("已生成今日空闲时间");
});

$("addFrag").addEventListener("click", ()=> openModal("mFrag"));
$("mFragCancel").addEventListener("click", ()=> closeModal("mFrag"));
$("mFragOk").addEventListener("click", ()=>{
  const start=$("fStart").value, end=$("fEnd").value;
  if(start && end && end > start){ dayData().fragments.push({start,end}); dayData().fragments.sort((a,b)=>a.start.localeCompare(b.start)); save(); render(); }
  closeModal("mFrag");
});

$("addTask").addEventListener("click", ()=>{
  const sel = $("tBacklog"); sel.innerHTML = '<option value="">— 自定义任务 —</option>' + state.backlog.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join("");
  $("tName").value=""; $("tMin").value="60"; openModal("mTask");
});
$("mTaskCancel").addEventListener("click", ()=> closeModal("mTask"));
$("mTaskOk").addEventListener("click", ()=>{
  const bid = $("tBacklog").value;
  const b = state.backlog.find(x=>x.id===bid);
  const name = $("tName").value.trim() || (b ? b.name : "");
  const min = parseInt($("tMin").value,10) || (b ? b.min : 60);
  if(name){ dayData().tasks.push({ id:uid(), backlogId:bid||null, title:name, min, done:false }); save(); render(); }
  closeModal("mTask");
});

function resetBacklogForm(){
  $("bName").value = "";
  $("bDesc").value = "";
  $("bMin").value = "20";
  $("bEnergy").value = "高";
  $("bScene").value = "不限";
  $("bType").value = "habit";
  $("bDeadline").value = "";
  $("bInterval").value = "2";
  $("bDeadlineWrap").style.display = "none";
  $("bIntervalWrap").style.display = "";
}
$("addBacklog").addEventListener("click", ()=> openModal("mBacklog"));
$("mBacklogCancel").addEventListener("click", ()=> closeModal("mBacklog"));
$("bType").addEventListener("change", e=>{
  const isDeadline = e.target.value === "deadline";
  $("bDeadlineWrap").style.display = isDeadline ? "" : "none";
  $("bIntervalWrap").style.display = isDeadline ? "none" : "";
});
$("mBacklogOk").addEventListener("click", ()=>{
  const name = $("bName").value.trim();
  if(name){
    state.backlog.push({
      id: uid(), name, desc: $("bDesc").value.trim(), cat:"自定义",
      min: parseInt($("bMin").value,10)||20,
      energy: $("bEnergy").value, scene: $("bScene").value,
      type: $("bType").value, deadline: $("bType").value==="deadline" ? ($("bDeadline").value || null) : null,
      interval: parseInt($("bInterval").value,10) || 2,
      lastDone: null, // 新建 = 从没做过（不是"今天做过了"，否则当天永远进不了"今天该做的"）
    });
    save(); render();
    resetBacklogForm(); // 写入后清空表单
  }
  closeModal("mBacklog");
});

/* ---------- 一键导入事项池 ---------- */
function dueItems(){
  const today = todayStr();
  return state.backlog.filter(b => {
    if(b.type === "deadline" && b.deadline) return b.deadline <= today;
    if(b.type === "habit") return habitGap(b) >= (b.interval||1);
    return false;
  });
}
function countInPlan(backlogId){ // 该事项今天已经列了几条（>0 说明重复导入过）
  return dayData().tasks.filter(t => t.backlogId === backlogId).length;
}
/* 一键导入 = 增量补新：只把"今天计划里还没有的"拉进来，已经排过的不再重复。
   只有勾选弹窗会传 allowDup（你亲手勾上 = 显式要求再做一次）。
   空闲时间段排不下时也照样进今日计划，只是不占时间段（跟"＋ 安排任务"手动加的一样）。
   不读 d.skipped：自动生成不跟你抢，手动导入永远算数。 */
function importTasks(items, opts){
  if(!items.length) return;
  const allowDup = !!(opts && opts.allowDup);
  const d = dayData();
  const scheduled = [], unscheduled = [], skipped = [];
  for(const b of items){
    if(!allowDup && countInPlan(b.id) > 0){ skipped.push(b.name); continue; } // 今天已经有了，只补新的
    const min = b.min || 20;
    const kind = b.type === "habit" ? "habit" : undefined;
    const slot = freeSlots().find(s => fragMin(s) >= min);
    if(slot){
      const start = slot.start, end = addMin(start, min);
      d.tasks.push({ id:uid(), backlogId:b.id, title:b.name, min, start, end, done:false, kind });
      scheduled.push({ name:b.name, at:`${start}–${end}` });
    } else {
      d.tasks.push({ id:uid(), backlogId:b.id, title:b.name, min, done:false, kind });
      unscheduled.push(b.name);
    }
  }
  lastSugg = null;
  save(); render();
  const added = scheduled.length + unscheduled.length;
  if(!added){ toast("没有新任务要导入"); return; }
  const parts = [];
  if(scheduled.length) parts.push(scheduled.map(x => `${x.name} ${x.at}`).join("、"));
  if(unscheduled.length) parts.push(`${unscheduled.join("、")}（还没定时间）`);
  const tail = skipped.length ? `；另有 ${skipped.length} 条今天已有，跳过` : "";
  toast(`已导入 ${added} 条：${parts.join("；")}${tail}`);
}
function doImport(mode){
  const items = mode === "all" ? state.backlog.slice() : dueItems();
  if(!items.length){
    toast(mode === "all"
      ? "事项池是空的，先去添加几个事项"
      : "今天没有到期的：截止型还没到日子，可用「全部事项」或「弹窗勾选」");
    return;
  }
  importTasks(items);
}
function openImportPick(){
  const dueIds = new Set(dueItems().map(x=>x.id));
  $("importPickList").innerHTML = state.backlog.map(b => {
    const n = countInPlan(b.id);
    const meta = (b.type === "deadline" ? "截止 " + (b.deadline||"") : "习惯") + ` · ${b.min}分钟`;
    // 今天已经排过的默认不勾（想再导一次就自己勾上），避免一不留神导出一堆重复
    return `
    <label class="ip-item">
      <input type="checkbox" value="${b.id}" ${(!n && dueIds.has(b.id)) ? "checked" : ""}>
      <span>${esc(b.name)}${n ? `<i class="ip-dup">今日计划里已有 ${n} 条，再勾会新增 1 条</i>` : ""}</span>
      <em>${meta}</em>
    </label>`;
  }).join("");
  openModal("mImportPick");
}
$("importTasks").addEventListener("click", ()=>{
  if(!settings.importMode){ openModal("mImportMode"); return; }  // 首次：先选方式
  if(settings.importMode === "pick"){ openImportPick(); return; }
  doImport(settings.importMode);
});
document.querySelectorAll("#mImportMode [data-mode]").forEach(b => b.addEventListener("click", ()=>{
  settings.importMode = b.dataset.mode; saveSettings();
  closeModal("mImportMode");
  if(settings.importMode === "pick") openImportPick();
  else doImport(settings.importMode);
}));
$("mImportPickCancel").addEventListener("click", ()=> closeModal("mImportPick"));
$("mImportPickOk").addEventListener("click", ()=>{
  const ids = [...document.querySelectorAll("#importPickList input:checked")].map(x=>x.value);
  const items = state.backlog.filter(b => ids.includes(b.id));
  closeModal("mImportPick");
  // 这里是你亲手勾的，已排过的也照加（"真重复"只有这一条路走得通）
  if(items.length) importTasks(items, { allowDup: true });
  else toast("没勾选任何事项");
});

/* 占用 */
$("addOcc").addEventListener("click", ()=>{
  $("oLabel").value = "";
  const rest = settings.restDays;
  document.querySelectorAll("#oDays input").forEach(cb => { cb.checked = !rest.includes(+cb.value); });
  openModal("mOcc");
});
$("mOccCancel").addEventListener("click", ()=> closeModal("mOcc"));
$("mOccOk").addEventListener("click", ()=>{
  const label=$("oLabel").value.trim()||"占用", start=$("oStart").value, end=$("oEnd").value;
  const days = [...document.querySelectorAll("#oDays input:checked")].map(x=>+x.value);
  if(start && end && end > start && days.length){ state.schedule.push({days, start, end, label}); save(); render(); }
  closeModal("mOcc");
});

/* 占用弹窗：快捷填充工作日 / 休息日 / 每天 */
document.querySelectorAll("[data-fill]").forEach(b => b.addEventListener("click", ()=>{
  const fill = b.dataset.fill, rest = settings.restDays;
  document.querySelectorAll("#oDays input").forEach(cb => {
    const d = +cb.value;
    cb.checked = fill === "all" ? true : (fill === "rest" ? rest.includes(d) : !rest.includes(d));
  });
}));

/* 休息日设置：预设 / 手动勾选 */
$("restPreset2").addEventListener("click", ()=> setRestDays([6,7]));
$("restPreset1").addEventListener("click", ()=> setRestDays([7]));
document.querySelectorAll("#restDays input").forEach(cb => cb.addEventListener("change", syncRestDays));

/* 点击委托：删除 / 打卡 */
document.addEventListener("click", e=>{
  const ss = e.target.closest("[data-sugg-single]");
  if(ss && lastSugg){
    const c = lastSugg.singles[+ss.dataset.suggSingle];
    if(c) scheduleItems([{item:c.item, min:c.item.min}]);
    return;
  }
  const sc = e.target.closest("[data-sugg-combo]");
  if(sc && lastSugg){
    const c = lastSugg.combos[+sc.dataset.suggCombo];
    if(c) scheduleItems(c.items.map(x=>({item:x, min:x.min})));
    return;
  }
  const df = e.target.closest("[data-del-frag]");
  if(df){ dayData().fragments.splice(+df.dataset.delFrag,1); save(); render(); return; }
  const dt = e.target.closest("[data-del-task]");
  if(dt){
    const d = dayData();
    const t = d.tasks[+dt.dataset.delTask];
    if(t && t.kind === "habit" && t.backlogId && !d.skipped.includes(t.backlogId)) d.skipped.push(t.backlogId);
    d.tasks.splice(+dt.dataset.delTask,1);
    save(); render(); return;
  }
  const db = e.target.closest("[data-del-backlog]");
  if(db){ state.backlog.splice(+db.dataset.delBacklog,1); save(); render(); return; }
  const dO = e.target.closest("[data-del-occ]");
  if(dO){ state.schedule.splice(+dO.dataset.delOcc,1); save(); render(); return; }
  const nd = e.target.closest("[data-note-del]");
  if(nd){ state.notes.splice(+nd.dataset.noteDel,1); save(); render(); return; }
  const nc = e.target.closest("[data-note-check]");
  if(nc){ state.notes[+nc.dataset.noteCheck].done = !state.notes[+nc.dataset.noteCheck].done; save(); render(); return; }
  const ac = e.target.closest("[data-actual]");
  if(ac){ openActual(+ac.dataset.actual); return; }
  const ck = e.target.closest("[data-check]");
  if(ck){
    const i = +ck.dataset.check;
    const t = dayData().tasks[i];
    if(t.done){ t.done = false; save(); render(); return; } // 取消打卡：直接还原，不必再问耗时
    openActual(i);                                          // 完成打卡：先上报实际耗时
    return;
  }
});

$("segEnergy").addEventListener("click", e=>{
  const b = e.target.closest("button"); if(!b) return;
  energy = b.dataset.v; [...$("segEnergy").children].forEach(x=>x.classList.toggle("on", x===b));
});
$("segScene").addEventListener("click", e=>{
  const b = e.target.closest("button"); if(!b) return;
  scene = b.dataset.v; [...$("segScene").children].forEach(x=>x.classList.toggle("on", x===b));
});

/* 记事本：类型切换 / 记下 */
$("segNoteType").addEventListener("click", e=>{
  const b = e.target.closest("button"); if(!b) return;
  noteType = b.dataset.v; [...$("segNoteType").children].forEach(x=>x.classList.toggle("on", x===b));
});
function addNote(){
  const text = $("noteInput").value.trim();
  if(!text){ $("noteInput").focus(); return; }
  state.notes.unshift({ id:uid(), type:noteType, text, done:false, ts:Date.now() }); // 最新在前
  $("noteInput").value = "";
  save(); render();
  $("noteInput").focus();
}
$("btnAddNote").addEventListener("click", addNote);
$("noteInput").addEventListener("keydown", e=>{
  if(e.key !== "Enter" || e.ctrlKey) return; // 普通回车保存；Ctrl+回车交给浏览器默认换行
  e.preventDefault();
  addNote();
});
$("btnSuggest").addEventListener("click", suggest);

/* ---------- 完成打卡：强制上报实际耗时（否则算不出提前省下的时间） ---------- */
let actualIdx = null;
function openActual(i){
  const t = dayData().tasks[i];
  if(!t) return;
  actualIdx = i;
  const edit = !!t.done; // 已完成 = 只是回来改数字，不改打卡状态
  $("aTitle").textContent = (edit ? "修改实际耗时" : "完成打卡") + "：「" + t.title + "」";
  $("aHint").textContent = `预计 ${fmtDur(t.min)}。填上实际花了多久，才算得出"提前省下多少时间"。`;
  $("aQuick").textContent = "就按预计 " + fmtDur(t.min);
  const inp = $("aMin");
  inp.value = (edit && t.actual != null) ? t.actual : "";
  inp.placeholder = "预计 " + fmtDur(t.min);
  syncActualOk();
  openModal("mActual");
  inp.focus();
}
function syncActualOk(){ // 没填数字就不给点「完成打卡」
  const v = String($("aMin").value).trim();
  const n = v === "" ? NaN : Number(v);
  $("mActualOk").disabled = !(Number.isFinite(n) && n >= 0);
}
function fillActualEstimate(){ // 「就按预计」一键填入
  const t = dayData().tasks[actualIdx]; if(!t) return;
  $("aMin").value = t.min; syncActualOk(); $("aMin").focus();
}
function commitActual(){
  const t = dayData().tasks[actualIdx];
  const raw = String($("aMin").value).trim();
  const n = raw === "" ? NaN : Math.round(Number(raw)); // 空值不能当 0：否则"没填"会被记成"零分钟做完"，白送一整段盈余
  if(!t || !Number.isFinite(n) || n < 0) return;
  const firstTime = !t.done;
  t.actual = n;
  if(firstTime){
    t.done = true;
    if(t.backlogId){
      const b = state.backlog.find(x => x.id === t.backlogId);
      if(b) b.lastDone = todayStr();
    }
  }
  closeModal("mActual");
  save(); render();
  const saved = t.min - n;
  const note = saved > 0 ? `省下 ${fmtDur(saved)}，已回到可支配时间`
             : saved < 0 ? `比预计多用了 ${fmtDur(-saved)}`
             : "正好用满预计时间";
  if(firstTime) cheerOnCheck(note); // 按设置里的频率弹鼓励，顺带报耗时结果
  else toast("已更新实际耗时 · " + note);
}
$("aMin").addEventListener("input", syncActualOk);
$("aQuick").addEventListener("click", fillActualEstimate);
$("mActualCancel").addEventListener("click", ()=> closeModal("mActual"));
$("mActualOk").addEventListener("click", commitActual);

document.querySelectorAll(".modal-mask").forEach(m=>{
  m.addEventListener("click", e=>{ if(e.target===m) m.classList.remove("on"); });
});

/* ---------- 轻提示 ---------- */
const CHEER = [
  "做完了，漂亮",
  "这一件拿下",
  "又往前挪了一步",
  "不错，接着来",
  "搞定，比昨天强",
  "今天也没落下",
];
const CHEER_MILESTONE = [
  "今天已经勾掉 {n} 个了",
  "第 {n} 个，这个劲攒起来了",
  "连续 {n} 件拿下，稳",
  "{n} 个了，比想象中快",
];
const CHEER_DONE = [
  "今天的任务全清完了",
  "今天收工，漂亮",
  "全都做完了，好好歇着",
  "今天这一页翻过去了，干得漂亮",
];
function milestoneCheer(n){ return pick(CHEER_MILESTONE).replace(/\{n\}/g, n); }
function cheerOnCheck(extra){
  const tail = extra ? " · " + extra : "";
  const d = dayData();
  const doneCount = d.tasks.filter(t => t.done).length;
  const total = d.tasks.length;
  if(settings.cheerDone && total > 0 && doneCount >= total){
    toast(pick(CHEER_DONE) + tail);
  } else if(settings.cheerMilestone > 0 && doneCount === settings.cheerMilestone){
    toast(milestoneCheer(settings.cheerMilestone) + tail);
  } else if(settings.cheerEvery){
    toast(pick(CHEER) + tail);
  } else if(extra){
    toast(extra); // 鼓励全关掉时，至少把耗时结果告诉用户
  }
}
let toastTimer;
function toast(msg){
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> t.classList.remove("show"), 1800);
}

/* ---------- 事项池拖拽排序（顺序即优先级） ---------- */
let dragIdx = null;
document.addEventListener("dragstart", e=>{
  const blk = e.target.closest(".blk"); if(!blk) return;
  dragIdx = +blk.dataset.idx;
  blk.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", String(dragIdx)); } catch(err){}
});
document.addEventListener("dragover", e=>{
  const blk = e.target.closest(".blk"); if(!blk) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".blk.dragover").forEach(x=>x.classList.remove("dragover"));
  blk.classList.add("dragover");
});
document.addEventListener("drop", e=>{
  const blk = e.target.closest(".blk"); if(!blk || dragIdx == null) return;
  e.preventDefault();
  const to = +blk.dataset.idx;
  if(to !== dragIdx){
    const [moved] = state.backlog.splice(dragIdx, 1);
    state.backlog.splice(to, 0, moved);
    save(); render();
  }
  cleanupDrag();
});
document.addEventListener("dragend", cleanupDrag);
function cleanupDrag(){
  dragIdx = null;
  document.querySelectorAll(".blk.dragging, .blk.dragover").forEach(x=>x.classList.remove("dragging","dragover"));
}

/* =========================================================
 * 冲刺计划模块 —— 考前 11 天备考配额（2026年10月考期）
 * 数据：plan-data.js（window.PLAN，只读计划）
 * 状态：localStorage companion-sprint-v1（勾选 / 让位 / 考试安排覆盖）
 * 规则：当天没勾完的考点自动顺延到之后每一天；低星可一键让位。
 * ========================================================= */
const SPRINT_KEY = "companion-sprint-v1";
let sprintState = loadSprint();
let sprintAllOpen = false;   // 「全部展开」：完整要点默认折 3 行，一键展开全部
function loadSprint(){
  try {
    const s = localStorage.getItem(SPRINT_KEY);
    if(s) return Object.assign({checked:{}, doneOn:{}, yielded:[], examOverride:null}, JSON.parse(s));
  } catch(e){}
  return {checked:{}, doneOn:{}, yielded:[], examOverride:null};
}
function saveSprint(){ localStorage.setItem(SPRINT_KEY, JSON.stringify(sprintState)); }

function planMeta(){ return (window.PLAN && window.PLAN.meta) || null; }
function planDays(){ return (window.PLAN && window.PLAN.days) || []; }
function dayIndexOf(dateStr){
  const ds = planDays();
  if(!ds.length) return -999;
  if(dateStr < ds[0].date) return -1;
  for(let i=0;i<ds.length;i++) if(ds[i].date === dateStr) return i;
  return ds.length; // 计划之后
}
function sprintExam(){
  const meta = planMeta();
  if(!meta) return [];
  return sprintState.examOverride || meta.exam;
}
function sprintAllItems(){
  const out = [];
  for(const d of planDays()) for(const it of d.items) out.push(it);
  return out;
}
function sprintCounts(){
  const all = sprintAllItems();
  const checked = all.filter(it => sprintState.checked[it.id]).length;
  return {total: all.length, checked};
}
/* 顺延：计划日前"没勾完且没让位"的条目滚到今天。
   今天刚勾掉的也留在清单里（看得见 ✓ 和划线，点错了还能取消），第二天才收起——
   否则勾一下整条就消失，像是被删了。 */
function carriedItems(dateStr){
  const idx = dayIndexOf(dateStr);
  if(idx <= 0) return [];
  const out = [];
  for(let i=0;i<idx;i++){
    for(const it of planDays()[i].items){
      if(sprintState.yielded.includes(it.id)) continue;
      const doneToday = sprintState.doneOn && sprintState.doneOn[it.id] === dateStr;
      if(sprintState.checked[it.id] && !doneToday) continue;
      out.push(it);
    }
  }
  return out;
}
const SPRINT_SUBJ_ORDER = ["my","gsf","jds","en","all"];
function sprintKindTag(it){
  if(it.kind === "batch") return "成套";
  if(it.kind === "words") return "词表";
  if(it.id.indexOf("-l-") >= 0) return "论述";
  if(it.id.indexOf("-c-") >= 0) return "案例";
  return "";
}
function sprintRow(it, isCarry){
  const checked = !!sprintState.checked[it.id];
  const star = it.stars ? '<span class="sp-stars">' + "★".repeat(it.stars) + "</span>" : "";
  const freq = it.freq ? '<span class="sp-freq">高频</span>' : "";
  const carry = isCarry ? '<span class="sp-carry">顺延</span>' : "";
  const kt = sprintKindTag(it);
  const kind = kt ? '<span class="sp-batch">' + kt + "</span>" : "";
  const point = it.point ? `<div class="sp-point">${esc(it.point)}</div>` : "";
  /* 要点很长时给一个明显的"展开全文"入口：数据是完整的，别让人以为被截断了 */
  const more = (it.point && it.point.length > 68)
    ? `<span class="sp-more" data-sprint-expand="${it.id}"></span>` : "";
  /* 词表：默认展开（打开就能背），并给一个写着词数的明确按钮可收可放 */
  const isWords = it.kind === "words" && it.words && it.words.length;
  const words = isWords
    ? `<span class="sp-more sp-words-toggle" data-sprint-expand="${it.id}">共 ${it.words.length} 词</span>
       <div class="sp-words">${it.words.map(w=>`<span>${esc(w)}</span>`).join("")}</div>` : "";
  return `<div class="sp-item ${checked?'done':''}${(sprintAllOpen || isWords)?' open':''}">
    <div class="sp-cb" data-sprint-check="${it.id}" title="${checked?'取消':'勾掉'}">${checked?'✓':''}</div>
    <div class="sp-body">
      <div class="sp-line"><span class="sp-name" data-sprint-expand="${it.id}">${freq}${carry}${kind}${star}${esc(it.title)}</span></div>
      ${point}
      ${more}
      ${words}
    </div>
  </div>`;
}
function renderSprint(){
  const meta = planMeta();
  const el = $("sprintList"), debtEl = $("spDebt"), yEl = $("spYielded");
  if(!meta || !planDays().length){
    $("spTitle").textContent = "冲刺计划";
    $("spMeta").textContent = "";
    $("spMeter").style.width = "0%";
    $("spDayTitle").innerHTML = "今日配额";
    $("spExamCard").style.display = "none";
    el.innerHTML = '<div class="empty">没有找到计划数据（plan-data.js）。<br>请确认 plan-data.js 和 index.html 在同一个文件夹里，再刷新一次。</div>';
    debtEl.innerHTML = ""; yEl.innerHTML = "";
    return;
  }
  const dateStr = state.date;
  const today = todayStr();
  const idx = dayIndexOf(dateStr);
  const exam = sprintExam();
  const firstExam = exam.length ? exam[0].date : null;
  const dd = firstExam ? daysUntil(firstExam) : null;

  /* 顶部：阶段 / 进度 / 倒计时 */
  let stageLabel = "考前冲刺";
  if(idx >= 0 && idx < planDays().length){
    const st = meta.stages.find(s => idx + 1 >= s.from && idx + 1 <= s.to);
    if(st) stageLabel = "第 " + (idx + 1) + " 天 · " + st.label;
  }
  const cnt = sprintCounts();
  $("spTitle").textContent = meta.title || "冲刺计划";
  let metaTxt = stageLabel;
  if(dd !== null){
    metaTxt += dd > 0 ? " · 距首场考试 " + dd + " 天" : (dd === 0 ? " · 今天考试，稳住" : " · 考试已结束");
  }
  $("spMeta").textContent = metaTxt;
  $("spMeter").style.width = (cnt.total ? Math.round(cnt.checked / cnt.total * 100) : 0) + "%";

  /* 考试安排卡片（可编辑） */
  const examCard = $("spExamCard");
  const onExamDay = exam.some(x => x.date === dateStr);
  const afterExam = firstExam && dateStr > exam[exam.length - 1].date;
  examCard.style.display = (onExamDay || afterExam || (dd !== null && dd <= 2 && dd >= 0)) ? "" : "none";
  $("spExamList").innerHTML = exam.map((ed)=>{
    const dayLabel = ed.date === today ? "今天" : ed.date;
    return `<div class="sp-exam-day">
      <div class="sp-exam-date">${dayLabel}${ed.date === dateStr ? ' <span class="hint">· 就是今天</span>' : ""}</div>
      ${ed.slots.map((sl, si)=>`
        <div class="sp-exam-slot">
          <span class="sp-subj-tag">${esc(meta.subjects[sl.subject] || sl.name)}</span>
          <input class="sp-exam-input" data-exam-date="${ed.date}" data-exam-slot="${si}" value="${esc(sl.name)}" title="科目名称">
          <input class="sp-exam-input sp-exam-time" data-exam-time="${ed.date}" data-exam-slot="${si}" value="${esc(sl.time)}" title="考试时间">
        </div>`).join("")}
    </div>`;
  }).join("") + '<button class="btn-ghost" data-sprint-saveexam>保存考试安排</button>';

  /* 今日配额主体 */
  const isPlanDay = idx >= 0 && idx < planDays().length;
  let shown = [];
  if(isPlanDay){
    for(const it of planDays()[idx].items){
      if(!sprintState.yielded.includes(it.id)) shown.push(it);
    }
  }
  const carried = (dateStr === today && isPlanDay) ? carriedItems(dateStr) : [];
  const carriedIds = new Set(carried.map(x => x.id));
  const merged = carried.concat(shown);
  const doneToday = merged.filter(it => sprintState.checked[it.id]).length;
  $("spDayTitle").innerHTML = (dateStr === today ? "今日配额" : dateStr + " · 配额") + ' <span class="hint">' +
    (idx < 0 ? "计划还没开始" : afterExam ? "考试结束，辛苦啦" : "已完成 " + doneToday + "/" + merged.length) + "</span>";

  debtEl.innerHTML = (dateStr === today && carried.filter(it => !sprintState.checked[it.id]).length)
    ? `<div class="sp-debt">📌 前几天顺延进来 ${carried.filter(it => !sprintState.checked[it.id]).length} 条，排在前面先做</div>` : "";

  if(onExamDay){
    /* 考试日：先看该日科目的高频清单 */
    const subjs = (exam.find(x => x.date === dateStr) || {}).slots || [];
    const subjSet = new Set(subjs.map(s => s.subject));
    const skim = [];
    for(const d of planDays()) for(const it of d.items){
      const doneToday = sprintState.doneOn && sprintState.doneOn[it.id] === dateStr;
      if(it.freq && subjSet.has(it.subject) && (!sprintState.checked[it.id] || doneToday)) skim.push(it);
    }
    const skimIds = new Set(skim.map(x=>x.id));
    const rest = merged.filter(it => !skimIds.has(it.id));
    el.innerHTML = '<div class="sp-sec-hd">今天的考试科目 · 考前扫一遍高频</div>' + skim.map(it => sprintRow(it, false)).join("") +
      (rest.length ? '<div class="sp-sec-hd">其他欠账（有余力再做）</div>' + rest.map(it => sprintRow(it, true)).join("") : "");
  } else if(afterExam){
    el.innerHTML = `<div class="empty">全部考试结束，共完成 ${cnt.checked}/${cnt.total} 个学习单元。<br>剩下的交给时间，好好休息。</div>`;
  } else if(!isPlanDay){
    el.innerHTML = '<div class="empty">计划外日期（计划：' + (planDays()[0] ? planDays()[0].date : "") + " 至 " + (planDays()[planDays().length-1] ? planDays()[planDays().length-1].date : "") + "）。</div>";
  } else {
    /* 按科目分组渲染 */
    const groups = [];
    for(const subj of SPRINT_SUBJ_ORDER){
      const items = merged.filter(it => it.subject === subj);
      if(items.length) groups.push({subj, items});
    }
    el.innerHTML = groups.map(g=>`
      <div class="sp-subj-hd">${esc(meta.subjects[g.subj] || g.subj)} <span class="hint">${g.items.filter(x=>sprintState.checked[x.id]).length}/${g.items.length}</span></div>
      ${g.items.map(it => sprintRow(it, carriedIds.has(it.id))).join("")}`).join("");
  }

  /* 已让位区 */
  const yieldedItems = sprintAllItems().filter(it => sprintState.yielded.includes(it.id));
  yEl.innerHTML = yieldedItems.length
    ? `<details class="sp-yielded"><summary>已让位 ${yieldedItems.length} 条（低星，可恢复）</summary>
       ${yieldedItems.map(it=>`<div class="sp-item sp-yield-row"><span class="sp-name">${esc(it.title)}</span>
       <button class="link" data-sprint-restore="${it.id}">恢复</button></div>`).join("")}</details>`
    : "";
}

/* 低星让位：把今天可见的 1-2 星考点移出，保留高频/成套任务 */
function yieldLowStars(){
  const dateStr = state.date;
  const idx = dayIndexOf(dateStr);
  if(idx < 0 || idx >= planDays().length){ toast("今天没有可让位的计划"); return; }
  const carried = dateStr === todayStr() ? carriedItems(dateStr) : [];
  const pool = carried.concat(planDays()[idx].items.filter(it => !sprintState.yielded.includes(it.id)));
  const low = pool.filter(it => it.kind === "kaodian" && it.stars >= 1 && it.stars <= 2 && !it.freq && !sprintState.checked[it.id]);
  if(!low.length){ toast("没有可让位的低星考点（剩下的都是高频或成套任务）"); return; }
  low.forEach(it => { if(!sprintState.yielded.includes(it.id)) sprintState.yielded.push(it.id); });
  saveSprint();
  renderSprint();
  toast("已让位 " + low.length + " 条低星考点，可随时在底部恢复");
}
$("spYieldBtn").addEventListener("click", yieldLowStars);

/* 全部展开/收起：复习时想一次看完所有要点 */
const spExpandBtn = $("spExpandAllBtn");
if(spExpandBtn) spExpandBtn.addEventListener("click", ()=>{
  sprintAllOpen = !sprintAllOpen;
  spExpandBtn.textContent = sprintAllOpen ? "全部收起" : "全部展开";
  renderSprint();
  toast(sprintAllOpen ? "已展开全部要点" : "已收起要点");
});

/* 点击委托：冲刺页 */
document.addEventListener("click", e=>{
  const spc = e.target.closest("[data-sprint-check]");
  if(spc){
    const id = spc.dataset.sprintCheck;
    sprintState.checked[id] = !sprintState.checked[id];
    if(!sprintState.doneOn) sprintState.doneOn = {};
    if(sprintState.checked[id]) sprintState.doneOn[id] = todayStr();
    else delete sprintState.doneOn[id];
    saveSprint(); renderSprint();
    if(sprintState.checked[id]) cheerOnCheck();
    return;
  }
  const spr = e.target.closest("[data-sprint-restore]");
  if(spr){
    const id = spr.dataset.sprintRestore;
    sprintState.yielded = sprintState.yielded.filter(x => x !== id);
    saveSprint(); renderSprint();
    toast("已恢复该考点");
    return;
  }
  const spn = e.target.closest("[data-sprint-expand]");
  if(spn){
    const row = spn.closest(".sp-item");
    if(row) row.classList.toggle("open");
    return;
  }
  const sse = e.target.closest("[data-sprint-saveexam]");
  if(sse){
    const exam = sprintExam().map(ed => ({date: ed.date, slots: ed.slots.slice()}));
    document.querySelectorAll("[data-exam-date]").forEach(inp => {
      const day = exam.find(x => x.date === inp.dataset.examDate);
      if(day && day.slots[+inp.dataset.examSlot]) day.slots[+inp.dataset.examSlot].name = inp.value.trim() || day.slots[+inp.dataset.examSlot].name;
    });
    document.querySelectorAll("[data-exam-time]").forEach(inp => {
      const day = exam.find(x => x.date === inp.dataset.examTime);
      if(day && day.slots[+inp.dataset.examSlot]) day.slots[+inp.dataset.examSlot].time = inp.value.trim() || day.slots[+inp.dataset.examSlot].time;
    });
    sprintState.examOverride = exam;
    saveSprint(); renderSprint();
    toast("考试安排已保存");
    return;
  }
});

render();

/* ---------- PWA：主屏图标 / 离线缓存 / 打开时提醒 ---------- */
if("serviceWorker" in navigator){
  window.addEventListener("load", ()=>{
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  });
}
function maybeRemind(){
  if(!("Notification" in window) || Notification.permission !== "granted") return;
  const d = state.days[todayStr()];
  // 找"逾期且今天还没做"的习惯，断得最久的排前面，只弹它一条接回文案
  const overdue = state.backlog
    .filter(b => b.type === "habit" && b.lastDone) // 从没开始过的不催：它还没进过今日计划，催了也没用
    .map(b => ({ b, gap: habitGap(b) }))
    .filter(x => x.gap >= (x.b.interval || 1))
    .filter(x => !(d && d.tasks.some(t => t.backlogId === x.b.id && t.done)))
    .sort((a,b) => b.gap - a.gap);
  if(!overdue.length) return;
  const { b, gap } = overdue[0];
  const body = isFinite(gap)
    ? pick([
        `「${b.name}」断了 ${gap} 天，今天做一点就接上了`,
        `「${b.name}」空窗 ${gap} 天了，现在接回来刚刚好`,
        `「${b.name}」有 ${gap} 天没碰，今天先做 5 分钟，别让它继续断`,
      ])
    : pick([
        `「${b.name}」好久没碰了，今天做一点就接上`,
        `「${b.name}」该回来了，今天做一小份就续上`,
      ]);
  new Notification("陪伴·计划", { body });
}
if("Notification" in window && Notification.permission === "default"){
  window.addEventListener("load", ()=>{ Notification.requestPermission(); });
}
window.addEventListener("load", ()=>{ setTimeout(maybeRemind, 800); });

/* ---------- 反馈：报告在本地拼，怎么发出去由你决定 ----------
   这个应用没有任何网络请求，反馈也不破例：报告只在你点开弹窗后拼出来，
   你复制 / 存文件 / 自己去提 issue。绝不自动发送，也绝不带你的文字内容。 */
const ERR_KEY = "companion-plan-errors";
const ERR_MAX = 5;
function loadErrLog(){
  try { const a = JSON.parse(localStorage.getItem(ERR_KEY) || "[]"); return Array.isArray(a) ? a.slice(0, ERR_MAX) : []; }
  catch(e){ return []; }
}
let errLog = loadErrLog();
function recordError(msg, where){
  errLog.unshift({ t: Date.now(), w: String(where || view), m: String(msg).slice(0, 300) });
  errLog = errLog.slice(0, ERR_MAX);
  try { localStorage.setItem(ERR_KEY, JSON.stringify(errLog)); } catch(e){}
  const bar = $("errBar");
  if(bar) bar.classList.add("on"); // 崩了也得让用户找得到反馈入口
}
function clearErrLog(){
  errLog = [];
  try { localStorage.removeItem(ERR_KEY); } catch(e){}
  const bar = $("errBar"); if(bar) bar.classList.remove("on");
}
window.addEventListener("error", e => {
  if(!e) return;
  const where = e.filename ? String(e.filename).split("/").pop() + ":" + (e.lineno || 0) : view;
  recordError(e.message || "脚本错误", where);
});
window.addEventListener("unhandledrejection", e => {
  const r = e && e.reason;
  recordError("未处理的 Promise：" + ((r && r.message) || r || "未知"), view);
});

/* 只报数量，不报内容：事项名、笔记正文、勾了哪些考点，一个字都不带 */
function countSummary(){
  const d = dayData();
  let checked = 0, total = 0;
  try {
    const items = sprintAllItems();
    total = items.length;
    checked = items.filter(it => sprintState.checked[it.id]).length;
  } catch(e){}
  return [
    `事项池 ${state.backlog.length} 条`,
    `今日任务 ${d.tasks.length} 条（已完成 ${d.tasks.filter(t=>t.done).length}）`,
    `空闲碎片 ${d.fragments.length} 段`,
    `笔记 ${state.notes.length} 条`,
    total ? `冲刺勾选 ${checked}/${total}` : "冲刺数据未加载",
  ].join(" / ");
}
function envSummary(){
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const brand = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox"
              : /Safari\//.test(ua) ? "Safari" : "未知浏览器";
  const major = (ua.match(/(?:Edg|Chrome|Firefox|Version)\/(\d+)/) || [])[1] || "";
  const os = /Windows NT 10/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android"
           : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : "未知系统";
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ? "是" : "否";
  const scr = (typeof screen !== "undefined" && screen.width) ? screen.width + "×" + screen.height : "?";
  const tz = (Intl && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : "?";
  const net = (navigator && navigator.onLine === false) ? "离线" : "在线";
  return `${brand}${major ? " " + major : ""} / ${os} / 窗口 ${window.innerWidth}×${window.innerHeight} / 屏幕 ${scr} / 时区 ${tz} / 独立窗口 ${standalone} / ${net}`;
}
function settingSummary(){
  const ms = { 1:"勾到 1 个", 3:"勾到 3 个", 5:"勾到 5 个" };
  const im = { due:"今天该做", all:"全部", pick:"勾选" };
  return [
    `主题 ${THEME_NAMES[document.body.dataset.theme] || "紫藤"}`,
    `休息日 ${settings.restDays.length ? settings.restDays.map(d=>"周"+DAY_NAMES[d-1]).join("") : "未设置"}`,
    `导入方式 ${im[settings.importMode] || "未设置"}`,
    `鼓励 每次 ${settings.cheerEvery ? "开" : "关"} / 完成数 ${ms[settings.cheerMilestone] || "关"} / 全部完成 ${settings.cheerDone ? "开" : "关"}`,
  ].join(" / ");
}
function fmtErrTime(ts){
  const d = new Date(ts);
  return `${d.getMonth()+1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const ERR_VIEW_NAMES = { today:"今日计划", backlog:"事项池", week:"周视图", schedule:"作息", notes:"记事", sprint:"冲刺" };
function errWhere(w){ const k = String(w); return ERR_VIEW_NAMES[k] || k; } // 视图 id 换成中文，文件名:行号原样留
function buildReport(desc){
  const now = new Date();
  const lines = [
    "【陪伴·计划 反馈】",
    `时间：${todayStr()} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
    `版本：${APP_VERSION}`,
    "",
    "我在做什么 / 问题描述：",
    String(desc || "").trim() || "（没写）",
    "",
    "--- 自动诊断（可以删掉这里面任何一行）---",
    `环境：${envSummary()}`,
    `数据量：${countSummary()}`,
    `设置：${settingSummary()}`,
  ];
  if(errLog.length){
    lines.push(`最近报错（保留了 ${errLog.length} 条，最多留 ${ERR_MAX} 条）：`);
    errLog.forEach((e,i) => lines.push(` ${i+1}) ${fmtErrTime(e.t)} · ${errWhere(e.w)} · ${e.m}`));
  } else {
    lines.push("最近报错：无");
  }
  lines.push("--- 自动诊断结束 ---");
  return lines.join("\n");
}
function reportFileName(){
  const d = new Date();
  return `陪伴-计划-反馈-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
}
function issueUrl(desc, report){
  const t = String(desc || "").trim().split("\n")[0].slice(0, 40) || "用户反馈";
  return "https://github.com/jingxiuaian/companion-app/issues/new"
       + "?title=" + encodeURIComponent("反馈：" + t)
       + "&body=" + encodeURIComponent(report);
}

/* 收件邮箱。拆成两段拼是为了别被公开仓库里的爬虫直接抓走地址。
   说清楚：这只抬高门槛，挡不住真去读代码的人；要完全藏住得走表单服务（那样地址在服务端）。 */
const FEEDBACK_EMAIL = ["245757759", "qq.com"].join("@");
const MAILTO_MAX = 1800; // 再长有些邮件客户端会截断正文
function mailtoUrl(report, desc){
  const t = String(desc || "").trim().split("\n")[0].slice(0, 40);
  const subject = "【陪伴·计划 反馈】" + APP_VERSION + (t ? " · " + t : "");
  return "mailto:" + FEEDBACK_EMAIL
       + "?subject=" + encodeURIComponent(subject)
       + "&body=" + encodeURIComponent(report);
}

function openFeedback(){
  $("fbText").value = "";
  $("fbReport").value = buildReport("");
  $("fbHint").textContent = (errLog.length
    ? `本地记着最近 ${errLog.length} 条报错，已经写在下面了。可以删掉任何一行。`
    : "没检测到报错，也欢迎直接提建议或说哪里别扭。")
    + "点「发邮件给我」没反应的话，就是浏览器没配邮件客户端，改用「复制报告」一样能发我。";
  openModal("mFeedback");
}
$("feedbackBtn").addEventListener("click", ()=>{ closeModal("mSettings"); openFeedback(); });
$("mFeedbackCancel").addEventListener("click", ()=> closeModal("mFeedback"));
$("fbText").addEventListener("input", ()=>{ $("fbReport").value = buildReport($("fbText").value); });
$("fbMail").addEventListener("click", ()=>{
  const url = mailtoUrl($("fbReport").value, $("fbText").value);
  if(url.length > MAILTO_MAX) toast("报告偏长，邮件可能被截断——建议改用「复制报告」");
  try { window.location.href = url; } // mailto: 交给系统邮件客户端，页面本身不发任何网络请求
  catch(e){ toast("没能唤起邮件客户端，改用「复制报告」吧"); }
});
$("fbCopy").addEventListener("click", ()=>{
  const txt = $("fbReport").value;
  const done = ()=> toast("报告已复制，直接发给我就行");
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(txt).then(done).catch(()=>{
      $("fbReport").select(); document.execCommand && document.execCommand("copy"); done();
    });
  } else {
    $("fbReport").select(); document.execCommand && document.execCommand("copy"); done();
  }
});
$("fbSave").addEventListener("click", ()=>{
  try {
    const blob = new Blob([$("fbReport").value], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = reportFileName();
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=> URL.revokeObjectURL(a.href), 1000);
    toast("已存到下载文件夹");
  } catch(e){ toast("保存失败，先点「复制报告」吧"); }
});
$("fbIssue").addEventListener("click", ()=>{
  const url = issueUrl($("fbText").value, $("fbReport").value);
  const w = window.open(url, "_blank");
  if(!w) toast("浏览器拦了新窗口，改用「复制报告」发我也行");
});
$("fbClear").addEventListener("click", ()=>{
  clearErrLog();
  $("fbReport").value = buildReport($("fbText").value);
  toast("报错记录已清空");
});
$("errBarGo").addEventListener("click", ()=>{ $("errBar").classList.remove("on"); openFeedback(); });
$("errBarClose").addEventListener("click", ()=> $("errBar").classList.remove("on"));
