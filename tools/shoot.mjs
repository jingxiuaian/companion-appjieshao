/* ============================================================
 * 「陪伴·计划」介绍站 · 真实应用截图生成器
 * ------------------------------------------------------------
 * 做法：Node 静态服务（root=应用目录）+ headless Chrome + CDP
 *      （照抄 应用/companion-app/tests/verify-browser.mjs 里已验证的模式）
 * 产出：网页/companion-intro/assets/ 下 13 张 PNG，780×1688（390×844 @2x）
 *
 * 用法：node tools\shoot.mjs
 * 约束：只读应用目录，只写 assets/；跑完自己关 Chrome / 服务 / 临时 profile。
 *
 * ⚠ 运行环境：headless Chrome 需要正常的 Windows 命名管道 / 进程访问权限。
 *   在 DSH 的 workspace-write 沙箱里 Chrome 会以
 *   `crashpad_client_win.cc OpenProcess: 拒绝访问 (0x5)` +
 *   `platform_channel.cc Check failed: 拒绝访问 (0x5)` 退出，这是沙箱限制、不是脚本问题；
 *   请在没有该沙箱限制的终端里跑本脚本（详见同目录 SHOOTING.md）。
 * ============================================================ */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");                       // 网页/companion-intro
const WORKSPACE = path.resolve(WEB_ROOT, "..", "..");            // 工作区根
const APP_ROOT = path.join(WORKSPACE, "应用", "companion-app");
const ASSETS = path.join(WEB_ROOT, "assets");
const DEMO_FILE = path.join(APP_ROOT, "tests", "演示数据-一键填充.js");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const PORT = 8901;               // 避开 verify-browser 的 8899
const CDP_PORT = 9341;           // 避开 verify-browser 的 9333
const VIEW_W = 390, VIEW_H = 844, DSF = 2;
const EXPECT_W = VIEW_W * DSF, EXPECT_H = VIEW_H * DSF;
const SPRINT_START = "2026-10-13";  // 计划第 1 天
const EXAM_DAY = "2026-10-24";      // 首场考试日

const SHOT_NAMES = [
  "hero-today", "today-tasks", "suggest", "backlog", "week", "schedule", "notes",
  "sprint", "sprint-exam", "settings", "theme-teal", "theme-amber", "theme-ink",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ============================================================
 * 0. 前置检查
 * ============================================================ */
if (!fs.existsSync(path.join(APP_ROOT, "index.html"))) throw new Error("找不到应用目录：" + APP_ROOT);
if (!fs.existsSync(DEMO_FILE)) throw new Error("找不到演示数据脚本：" + DEMO_FILE);
if (!fs.existsSync(CHROME)) throw new Error("找不到 Chrome：" + CHROME);
fs.mkdirSync(ASSETS, { recursive: true });

const shots = [];          // { name, file, bytes, width, height, desc, view, scrollY }
let failed = 0;
let server = null;
let chrome = null;
let profile = null;
let ws = null;
let chromeExit = null;

/* ============================================================
 * 1. 静态服务（root = 应用目录）
 * ============================================================ */
function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
      const file = path.join(APP_ROOT, rel);
      if (!file.startsWith(APP_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end("404"); return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

/* ============================================================
 * 2. headless Chrome + 极简 CDP 客户端
 * ============================================================ */
let msgId = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    if (!ws || ws.readyState !== 1) { pending.delete(id); reject(new Error("WebSocket 未连接")); return; }
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expr, { awaitPromise = true, returnByValue = true } = {}) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue, awaitPromise });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || "页面 JS 执行出错");
  }
  return returnByValue ? r.result.value : undefined;
}

async function waitFor(expr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evalJs(`!!(${expr})`)) return true; } catch { /* 页面还没就绪 */ }
    await sleep(120);
  }
  return false;
}

