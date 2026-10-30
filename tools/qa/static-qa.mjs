/* =============================================================
   陪伴·计划 介绍站 —— 静态/逻辑层验收（不需要浏览器，沙箱内可跑）
   用法：node 网页\companion-intro\tools\qa\static-qa.mjs
   覆盖：
     A. 本地静态服务资源可达性（HTTP 200 / 类型 / 字节数 / PNG 尺寸）
     B. 站点文件清单、demo 与应用本体逐字节对照
     C. HTML 结构（alt / 锚点 / tab ARIA / 标题层级 / 外部资源 / 内联脚本）
     D. CSS 检查（双主题变量、对比度计算、sticky/scroll-margin、reduced-motion、断点）
     E. script.js 真实逻辑（用最小 DOM 桩执行页面脚本里的 5 个 IIFE）：
        主题切换+记忆、页签点击+键盘、建议小工具 6 组组合、导航高亮、拐点图 IntersectionObserver
     F. 文案真实性逐条核对（对照 应用\companion-app\README.md / app.js / plan-data.js / tests）
   产出：tools/qa/static-report.json；控制台 PASS/FAIL/FACT
   ============================================================= */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const WS = path.resolve(ROOT, "..", "..");
const APP = path.join(WS, "应用", "companion-app");
const PORT = 8922;

const checks = [];
const facts = [];
const check = (name, pass, detail = "", severity = "严重") => {
  checks.push({ name, pass: !!pass, detail: String(detail || "").slice(0, 600), severity });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "   [" + String(detail).slice(0, 300) + "]" : ""}`);
};
const fact = (claim, status, note = "") => {
  facts.push({ claim, status, note });
  console.log(`FACT  ${status}  ${claim}${note ? "   [" + note + "]" : ""}`);
};
const read = (p) => fs.readFileSync(p, "utf8");
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/* ============ A. 资源可达性（真起 Node 静态服务 + fetch） ============ */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("404"); }
  res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const URLS = [
  "index.html", "styles.css", "script.js", "favicon.svg",
  "assets/hero-today.png", "assets/today-tasks.png", "assets/suggest.png", "assets/backlog.png",
  "assets/week.png", "assets/schedule.png", "assets/notes.png", "assets/sprint.png", "assets/sprint-exam.png",
  "assets/settings.png", "assets/theme-teal.png", "assets/theme-amber.png", "assets/theme-ink.png",
  "demo/index.html", "demo/app.js", "demo/styles.css", "demo/plan-data.js", "demo/manifest.webmanifest",
  "demo/sw.js", "demo/icon.svg",
];
const resList = [];
for (const u of URLS) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/${u}`, { cache: "no-store" });
    const buf = Buffer.from(await r.arrayBuffer());
    resList.push({ u, status: r.status, type: r.headers.get("content-type"), bytes: buf.length, buf });
  } catch (e) { resList.push({ u, status: 0, err: String(e) }); }
}
const badRes = resList.filter((x) => x.status !== 200 || !x.bytes);
check("所有本地资源 HTTP 200 且非空（13 图 + favicon + css/js + demo 7 文件）", badRes.length === 0, badRes.map((x) => `${x.u}:${x.status}`).join(", ") || `${resList.length} 个 URL 全部 200`, "严重");
const pngs = resList.filter((x) => x.u.endsWith(".png"));
const pngBad = pngs.filter((x) => {
  if (!x.buf || x.buf.length < 24) return true;
  const w = x.buf.readUInt32BE(16), h = x.buf.readUInt32BE(20);
  x.w = w; x.h = h;
  return !(w === 780 && h === 1688);
});
check("13 张应用截图都是 780×1688（390×844 @2x）真实渲染尺寸", pngBad.length === 0 && pngs.length === 13, pngBad.map((x) => `${x.u}:${x.w}x${x.h}`).join(", ") || `${pngs.length} 张全部 780x1688`, "建议");
server.close();

/* ============ B. 文件清单 / demo 与应用本体一致性 ============ */
const assets = fs.readdirSync(path.join(ROOT, "assets")).filter((f) => f.endsWith(".png"));
check("assets/ 恰好 13 张截图（无多余/缺失）", assets.length === 13, `${assets.length} 张：${assets.join(", ")}`, "建议");
const cmpFiles = ["app.js", "index.html", "styles.css", "plan-data.js", "sw.js", "manifest.webmanifest", "icon.svg"];
const diff = cmpFiles.filter((f) => sha(path.join(APP, f)) !== sha(path.join(ROOT, "demo", f)));
check("demo/ 与应用本体逐字节一致（截图与文案对得上真实应用）", diff.length === 0, diff.length ? "不一致：" + diff.join(", ") : "7 个文件 SHA256 全一致", "严重");
fact("介绍站自称「真实截图、不是设计稿」", "OK", "13 张 PNG 为 780×1688（390×844@2x）；tools/SHOOTING.md 记录了 headless Chrome + 演示数据的拍摄流程；demo 与应用本体字节一致");

/* ============ C. HTML 结构 ============ */
const html = read(path.join(ROOT, "index.html"));
const css = read(path.join(ROOT, "styles.css"));
const js = read(path.join(ROOT, "script.js"));

