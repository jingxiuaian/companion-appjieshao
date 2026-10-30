"use strict";
/* =========================================================
   陪伴 · 计划 —— 介绍页脚本
   1) 双主题切换（夜读灯 / 纸感）
   2) 导航滚动态 + 当前区块高亮
   3) 拐点曲线：进入视口时画出并接上
   4) 界面巡览页签
   5) 空余时间建议小工具（应用规则引擎的简化演示）
   ========================================================= */

/* ---------- 1. 主题 ---------- */
(function initTheme() {
  const root = document.documentElement;
  const btn = document.getElementById("themeBtn");
  const meta = document.querySelector('meta[name="theme-color"]');
  const KEY = "companion-intro-theme";

  const current = () => (root.dataset.theme === "light" ? "light" : "dark");

  function apply(theme, persist) {
    root.dataset.theme = theme;
    if (meta) meta.setAttribute("content", theme === "light" ? "#F3EDE3" : "#14121C");
    if (btn) {
      const label = theme === "light"
        ? "切换界面风格：纸感 → 夜读灯"
        : "切换界面风格：夜读灯 → 纸感";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", theme === "light" ? "切到夜读灯" : "切到纸感");
    }
    if (persist) {
      try { localStorage.setItem(KEY, theme); } catch (e) {}
    }
  }

  apply(current(), false);

  if (btn) {
    btn.addEventListener("click", () => {
      apply(current() === "dark" ? "light" : "dark", true);
    });
  }
})();

/* ---------- 2. 导航 ---------- */
(function initNav() {
  const nav = document.getElementById("nav");
  if (!nav) return;

  const links = Array.prototype.slice.call(document.querySelectorAll(".nav-links a"));
  const targets = links.map((a) => {
    const id = a.getAttribute("href").slice(1);
    return { link: a, el: document.getElementById(id) };
  });
  const sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));

  function onScroll() {
    nav.classList.toggle("scrolled", window.scrollY > 8);
    let current = null;
    sections.forEach((section) => {
      if (section.getBoundingClientRect().top <= 140) current = section;
    });
    const hit = current ? targets.find((t) => t.el === current) : null;
    links.forEach((a) => a.classList.toggle("on", !!hit && a === hit.link));
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScroll();
})();

/* ---------- 3. 拐点曲线 ---------- */
(function initChart() {
  const chart = document.getElementById("turnChart");
  if (!chart) return;
  if (!("IntersectionObserver" in window)) {
    chart.classList.add("is-in");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          chart.classList.add("is-in");
          io.disconnect();
        }
      });
    },
    { threshold: 0.22 }
  );
  io.observe(chart);
})();

/* ---------- 4. 界面巡览页签 ---------- */
(function initTabs() {
  const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  if (!tabs.length) return;
  const panels = tabs.map((t) => document.getElementById(t.getAttribute("aria-controls"))).filter(Boolean);

  function activate(tab, focus) {
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) {
        panel.hidden = !on;
        panel.classList.toggle("on", on);
      }
    });
    if (focus) tab.focus();
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activate(tab, false));
    tab.addEventListener("keydown", (e) => {
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        activate(next, true);
      }
    });
  });

  // 初始状态：以 HTML 里 aria-selected=true 的页签为准
  const initial = tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
  activate(initial, false);
  panels.forEach((p, i) => {
    if (p !== document.getElementById(initial.getAttribute("aria-controls"))) p.hidden = true;
  });
})();

/* ---------- 5. 空余时间建议小工具 ---------- */
(function initSuggest() {
  const tool = document.getElementById("suggestTool");
  const out = document.getElementById("suggestOut");
  if (!tool || !out) return;

  const state = { energy: "高", scene: "室内", mins: 45 };
  const ENERGY_RANK = { 低: 1, 中: 2, 高: 3 };

  /* 简化版事项池，字段和真实应用一致：最短时长 / 精力 / 场景 / 截止或习惯 */
  const POOL = [
    { name: "英语单词", min: 20, energy: "高", scene: "不限", type: "habit", gap: 3, interval: 1 },
    { name: "法学网课", min: 30, energy: "中", scene: "室内", type: "habit", gap: 2, interval: 1 },
    { name: "读《被讨厌的勇气》", min: 30, energy: "低", scene: "室内", type: "habit", gap: null },
    { name: "楼下散步", min: 15, energy: "低", scene: "室外", type: "habit", gap: 5, interval: 1 },
    { name: "剪参赛视频", min: 60, energy: "高", scene: "室内", type: "deadline", days: 3, unit: "交片" },
    { name: "低冲击健身", min: 30, energy: "中", scene: "室内", type: "habit", gap: 1, interval: 2 }
  ];

  function sceneAllow(item) {
    return state.scene === "可外出" || item.scene !== "室外";
  }

  function buildSuggestion(item) {
    if (item.type === "deadline") {
      return {
        score: Math.max(0, 14 - item.days) * 15,
        reason: (item.unit || "截止") + "还剩 " + item.days + " 天，做一点就少一点。"
      };
    }
    if (item.gap == null) {
      return { score: 20, reason: "「" + item.name + "」还没开始，今天开个头。" };
    }
    if (item.gap >= (item.interval || 1)) {
      return {
        score: (item.gap - (item.interval || 1) + 1) * 10,
        reason: "「" + item.name + "」断了 " + item.gap + " 天，今天做一点就接上了。"
      };
    }
    return { score: -100, reason: "「" + item.name + "」最近有在做，保持住。" };
  }

  function pick() {
    return POOL
      .filter((it) => it.min <= state.mins)
      .filter(sceneAllow)
      .filter((it) => ENERGY_RANK[it.energy] <= ENERGY_RANK[state.energy])
      .map((it) => {
        const s = buildSuggestion(it);
        return { item: it, score: s.score, reason: s.reason };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
  }

  function fitTag(item) {
    const over = state.mins - item.min;
    if (over <= 15) return "刚刚好";
    if (over <= 45) return "合适";
    return "时间有余";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render() {
    const results = pick();
    let html = "";
    if (!results.length) {
      html += '<p class="tool-now">现在有 ' + state.mins + " 分钟。</p>";
      html +=
        '<div class="tool-empty"><b>按你现在的精力 / 环境，池子里没有合适的。</b><br>' +
        "真实应用里会告诉你为什么没有：可能时间不够，也可能精力、场景对不上——而不是笼统甩一句「暂无建议」。</div>";
    } else {
      html += '<p class="tool-now">现在有 ' + state.mins + " 分钟，可以试试：</p>";
      results.forEach((r) => {
        html +=
          '<div class="sugg"><div class="sugg-top"><b>' + esc(r.item.name) + "</b>" +
          '<span class="fit">' + fitTag(r.item) + "</span></div>" +
          "<p>" + esc(r.reason) + "</p></div>";
      });
      html += '<p class="tool-fine">它不会把今天已经排过、或者已经做完的事再推一遍。</p>';
    }
    out.innerHTML = html;
  }

  tool.querySelectorAll(".seg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const field = btn.dataset.field;
      const raw = btn.dataset.v;
      state[field] = field === "mins" ? parseInt(raw, 10) : raw;
      const group = btn.parentElement;
      group.querySelectorAll("button").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      render();
    });
  });

  render();
})();