async function launchChrome() {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "companion-shot-"));
  chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--mute-audio",
    `--window-size=${VIEW_W},${VIEW_H}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `http://127.0.0.1:${PORT}/index.html`,
  ], { stdio: "ignore", detached: false });
  chrome.on("error", (e) => { chromeExit = { error: String(e) }; });
  chrome.on("exit", (code, signal) => { chromeExit = { code, signal }; });

  let targets = null;
  for (let i = 0; i < 80 && !targets; i++) {
    await sleep(250);
    if (chromeExit) throw new Error(`Chrome 提前退出：${JSON.stringify(chromeExit)}`);
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      targets = list.filter((t) => t.type === "page" && /127\.0\.0\.1:8901/.test(t.url));
    } catch { /* 调试端口还没起来 */ }
  }
  if (!targets || !targets.length) throw new Error("无法连上 Chrome 调试端口 / 没有页面 target");

  ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket 连接超时")), 8000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket 连接失败")); };
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      pageErrors.push(m.params.entry.text);
    }
  };
  // 浏览器关掉时把没回包的请求 reject 掉，免得收尾卡死
  ws.onclose = () => {
    for (const [, p] of pending) p.reject(new Error("WebSocket 已关闭（浏览器可能已退出）"));
    pending.clear();
  };
}

/* ============================================================
 * 3. 截图 / 滚动 小工具
 * ============================================================ */
async function quietPage() {
  // toast 别挡画面；兜底报错条也收起来
  await evalJs(`(() => {
    const t = document.getElementById("toast"); if (t) t.classList.remove("show");
    const e = document.getElementById("errBar"); if (e) e.classList.remove("on");
    return "quiet";
  })()`);
}

async function capture(name, desc) {
  await quietPage();
  await sleep(450);                     // 等过渡动画 / toast 淡出 / 字体排版稳定
  const info = await evalJs(`({ view: view, y: Math.round(window.scrollY), h: document.documentElement.scrollHeight })`);
  const res = await send("Page.captureScreenshot", { format: "png" });
  if (!res || !res.data) throw new Error("截图失败：" + name);
  const buf = Buffer.from(res.data, "base64");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const file = path.join(ASSETS, name + ".png");
  fs.writeFileSync(file, buf);
  shots.push({ name, file, bytes: buf.length, width, height, desc, view: info.view, scrollY: info.y });
  log(`  ✓ ${name}.png  ${width}×${height}  ${buf.length} B  (view=${info.view}, scrollY=${info.y})`);
  return { width, height };
}

async function scrollPage(y) {
  await evalJs(`window.scrollTo(0, ${Math.round(y)}); "ok"`);
  await sleep(420);
}

/** 把某个元素滚到视口里：offset=-70 → 元素顶部落在 70px（sticky 头约 48px，不盖标题） */
async function scrollInto(getElExpr, offset = -70) {
  const r = await evalJs(`(() => {
    const el = (${getElExpr});
    if (!el) return { ok: false };
    const top0 = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, Math.round(top0 + (${offset}))));
    return { ok: true, top0: Math.round(top0), y: Math.round(window.scrollY), top: Math.round(el.getBoundingClientRect().top) };
  })()`);
  await sleep(420);
  if (!r || !r.ok) throw new Error("滚动目标不存在：" + getElExpr);
  return r;
}

/** 把页签行滚到 sticky 头下方，页签内容从下面开始（用于冲刺页：跳过今日概览，避免 0h 概览抢戏） */
async function scrollToTabs(offset = -62) {
  const r = await evalJs(`(() => {
    const t = document.querySelector(".tabs");
    const top = t.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, Math.round(top + (${offset}))));
    return { y: Math.round(window.scrollY), top: Math.round(t.getBoundingClientRect().top) };
  })()`);
  await sleep(420);
  return r;
}

async function clickSeg(segId, value) {
  await evalJs(`(() => {
    const b = [...document.querySelectorAll("#${segId} button")].find(x => x.dataset.v === ${JSON.stringify(value)});
    if (!b) throw new Error("找不到段控按钮 ${segId} / ${value}");
    b.click();
    return b.classList.contains("on");
  })()`);
  await sleep(120);
}