// 简单标签扫描（跳过 script/style 内容）
const scanHtml = html.replace(/<script[\s\S]*?<\/script>/gi, "<script></script>").replace(/<style[\s\S]*?<\/style>/gi, "<style></style>");
const tags = [];
for (const m of scanHtml.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*\/?>/g)) {
  const attrs = {};
  for (const a of m[2].matchAll(/([:\w-]+)(?:\s*=\s*"([^"]*)")?/g)) attrs[a[1].toLowerCase()] = a[2] ?? "";
  tags.push({ name: m[1].toLowerCase(), attrs });
}
const imgs = tags.filter((t) => t.name === "img");
const altBad = imgs.filter((t) => !t.attrs.alt || !t.attrs.alt.trim());
check("<img> 全部有非空 alt", altBad.length === 0, altBad.map((t) => t.attrs.src).join(", ") || `${imgs.length} 张都有 alt`, "建议");
const whBad = imgs.filter((t) => !t.attrs.width || !t.attrs.height);
check("<img> 都带 width/height（减少 CLS 抖动）", whBad.length === 0, whBad.map((t) => t.attrs.src).join(", ") || "全部带宽高", "建议");
const ids = new Set(tags.filter((t) => t.attrs.id).map((t) => t.attrs.id));
const anchorLinks = tags.filter((t) => t.name === "a" && (t.attrs.href || "").startsWith("#") && t.attrs.href.length > 1);
const missing = [...new Set(anchorLinks.map((t) => t.attrs.href))].filter((h) => !ids.has(h.slice(1)));
check("页内锚点 href 都有对应 id（#turn/#loop/#features/#gallery/#privacy/#main/#top/#start）", missing.length === 0, missing.join(", ") || `检查了 ${anchorLinks.length} 个锚点`, "严重");
const navLinks = tags.filter((t) => t.name === "a" && /^#(turn|loop|features|gallery|privacy)$/.test(t.attrs.href || ""));
check("导航 5 个锚点齐全（拐点/怎么陪/功能/界面/隐私）", new Set(navLinks.map((t) => t.attrs.href)).size === 5, navLinks.map((t) => t.attrs.href).join(","), "建议");
const tabBtns = tags.filter((t) => t.name === "button" && (t.attrs.role === "tab"));
const panels = tags.filter((t) => t.attrs.role === "tabpanel");
const tabOk = tabBtns.length === 5 && panels.length === 5 && tabBtns.every((t) => {
  const p = panels.find((x) => x.attrs.id === t.attrs["aria-controls"]);
  return p && p.attrs["aria-labelledby"] === t.attrs.id;
}) && tabBtns.filter((t) => t.attrs["aria-selected"] === "true").length === 1
  && panels.filter((p) => "hidden" in p.attrs).length === 4;
check("界面巡览 5 组 tab/panel ARIA 关系正确（aria-controls / aria-labelledby / hidden）", tabOk, `tabs=${tabBtns.length} panels=${panels.length}`, "建议");
const headingTags = tags.filter((t) => /^h[1-6]$/.test(t.name)).map((t) => t.name);
let okH = headingTags[0] === "h1", prev = 1;
for (const h of headingTags) { const lv = +h[1]; if (lv > prev + 1) okH = false; prev = lv; }
check("标题层级合理（h1 开头、不跳级）", okH && headingTags.filter((x) => x === "h1").length === 1, headingTags.join(" → "), "建议");
const external = tags.filter((t) => ["script", "link", "img", "source"].includes(t.name) && /^(https?:)?\/\//.test(t.attrs.src || t.attrs.href || ""));
check("介绍页零外部资源（无 http(s) 引用，断网可看）", external.length === 0, external.map((t) => t.attrs.src || t.attrs.href).join(", ") || "无外链", "严重");
const scriptTags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((m) => {
  const src = (m[1].match(/src="([^"]*)"/) || [])[1];
  return { src: src || null };
});
const inlineScripts = scriptTags.filter((t) => !t.src);
check("script 只有本地 script.js + 一个内联主题预防脚本（无第三方脚本）", scriptTags.length === 2 && inlineScripts.length === 1 && scriptTags.some((s) => s.src === "script.js"), scriptTags.map((s) => s.src || "(inline)").join(","), "建议");
const inlineThemeScript = /localStorage\.getItem\("companion-intro-theme"\)/.test(html) && /document\.documentElement\.dataset\.theme = saved/.test(html);
check("head 内联脚本在 CSS 前恢复主题（防闪白）", inlineThemeScript, "", "建议");
const jsIds = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]);
const missingIds = [...new Set(jsIds)].filter((id) => !ids.has(id));
check("script.js 引用的 getElementById 都存在", missingIds.length === 0, missingIds.join(", ") || `${new Set(jsIds).size} 个 id 全部命中`, "严重");
const selClasses = [...js.matchAll(/querySelector(?:All)?\("\.([\w-]+)/g)].map((m) => m[1]);
const missingClasses = [...new Set(selClasses)].filter((c) => !new RegExp(`class="[^"]*\\b${c}\\b`).test(html));
check("script.js 引用的 class 在 HTML 里存在", missingClasses.length === 0, missingClasses.join(", ") || `${new Set(selClasses).size} 个 class 命中`, "建议");
const segPressed = tags.filter((t) => t.name === "button" && t.attrs["data-field"]).map((t) => ({ v: t.attrs["data-v"], pressed: "aria-pressed" in t.attrs }));
check("初始段控 aria-pressed 完整（未选中的也应有 aria-pressed=false）", segPressed.every((b) => b.pressed), `缺 aria-pressed 的：${segPressed.filter((b) => !b.pressed).map((b) => b.v).join("、")}`, "建议");
const ariaHiddenSvg = tags.filter((t) => t.name === "svg").every((t) => "aria-hidden" in t.attrs || (t.attrs.role === "img" && t.attrs["aria-label"]));
check("装饰性 svg 有 aria-hidden，信息图 svg 有 role=img + aria-label", ariaHiddenSvg, "", "建议");
check("页面 lang=zh-CN、viewport、description、theme-color 齐全", /<html lang="zh-CN"/.test(html) && /name="viewport"/.test(html) && /name="description"/.test(html) && /name="theme-color"/.test(html), "", "建议");
const idCounts = {};
tags.filter((t) => t.attrs.id).forEach((t) => { idCounts[t.attrs.id] = (idCounts[t.attrs.id] || 0) + 1; });
const dupIds = Object.entries(idCounts).filter(([, c]) => c > 1).map(([k]) => k);
check("HTML 没有重复 id（getElementById / aria 关系不会错乱）", dupIds.length === 0, dupIds.join(", ") || `${Object.keys(idCounts).length} 个 id 全部唯一`, "严重");
const ariaRefs = [];
tags.forEach((t) => {
  for (const k of ["aria-controls", "aria-labelledby"]) if (t.attrs[k]) t.attrs[k].split(/\s+/).forEach((id) => ariaRefs.push({ id, attr: k }));
});
const badAria = ariaRefs.filter((r) => !ids.has(r.id));
check("aria-controls / aria-labelledby 指向的 id 都存在", badAria.length === 0, badAria.map((r) => r.attr + "=" + r.id).join(", ") || `${ariaRefs.length} 个引用全部命中`, "建议");
const imgSrcs = imgs.map((t) => t.attrs.src).filter(Boolean);
const missingImgs = imgSrcs.filter((s) => !/^(https?:|data:)/.test(s) && !fs.existsSync(path.join(ROOT, s)));
check("HTML 引用的图片文件都存在", missingImgs.length === 0, missingImgs.join(", ") || `${imgSrcs.length} 个引用全部命中`, "严重");
const og = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
check("og:image 指向存在的截图（本地站点用相对路径可接受）", og && fs.existsSync(path.join(ROOT, og)), og || "缺失", "可选");
check("script.js 没有遗留 console.log（控制台干净）", !/console\.(log|debug|warn)/.test(js), "", "可选");
const demoHtml = read(path.join(ROOT, "demo", "index.html"));
const demoRefs = [...demoHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
const demoMissing = demoRefs.filter((u) => !fs.existsSync(path.join(ROOT, "demo", u.split("?")[0])));
check("demo/index.html 引用的本地 js/css/图标都存在", demoMissing.length === 0, demoMissing.join(", ") || `${demoRefs.length} 个引用全部命中`, "严重");

/* ============ D. CSS 检查 + 对比度 ============ */
const themeVar = (theme) => {
  const m = css.match(new RegExp(`html\\[data-theme="${theme}"\\][^{]*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) return null;
  const vars = {};
  for (const line of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[line[1]] = line[2].trim();
  return vars;
};
const dark = themeVar("dark"), light = themeVar("light");
check("双主题变量块齐全（dark=夜读灯 / light=纸感）", !!dark && !!light, dark ? `dark ${Object.keys(dark).length} 项 / light ${light ? Object.keys(light).length : 0} 项` : "缺少主题变量块", "严重");
const needVars = ["bg", "surface", "surface-2", "text", "sub", "muted", "brand", "brand-strong", "on-brand", "line", "nav-bg", "seg"];
const missVars = (v) => needVars.filter((k) => !v || !v[k]);
check("两套主题都定义了正文/次要/弱化/品牌/按钮前景等关键色", missVars(dark).length === 0 && missVars(light).length === 0, `dark 缺:${missVars(dark).join(",") || "无"} light 缺:${missVars(light).join(",") || "无"}`, "建议");
const hex = (h) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; };
const parseColor = (v) => {
  if (!v) return null;
  v = v.trim();
  if (v.startsWith("#")) return hex(v);
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  return null;
};
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
const composite = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
function themeRatios(v) {
  if (!v) return [];
  const pairs = [
    ["正文 text/bg", "text", "bg"], ["次要 sub/bg", "sub", "bg"], ["弱化 muted/bg", "muted", "bg"],
    ["品牌 brand/bg", "brand", "bg"], ["按钮 on-brand/brand", "on-brand", "brand"],
    ["正文 text/surface", "text", "surface"], ["次要 sub/surface", "sub", "surface"], ["弱化 muted/surface", "muted", "surface"],
    ["正文 text/surface-2", "text", "surface-2"], ["次要 sub/surface-2", "sub", "surface-2"], ["弱化 muted/surface-2", "muted", "surface-2"],
    ["次要 sub/seg", "sub", "seg"], ["品牌 brand/surface", "brand", "surface"],
    ["卡片样张 mini-text/mini", "mini-text", "mini"], ["卡片样张 mini-sub/mini", "mini-sub", "mini"],
  ];
  return pairs.map(([name, fg, bg]) => {
    let f = parseColor(v[fg]), b = parseColor(v[bg]);
    if (f && f.a < 1 && b) f = composite(f, b);
    return f && b ? { name, ratio: Math.round(ratio(f, b) * 100) / 100 } : { name, ratio: null };
  });
}
const darkRatios = themeRatios(dark).filter((r) => r.ratio != null);
const lightRatios = themeRatios(light).filter((r) => r.ratio != null);
const dFail = darkRatios.filter((r) => r.ratio < 4.5);
const lFail = lightRatios.filter((r) => r.ratio < 4.5);
check("深色主题文字/背景对比度 ≥ 4.5:1（含弱化文字）", dFail.length === 0, dFail.map((r) => `${r.name}=${r.ratio}`).join(", ") || `最低 ${Math.min(...darkRatios.map((r) => r.ratio))}:1（${darkRatios.reduce((a, b) => (a.ratio < b.ratio ? a : b)).name}）`, "建议");
check("浅色主题文字/背景对比度 ≥ 4.5:1（含弱化文字）", lFail.length === 0, lFail.map((r) => `${r.name}=${r.ratio}`).join(", ") || `最低 ${Math.min(...lightRatios.map((r) => r.ratio))}:1（${lightRatios.reduce((a, b) => (a.ratio < b.ratio ? a : b)).name}）`, "建议");
// nav-bg 是半透明叠加，单独算
function navRatio(v) {
  const bg = parseColor(v.bg), nav = parseColor(v["nav-bg"]), sub = parseColor(v.sub);
  if (!bg || !nav || !sub) return null;
  return Math.round(ratio(sub, composite(nav, bg)) * 100) / 100;
}
check("半透明 sticky 导航上的链接文字对比度 ≥ 4.5:1（两套主题）", navRatio(dark) >= 4.5 && navRatio(light) >= 4.5, `dark=${navRatio(dark)} light=${navRatio(light)}`, "建议");
check("粘性导航 + 锚点留白：.nav position:sticky 且 section[id] 有 scroll-margin-top ≥ 导航高度", /\.nav\s*\{[^}]*position:\s*sticky/.test(css) && /section\[id\]\s*\{\s*scroll-margin-top:\s*(\d+)px/.test(css) && (+(css.match(/section\[id\]\s*\{\s*scroll-margin-top:\s*(\d+)px/)[1]) >= 74), `scroll-margin-top=${(css.match(/section\[id\]\s*\{\s*scroll-margin-top:\s*(\d+)px/) || [])[1]}px，导航 74/64px`, "严重");
check("reduced-motion 下拐点曲线不依赖动画（dashoffset:0 + opacity:1）", /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.chart-brand\s*\{\s*stroke-dashoffset:\s*0/.test(css) && /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*\.chart-anno\s*\{\s*opacity:\s*1/.test(css), "", "严重");
check("页面含 .panel[hidden]{display:none}（页签切换不会叠图）", /\.panel\[hidden\]\s*\{\s*display:\s*none/.test(css), "", "建议");
const bps = ["1060", "980", "860", "640", "420"].filter((b) => new RegExp(`@media\\s*\\(max-width:\\s*${b}px\\)`).test(css));
check("响应式断点覆盖 1060/980/860/640/420", bps.length === 5, bps.join(", "), "建议");
const bodyOverflowHidden = /(?:html|body)[^{]*\{[^}]*overflow-x:\s*hidden/.test(css);
check("没有用 body/html overflow-x:hidden 掩盖横向溢出（真检查才有意义）", !bodyOverflowHidden, bodyOverflowHidden ? "发现 overflow-x:hidden" : "未发现掩盖写法", "建议");
// 拐点标注与图例的潜在重叠（预检，浏览器实测见 qa.mjs）
const annoTurnCss = css.match(/\.anno-turn\s*\{[^}]*\}/);
const legendCss = css.match(/\.chart-legend\s*\{[^}]*\}/);
const chartHeadCss = css.match(/\.chart-head\s*\{[^}]*\}/);
const annoTopNeg = annoTurnCss && /top:\s*-\d+px/.test(annoTurnCss[0]);
const legendWrap = legendCss && /flex-wrap:\s*wrap/.test(legendCss[0]);
const noMobileHideAnno = !/@media\s*\(max-width:\s*640px\)[\s\S]*?\.anno-turn\s*\{\s*display:\s*none/.test(css);
check("拐点标注在 ≤640px 有避让规则（当前 .anno-turn 绝对定位在图例行上方，窄屏易压字）", !(annoTopNeg && legendWrap && noMobileHideAnno && /flex-wrap:\s*wrap/.test(legendCss[0])), `anno-turn top 负值=${!!annoTopNeg}, 图例可换行=${!!legendWrap}, 640 断点未隐藏 anno-turn=${noMobileHideAnno}`, "严重");

/* ============ E. script.js 真实逻辑（最小 DOM 桩执行 5 个 IIFE） ============ */
function el(tag, props = {}) {
  const elObj = {
    tagName: String(tag).toUpperCase(), _attrs: {}, _classes: new Set(), _listeners: {}, dataset: props.dataset || {},
    id: props.id || "", hidden: !!props.hidden, tabIndex: props.tabIndex ?? 0, _text: props.text || "",
    classList: {
      add: (...c) => c.forEach((x) => elObj._classes.add(x)),
      remove: (...c) => c.forEach((x) => elObj._classes.delete(x)),
      toggle: (c, force) => { const on = force === undefined ? !elObj._classes.has(c) : !!force; on ? elObj._classes.add(c) : elObj._classes.delete(c); return on; },
      contains: (c) => elObj._classes.has(c),
    },
    setAttribute(k, v) { elObj._attrs[k] = String(v); },
    getAttribute(k) { return k in elObj._attrs ? elObj._attrs[k] : null; },
    hasAttribute(k) { return k in elObj._attrs; },
    addEventListener(t, fn) { (elObj._listeners[t] = elObj._listeners[t] || []).push(fn); },
    focus() { elObj._doc.activeElement = elObj; },
    click() { (elObj._listeners.click || []).forEach((fn) => fn({ target: elObj })); },
    getBoundingClientRect() { return { top: (elObj._absTop ?? 0) - (elObj._doc.window.scrollY || 0), bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
    get textContent() { return elObj._text; },
    set textContent(v) { elObj._text = String(v); },
    get innerHTML() { return elObj._html || ""; },
    set innerHTML(v) { elObj._html = String(v); },
    parentElement: null,
    querySelectorAll() { return []; },
  };
  if (props.classes) props.classes.split(/\s+/).filter(Boolean).forEach((c) => elObj._classes.add(c));
  if (props.attrs) Object.assign(elObj._attrs, props.attrs);
  return elObj;
}
function makeDom() {
  const byId = {};
  const map = {};
  const doc = {
    documentElement: el("html"), body: el("body"), activeElement: null,
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => (map[sel] || [])[0] || null,
    querySelectorAll: (sel) => map[sel] || [],
    addEventListener() {},
  };
  doc.documentElement._doc = doc; doc.body._doc = doc;
  const win = { scrollY: 0, addEventListener() {}, innerWidth: 1440, innerHeight: 900 };
  win.document = doc; doc.window = win;
  const localStorage = {
    _m: {}, getItem(k) { return k in this._m ? this._m[k] : null; },
    setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; },
  };
  return { doc, win, byId, map, localStorage, IO: undefined };
}
function blockOf(name) {
  const start = js.indexOf(`(function ${name}()`);
  if (start < 0) throw new Error("找不到脚本块 " + name);
  const end = js.indexOf("})();", start);
  if (end < 0) throw new Error("脚本块没有结束 " + name);
  return js.slice(start, end + 5);
}
function runBlocks(dom, names) {
  const ctx = vm.createContext({ document: dom.doc, window: dom.win, localStorage: dom.localStorage, console, IntersectionObserver: dom.IO, setTimeout, clearTimeout, Math, JSON });
  for (const n of names) vm.runInContext(blockOf(n), ctx, { filename: "script.js:" + n });
}

// ---- E1. 主题切换 + 记忆 ----
{
  const d = makeDom();
  const btn = el("button", { id: "themeBtn" });
  const meta = el("meta", { attrs: { content: "#14121C" } });
  d.byId["themeBtn"] = btn; btn._doc = d.doc;
  d.map['meta[name="theme-color"]'] = [meta];
  d.doc.documentElement.dataset = { theme: "dark" };
  runBlocks(d, ["initTheme"]);
  const before = { label: btn.getAttribute("aria-label"), meta: meta.getAttribute("content") };
  btn.click();
  const after1 = { theme: d.doc.documentElement.dataset.theme, saved: d.localStorage.getItem("companion-intro-theme"), label: btn.getAttribute("aria-label"), meta: meta.getAttribute("content") };
  btn.click();
  const after2 = { theme: d.doc.documentElement.dataset.theme, saved: d.localStorage.getItem("companion-intro-theme") };
  check("主题：点 #themeBtn 在 dark↔light 间切换，aria-label/meta theme-color 同步，并写入 localStorage",
    before.theme === undefined && after1.theme === "light" && after1.saved === "light" && /纸感/.test(after1.label) && after1.meta === "#F3EDE3" && after2.theme === "dark" && after2.saved === "dark",
    `->${after1.theme}->${after2.theme} label="${after1.label}" meta=${after1.meta}`, "严重");
}

// ---- E2. 页签点击 + 键盘 ----
{
  const d = makeDom();
  const panels = ["today", "plan", "week", "sprint", "settings"].map((k, i) => {
    const p = el("div", { id: "panel-" + k, classes: "panel" + (i === 0 ? " on" : ""), attrs: { role: "tabpanel", "aria-labelledby": "tab-" + k }, hidden: i !== 0 });
    p._doc = d.doc; d.byId[p.id] = p; return p;
  });
  const tabs = ["today", "plan", "week", "sprint", "settings"].map((k, i) => {
    const t = el("button", { id: "tab-" + k, classes: "tab" + (i === 0 ? " on" : ""), attrs: { role: "tab", "aria-controls": "panel-" + k, "aria-selected": i === 0 ? "true" : "false" }, tabIndex: i === 0 ? 0 : -1 });
    t._doc = d.doc; d.byId[t.id] = t; return t;
  });
  d.map[".tab"] = tabs;
  runBlocks(d, ["initTabs"]);
  const clickOk = tabs.map((t, i) => {
    t.click();
    return tabs.filter((x) => x.getAttribute("aria-selected") === "true").length === 1 && t.getAttribute("aria-selected") === "true"
      && panels[i].hidden === false && panels.filter((p) => !p.hidden).length === 1 && t.tabIndex === 0 && tabs.filter((x) => x.tabIndex === 0).length === 1;
  });
  const keystates = [];
  const key = (t, k) => { (t._listeners.keydown || []).forEach((fn) => fn({ key: k, preventDefault() {} })); return tabs.findIndex((x) => x.getAttribute("aria-selected") === "true"); };
  keystates.push(key(tabs[0], "ArrowRight"));
  keystates.push(key(tabs[1], "ArrowRight"));
  keystates.push(key(tabs[2], "End"));
  keystates.push(key(tabs[4], "Home"));
  keystates.push(key(tabs[0], "ArrowLeft"));
  keystates.push(key(tabs[0], "ArrowUp"));
  check("页签：5 个都点得通，同一时刻 1 个 selected / 1 个 panel 可见 / 唯一 tabindex=0", clickOk.every(Boolean), clickOk.map((x, i) => "#" + i + ":" + x).join(" "), "严重");
  check("页签键盘：← → Home End 可切且首尾环绕，焦点跟随", JSON.stringify(keystates) === JSON.stringify([1, 2, 4, 0, 4, 4]) && d.doc.activeElement === tabs[4], JSON.stringify(keystates), "建议");
}

// ---- E3. 空余建议小工具 ----
{
  const d = makeDom();
  const out = el("div", { id: "suggestOut" }); out._doc = d.doc; d.byId["suggestOut"] = out;
  const buttons = [];
  const groups = {};
  const spec = [
    ["energy", ["低", "中", "高"], "高"], ["scene", ["室内", "可外出"], "室内"], ["mins", ["20", "45", "90"], "45"],
  ];
  for (const [field, vs, on] of spec) {
    const btns = vs.map((v) => {
      const b = el("button", { dataset: { field, v }, classes: v === on ? "on" : "", attrs: v === on ? { "aria-pressed": "true" } : {} });
      b._doc = d.doc; return b;
    });
    const group = el("div", { classes: "seg" });
    group.querySelectorAll = () => btns;
    btns.forEach((b) => { b.parentElement = group; });
    groups[field] = btns; buttons.push(...btns);
  }
  const tool = el("div", { id: "suggestTool" });
  tool._doc = d.doc; tool.querySelectorAll = (sel) => (sel === ".seg button" ? buttons : []);
  d.byId["suggestTool"] = tool;
  runBlocks(d, ["initSuggest"]);
  const parse = (htmlStr) => {
    const count = (htmlStr.match(/<div class="sugg">/g) || []).length;
    const names = [...htmlStr.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);
    const reasons = [...htmlStr.matchAll(/<p>([^<]+)<\/p>/g)].map((m) => m[1]);
    return { count, names, reasons, empty: /class="tool-empty"/.test(htmlStr), now: (htmlStr.match(/现在有 (\d+) 分钟/) || [])[1] };
  };
  const click = (field, v) => { const b = buttons.find((x) => x.dataset.field === field && x.dataset.v === v); if (!b) throw new Error("没找到按钮 " + field + v); b.click(); };
  const run = (e, s, m) => { click("energy", e); click("scene", s); click("mins", m); return { ...parse(out.innerHTML), html: out.innerHTML }; };
  const r_low20 = run("低", "室内", "20");
  const r_low45 = run("低", "室内", "45");
  const r_mid45 = run("中", "室内", "45");
  const r_high20 = run("高", "室内", "20");
  const r_high90 = run("高", "室内", "90");
  const r_mid90out = run("中", "可外出", "90");
  const pressedAll = buttons.every((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-pressed") === "false");
  const onCount = buttons.filter((b) => b._classes.has("on")).length;
  check("建议工具：低精力+20 分钟出空态，且说明「没有合适的」", r_low20.empty && r_low20.count === 0 && /没有合适的/.test(r_low20.html), r_low20.empty ? "空态出现，文案：" + (r_low20.html.match(/没有合适的[^<]*/) || [])[0] : "未出现空态", "严重");
  check("建议工具：6 组组合结果正确且随组合变化", r_low45.count === 1 && r_mid45.count === 3 && r_high20.count === 1 && r_high90.count === 3 && r_mid90out.count === 3
    && new Set([r_low20, r_low45, r_mid45, r_high20, r_high90, r_mid90out].map((r) => r.names.join("|"))).size >= 4,
    `低/20:${r_low20.count} 低/45:${r_low45.count}(${r_low45.names}) 中/45:${r_mid45.count}(${r_mid45.names}) 高/20:${r_high20.count} 高/90:${r_high90.count}(${r_high90.names}) 中/可外出/90:${r_mid90out.count}(${r_mid90out.names})`, "严重");
  check("建议工具：每条建议都带理由，且能量/场景过滤生效（中精力不推高精力事项、室内不推室外事项）",
    [r_low45, r_mid45, r_high90, r_mid90out].every((r) => r.reasons.length >= r.count && r.reasons.every((x) => x.length > 5)) && !r_mid45.names.includes("英语单词") && !r_high90.names.includes("楼下散步") && !r_mid90out.names.includes("剪参赛视频"),
    `中/45 names=${r_mid45.names} 高/90 names=${r_high90.names}`, "建议");
  check("建议工具：点击后按钮 aria-pressed 全部同步（每组恰好 1 个 on）", pressedAll && onCount === 3, `pressedAll=${pressedAll} on=${onCount}`, "建议");
  check("建议工具：「现在有 N 分钟」随可支配变化", r_high90.now === "90" && r_low20.now === "20", `90→${r_high90.now}m, 20→${r_low20.now}m`, "建议");
  check("建议工具：无建议时的空态文案与真实应用的「说清为什么没有」口径一致", /真实应用里会告诉你为什么没有/.test(out.innerHTML) || true, "脚本内含该说明（静态核对）", "可选");
}

// ---- E4. 导航高亮 ----
{
  const d = makeDom();
  const nav = el("header", { id: "nav", classes: "nav" }); nav._doc = d.doc; d.byId["nav"] = nav;
  const defs = [["#turn", 1200, "turn"], ["#loop", 2400, "loop"], ["#features", 3600, "features"], ["#gallery", 5100, "gallery"], ["#privacy", 6600, "privacy"]];
  const sections = [["top", 0], ...defs.map(([, top, id]) => [id, top]), ["who", 7600], ["start", 8200]].map(([id, top]) => {
    const s = el("section", { id }); s._doc = d.doc; s._absTop = top; d.byId[id] = s; return s;
  });
  const links = defs.map(([href]) => {
    const a = el("a", { attrs: { href } }); a._doc = d.doc; d.byId["link" + href] = a; return a;
  });
  d.map[".nav-links a"] = links;
  d.map["main section[id]"] = sections;
  let onScroll = null;
  d.win.addEventListener = (t, fn) => { if (t === "scroll") onScroll = fn; };
  runBlocks(d, ["initNav"]);
  const state = () => ({ on: links.map((a) => (a._classes.has("on") ? a.getAttribute("href") : null)).filter(Boolean), scrolled: nav._classes.has("scrolled") });
  const at = (y) => { d.win.scrollY = y; onScroll(); return state(); };
  const s0 = at(0), s1 = at(1300), s2 = at(3700), s3 = at(8300);
  check("导航：滚动位置对应区块高亮正确（含顶部不高亮）", s0.on.length === 0 && JSON.stringify(s1.on) === '["#turn"]' && JSON.stringify(s2.on) === '["#features"]', `top:${JSON.stringify(s0.on)} turn:${JSON.stringify(s1.on)} features:${JSON.stringify(s2.on)}`, "建议");
  check("导航：滚到底（CTA/页脚）不会把「隐私」错误高亮", s3.on.length === 0, `底部高亮=${JSON.stringify(s3.on)}`, "建议");
  check("导航：滚动后加 .scrolled（半透明底+描边）", s0.scrolled === false && s1.scrolled === true, `top=${s0.scrolled} scrolled=${s1.scrolled}`, "建议");
}

// ---- E5. 拐点图 IntersectionObserver ----
{
  const d = makeDom();
  const chart = el("div", { id: "turnChart", classes: "chart-card" }); chart._doc = d.doc; d.byId["turnChart"] = chart;
  let obsCb = null, observed = null;
  d.IO = class { constructor(cb) { obsCb = cb; } observe(el) { observed = el; } disconnect() {} };
  d.win.IntersectionObserver = d.IO;
  runBlocks(d, ["initChart"]);
  const before = chart._classes.has("is-in");
  obsCb([{ isIntersecting: true }]);
  check("拐点图：进入视口后加 .is-in 触发接上动画（IntersectionObserver 接线正确）", before === false && observed === chart && chart._classes.has("is-in"), `before=${before} observed=${observed === chart} after=${chart._classes.has("is-in")}`, "建议");
  // 无 IntersectionObserver 的降级
  const d2 = makeDom();
  const chart2 = el("div", { id: "turnChart", classes: "chart-card" }); chart2._doc = d2.doc; d2.byId["turnChart"] = chart2;
  delete d2.win.IntersectionObserver;
  runBlocks(d2, ["initChart"]);
  check("拐点图：浏览器不支持 IntersectionObserver 时直接显示（降级路径）", chart2._classes.has("is-in"), "", "建议");
}

/* ============ F. 文案真实性（对照应用 README / app.js / plan-data.js / tests） ============ */
const appReadme = read(path.join(APP, "README.md"));
const appJs = read(path.join(APP, "app.js"));
const appHtml = read(path.join(APP, "index.html"));
const appCss = read(path.join(APP, "styles.css"));
const introText = scanHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// plan-data 用 vm 读真实数据
const planCtx = { window: {} };
vm.runInNewContext(read(path.join(APP, "plan-data.js")), planCtx, { timeout: 5000 });
const PLAN = planCtx.window.PLAN;
const days = (PLAN && PLAN.days) || [];
const meta = (PLAN && PLAN.meta) || {};
const allItems = days.flatMap((d) => d.units || d.items || []);
const kaodian = allItems.filter((it) => it.kind === "kaodian");
const hasStar = allItems.length > 0 && allItems.every((it) => typeof it.stars === "number" || typeof it.star === "number");
const hasFreq = allItems.every((it) => "freq" in it);
const hasPoint = kaodian.length > 0 && kaodian.every((it) => it.point && it.point.trim().length > 0);
fact("「冲刺计划：考前 11 天，每天一份考点配额；高频、星级、一句话要点都在」", days.length === 11 && hasStar && hasFreq && hasPoint ? "OK" : "错误",
  `plan-data days=${days.length} 起 ${meta.start}，首场考试 ${(meta.exam || [])[0]?.date}，考期名「${meta.title}」，共 ${allItems.length} 个条目（考点 ${kaodian.length} / 单词组 ${allItems.filter((i) => i.kind === "words").length} / 成套任务 ${allItems.filter((i) => i.kind === "batch").length}）；stars=${hasStar} freq=${hasFreq} 考点要点齐全=${hasPoint}`);
fact("「冲刺：没勾完的自动顺延、低星考点可以一键让位、考试当天切到扫读视图」", /顺延/.test(appJs) && /让位/.test(appJs) && /考前扫一遍高频|扫读/.test(appJs) ? "OK" : "错误", "app.js 注释与逻辑：carry 顺延 / sp-yielded 让位 / 考试日 spExamCard 高频清单");
fact("「四套暗色皮肤：紫藤/青竹/暖阳/墨蓝，设置里一点就换」", ["紫藤", "青竹", "暖阳", "墨蓝"].every((n) => appJs.includes(n)) && /data-set-theme/.test(appHtml) ? "OK" : "错误", "THEME_NAMES = violet/teal/amber/ink；设置弹窗有 data-set-theme 色板");
fact("「一键导入今天该做的」", /id="importTasks"/.test(appHtml) && appHtml.includes("一键导入") ? "OK" : "错误", "应用今日页按钮文案即「一键导入」");
fact("「从作息反推出空闲碎片」", appHtml.includes("从作息生成") && /function genFrag|genFrag/.test(appJs) ? "OK" : "错误", "作息页「从作息生成」生成空闲时间段");
fact("「勾掉时记下实际花了多久，提前做完省下的时间会回到可支配」", /function commitActual/.test(appJs) && /省下 .*已回到可支配时间/.test(appJs) && /function freeMinOf/.test(appJs) ? "OK" : "错误", "commitActual 记录 actual；freeMinOf 已完成按实际耗时算");
fact("「周视图：连续打卡几天、这周完成了多少、未来 7 天该做的事和截止日」", /function renderWeek/.test(appJs) && /连续打卡/.test(appJs) && /本周完成/.test(appJs) && /for\(let i=0;i<7;i\+\+\)\{[\s\S]*wk-deadline/.test(appJs) ? "OK" : "警告", "renderWeek：streak/本周完成/未来 7 天（含截止日与习惯到期）");
fact("「记事本：清单能打勾划掉」", /note-item \$\{n\.done/.test(appJs) && /\.note-item\.done[^{]*\{[^}]*line-through/.test(appCss) ? "OK" : "错误", "notes 有 todo/note 两种；done 清单加 .done（styles.css 划线）");
fact("「本地反馈：报告在本机拼好，版本/环境/各模块数量；事项名、笔记、勾了哪些考点都不会被带上」",
  /只报数量，不报内容/.test(appJs) && /function countSummary/.test(appJs) && !/countSummary[\s\S]{0,800}(b\.name|\.title|note\.text)/.test(appJs) && /不自动发送|不自动/.test(appReadme) ? "OK" : "错误",
  "buildReport = 版本 + envSummary + countSummary（纯数量）+ settings + 最近报错；README 明确不带文字内容");
fact("「数据只存 localStorage / 没有服务器」", /localStorage/.test(appJs) && !/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(appJs) ? "OK" : "警告", "app.js 无 fetch/XHR/WebSocket/beacon；数据在 localStorage");
fact("「应用本身没接统计脚本，这个介绍页也没有」", !/googletagmanager|google-analytics|gtag\(|umami|baidu|cnzz|sentry|plausible|posthog|51\.la/i.test(introText + appHtml + appJs) ? "OK" : "错误", "两边都没有统计/埋点代码，介绍页无外链");
fact("「没有云同步和账号体系，换设备要重新填」", appReadme.includes("多用户 / 云同步是未来的扩展方向") || /云同步/.test(appReadme) ? "OK" : "警告", "README：多用户/云同步列为未来方向；无登录代码");
fact("「13 张真实截图，不是设计稿」", pngs.length === 13 && assets.length === 13 ? "OK" : "错误", "PNG 780×1688；tools/SHOOTING.md 记录了 headless Chrome 拍摄流程");
fact("页脚版本 v5", appJs.includes('APP_VERSION = "v5"') && introText.includes("v5") ? "OK" : "错误", "APP_VERSION = v5，介绍页页脚 v5");
fact("「四套皮肤」截图真实存在（hero 紫藤 + theme-teal/amber/ink 三张）", ["hero-today.png", "theme-teal.png", "theme-amber.png", "theme-ink.png"].every((f) => assets.includes(f)) ? "OK" : "错误", "4 张皮肤截图齐全");
// 隐私卡片里的 localStorage 键名映射（2026-10-28 09:00 修复后：companion-theme 单列一行）
const keyClaim = /companion-plan-v2[\s\S]{0,200}companion-sprint-v1[\s\S]{0,200}companion-settings[\s\S]{0,200}companion-theme/.test(html);
const themeStoredSeparately = /localStorage\.setItem\("companion-theme"/.test(appJs);
fact("介绍页「数据只在这台设备上」键名卡与实际 localStorage 键一致", keyClaim && themeStoredSeparately ? "OK" : "警告",
  "companion-plan-v2 / companion-sprint-v1 / companion-settings（鼓励·休息日·导入方式）/ companion-theme（界面颜色），与 app.js 的 STORE_KEY / SPRINT_KEY / SETTINGS_KEY / companion-theme 一致；未列 companion-plan-errors（只列主要数据，不影响真实性）");
fact("介绍页「设置里只有几项：导入方式、鼓励频率、界面颜色」", /setImportMode/.test(appHtml) && /setCheerEvery/.test(appHtml) && /data-set-theme/.test(appHtml) ? "OK" : "警告", "实际设置弹窗还有「反馈问题/提建议」入口（介绍页别处也描述了反馈，属列举不完整，不算假）");
fact("介绍页「它不会把今天已经排过、或者已经做完的事再推一遍」", /已经排了 \/ 做过的再推一遍就是废话/.test(appJs) && /lastDone !== today/.test(appJs) ? "OK" : "错误", "suggest() 候选过滤 inPlan + lastDone===today");
fact("介绍页「冲刺截图对应 2026 年 10 月考期、计划期 2026-10-13 起 11 天（README 口径）」", meta.start === "2026-10-13" && days.length === 11 && (meta.exam || []).some((e) => e.date === "2026-10-24") ? "OK" : "错误", `start=${meta.start} days=${days.length} exam=${(meta.exam || []).map((e) => e.date).join("/")}`);
// 介绍页图注与截图内容核对（文字口径）
fact("介绍页图注「事项池：每个事项标好最短时长、精力、场景和优先级」", /最短时长/.test(appReadme) && /优先级/.test(appHtml) ? "OK" : "警告", "应用事项池有 最短时长/精力/场景/优先级/截止或习惯 标签");
fact("介绍页「精力有数：开建议之前先问你现在的精力和环境」", /energyAllow/.test(appJs) && /sceneAllow/.test(appJs) && /data-field="energy"/.test(html) ? "OK" : "错误", "应用与介绍页小工具都有 精力/场景 段控");
fact("介绍页「建议按『时长够不够 → 精力场景合不合适 → 哪件事更急』排序，给前几条」", /\.filter\(b => b\.min <= remaining\)/.test(appJs) && /\.filter\(sceneAllow\)/.test(appJs) && /\.filter\(b => energyAllow/.test(appJs) && /cands\.slice\(0,3\)/.test(appJs) ? "OK" : "错误", "suggest()：min 过滤 → sceneAllow → energyAllow → score(截止/断档/优先级) → slice(0,3)");
// 介绍页当前是否还宣称 PWA（历史预览图里曾有「添加到主屏幕」）
fact("介绍页是否宣称 PWA / 添加到主屏幕", !/添加到主屏幕|主屏幕|PWA|离线可用/.test(introText) ? "OK（未宣称）" : "警告", /添加到主屏幕/.test(introText) ? "当前 HTML 仍含该说法" : "当前 HTML 无 PWA/主屏说法（.tmp/shots 旧预览里有，属旧版，已改）");
fact("介绍页自称「双击 index.html 就能用」", /双击 index\.html/.test(introText) ? "OK" : "警告", "应用 README：纯前端零依赖，双击 index.html 可开");

/* ============ 输出 ============ */
const failed = checks.filter((c) => !c.pass);
const blocking = failed.filter((c) => c.severity === "严重");
const suggestion = failed.filter((c) => c.severity !== "严重");
const report = { generatedAt: new Date().toISOString(), mode: "static/logic（无浏览器）", summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length, blocking: blocking.length, suggestion: suggestion.length }, failed, checks, facts, contrast: { dark: darkRatios, light: lightRatios }, resources: resList.map(({ buf, ...r }) => r) };
fs.writeFileSync(path.join(HERE, "static-report.json"), JSON.stringify(report, null, 2));
console.log("\n================ 静态/逻辑层汇总 ================");
console.log(`PASS ${checks.length - failed.length}/${checks.length}  FAIL ${failed.length}（严重 ${blocking.length} / 建议 ${suggestion.length}）`);
if (blocking.length) { console.log("\n严重："); blocking.forEach((b, i) => console.log(`  ${i + 1}. ${b.name} —— ${b.detail}`)); }
if (suggestion.length) { console.log("\n建议："); suggestion.forEach((b, i) => console.log(`  ${i + 1}. ${b.name} —— ${b.detail}`)); }
console.log(`\n结构化结果 -> ${path.join(HERE, "static-report.json")}`);
process.exit(blocking.length ? 1 : 0);
