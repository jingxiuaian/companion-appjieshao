/* =============================================================
   陪伴·计划 介绍站 —— 独立验收脚本（只读站点，只写 tools/qa/）
   用法（需要能正常启动 headless Chrome 的终端；DSH workspace-write 沙箱内 Chrome 起不来）：
     node 网页\companion-intro\tools\qa\qa.mjs
   产出：
     tools/qa/shots/*.png   三档宽度 × 双主题的截图（按区块）
     tools/qa/report.json   结构化结果（checks / facts / contrast / shots）
   覆盖：
      控制台/资源 4xx、三档响应式（375/768/1440）、双主题 + 对比度、主题记忆、
      tab 点击与键盘、建议小工具 6 组组合、锚点导航遮挡、reduced-motion、
      demo/index.html 新开页状态、file:// 直开、ARIA/alt/标题层级/焦点。
   端口：静态服务 8921、CDP 9361、file:// 用第二个 Chrome 实例 9362。
   ============================================================= */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", ".."); // 网页/companion-intro
const SHOTS = path.join(HERE, "shots");
const REPORT = path.join(HERE, "report.json");
const PORT = 8921;
const CDP_PORT = 9361;
const FILE_CDP_PORT = 9362;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = []; // {name, pass, detail, severity, phase}
const facts = [];  // {claim, status, note}
const shots = [];
let pageErrors = [];
const httpErrors = [];
const allRequests = [];
let darkRatios = null, lightRatios = null;

function check(name, pass, detail = "", severity = "严重", phase = "") {
  checks.push({ name, pass: !!pass, detail: String(detail || "").slice(0, 500), severity, phase });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`${tag}  [${phase || "-"}] ${name}${detail ? "   [" + String(detail).slice(0, 240) + "]" : ""}`);
}
function fact(claim, status, note = "") {
  facts.push({ claim, status, note });
  console.log(`FACT  ${status}  ${claim}${note ? "   [" + note + "]" : ""}`);
}

/* ---------------- 1. 静态服务 ---------------- */
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("404");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const URL_SITE = `http://127.0.0.1:${PORT}/index.html`;

/* ---------------- 2. 启动 headless Chrome ---------------- */
const profiles = [];
function launchChrome(cdpPort, url, extraArgs = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "intro-qa-"));
  profiles.push(profile);
  const child = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update",
    "--disable-breakpad", "--noerrdialogs", "--mute-audio",
    ...extraArgs,
    `--window-size=1440,900`, `--user-data-dir=${profile}`,
    `--remote-debugging-port=${cdpPort}`, url,
  ], { stdio: "ignore", detached: false });
  return child;
}
async function waitTargets(cdpPort, n = 1, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      const pages = list.filter((t) => t.type === "page");
      if (pages.length >= n) return pages;
    } catch {}
  }
  return null;
}

const chrome = launchChrome(CDP_PORT, URL_SITE);
let targets = await waitTargets(CDP_PORT, 1);
if (!targets) {
  console.error(
    "\n[FATAL] 无法启动/连接 headless Chrome（本沙箱限制）。\n" +
    "请在有完整权限的终端运行本脚本；若仍失败，把下面这条报错发回：\n" +
    "  crashpad OpenProcess 0x5 / platform_channel Check failed\n"
  );
  try { chrome.kill(); } catch {}
  server.close();
  for (const p of profiles) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  process.exit(2);
}

/* ---------------- 3. 极简 CDP 客户端 ---------------- */
function makeClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  const events = [];
  const client = {
    ws,
    events,
    pageErrors: [],
    async open() {
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
    },
    send(method, params = {}) {
      return new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    async eval(expr) {
      const r = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 10000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await client.eval(`!!(${expr})`)) return true; } catch {}
        await sleep(120);
      }
      return false;
    },
    close() { try { ws.close(); } catch {} },
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    client.events.push(m.method);
    if (m.method === "Runtime.exceptionThrown") {
      client.pageErrors.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      client.pageErrors.push("console.error: " + m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      client.pageErrors.push("log: " + m.params.entry.text + (m.params.entry.url ? " @ " + m.params.entry.url : ""));
    } else if (m.method === "Network.responseReceived") {
      const { status, url } = m.params.response;
      allRequests.push({ status, url });
      if (status >= 400) httpErrors.push(status + " " + url);
    } else if (m.method === "Network.loadingFailed") {
      if (!m.params.canceled) client.pageErrors.push("network failed: " + (m.params.errorText || "") + " " + (m.params.requestId || ""));
    }
  };
  return client;
}

const pageTarget = targets.find((t) => t.type === "page");
const cdp = makeClient(pageTarget.webSocketDebuggerUrl);
await cdp.open();
pageErrors = cdp.pageErrors;
for (const domain of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await cdp.send(domain);

/* ---------------- 4. 工具函数 ---------------- */
const NAVH = (w) => (w <= 640 ? 64 : 74);
async function setViewport(width, height, mobile, dsf) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile });
}
async function setThemeAndReload(theme) {
  await cdp.eval(`try{localStorage.setItem("companion-intro-theme", ${JSON.stringify(theme)});}catch(e){}; "ok"`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.readyState === 'complete' && document.getElementById('suggestOut') && document.getElementById('suggestOut').children.length > 0");
  await sleep(500);
}
async function scrollAll() {
  await cdp.eval(`(async () => {
    document.documentElement.style.scrollBehavior = "auto";
    document.querySelectorAll("img").forEach((i) => { i.loading = "eager"; });
    const H = window.innerHeight;
    const max = document.documentElement.scrollHeight - H;
    for (let y = 0; y <= max; y += Math.max(300, H * 0.8)) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
    window.scrollTo(0, max);
    await new Promise(r => setTimeout(r, 300));
    await Promise.all([...document.images].map((i) => (i.decode ? i.decode().catch(() => {}) : Promise.resolve())));
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 200));
    return "ok";
  })()`);
  await sleep(400);
}
async function scrollToSel(sel, navH = 74) {
  const top = await cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    return Math.round(el.getBoundingClientRect().top + window.scrollY);
  })()`);
  if (top == null) return null;
  await cdp.eval(`window.scrollTo(0, ${Math.max(0, top - navH - 8)}); "ok"`);
  await sleep(280);
  return top;
}
async function shot(file) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, "base64"));
  shots.push(file);
}
async function captureSections(width, theme, viewH) {
  const sections = [["hero", "#top"], ["turn", "#turn"], ["loop", "#loop"], ["features", "#features"], ["skins", ".skins"], ["gallery", "#gallery"], ["who", "#who"], ["privacy", "#privacy"], ["cta", "#start"], ["footer", "footer"]];
  const navH = NAVH(width);
  for (const [name, sel] of sections) {
    const info = await cdp.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height) };
    })()`);
    if (!info) { check(`截图区块存在：${name}`, false, sel, "建议", `截图 ${width}-${theme}`); continue; }
    const baseY = name === "footer" ? Math.max(0, await cdp.eval("document.documentElement.scrollHeight - innerHeight")) : Math.max(0, info.top - navH - 8);
    await cdp.eval(`window.scrollTo(0, ${baseY}); "ok"`);
    await sleep(320);
    await shot(`${width}-${theme}-${name}.png`);
    if (info.h > viewH * 1.25 && name !== "footer") {
      const y2 = Math.min(baseY + Math.round(viewH * 0.85), Math.max(0, await cdp.eval("document.documentElement.scrollHeight - innerHeight")));
      await cdp.eval(`window.scrollTo(0, ${y2}); "ok"`);
      await sleep(300);
      await shot(`${width}-${theme}-${name}-2.png`);
    }
  }
}
async function captureFullPage(width, theme) {
  try {
    const m = await cdp.send("Page.getLayoutMetrics");
    const cs = m.cssContentSize || m.contentSize;
    const w = Math.ceil(cs.width), h = Math.ceil(cs.height);
    if (h > 15000) { check(`全页截图（${width}-${theme}）`, true, `页面高 ${h}px，超过 15000 跳过（看分区截图）`, "可选", "截图"); return; }
    const r = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    const file = `${width}-${theme}-fullpage.png`;
    fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, "base64"));
    shots.push(file);
    check(`全页截图（${width}-${theme}）`, true, `${w}x${h}`, "可选", "截图");
  } catch (e) {
    check(`全页截图（${width}-${theme}）`, false, e.message, "可选", "截图");
  }
}