async function clickTab(tabId) {
  await evalJs(`document.getElementById(${JSON.stringify(tabId)}).click(); "ok"`);
  await sleep(420);
}

/* ============================================================
 * 4. 主流程
 * ============================================================ */
async function main() {
  log("启动静态服务 + headless Chrome …");
  await startServer();
  await launchChrome();

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: VIEW_W, height: VIEW_H, deviceScaleFactor: DSF, mobile: true,
  });

  const ready = await waitFor(`typeof importTasks === "function" && typeof state === "object" && document.readyState === "complete"`, 15000);
  if (!ready) throw new Error("应用没加载出来（importTasks/state 不存在）");

  /* ---------- 4.0 填演示数据（先清 localStorage、堵住 alert） ---------- */
  log("填充演示数据 …");
  await evalJs(`localStorage.clear(); window.alert = () => {}; window.confirm = () => true; "prepared"`);
  const demoSource = fs.readFileSync(DEMO_FILE, "utf8");
  await evalJs(demoSource);
  await sleep(700);

  const seeded = await evalJs(`(() => {
    const d = dayData();
    return {
      date: state.date, today: todayStr(),
      frags: d.fragments.length, tasks: d.tasks.length,
      done: d.tasks.filter(t => t.done).length, undone: d.tasks.filter(t => !t.done).length,
      backlog: state.backlog.length, notes: state.notes.length, view,
    };
  })()`);
  log("  演示数据:", JSON.stringify(seeded));
  if (seeded.tasks !== 4 || seeded.done !== 2) throw new Error("演示数据状态不对（期望 4 条任务 / 2 条已完成）");

  /* ---------- 1/13 今日视图顶部 ---------- */
  await clickTab("tabToday");
  await scrollPage(0);
  await capture("hero-today", "今日视图顶部：品牌行 + 今日概览（可支配/已完成）+ 六个页签 + 今日空闲时间段开头");

  /* ---------- 2/13 今日计划列表 ---------- */
  await scrollInto(`document.getElementById("taskList").closest(".card")`, -60);
  await capture("today-tasks", "今日计划列表：4 条日常任务，其中 2 条已完成并显示「实际 30m / 实际 50m（预计 1h）」");

  /* ---------- 3/13 空余时间建议（可支配 42 分钟的演示状态） ---------- */
  log("  重新载入演示数据，切到「可支配 42 分钟」的建议场景 …");
  await send("Page.reload", { ignoreCache: true });
  await waitFor(`typeof importTasks === "function" && typeof state === "object" && document.readyState === "complete"`, 15000);
  await evalJs(`localStorage.clear(); window.alert = () => {}; window.confirm = () => true; "prepared"`);
  await evalJs(demoSource);
  await sleep(500);
  const scenario = await evalJs(`(() => {
    /* 固定"现在"= 08:28：一段 06:25–09:10 的空闲，扣掉今天已完成的两件事，正好剩 42 分钟。
       把「英语单词」「读《被讨厌的勇气》」从今日计划移出、标成跳过（相当于今天先不安排它们），
       于是它们成为建议候选，理由里就能出现「断了 3 天，今天做一点就接上了」。 */
    window.nowMin = () => 8 * 60 + 28;
    const d = dayData();
    d.tasks = d.tasks.filter(t => !["b-english", "b-read"].includes(t.backlogId));
    d.skipped = ["b-english", "b-read"];               // 别让 autoGenHabits 再塞回来
    d.fragments = [{ start: "06:25", end: "09:10" }];
    const dt = new Date(); dt.setDate(dt.getDate() - 3);
    const read = state.backlog.find(b => b.id === "b-read");
    if (read) read.lastDone = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
    save(); render();
    return { free: freeMinOf(d), tasks: d.tasks.length };
  })()`);
  log("  建议场景:", JSON.stringify(scenario));
  await clickSeg("segEnergy", "高");
  await clickSeg("segScene", "室内");
  await evalJs(`document.getElementById("btnSuggest").click(); "ok"`);
  await sleep(500);
  const suggInfo = await evalJs(`(() => ({
    cards: document.querySelectorAll("#suggList .sugg-card").length,
    reasons: [...document.querySelectorAll("#suggList .sugg-card .s-reason")].map(x => x.innerText.trim()),
    energy: [...document.querySelectorAll("#segEnergy button.on")].map(b => b.dataset.v),
    scene: [...document.querySelectorAll("#segScene button.on")].map(b => b.dataset.v),
  }))()`);
  log("  建议:", JSON.stringify(suggInfo));
  if (suggInfo.cards < 3) throw new Error(`建议卡只有 ${suggInfo.cards} 张，要求 3 张`);
  if (!suggInfo.reasons.some(r => r.includes("英语单词") && r.includes("3 天"))) throw new Error("建议理由里没有「英语单词 / 3 天」这条断档理由");
  await scrollInto(`document.getElementById("suggList").closest(".card")`, -60);
  await capture("suggest", "空余时间建议：可支配 42 分钟，3 张建议卡，每条都带一句理由（含「断了 3 天，今天做一点就接上了」）");

  /* 建议图拍完，重新载入一份干净的演示数据，供后面的页签使用 */
  await send("Page.reload", { ignoreCache: true });
  await waitFor(`typeof importTasks === "function" && typeof state === "object" && document.readyState === "complete"`, 15000);
  await evalJs(`localStorage.clear(); window.alert = () => {}; window.confirm = () => true; "prepared"`);
  await evalJs(demoSource);
  await sleep(600);

  /* ---------- 4~7/13 事项池 / 周视图 / 作息 / 记事 ---------- */
  await clickTab("tabBacklog"); await scrollPage(0);
  await capture("backlog", "事项池页签顶部：7 个事项，带优先级、最短时长、精力、场景、截止/习惯状态标签");

  await clickTab("tabWeek"); await scrollPage(0);
  await capture("week", "周视图页签顶部：本周统计（连续打卡/完成数/完成率）+ 未来 7 天截止日与习惯");

  await clickTab("tabSchedule"); await scrollPage(0);
  await capture("schedule", "作息页签顶部：每周休息日选择 + 固定占用按工作日/休息日/每天分组");

  await clickTab("tabNotes"); await scrollPage(0);
  await capture("notes", "记事页签顶部：类型切换、输入框 + 2 条演示笔记（1 条文字、1 条清单）");

  /* ---------- 8/13 冲刺：第 1 天配额 ---------- */
  /* 真实日期是 2026-10-28（考期之后），渲染「距首场考试」会变成"考试已结束"；
     这里把页面里的 todayStr 临时指到计划第 1 天，等价于在 2026-10-13 当天打开应用。 */
  await evalJs(`window.__realTodayStr = window.todayStr; window.todayStr = () => ${JSON.stringify(SPRINT_START)}; state.date = ${JSON.stringify(SPRINT_START)}; document.getElementById("tabSprint").click(); "ok"`);
  await sleep(400);
  /* 勾掉前两个还没勾的考点，给进度条一点进度，画面比全空更像"在用" */
  const clickNextUnchecked = `(() => {
    const cb = [...document.querySelectorAll("#sprintList .sp-cb")].find(x => !x.closest(".sp-item").classList.contains("done"));
    if (!cb) return false;
    cb.click();
    return true;
  })()`;
  await evalJs(clickNextUnchecked);
  await sleep(300);
  await evalJs(clickNextUnchecked);
  await sleep(500);
  await scrollInto(`document.querySelector(".sprint-head")`, -70);
  await capture("sprint", "冲刺页签 · 2026-10-13（第 1 天 · 只背高频）：进度 2/23，今日配额按科目分组的考点");

  /* ---------- 9/13 冲刺：考试日 ---------- */
  await evalJs(`window.todayStr = () => ${JSON.stringify(EXAM_DAY)}; state.date = ${JSON.stringify(EXAM_DAY)}; document.getElementById("tabSprint").click(); "ok"`);
  await sleep(500);
  await scrollInto(`document.getElementById("spExamCard")`, -60);
  await capture("sprint-exam", "冲刺 · 考试日（2026-10-24）：考试安排卡片 + 「今天的考试科目 · 考前扫一遍高频」");

  /* ---------- 10/13 设置弹窗 ---------- */
  await evalJs(`window.todayStr = window.__realTodayStr; state.date = todayStr(); save(); document.getElementById("tabToday").click(); window.scrollTo(0, 0); "ok"`);
  await sleep(500);
  await evalJs(`openSettings(); "opened"`);
  await sleep(500);
  const modalRect = await evalJs(`(() => {
    const m = document.querySelector("#mSettings .modal");
    const r = m.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), vh: innerHeight,
             themes: document.querySelectorAll("#mSettings [data-set-theme]").length };
  })()`);
  log("  设置弹窗:", JSON.stringify(modalRect));
  await capture("settings", "今日视图上打开设置弹窗：通用（界面颜色四套皮肤）、今日计划导入方式、鼓励频率等");

  /* ---------- 11~13/13 三套主题的今日视图顶部 ---------- */
  await evalJs(`document.getElementById("mSettingsClose").click(); window.scrollTo(0, 0); "ok"`);
  await sleep(420);
  for (const theme of ["teal", "amber", "ink"]) {
    await evalJs(`applyTheme(${JSON.stringify(theme)}); render(); window.scrollTo(0, 0); "ok"`);
    await sleep(450);
    await capture(`theme-${theme}`, `今日视图顶部 · ${theme} 皮肤（青竹/暖阳/墨蓝）`);
  }
  /* 还原主题，别把演示环境留在墨蓝 */
  await evalJs(`applyTheme("violet"); render(); "restored"`);
  await sleep(200);
}