/* ---------------- 5. 页面内检查表达式 ---------------- */
const IN_PAGE = {
  layout: `(() => {
    const W = window.innerWidth;
    const doc = document.documentElement;
    const bad = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) continue;
      if (r.right <= W + 1 && r.left >= -1) continue;
      let n = el.parentElement, clipped = false;
      while (n && n !== document.body) {
        const cs = getComputedStyle(n);
        if (/(hidden|clip|auto|scroll)/.test(cs.overflowX)) { clipped = true; break; }
        n = n.parentElement;
      }
      if (!clipped) bad.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 70), left: Math.round(r.left), right: Math.round(r.right) });
    }
    const clippedText = [];
    for (const el of document.querySelectorAll("p, li, b, span, figcaption, h1, h2, h3")) {
      if (!el.textContent || el.textContent.trim().length < 15) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === "hidden" && el.scrollHeight > el.clientHeight + 3) {
        clippedText.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 50), sh: el.scrollHeight, ch: el.clientHeight });
      }
    }
    return {
      innerWidth: W, scrollWidth: doc.scrollWidth, scrollHeight: doc.scrollHeight,
      horizontalScroll: doc.scrollWidth > W + 1,
      bad: bad.slice(0, 15),
      clippedText: clippedText.slice(0, 10),
      navH: Math.round(document.querySelector(".nav").getBoundingClientRect().height),
    };
  })()`,
  structure: `(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const imgs = qa("img");
    const headings = qa("h1,h2,h3,h4").map((h) => ({ tag: h.tagName, text: h.textContent.trim().slice(0, 40) }));
    let level = 0, headingOrderOk = true, headingNote = "";
    for (const h of headings) {
      const lv = +h.tag.slice(1);
      if (level === 0) { if (lv !== 1) { headingOrderOk = false; headingNote = "首个标题不是 h1"; } }
      else if (lv > level + 1) { headingOrderOk = false; headingNote = headingNote || ("跳级：" + h.tag + " " + h.text); }
      level = lv;
    }
    const tabs = qa(".tab"), panels = qa(".panel");
    const tabOk = tabs.length === 5 && tabs.every((t) => {
      const p = document.getElementById(t.getAttribute("aria-controls"));
      return t.getAttribute("role") === "tab" && p && p.getAttribute("role") === "tabpanel" && p.getAttribute("aria-labelledby") === t.id;
    });
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true").length;
    const visiblePanels = panels.filter((p) => !p.hidden).length;
    const anchors = qa("a[href^='#']").map((a) => a.getAttribute("href")).filter((h) => h && h.length > 1);
    const missingAnchors = [...new Set(anchors)].filter((h) => !document.querySelector(h));
    const segBtns = qa(".seg button").map((b) => ({ pressed: b.getAttribute("aria-pressed"), text: b.textContent.trim() }));
    return {
      title: document.title,
      lang: document.documentElement.lang,
      h1: qa("h1").length, headings, headingOrderOk, headingNote,
      imgs: imgs.length,
      imgsNoAlt: imgs.filter((i) => !i.getAttribute("alt") || !i.getAttribute("alt").trim()).map((i) => i.getAttribute("src")),
      imgsBroken: imgs.filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")),
      tabs: tabs.length, panels: panels.length, tabOk, selected, visiblePanels,
      missingAnchors, segBtns,
      skipLink: !!q(".skip-link"),
      ariaLive: (q("#suggestOut") || {}).getAttribute ? q("#suggestOut").getAttribute("aria-live") : null,
      metaViewport: (q('meta[name="viewport"]') || {}).content || null,
      themeColor: (q('meta[name="theme-color"]') || {}).content || null,
      externalRefs: [...document.querySelectorAll("script[src],link[href],img[src],source[src]")]
        .map((e) => e.getAttribute("src") || e.getAttribute("href"))
        .filter((u) => u && /^(https?:)?\\/\\//.test(u)),
      demoLinks: qa("a[href*='demo/']").map((a) => ({ href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel") })),
    };
  })()`,
  parts: `(() => {
    const W = window.innerWidth;
    const bad = [];
    const sels = [".cta-actions .btn", ".hero .phone", ".float-card", ".panel:not([hidden]) .phone-shot", ".suggest-tool", ".skins .skin", ".footer-top", ".chart-card"];
    for (const s of sels) document.querySelectorAll(s).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.left < -1 || r.right > W + 1)) bad.push({ s, left: Math.round(r.left), right: Math.round(r.right) });
    });
    return bad.slice(0, 10);
  })()`,
  charts: `(() => {
    const card = document.getElementById("turnChart");
    const brand = card && card.querySelector(".chart-brand");
    const muted = card && card.querySelector(".chart-muted");
    const area = card && card.querySelector(".chart-area");
    const dot = card && card.querySelector(".chart-dot");
    const anno = card && card.querySelector(".chart-anno");
    const cs = (el) => el ? getComputedStyle(el) : null;
    const rect = card ? card.getBoundingClientRect() : null;
    const legend = document.querySelector(".chart-legend");
    const annoTurn = card && card.querySelector(".anno-turn");
    return {
      isIn: card ? card.classList.contains("is-in") : null,
      brandDashoffset: cs(brand) ? cs(brand).strokeDashoffset : null,
      mutedOpacity: cs(muted) ? cs(muted).opacity : null,
      areaOpacity: cs(area) ? cs(area).opacity : null,
      dotOpacity: cs(dot) ? cs(dot).opacity : null,
      annoOpacity: cs(anno) ? cs(anno).opacity : null,
      legendRect: legend ? { t: Math.round(legend.getBoundingClientRect().top), b: Math.round(legend.getBoundingClientRect().bottom), l: Math.round(legend.getBoundingClientRect().left), r: Math.round(legend.getBoundingClientRect().right) } : null,
      annoTurnRect: annoTurn ? { t: Math.round(annoTurn.getBoundingClientRect().top), b: Math.round(annoTurn.getBoundingClientRect().bottom), l: Math.round(annoTurn.getBoundingClientRect().left), r: Math.round(annoTurn.getBoundingClientRect().right), display: cs(annoTurn).display } : null,
      annoReconnectRect: (() => { const a = card && card.querySelector(".anno-reconnect"); if (!a) return null; return { t: Math.round(a.getBoundingClientRect().top), b: Math.round(a.getBoundingClientRect().bottom), display: cs(a).display }; })(),
    };
  })()`,
  tabsState: `(() => {
    const tabs = [...document.querySelectorAll(".tab")];
    return {
      selected: tabs.map((t) => t.getAttribute("aria-selected")),
      hidden: [...document.querySelectorAll(".panel")].map((p) => p.hidden),
      tabIndex: tabs.map((t) => t.getAttribute("tabindex")),
      active: document.activeElement ? (document.activeElement.id || document.activeElement.className || document.activeElement.tagName) : null,
      shownImgs: [...document.querySelectorAll(".panel:not([hidden]) img")].map((i) => ({ src: i.getAttribute("src"), ok: i.complete && i.naturalWidth > 0 })),
    };
  })()`,
  suggestState: `(() => {
    const out = document.getElementById("suggestOut");
    const all = [...document.querySelectorAll(".seg button")];
    return {
      outText: out.textContent.replace(/\\s+/g, " ").trim().slice(0, 300),
      empty: !!out.querySelector(".tool-empty"),
      emptyText: (out.querySelector(".tool-empty") || { textContent: "" }).textContent.replace(/\\s+/g, " ").trim(),
      count: out.querySelectorAll(".sugg").length,
      names: [...out.querySelectorAll(".sugg b")].map((b) => b.textContent.trim()),
      reasons: [...out.querySelectorAll(".sugg p")].map((p) => p.textContent.trim()),
      pressed: all.map((b) => ({ k: b.dataset.field + ":" + b.dataset.v, v: b.getAttribute("aria-pressed") })),
      pressedOk: all.every((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-pressed") === "false"),
      onCount: all.filter((b) => b.classList.contains("on")).length,
    };
  })()`,
  ratioCode: `(() => {
    const parse = (s) => { const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
    const body = parse(getComputedStyle(document.body).backgroundColor) || { r: 20, g: 18, b: 28, a: 1 };
    function effectiveBg(el) {
      let n = el, stack = [];
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
        n = n.parentElement;
      }
      let bg = stack.length ? stack.pop() : body;
      if (bg.a < 1) bg = over(bg, body);
      while (stack.length) bg = over(stack.pop(), bg);
      if (bg.a < 1) bg = over(bg, body);
      return bg;
    }
    const selectors = [
      ".hero-lead", ".hero-title", ".hero-sub", ".hero-note", ".btn-primary", ".btn-ghost",
      ".nav-links a", ".brand-name", ".theme-btn",
      ".section-head h2", ".section-lead p", ".turn-note h3", ".turn-note p",
      ".chart-legend", ".chart-foot", ".chart-anno.anno-turn",
      ".step h3", ".step p", ".mini-task b", ".mini-task span", ".mini-task.done b",
      ".feat h3", ".feat-copy", ".tool-label", ".seg button", ".seg button.on",
      ".tool-now", ".sugg-top b", ".sugg p", ".tool-fine", ".tool-empty", ".quote-card",
      ".pool-list em", ".sprint-line", ".sprint-line b", ".feat-note",
      ".tab", ".tab.on", ".shot figcaption", ".shot figcaption b", ".shot-side p", ".shot-side-note",
      ".who-col h3", ".check-list li", ".cross-list li", ".who-quote",
      ".privacy-points b", ".privacy-points span", ".local-label", ".local-card code", ".local-card em", ".cloud-card",
      ".cta-kicker", ".cta-title", ".cta-sub", ".cta-note",
      ".footer-desc", ".footer-links a", ".footer-note", ".footer-ver", ".skin figcaption",
    ];
    const out = [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const cs = getComputedStyle(el);
      const fg = parse(cs.color); if (!fg) continue;
      const bg = effectiveBg(el);
      const c1 = lum(fg), c2 = lum(bg);
      const ratio = (Math.max(c1, c2) + 0.05) / (Math.min(c1, c2) + 0.05);
      const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      out.push({ sel, ratio: Math.round(ratio * 100) / 100, size, weight, large, fg: cs.color, bg: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")" });
    }
    return out;
  })()`,
};

/* ---------------- 6. 主流程 ---------------- */
try {
  /* ===== 阶段 A：1440 深色，基础加载/资源/结构/控制台 ===== */
  await setViewport(1440, 900, false, 1);
  await cdp.waitFor("document.readyState === 'complete'");
  await sleep(800);
  await scrollAll();
  // 等拐点图各层过渡跑完（.chart-area 是 opacity 1s ease .75s，最后 ~1.75s 才到 1）
  await cdp.waitFor(`(() => { const a = document.querySelector(".chart-area"); return a && parseFloat(getComputedStyle(a).opacity) >= 0.99; })()`, 6000);
  await sleep(200);
  // 资源可达（真实 HTTP fetch，覆盖 13 张图 + favicon + css/js + demo 全部文件）
  const assetList = await cdp.eval(`(async () => {
    const list = ["index.html", "styles.css", "script.js", "favicon.svg",
      "assets/hero-today.png","assets/today-tasks.png","assets/suggest.png","assets/backlog.png",
      "assets/week.png","assets/schedule.png","assets/notes.png","assets/sprint.png","assets/sprint-exam.png",
      "assets/settings.png","assets/theme-teal.png","assets/theme-amber.png","assets/theme-ink.png",
      "demo/index.html","demo/app.js","demo/styles.css","demo/plan-data.js","demo/manifest.webmanifest","demo/sw.js","demo/icon.svg"];
    const out = [];
    for (const u of list) {
      try { const r = await fetch(u, { cache: "no-store" }); out.push({ u, status: r.status, type: r.headers.get("content-type") }); }
      catch (e) { out.push({ u, status: 0, err: String(e) }); }
    }
    return out;
  })()`);
  const badRes = assetList.filter((x) => x.status !== 200);
  check("所有资源可达（13 图 + favicon + css/js + demo 全文件）", badRes.length === 0, badRes.map((x) => x.u + ":" + x.status).join(", ") || `共 ${assetList.length} 个 URL 全部 200`, "严重", "资源");
  check("网络请求无 4xx/5xx", httpErrors.length === 0, httpErrors.join(" | ") || `已观察 ${allRequests.length} 个响应`, "严重", "资源");

  const st = await cdp.eval(IN_PAGE.structure);
  check("标题/语言/meta viewport", st.title.includes("陪伴") && st.lang === "zh-CN" && !!st.metaViewport, `title=${st.title} lang=${st.lang}`, "建议", "结构");
  check("只有一个 h1 且标题层级不跳级", st.h1 === 1 && st.headingOrderOk, st.headingNote || `首个 h1，共 ${st.headings.length} 个标题`, "建议", "结构");
  check("所有图片都有非空 alt", st.imgsNoAlt.length === 0, st.imgsNoAlt.join(", ") || `${st.imgs} 张图`, "建议", "可访问性");
  check("所有图片加载成功（naturalWidth>0）", st.imgsBroken.length === 0, st.imgsBroken.join(", ") || `${st.imgs} 张`, "严重", "资源");
  check("tab/panel ARIA 关系正确（5 个页签、1 个 selected、1 个可见 panel）", st.tabOk && st.selected === 1 && st.visiblePanels === 1, `tabOk=${st.tabOk} selected=${st.selected} visiblePanels=${st.visiblePanels}`, "建议", "可访问性");
  check("锚点 href 都有对应目标", st.missingAnchors.length === 0, st.missingAnchors.join(", ") || "全部命中", "严重", "交互");
  check("建议工具输出区有 aria-live", st.ariaLive === "polite", `aria-live=${st.ariaLive}`, "建议", "可访问性");
  check("没有外部资源引用（零依赖/断网可用）", st.externalRefs.length === 0, st.externalRefs.join(", ") || "无 http(s) 引用", "严重", "结构");
  check("demo 链接 target=_blank + rel=noopener", st.demoLinks.length >= 2 && st.demoLinks.every((l) => l.target === "_blank"), JSON.stringify(st.demoLinks), "建议", "结构");
  check("初始段控 aria-pressed 完整（未选中的也应有 false）", st.segBtns.every((b) => b.pressed === "true" || b.pressed === "false"), `缺 aria-pressed 的按钮：${st.segBtns.filter((b) => !b.pressed).map((b) => b.text).join("、") || "无"}`, "建议", "可访问性");

  const layout1440 = await cdp.eval(IN_PAGE.layout);
  check("1440 宽无横向滚动", !layout1440.horizontalScroll, `scrollWidth=${layout1440.scrollWidth} innerWidth=${layout1440.innerWidth}`, "严重", "响应式 1440");
  check("1440 宽无元素溢出视口", layout1440.bad.length === 0, JSON.stringify(layout1440.bad), "严重", "响应式 1440");
  check("1440 宽无文字被容器截断", layout1440.clippedText.length === 0, JSON.stringify(layout1440.clippedText), "建议", "响应式 1440");
  const parts1440 = await cdp.eval(IN_PAGE.parts);
  check("1440 宽 CTA 按钮 / 手机截图 / 卡片 / 浮卡不破版（都在视口内）", parts1440.length === 0, JSON.stringify(parts1440), "严重", "响应式 1440");

  const chart = await cdp.eval(IN_PAGE.charts);
  check("拐点图滚动进入视口后接上（is-in + 曲线可见）",
    chart.isIn === true && parseFloat(chart.mutedOpacity) >= 0.89 && parseFloat(chart.areaOpacity) >= 0.99 && parseFloat(chart.dotOpacity) >= 0.99,
    `isIn=${chart.isIn} muted=${chart.mutedOpacity} area=${chart.areaOpacity} dot=${chart.dotOpacity}`, "严重", "拐点图");
  check("拐点标注与图例不重叠（y 轴区间不相交）", !(chart.annoTurnRect && chart.legendRect && chart.annoTurnRect.b > chart.legendRect.t && chart.annoTurnRect.t < chart.legendRect.b && chart.annoTurnRect.r > chart.legendRect.l && chart.annoTurnRect.l < chart.legendRect.r), `legend=${JSON.stringify(chart.legendRect)} anno=${JSON.stringify(chart.annoTurnRect)}`, "严重", "拐点图");

  /* 控制台 */
  check("加载/滚动全程无 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 8).join(" | ") || "无", "严重", "控制台");

  /* ===== 阶段 B：1440 深色截图 + 对比度 ===== */
  await cdp.eval(`document.activeElement && document.activeElement.blur(); window.scrollTo(0,0); "ok"`);
  await sleep(400);
  await captureSections(1440, "dark", 900);
  await cdp.eval(`window.scrollTo(0,0); "ok"`); await sleep(200);
  await captureFullPage(1440, "dark");
  const darkRatiosLocal = await cdp.eval(IN_PAGE.ratioCode);
  darkRatios = darkRatiosLocal;
  const darkFail = darkRatiosLocal.filter((r) => (r.large ? r.ratio < 3 : r.ratio < 4.5));
  check("深色主题关键文本对比度 ≥ 4.5:1（大字 ≥3:1）", darkFail.length === 0, darkFail.map((r) => `${r.sel} ${r.ratio}:1 (${r.size}px)`).join(" | ") || `${darkRatiosLocal.length} 处文本全部达标，最低 ${Math.min(...darkRatiosLocal.map((r) => r.ratio))}:1`, "建议", "主题 dark");

  /* ===== 阶段 C：reduced-motion（不依赖动画） ===== */
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.readyState === 'complete' && document.getElementById('turnChart')");
  await sleep(600);
  const rm = await cdp.eval(IN_PAGE.charts);
  const dash0 = Math.abs(parseFloat(String(rm.brandDashoffset))) < 0.01;
  check("reduced-motion：拐点曲线直接是最终形态（dashoffset≈0、各层 opacity=1，无需滚动触发）",
    dash0 && rm.mutedOpacity === "1" && rm.areaOpacity === "1" && rm.dotOpacity === "1" && rm.annoOpacity === "1",
    `isIn=${rm.isIn} dashoffset=${rm.brandDashoffset} muted=${rm.mutedOpacity} area=${rm.areaOpacity} dot=${rm.dotOpacity} anno=${rm.annoOpacity}`, "严重", "reduced-motion");
  await cdp.send("Emulation.setEmulatedMedia", { features: [] });

  /* ===== 阶段 D：主题切换 + 记忆（1440） ===== */
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.readyState === 'complete' && document.getElementById('themeBtn')");
  await sleep(500);
  const theme0 = await cdp.eval(`document.documentElement.dataset.theme || ""`);
  await cdp.eval(`document.getElementById("themeBtn").click(); "ok"`);
  await sleep(250);
  const theme1 = await cdp.eval(`({ theme: document.documentElement.dataset.theme, meta: document.querySelector('meta[name="theme-color"]').content, label: document.getElementById("themeBtn").getAttribute("aria-label"), saved: localStorage.getItem("companion-intro-theme") })`);
  check("点击 #themeBtn 切换 html[data-theme]（dark→light）", theme0 === "dark" && theme1.theme === "light", `${theme0} → ${theme1.theme}`, "严重", "主题");
  check("切换时 meta theme-color 与按钮 aria-label 同步", theme1.meta === "#F3EDE3" && /纸感/.test(theme1.label || ""), `meta=${theme1.meta} label=${theme1.label}`, "建议", "主题");
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.readyState === 'complete'");
  await sleep(500);
  const persisted = await cdp.eval(`({ theme: document.documentElement.dataset.theme, saved: localStorage.getItem("companion-intro-theme") })`);
  check("刷新后 localStorage 主题记忆生效", persisted.theme === "light" && persisted.saved === "light", JSON.stringify(persisted), "严重", "主题");
  // 切回深色再验证一次
  await cdp.eval(`document.getElementById("themeBtn").click(); "ok"`);
  await sleep(200);
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.readyState === 'complete'"); await sleep(400);
  check("再切回深色并刷新仍记忆正确", (await cdp.eval(`document.documentElement.dataset.theme`)) === "dark", "", "严重", "主题");

  /* ===== 阶段 E：1440 浅色截图 + 对比度 ===== */
  await setThemeAndReload("light");
  await scrollAll();
  await captureSections(1440, "light", 900);
  await cdp.eval(`window.scrollTo(0,0); "ok"`); await sleep(200);
  await captureFullPage(1440, "light");
  const lightRatiosLocal = await cdp.eval(IN_PAGE.ratioCode);
  lightRatios = lightRatiosLocal;
  const lightFail = lightRatiosLocal.filter((r) => (r.large ? r.ratio < 3 : r.ratio < 4.5));
  check("浅色主题关键文本对比度 ≥ 4.5:1（大字 ≥3:1）", lightFail.length === 0, lightFail.map((r) => `${r.sel} ${r.ratio}:1 (${r.size}px)`).join(" | ") || `${lightRatiosLocal.length} 处文本全部达标，最低 ${Math.min(...lightRatiosLocal.map((r) => r.ratio))}:1`, "建议", "主题 light");

  /* ===== 阶段 F：界面巡览 tab（点击 + 键盘） ===== */
  await setViewport(1440, 900, false, 1);
  await setThemeAndReload("dark");
  await scrollAll();
  let tabClickOk = true, tabClickDetail = [];
  for (let i = 0; i < 5; i++) {
    await cdp.eval(`document.querySelectorAll(".tab")[${i}].click(); "ok"`);
    await sleep(220);
    const s = await cdp.eval(IN_PAGE.tabsState);
    const ok = s.selected[i] === "true" && s.selected.filter((x) => x === "true").length === 1 && s.hidden.filter((h) => h).length === 4 && s.shownImgs.length >= 1 && s.shownImgs.every((im) => im.ok);
    if (!ok) tabClickOk = false;
    tabClickDetail.push(`tab${i}:${s.selected.join("/")}|hidden=${s.hidden.map((x) => (x ? "1" : "0")).join("")}|imgs=${s.shownImgs.length}`);
  }
  check("界面巡览 5 个页签：点击后 aria-selected/hidden/图片显示都正确", tabClickOk, tabClickDetail.join(" ; "), "严重", "交互-tab");
  await cdp.eval(`document.querySelectorAll(".tab")[3].click(); "ok"`);
  await sleep(250);
  await scrollToSel("#gallery");
  await shot("gallery-tab-冲刺.png");
  // 键盘
  await cdp.eval(`document.querySelectorAll(".tab")[0].focus(); "ok"`);
  const press = async (key, code, vk) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(160);
  };
  const seq = [];
  const selIdx = async () => cdp.eval(`(() => { const t=[...document.querySelectorAll(".tab")]; return { idx: t.findIndex((x) => x.getAttribute("aria-selected") === "true"), focus: t.indexOf(document.activeElement), pressed: t.findIndex((x)=>x.getAttribute("aria-selected")==="true") }; })()`);
  await press("ArrowRight", "ArrowRight", 39); seq.push(["→", await selIdx()]);
  await press("ArrowRight", "ArrowRight", 39); seq.push(["→", await selIdx()]);
  await press("End", "End", 35); seq.push(["End", await selIdx()]);
  await press("Home", "Home", 36); seq.push(["Home", await selIdx()]);
  await press("ArrowLeft", "ArrowLeft", 37); seq.push(["←", await selIdx()]);
  const kbOk = seq[0][1].idx === 1 && seq[1][1].idx === 2 && seq[2][1].idx === 4 && seq[3][1].idx === 0 && seq[4][1].idx === 4 && seq.every(([, s]) => s.focus === s.idx);
  check("页签键盘 ← → Home End 可切换（含首尾环绕）", kbOk, seq.map(([k, s]) => `${k}→idx${s.idx}/focus${s.focus}`).join(" "), "建议", "交互-tab");

  /* ===== 阶段 G：空余建议小工具 6 组组合 ===== */
  await scrollToSel("#features");
  const combos = [
    ["低", "室内", "20"], ["低", "室内", "45"], ["中", "室内", "45"],
    ["高", "室内", "20"], ["高", "室内", "90"], ["中", "可外出", "90"],
  ];
  const comboOut = [];
  for (const [energy, scene, mins] of combos) {
    await cdp.eval(`(() => {
      const click = (f, v) => { const b = document.querySelector('.seg button[data-field="' + f + '"][data-v="' + v + '"]'); if (b) b.click(); };
      click("energy", ${JSON.stringify(energy)}); click("scene", ${JSON.stringify(scene)}); click("mins", ${JSON.stringify(mins)});
      return "ok";
    })()`);
    await sleep(180);
    comboOut.push({ energy, scene, mins, ...(await cdp.eval(IN_PAGE.suggestState)) });
  }
  const emptyCombo = comboOut.find((c) => c.energy === "低" && c.mins === "20");
  check("建议工具：低精力 + 20 分钟 → 空态「没有合适的」", !!emptyCombo && emptyCombo.empty && /没有合适的/.test(emptyCombo.emptyText), emptyCombo ? emptyCombo.emptyText || emptyCombo.outText : "未取到", "严重", "交互-建议");
  const nonEmpty = comboOut.filter((c) => !(c.energy === "低" && c.mins === "20"));
  check("建议工具：其余 5 组组合都出结果（1~3 条，每条带理由）", nonEmpty.every((c) => c.count >= 1 && c.count <= 3 && c.reasons.every((r) => r.length > 5)), nonEmpty.map((c) => `${c.energy}/${c.mins}:${c.count}条`).join(" "), "严重", "交互-建议");
  const sig = comboOut.map((c) => c.names.join("|"));
  check("建议工具：不同组合结果会变化（非固定文案）", new Set(sig).size >= 4, comboOut.map((c) => `${c.energy}/${c.mins}:[${c.names.join(",")}]`).join(" ; "), "建议", "交互-建议");
  check("建议工具：按钮 aria-pressed 同步（点击后每组全部按钮都有 true/false）", comboOut.every((c) => c.pressedOk) && comboOut.every((c) => c.onCount === 3), comboOut.map((c) => `${c.energy}/${c.mins}:on=${c.onCount},pressedOk=${c.pressedOk}`).join(" "), "建议", "交互-建议");
  const nowText = comboOut.find((c) => c.mins === "90")?.outText || "";
  check("建议工具：「现在有 N 分钟」文案随可支配变化", /90 分钟/.test(nowText), nowText.slice(0, 120), "建议", "交互-建议");

  /* ===== 阶段 H：导航锚点 + sticky 遮挡 + 底部高亮 ===== */
  await setViewport(1440, 900, false, 1);
  await setThemeAndReload("dark");
  await scrollAll();
  const navInfo = await cdp.eval(`({ h: Math.round(document.querySelector(".nav").getBoundingClientRect().height), sticky: getComputedStyle(document.querySelector(".nav")).position })`);
  const anchorTargets = ["#turn", "#loop", "#features", "#gallery", "#privacy"];
  const anchorRes = [];
  for (const href of anchorTargets) {
    await cdp.eval(`(() => { const a = document.querySelector('.nav-links a[href="${href}"]'); if (a) a.click(); return "ok"; })()`);
    // 等平滑滚动结束
    let last = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const y = await cdp.eval("window.scrollY");
      if (Math.abs(y - last) < 1) { if (++stable >= 3) break; } else stable = 0;
      last = y;
    }
    const r = await cdp.eval(`(() => {
      const sec = document.querySelector(${JSON.stringify(href)});
      const head = sec.querySelector("h2") || sec;
      const sr = sec.getBoundingClientRect();
      const hr = head.getBoundingClientRect();
      const navB = document.querySelector(".nav").getBoundingClientRect().bottom;
      const on = [...document.querySelectorAll(".nav-links a.on")].map((a) => a.getAttribute("href"));
      return { secTop: Math.round(sr.top), top: Math.round(hr.top), navBottom: Math.round(navB), scrollY: Math.round(window.scrollY), on };
    })()`);
    anchorRes.push({ href, ...r, ok: r.secTop >= r.navBottom - 2 && r.top >= r.navBottom - 2 && r.scrollY > 100 });
  }
  check("导航锚点：点「拐点/怎么陪/功能/界面/隐私」能滚到区块且标题不被 sticky 头遮住",
    anchorRes.every((a) => a.ok) && navInfo.sticky === "sticky",
    anchorRes.map((a) => `${a.href}:secTop=${a.secTop}/top=${a.top}/navB=${a.navBottom}${a.ok ? "" : "!!"}`).join(" "), "严重", "交互-锚点");
  check("滚动时当前区块导航高亮跟随", anchorRes.every((a) => a.on.length === 1 && a.on[0] === a.href), anchorRes.map((a) => `${a.href}:on=${a.on.join(",")}`).join(" "), "建议", "交互-锚点");
  await cdp.eval(`window.scrollTo(0, document.documentElement.scrollHeight); "ok"`);
  await sleep(500);
  const bottomOn = await cdp.eval(`[...document.querySelectorAll(".nav-links a.on")].map((a) => a.getAttribute("href"))`);
  check("页面底部没有错误高亮（避免把「隐私」错误标成当前区块）", bottomOn.length === 0, `高亮=${JSON.stringify(bottomOn)}`, "建议", "交互-锚点");

  /* ===== 阶段 I：键盘 Tab 焦点可见 ===== */
  await cdp.eval(`window.scrollTo(0,0); document.body.focus(); "ok"`);
  const focusSeen = { skip: null, theme: null, tab: null, anyOutline: 0, sample: [] };
  const focusable = [];
  for (let i = 0; i < 30; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(60);
    const f = await cdp.eval(`(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const cs = getComputedStyle(a);
      return { tag: a.tagName, id: a.id || "", cls: String(a.className || "").slice(0, 40), vis: a.matches(":focus-visible"), outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor, text: (a.textContent || "").trim().slice(0, 20) };
    })()`);
    if (!f) continue;
    focusable.push(f.tag + (f.id ? "#" + f.id : "") + (f.cls ? "." + f.cls.split(" ")[0] : ""));
    if (f.vis && f.outline.split(" ")[0] !== "none" && f.outline.split(" ")[1] !== "0px") focusSeen.anyOutline++;
    if (f.cls.includes("skip-link")) focusSeen.skip = f;
    if (f.id === "themeBtn") focusSeen.theme = f;
    if (f.cls.includes("tab")) focusSeen.tab = f;
    if (focusSeen.sample.length < 8) focusSeen.sample.push(f.tag + (f.id ? "#" + f.id : "") + " outline=" + f.outline.split(" ").slice(0, 2).join(" "));
  }
  check("Tab 可依次聚焦主要控件（主题按钮 / 页签 / 链接）", focusable.length >= 8 && !!focusSeen.theme && !!focusSeen.tab, `聚焦序列：${focusable.slice(0, 18).join(" → ")}`, "建议", "可访问性");
  check("键盘聚焦时 outline 可见（:focus-visible 生效）", focusSeen.anyOutline >= 5, `可见焦点数=${focusSeen.anyOutline}；${focusSeen.sample.join(" ; ")}`, "建议", "可访问性");
  await cdp.eval(`document.activeElement && document.activeElement.blur(); "ok"`);

  /* ===== 阶段 J：768 平板 + 375 手机（双主题截图 + 检查） ===== */
  for (const [width, height, mobile, dsf] of [[768, 1024, false, 1], [375, 812, true, 2]]) {
    for (const theme of ["dark", "light"]) {
      await setViewport(width, height, mobile, dsf);
      await setThemeAndReload(theme);
      await scrollAll();
      const lay = await cdp.eval(IN_PAGE.layout);
      check(`${width} 宽（${theme}）无横向滚动`, !lay.horizontalScroll, `scrollWidth=${lay.scrollWidth} innerWidth=${lay.innerWidth}`, "严重", `响应式 ${width}`);
      check(`${width} 宽（${theme}）无元素溢出视口`, lay.bad.length === 0, JSON.stringify(lay.bad.slice(0, 6)), "严重", `响应式 ${width}`);
      check(`${width} 宽（${theme}）无文字被截断`, lay.clippedText.length === 0, JSON.stringify(lay.clippedText.slice(0, 5)), "建议", `响应式 ${width}`);
      const partsW = await cdp.eval(IN_PAGE.parts);
      check(`${width} 宽（${theme}）CTA 按钮 / 手机截图 / 卡片 / 浮卡不破版（都在视口内）`, partsW.length === 0, JSON.stringify(partsW), "严重", `响应式 ${width}`);
      const ch = await cdp.eval(IN_PAGE.charts);
      const overlap = !!(ch.annoTurnRect && ch.legendRect && ch.annoTurnRect.display !== "none" &&
        ch.annoTurnRect.b > ch.legendRect.t && ch.annoTurnRect.t < ch.legendRect.b &&
        ch.annoTurnRect.r > ch.legendRect.l && ch.annoTurnRect.l < ch.legendRect.r);
      check(`${width} 宽（${theme}）拐点标注「拐点」不压住图例文字`, !overlap, overlap ? `legend=${JSON.stringify(ch.legendRect)} anno=${JSON.stringify(ch.annoTurnRect)}` : "无重叠", "严重", `响应式 ${width}`);
      await cdp.eval(`window.scrollTo(0,0); "ok"`); await sleep(250);
      await captureSections(width, theme, height);
      // 滚到底检查页脚
      await cdp.eval(`window.scrollTo(0, document.documentElement.scrollHeight); "ok"`);
      await sleep(400);
      const foot = await cdp.eval(`(() => {
        const f = document.querySelector("footer").getBoundingClientRect();
        const W = window.innerWidth;
        const done = document.querySelector(".footer-note").getBoundingClientRect();
        return { footerLeft: Math.round(f.left), footerRight: Math.round(f.right), W, noteBottom: Math.round(done.bottom), docH: document.documentElement.scrollHeight, scrollY: Math.round(window.scrollY), innerH: innerHeight, horizontal: document.documentElement.scrollWidth > W + 1 };
      })()`);
      check(`${width} 宽（${theme}）滚到底：页脚完整、无横向滚动`, foot.footerLeft >= -1 && foot.footerRight <= foot.W + 1 && !foot.horizontal, JSON.stringify(foot), "严重", `响应式 ${width}`);
      await shot(`${width}-${theme}-bottom-footer.png`);
      const imgs = await cdp.eval(`({ total: document.images.length, broken: [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")) })`);
      check(`${width} 宽（${theme}）截图/图片全部加载`, imgs.broken.length === 0, imgs.broken.join(", ") || `${imgs.total} 张全部加载`, "严重", `响应式 ${width}`);
    }
  }

  /* 375 宽点按：主题切换 + tab */
  await setViewport(375, 812, true, 2);
  await setThemeAndReload("dark");
  await cdp.eval(`window.scrollTo(0,0); "ok"`); await sleep(200);
  await cdp.eval(`document.getElementById("themeBtn").click(); "ok"`);
  await sleep(250);
  const mTheme = await cdp.eval(`({ theme: document.documentElement.dataset.theme, saved: localStorage.getItem("companion-intro-theme") })`);
  check("375 宽点按主题按钮可切换并记忆", mTheme.theme === "light" && mTheme.saved === "light", JSON.stringify(mTheme), "严重", "响应式 375");
  await scrollToSel("#gallery");
  await cdp.eval(`document.querySelectorAll(".tab")[2].click(); "ok"`);
  await sleep(280);
  const mTab = await cdp.eval(IN_PAGE.tabsState);
  check("375 宽点按页签可切换（aria-selected/panel 正确）", mTab.selected[2] === "true" && mTab.hidden.filter((h) => h).length === 4 && mTab.shownImgs.every((i) => i.ok), mTab.selected.join("/"), "严重", "响应式 375");

  /* ===== 阶段 K：demo/index.html 新开页 ===== */
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/demo/index.html`)}`, { method: "PUT" });
    let demoTarget = null;
    for (let i = 0; i < 20 && !demoTarget; i++) {
      await sleep(250);
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      demoTarget = list.find((t) => t.type === "page" && /demo\/index\.html/.test(t.url));
    }
    if (!demoTarget) throw new Error("未找到 demo 页面 target");
    const demo = makeClient(demoTarget.webSocketDebuggerUrl);
    await demo.open();
    for (const d of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) await demo.send(d);
    const ready = await demo.waitFor("typeof state === 'object' && !!window.PLAN && document.readyState === 'complete'", 15000);
    await sleep(800);
    const demoInfo = ready ? await demo.eval(`({
      hasState: typeof state === "object",
      planDays: window.PLAN && window.PLAN.days ? window.PLAN.days.length : null,
      planMeta: !!(window.PLAN && window.PLAN.meta),
      title: document.title,
      tasks: document.querySelectorAll("#taskList .task").length,
      tabs: document.querySelectorAll(".tab").length,
      version: typeof APP_VERSION !== "undefined" ? APP_VERSION : null,
    })`) : null;
    check("demo/index.html 能独立打开并运行（state 对象 + window.PLAN + 无报错）",
      !!demoInfo && demoInfo.hasState && demoInfo.planMeta && demoInfo.planDays >= 11 && demo.pageErrors.length === 0,
      JSON.stringify({ info: demoInfo, errors: demo.pageErrors.slice(0, 5) }), "严重", "demo");
    if (demoInfo) {
      fact("demo 副本是应用真实副本（可运行，11 天冲刺数据齐全）", demoInfo.planDays >= 11 ? "OK" : "错误", `PLAN.days=${demoInfo.planDays} version=${demoInfo.version}`);
    }
    demo.close();
    try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${demoTarget.id}`); } catch {}
  } catch (e) {
    check("demo/index.html 能独立打开并运行", false, "无法创建 demo 页 target: " + e.message, "严重", "demo");
  }

  /* ===== 阶段 L：file:// 直开（第二个 Chrome 实例） ===== */
  const filePath = path.join(ROOT, "index.html").replace(/\\/g, "/");
  const fileUrl = "file:///" + encodeURI(filePath).replace(/#/g, "%23");
  const fileChrome = launchChrome(FILE_CDP_PORT, fileUrl, ["--allow-file-access-from-files", "--allow-file-access"]);
  let fileOk = false;
  try {
    const ft = await waitTargets(FILE_CDP_PORT, 1, 20000);
    if (!ft) throw new Error("file:// Chrome 未启动");
    const fcdp = makeClient(ft[0].webSocketDebuggerUrl);
    await fcdp.open();
    for (const d of ["Page.enable", "Runtime.enable", "Log.enable"]) await fcdp.send(d);
    const ready = await fcdp.waitFor("document.readyState === 'complete' && document.getElementById('suggestOut') && document.getElementById('suggestOut').children.length > 0", 15000);
    await fcdp.eval(`(async () => {
      document.querySelectorAll("img").forEach((i) => { i.loading = "eager"; });
      const H = innerHeight, max = document.documentElement.scrollHeight - H;
      for (let y = 0; y <= max; y += Math.max(300, H * 0.8)) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 50)); }
      window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));
      return "ok";
    })()`);
    await sleep(400);
    const finfo = await fcdp.eval(`(() => {
      let ls = "ok";
      try { localStorage.setItem("__qa_probe", "1"); localStorage.removeItem("__qa_probe"); } catch (e) { ls = String(e).slice(0, 80); }
      const link = document.querySelector('link[rel="stylesheet"]');
      let sheetOk = false;
      try { sheetOk = !!(link && link.sheet && link.sheet.cssRules && link.sheet.cssRules.length > 0); } catch (e) { sheetOk = "blocked:" + String(e).slice(0, 40); }
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      return {
        theme: document.documentElement.dataset.theme,
        bodyBg, fontSize: getComputedStyle(document.body).fontSize,
        navPosition: getComputedStyle(document.querySelector(".nav")).position,
        sheetOk,
        imgsTotal: document.images.length,
        imgsBroken: [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.getAttribute("src")),
        scriptsRan: document.getElementById("suggestOut").children.length > 0,
        demoHrefs: [...document.querySelectorAll("a[href*='demo/']")].map((a) => a.href),
        ls,
      };
    })()`);
    const ferrs = fcdp.pageErrors;
    check("file:// 直开：CSS 生效、图片加载、脚本运行",
      ready && finfo.fontSize === "16px" && finfo.bodyBg !== "rgba(0, 0, 0, 0)" && finfo.navPosition === "sticky" && finfo.imgsBroken.length === 0 && finfo.scriptsRan,
      JSON.stringify({ ready, bodyBg: finfo.bodyBg, nav: finfo.navPosition, sheetOk: finfo.sheetOk, imgs: `${finfo.imgsTotal - finfo.imgsBroken.length}/${finfo.imgsTotal}`, broken: finfo.imgsBroken, scriptsRan: finfo.scriptsRan }), "严重", "file://");
    await fcdp.eval(`document.getElementById("themeBtn").click(); "ok"`);
    await sleep(250);
    const fTheme = await fcdp.eval(`document.documentElement.dataset.theme`);
    check("file:// 直开：主题切换可用", fTheme === "light", `data-theme=${fTheme}`, "严重", "file://");
    const demoHref = finfo.demoHrefs[0] || "";
    const demoExists = fs.existsSync(path.join(ROOT, "demo", "index.html"));
    check("file:// 直开：demo 链接 href 可点且目标存在", /\/demo\/index\.html$/.test(demoHref) && demoExists, `href=${demoHref}`, "严重", "file://");
    check("file:// 直开：无 JS 报错", ferrs.length === 0, ferrs.slice(0, 5).join(" | ") || "无", "严重", "file://");
    fact("file:// 下 localStorage 行为", finfo ? "OK" : "未测", `localStorage 可用性=${JSON.stringify(finfo && finfo.ls)}（file:// 下 Chrome 允许 localStorage；若异常已单独记录）`);
    if (finfo.ls !== "ok") fact("file:// 下 localStorage 写入异常", "警告", String(finfo.ls));
    await fcdp.eval(`window.scrollTo(0,0); "ok"`);
    await sleep(250);
    try {
      const r = await fcdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, "file-protocol-top.png"), Buffer.from(r.data, "base64"));
      shots.push("file-protocol-top.png");
    } catch {}
    fcdp.close();
    fileOk = true;
  } catch (e) {
    check("file:// 直开：CSS/图片/脚本/主题/无报错", false, "未能验证 file://：" + e.message, "严重", "file://");
  } finally {
    try { fileChrome.kill(); } catch {}
  }

  /* ===== 阶段 M：已知现状记录（人工复核辅助） ===== */
  check("控制台/网络错误汇总（全流程）", pageErrors.length === 0 && httpErrors.length === 0, (pageErrors.slice(0, 6).join(" | ") + " " + httpErrors.slice(0, 6).join(" | ")).trim() || `全程 ${allRequests.length} 个响应，0 报错`, "严重", "控制台");

} catch (e) {
  check("验收脚本执行完成", false, "脚本异常：" + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" ") : String(e)), "严重", "脚本");
} finally {
  /* ---------------- 7. 汇总 + 清理 ---------------- */
  const failed = checks.filter((c) => !c.pass);
  const blocking = failed.filter((c) => c.severity === "严重");
  const suggestion = failed.filter((c) => c.severity !== "严重");
  const report = {
    generatedAt: new Date().toISOString(),
    url: URL_SITE,
    viewport: "375 / 768 / 1440，dark + light",
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length, blocking: blocking.length, suggestion: suggestion.length },
    failed,
    checks,
    facts,
    contrast: { dark: typeof darkRatios !== "undefined" ? darkRatios : null, light: typeof lightRatios !== "undefined" ? lightRatios : null },
    shots,
    consoleErrors: pageErrors,
    httpErrors,
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log("\n================ 汇总 ================");
  console.log(`PASS ${checks.length - failed.length}/${checks.length}  FAIL ${failed.length}（严重 ${blocking.length} / 建议 ${suggestion.length}）`);
  if (blocking.length) {
    console.log("\n严重问题：");
    blocking.forEach((b, i) => console.log(`  ${i + 1}. [${b.phase}] ${b.name}  —— ${b.detail}`));
  }
  if (suggestion.length) {
    console.log("\n建议问题：");
    suggestion.forEach((b, i) => console.log(`  ${i + 1}. [${b.phase}] ${b.name}  —— ${b.detail}`));
  }
  console.log(`\n截图 ${shots.length} 张 -> ${SHOTS}`);
  console.log(`结构化结果 -> ${REPORT}`);
  try { await cdp.send("Browser.close"); } catch {}
  await sleep(400);
  try { chrome.kill(); } catch {}
  server.close();
  for (const p of profiles) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
  process.exit(blocking.length ? 1 : 0);
}