/* ============================================================
 * 5. 收尾 + 自检
 * ============================================================ */
async function cleanup() {
  // Browser.close 可能不回包就断开，加个超时兜底
  try { await Promise.race([send("Browser.close").catch(() => {}), sleep(1500)]); } catch { /* ws 可能已被关闭 */ }
  await sleep(500);
  try { if (chrome) chrome.kill(); } catch {}
  try { if (server) server.close(); } catch {}
  try { if (ws) ws.close(); } catch {}
  if (profile) {
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profile, { recursive: true, force: true }); break; }
      catch { await sleep(400); }   // Chrome 还在退出时可能占用文件
    }
  }
}

function verify() {
  log("\n自检：");
  let bad = 0;
  for (const name of SHOT_NAMES) {
    const file = path.join(ASSETS, name + ".png");
    if (!fs.existsSync(file)) { log(`  ✗ 缺文件 ${name}.png`); bad++; continue; }
    const buf = fs.readFileSync(file);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const ok = w === EXPECT_W && h === EXPECT_H;
    if (!ok) { log(`  ✗ ${name}.png 尺寸 ${w}×${h}，期望 ${EXPECT_W}×${EXPECT_H}`); bad++; }
  }
  log(`  13 张：${SHOT_NAMES.length - bad}/${SHOT_NAMES.length} 通过（${EXPECT_W}×${EXPECT_H}）`);

  const extra = fs.readdirSync(ASSETS).filter((f) => !SHOT_NAMES.includes(f.replace(/\.png$/, "")));
  if (extra.length) log(`  ⚠ assets 里还有其它文件：${extra.join("、")}`);
  else log("  assets 里只有这 13 张图");

  return bad;
}

/* ---------- 跑 ---------- */
try {
  await main();
  if (pageErrors.length) {
    log("\n⚠ 页面运行时报错（不影响已生成截图，但需要留意）：");
    pageErrors.forEach((e) => log("  - " + e));
  }
} catch (e) {
  failed = 1;
  console.error("\n[FAIL]", e && e.stack ? e.stack : e);
} finally {
  await cleanup();
}

failed += verify();
log(`\n${failed ? "✗ 有失败项" : "✓ 全部完成"}`);
process.exit(failed ? 1 : 0);
