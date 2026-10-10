// ==UserScript==
// @name         Forum Read-Only Browse Helper
// @namespace    https://github.com/huangsijun17/linuxdo-read-plugin
// @version      0.5.2
// @description  Read topics on whitelisted Discourse-style forums with visible, manual controls, optional assistive main-post likes, normal-distribution timing, and simple anti-bot challenge detection. No comments, bookmarks, or other interactions.
// @author       huangsijun17
// @match        https://linux.do/*
// @match        https://www.linux.do/*
// @match        https://nodeloc.com/*
// @match        https://www.nodeloc.com/*
// @match        https://meta.discourse.org/*
// @match        https://discuss.python.org/*
// @match        https://forum.vuejs.org/*
// @match        https://forum.arduino.cc/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/huangsijun17/linuxdo-read-plugin/main/linuxdo-read-only-browse.user.js
// @updateURL    https://raw.githubusercontent.com/huangsijun17/linuxdo-read-plugin/main/linuxdo-read-only-browse.user.js
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "linuxdo_read_only_browse_state";
  const VISITED_LIMIT = 1000;
  const DAILY_TOPIC_LIMIT = 2000;
  const LIST_REFRESH_AFTER_TOPICS = 10;
  // Domains the script may run on. Keep this list in sync with the @match whitelist above.
  // To support another Discourse-style forum, add an @match line and one entry here.
  const DOMAIN_WHITELIST = [
    "linux.do",
    "nodeloc.com",
    "meta.discourse.org",
    "discuss.python.org",
    "forum.vuejs.org",
    "forum.arduino.cc",
  ];
  const DEFAULTS = {
    enabled: false,
    minReadMs: 25000,
    maxReadMs: 65000,
    minPauseMs: 5000,
    maxPauseMs: 14000,
    scrollStepsMin: 3,
    scrollStepsMax: 8,
    normalDistribution: false,
    breakAfterTopics: 10,
    breakAfterTopicsMin: 10,
    breakAfterTopicsMax: 15,
    breakAfterTarget: 10,
    longBreakMs: 300000,
    longBreakMinMs: 300000,
    longBreakMaxMs: 480000,
    topicsReadInBatch: 0,
    topicsReadSinceListRefresh: 0,
    maxRunTopics: 0,
    maxRunTopicsMin: 0,
    maxRunTopicsMax: 0,
    maxRunMinutes: 0,
    maxRunMinutesMin: 0,
    maxRunMinutesMax: 0,
    runTopicLimit: 0,
    runMinutesLimit: 0,
    runStartedAt: 0,
    runCompletedTopics: 0,
    panelCollapsed: false,
    panelSide: "right",
    panelY: -1,
    mainPostLikeThreshold: 0,
    mainPostLikeThresholdMin: 0,
    mainPostLikeThresholdMax: 0,
    autoLikeMainPost: false,
    autoLiked: [],
    dailyReadDate: "",
    dailyReadCount: 0,
    dailyLikeDate: "",
    dailyLikeCount: 0,
    dailyTopicDate: "",
    dailyTopicCount: 0,
    dailyTopics: [],
    idleCycles: 0,
    visited: [],
  };

  const safeJson = (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  const loadState = () => {
    const stored = safeJson(GM_getValue(STORAGE_KEY, "{}"), {}) || {};
    const state = { ...DEFAULTS, ...stored };
    // Migrate pre-0.5.0 single-value break settings into ranges without touching stored keys.
    if (
      stored.breakAfterTopics !== undefined &&
      stored.breakAfterTopicsMin === undefined &&
      stored.breakAfterTopicsMax === undefined
    ) {
      state.breakAfterTopicsMin = stored.breakAfterTopics;
      state.breakAfterTopicsMax = stored.breakAfterTopics;
    }
    if (stored.longBreakMs !== undefined && stored.longBreakMinMs === undefined && stored.longBreakMaxMs === undefined) {
      state.longBreakMinMs = stored.longBreakMs;
      state.longBreakMaxMs = stored.longBreakMs;
    }
    if (stored.breakAfterTarget === undefined) {
      state.breakAfterTarget = state.breakAfterTopicsMin;
    }
    if (stored.maxRunTopics !== undefined && stored.maxRunTopicsMin === undefined && stored.maxRunTopicsMax === undefined) {
      state.maxRunTopicsMin = stored.maxRunTopics;
      state.maxRunTopicsMax = stored.maxRunTopics;
    }
    if (
      stored.maxRunMinutes !== undefined &&
      stored.maxRunMinutesMin === undefined &&
      stored.maxRunMinutesMax === undefined
    ) {
      state.maxRunMinutesMin = stored.maxRunMinutes;
      state.maxRunMinutesMax = stored.maxRunMinutes;
    }
    if (
      stored.mainPostLikeThreshold !== undefined &&
      stored.mainPostLikeThresholdMin === undefined &&
      stored.mainPostLikeThresholdMax === undefined
    ) {
      state.mainPostLikeThresholdMin = stored.mainPostLikeThreshold;
      state.mainPostLikeThresholdMax = stored.mainPostLikeThreshold;
    }
    if (stored.runTopicLimit === undefined) {
      state.runTopicLimit = state.maxRunTopicsMin;
    }
    if (stored.runMinutesLimit === undefined) {
      state.runMinutesLimit = state.maxRunMinutesMin;
    }
    return state;
  };

  const saveState = (patch) => {
    const next = { ...loadState(), ...patch };
    GM_setValue(STORAGE_KEY, JSON.stringify(next));
    return next;
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const randomInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const isTopicPage = () => /^\/t\//.test(location.pathname);
  const isListPage = () =>
    /^(\/|\/latest|\/new|\/unread|\/top|\/categories)(\?.*)?$/.test(location.pathname + location.search) ||
    /^\/c\//.test(location.pathname);
  const isHostAllowed = () => {
    const host = location.hostname.toLowerCase();
    return DOMAIN_WHITELIST.some((domain) => host === domain || host.endsWith(`.${domain}`));
  };

  function gaussianRandom() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Uniform by default; when 正态随机 is enabled, sample a truncated normal with the
  // mean at the range center and sigma = range / 6 (about 99.7% of samples stay in range).
  function sampleRange(min, max) {
    let low = min;
    let high = max;
    if (high < low) [low, high] = [high, low];
    if (!loadState().normalDistribution) return randomInt(low, high);

    const mean = (low + high) / 2;
    const sigma = (high - low) / 6;
    const value = mean + gaussianRandom() * sigma;
    return Math.min(high, Math.max(low, Math.round(value)));
  }

  const CHALLENGE_SELECTOR = [
    "#challenge-form",
    "#challenge-error-text",
    "#challenge-running",
    "#cf-challenge-running",
    "#cf-please-wait",
    ".cf-turnstile",
    "iframe[src*='challenges.cloudflare.com']",
    "script[src*='/cdn-cgi/challenge-platform/']",
  ].join(",");
  const CHALLENGE_TITLE_PATTERN =
    /just a moment|attention required|checking your browser|verify you are human|安全验证|请完成验证|请稍后重试/i;

  function detectChallenge() {
    if (document.querySelector(CHALLENGE_SELECTOR)) return true;
    return CHALLENGE_TITLE_PATTERN.test(document.title || "");
  }

  // Pauses all automation while a challenge page is up so the user can solve it manually.
  // Never clicks, reloads, or navigates on its own while waiting.
  async function waitForChallengeToClear() {
    if (!detectChallenge()) return true;
    while (loadState().enabled && detectChallenge()) {
      setStatus("检测到 CF 盾/人机验证，已暂停自动化，请手动完成验证");
      if (!(await sleepWithRunLimit(sampleRange(6000, 12000)))) return false;
    }
    return !detectChallenge();
  }

  function todayKey() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function secondsToMs(value, fallbackMs) {
    return clampNumber(value, 3, 3600, fallbackMs / 1000) * 1000;
  }

  function positiveInt(value, min, max, fallback) {
    return Math.round(clampNumber(value, min, max, fallback));
  }

  function formatElapsedMinutes(ms) {
    return Math.max(0, Math.floor(ms / 60000));
  }

  function parseCompactNumber(text) {
    const match = String(text || "")
      .replace(/,/g, "")
      .match(/(\d+(?:\.\d+)?)\s*([kKmM万]?)/);
    if (!match) return null;

    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;

    const unit = match[2].toLowerCase();
    if (unit === "k") return Math.round(number * 1000);
    if (unit === "m") return Math.round(number * 1000000);
    if (unit === "万") return Math.round(number * 10000);
    return Math.round(number);
  }

  function parseTopicTimelineProgress() {
    const timeline = document.querySelector(".timeline-container, .topic-navigation");
    if (!timeline) return null;

    const text = String(timeline.textContent || "").replace(/\s+/g, " ");
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;

    const current = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;

    return { current, total };
  }

  function normalizeTopicUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      const match = parsed.pathname.match(/^\/t\/[^/]+\/\d+/);
      if (!match) return null;
      parsed.pathname = match[0];
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return null;
    }
  }

  function getTopicLinks() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/t/"]'));
    const seen = new Set();

    return anchors
      .map((anchor) => ({
        anchor,
        title: (anchor.textContent || "").trim(),
        url: normalizeTopicUrl(anchor.href),
      }))
      .filter((item) => {
        if (!item.url || !item.title || item.title.length < 4) return false;
        if (/^\d+(\.\d+)?k?$|^\d+\s*(分钟|小时|天)$/.test(item.title)) return false;
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
  }

  function chooseNextTopic() {
    const state = loadState();
    const visited = new Set(state.visited || []);
    const currentTopic = normalizeTopicUrl(location.href);
    return getTopicLinks().find((topic) => topic.url !== currentTopic && !visited.has(topic.url));
  }

  function rememberVisited(url) {
    const state = loadState();
    const normalized = normalizeTopicUrl(url);
    if (!normalized) return;
    const visited = [normalized, ...(state.visited || []).filter((item) => item !== normalized)].slice(0, VISITED_LIMIT);
    saveState({ visited });
  }

  function getDailyReadCount() {
    const state = loadState();
    return state.dailyReadDate === todayKey() ? state.dailyReadCount || 0 : 0;
  }

  function incrementDailyReadCount() {
    const state = loadState();
    const today = todayKey();
    const dailyReadCount = state.dailyReadDate === today ? (state.dailyReadCount || 0) + 1 : 1;
    saveState({ dailyReadDate: today, dailyReadCount });
    return dailyReadCount;
  }

  function resetDailyReadCount() {
    saveState({ dailyReadDate: todayKey(), dailyReadCount: 0 });
  }

  function getDailyLikeCount() {
    const state = loadState();
    return state.dailyLikeDate === todayKey() ? state.dailyLikeCount || 0 : 0;
  }

  function incrementDailyLikeCount() {
    const state = loadState();
    const today = todayKey();
    const dailyLikeCount = state.dailyLikeDate === today ? (state.dailyLikeCount || 0) + 1 : 1;
    saveState({ dailyLikeDate: today, dailyLikeCount });
    return dailyLikeCount;
  }

  function resetDailyLikeCount() {
    saveState({ dailyLikeDate: todayKey(), dailyLikeCount: 0 });
  }

  function getDailyTopicCount() {
    const state = loadState();
    return state.dailyTopicDate === todayKey() ? state.dailyTopicCount || 0 : 0;
  }

  function rememberDailyTopic(url) {
    const normalized = normalizeTopicUrl(url);
    if (!normalized) return getDailyTopicCount();

    const state = loadState();
    const today = todayKey();
    const dailyTopics = state.dailyTopicDate === today ? state.dailyTopics || [] : [];

    if (dailyTopics.includes(normalized)) return state.dailyTopicDate === today ? state.dailyTopicCount || 0 : 0;

    const nextDailyTopics = [normalized, ...dailyTopics].slice(0, DAILY_TOPIC_LIMIT);
    const dailyTopicCount = state.dailyTopicDate === today ? (state.dailyTopicCount || 0) + 1 : 1;
    saveState({ dailyTopicDate: today, dailyTopicCount, dailyTopics: nextDailyTopics });
    return dailyTopicCount;
  }

  function resetDailyTopicCount() {
    saveState({ dailyTopicDate: todayKey(), dailyTopicCount: 0, dailyTopics: [] });
  }

  function buildPanel() {
    const existing = document.getElementById("linuxdo-read-only-helper");
    if (existing) return existing;

    const panel = document.createElement("div");
    panel.id = "linuxdo-read-only-helper";
    panel.innerHTML = `
      <div class="ldo-roh-header">
        <div class="ldo-roh-title">论坛只读浏览</div>
        <button type="button" class="ldo-roh-collapse" data-role="collapse"></button>
      </div>
      <div class="ldo-roh-content">
        <div class="ldo-roh-status" data-role="status">待机</div>
        <div class="ldo-roh-daily" data-role="daily-count">今日已读 0 篇 / 新话题 0 个 / 点赞 0 次</div>
        <div class="ldo-roh-like-hint" data-role="like-hint"></div>
        <label>阅读秒数
          <span>
            <input type="number" min="10" max="3600" step="5" data-role="min-read">
            -
            <input type="number" min="10" max="3600" step="5" data-role="max-read">
          </span>
        </label>
        <label>间隔秒数
          <span>
            <input type="number" min="3" max="600" step="1" data-role="min-pause">
            -
            <input type="number" min="3" max="600" step="1" data-role="max-pause">
          </span>
        </label>
        <label>滚动步数
          <span>
            <input type="number" min="1" max="30" step="1" data-role="min-steps">
            -
            <input type="number" min="0" max="30" step="1" data-role="max-steps">
          </span>
        </label>
        <label>读几篇休息
          <span>
            <input type="number" min="1" max="200" step="1" data-role="break-after-min">
            -
            <input type="number" min="1" max="200" step="1" data-role="break-after-max">
          </span>
        </label>
        <label>休息秒数
          <span>
            <input type="number" min="10" max="86400" step="10" data-role="min-long-break">
            -
            <input type="number" min="10" max="86400" step="10" data-role="max-long-break">
          </span>
        </label>
        <label title="本轮开始时在该范围内随机取样本轮篇数上限；填 0 表示不限制">
          最大帖子
          <span>
            <input type="number" min="0" max="10000" step="1" data-role="max-run-topics-min">
            -
            <input type="number" min="0" max="10000" step="1" data-role="max-run-topics-max">
          </span>
        </label>
        <label title="本轮开始时在该范围内随机取样运行分钟上限；填 0 表示不限制">
          最长分钟
          <span>
            <input type="number" min="0" max="10080" step="1" data-role="max-run-minutes-min">
            -
            <input type="number" min="0" max="10080" step="1" data-role="max-run-minutes-max">
          </span>
        </label>
        <label title="勾选后所有随机时长/步数按截断正态分布取值，中心为区间中点">
          正态随机
          <input type="checkbox" data-role="normal-dist">
        </label>
        <label title="每篇帖子在该范围内随机取样点赞阈值；填 0 表示关闭点赞提示与自动点赞">
          主帖赞阈值
          <span>
            <input type="number" min="0" max="1000000" step="1" data-role="like-threshold-min">
            -
            <input type="number" min="0" max="1000000" step="1" data-role="like-threshold-max">
          </span>
        </label>
        <label>自动点赞
          <input type="checkbox" data-role="auto-like">
        </label>
        <div class="ldo-roh-row">
          <button type="button" data-role="toggle"></button>
          <button type="button" data-role="reset">清记录</button>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #linuxdo-read-only-helper {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 230px;
        padding: 12px;
        border: 1px solid rgba(125, 125, 125, 0.25);
        border-radius: 12px;
        background: rgba(32, 34, 37, 0.94);
        color: #fff;
        font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
      }
      #linuxdo-read-only-helper .ldo-roh-title {
        font-weight: 700;
      }
      #linuxdo-read-only-helper .ldo-roh-header {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      #linuxdo-read-only-helper .ldo-roh-collapse {
        position: relative;
        flex: none;
        padding: 4px 8px;
        font-size: 12px;
        min-width: 44px;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed {
        width: 58px;
        height: 58px;
        padding: 0;
        border-radius: 50%;
        background: rgba(32, 34, 37, 0.96);
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-title,
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-content {
        display: none;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-header {
        width: 100%;
        height: 100%;
        margin-bottom: 0;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-collapse {
        width: 100%;
        height: 100%;
        padding: 0;
        border-radius: 50%;
        background: #f5f5f5;
        color: transparent;
        font-size: 0;
        cursor: grab;
        touch-action: none;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-collapse:active {
        cursor: grabbing;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-collapse::before {
        content: "";
        position: absolute;
        left: 50%;
        top: 50%;
        width: 34px;
        height: 34px;
        transform: translate(-50%, -50%);
        background: #2e3033;
        clip-path: polygon(50% 4%, 88% 25%, 88% 75%, 50% 96%, 12% 75%, 12% 25%);
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-collapse::after {
        content: "展开";
        position: absolute;
        left: 50%;
        bottom: -22px;
        transform: translateX(-50%);
        min-width: 42px;
        padding: 3px 6px;
        border-radius: 999px;
        background: rgba(32, 34, 37, 0.9);
        color: #fff;
        font-size: 12px;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed:hover .ldo-roh-collapse::after {
        opacity: 1;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-header::before,
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-header::after {
        content: "";
        position: absolute;
        z-index: 1;
        left: 50%;
        top: 50%;
        width: 18px;
        height: 4px;
        border-radius: 999px;
        background: #f5f5f5;
        transform-origin: center;
        pointer-events: none;
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-header::before {
        transform: translate(-50%, -50%) rotate(30deg) translateY(-5px);
      }
      #linuxdo-read-only-helper.ldo-roh-collapsed .ldo-roh-header::after {
        transform: translate(-50%, -50%) rotate(-30deg) translateY(-5px);
      }
      #linuxdo-read-only-helper .ldo-roh-status {
        min-height: 22px;
        opacity: 0.88;
        margin-bottom: 4px;
      }
      #linuxdo-read-only-helper .ldo-roh-daily {
        opacity: 0.88;
        margin-bottom: 10px;
      }
      #linuxdo-read-only-helper .ldo-roh-like-hint {
        display: none;
        margin-bottom: 10px;
        padding: 7px 8px;
        border-radius: 8px;
        background: rgba(255, 209, 102, 0.16);
        color: #ffe7a3;
      }
      #linuxdo-read-only-helper .ldo-roh-like-hint:not(:empty) {
        display: block;
      }
      #linuxdo-read-only-helper label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 7px 0;
        color: rgba(255, 255, 255, 0.9);
      }
      #linuxdo-read-only-helper input {
        width: 54px;
        box-sizing: border-box;
        border: 0;
        border-radius: 7px;
        padding: 5px 6px;
        color: #111;
        background: #fff;
      }
      #linuxdo-read-only-helper input[type="checkbox"] {
        width: auto;
        transform: scale(1.15);
      }
      #linuxdo-read-only-helper .ldo-roh-row {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      #linuxdo-read-only-helper button {
        flex: 1;
        border: 0;
        border-radius: 8px;
        padding: 7px 8px;
        cursor: pointer;
        color: #111;
        background: #f0f0f0;
      }
      #linuxdo-read-only-helper button[data-role="toggle"] {
        background: #9ee493;
      }
      .ldo-roh-like-highlight {
        outline: 3px solid #ffd166 !important;
        outline-offset: 3px !important;
        border-radius: 8px !important;
        box-shadow: 0 0 0 4px rgba(255, 209, 102, 0.22) !important;
      }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);
    return panel;
  }

  // Places the panel/logo at the persisted anchor: snapped to the left/right edge,
  // with panelY as the vertical position. panelY < 0 keeps the default corner spot.
  function applyPanelPosition() {
    const panel = buildPanel();
    const state = loadState();
    const y = Number(state.panelY);
    if (!Number.isFinite(y) || y < 0) {
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      return;
    }

    const collapsed = panel.classList.contains("ldo-roh-collapsed");
    const width = collapsed ? 58 : panel.offsetWidth || 230;
    const height = collapsed ? 58 : panel.offsetHeight || 320;
    const side = state.panelSide === "left" ? "left" : "right";
    const left = side === "right" ? Math.max(16, window.innerWidth - width - 16) : 16;
    const top = Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - height - 8));

    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function syncPanelVisibility() {
    const panel = buildPanel();
    const state = loadState();
    panel.classList.toggle("ldo-roh-collapsed", state.panelCollapsed);
    panel.querySelector('[data-role="collapse"]').textContent = state.panelCollapsed ? "展开" : "收起";
    applyPanelPosition();
  }

  function syncDailyReadCount() {
    const panel = buildPanel();
    const runSummary = formatRunSummary(loadState());
    panel.querySelector(
      '[data-role="daily-count"]'
    ).textContent = `今日已读 ${getDailyReadCount()} 篇 / 新话题 ${getDailyTopicCount()} 个 / 点赞 ${getDailyLikeCount()} 次${runSummary}`;
  }

  function setStatus(text) {
    const panel = buildPanel();
    const status = panel.querySelector('[data-role="status"]');
    const toggle = panel.querySelector('[data-role="toggle"]');
    const state = loadState();

    status.textContent = text;
    toggle.textContent = state.enabled ? "停止" : "开始";
    toggle.style.background = state.enabled ? "#ffb3b3" : "#9ee493";
    syncDailyReadCount();
  }

  function setLikeHint(text) {
    const hint = buildPanel().querySelector('[data-role="like-hint"]');
    hint.textContent = text;
  }

  function formatRunSummary(state) {
    const parts = [];
    if ((state.runTopicLimit || 0) > 0) {
      parts.push(`本轮 ${state.runCompletedTopics || 0}/${state.runTopicLimit} 篇`);
    }
    if ((state.runMinutesLimit || 0) > 0) {
      const elapsed = state.runStartedAt ? formatElapsedMinutes(Date.now() - state.runStartedAt) : 0;
      parts.push(`${elapsed}/${state.runMinutesLimit} 分`);
    }

    return parts.length ? ` / ${parts.join(" / ")}` : "";
  }

  function getRunLimitReason(state = loadState()) {
    if (!state.enabled) return "";
    const topicLimit = state.runTopicLimit || 0;
    if (topicLimit > 0 && (state.runCompletedTopics || 0) >= topicLimit) {
      return `已读满本轮 ${topicLimit} 篇，自动停止`;
    }
    const minutesLimit = state.runMinutesLimit || 0;
    if (minutesLimit > 0 && state.runStartedAt > 0) {
      const elapsedMs = Date.now() - state.runStartedAt;
      if (elapsedMs >= minutesLimit * 60000) {
        return `本轮运行 ${minutesLimit} 分钟，自动停止`;
      }
    }

    return "";
  }

  function stopIfRunLimitReached() {
    const reason = getRunLimitReason();
    if (!reason) return false;

    saveState({ enabled: false });
    setStatus(reason);
    return true;
  }

  async function sleepWithRunLimit(ms) {
    const endAt = Date.now() + Math.max(0, ms);
    while (Date.now() < endAt) {
      if (stopIfRunLimitReached() || !loadState().enabled) return false;
      await sleep(Math.min(1000, endAt - Date.now()));
    }

    return !(stopIfRunLimitReached() || !loadState().enabled);
  }

  function syncInputsFromState() {
    const panel = buildPanel();
    const state = loadState();
    panel.querySelector('[data-role="min-read"]').value = Math.round(state.minReadMs / 1000);
    panel.querySelector('[data-role="max-read"]').value = Math.round(state.maxReadMs / 1000);
    panel.querySelector('[data-role="min-pause"]').value = Math.round(state.minPauseMs / 1000);
    panel.querySelector('[data-role="max-pause"]').value = Math.round(state.maxPauseMs / 1000);
    panel.querySelector('[data-role="min-steps"]').value = state.scrollStepsMin;
    panel.querySelector('[data-role="max-steps"]').value = state.scrollStepsMax;
    panel.querySelector('[data-role="break-after-min"]').value = state.breakAfterTopicsMin;
    panel.querySelector('[data-role="break-after-max"]').value = state.breakAfterTopicsMax;
    panel.querySelector('[data-role="min-long-break"]').value = Math.round(state.longBreakMinMs / 1000);
    panel.querySelector('[data-role="max-long-break"]').value = Math.round(state.longBreakMaxMs / 1000);
    panel.querySelector('[data-role="normal-dist"]').checked = Boolean(state.normalDistribution);
    panel.querySelector('[data-role="max-run-topics-min"]').value = state.maxRunTopicsMin;
    panel.querySelector('[data-role="max-run-topics-max"]').value = state.maxRunTopicsMax;
    panel.querySelector('[data-role="max-run-minutes-min"]').value = state.maxRunMinutesMin;
    panel.querySelector('[data-role="max-run-minutes-max"]').value = state.maxRunMinutesMax;
    panel.querySelector('[data-role="like-threshold-min"]').value = state.mainPostLikeThresholdMin;
    panel.querySelector('[data-role="like-threshold-max"]').value = state.mainPostLikeThresholdMax;
    panel.querySelector('[data-role="auto-like"]').checked = state.autoLikeMainPost;
  }

  function saveInputsToState() {
    const panel = buildPanel();
    let minReadMs = secondsToMs(panel.querySelector('[data-role="min-read"]').value, DEFAULTS.minReadMs);
    let maxReadMs = secondsToMs(panel.querySelector('[data-role="max-read"]').value, DEFAULTS.maxReadMs);
    let minPauseMs = secondsToMs(panel.querySelector('[data-role="min-pause"]').value, DEFAULTS.minPauseMs);
    let maxPauseMs = secondsToMs(panel.querySelector('[data-role="max-pause"]').value, DEFAULTS.maxPauseMs);
    let scrollStepsMin = positiveInt(
      panel.querySelector('[data-role="min-steps"]').value,
      1,
      30,
      DEFAULTS.scrollStepsMin
    );
    let scrollStepsMax = positiveInt(
      panel.querySelector('[data-role="max-steps"]').value,
      0,
      30,
      DEFAULTS.scrollStepsMax
    );
    let breakAfterTopicsMin = positiveInt(
      panel.querySelector('[data-role="break-after-min"]').value,
      1,
      200,
      DEFAULTS.breakAfterTopicsMin
    );
    let breakAfterTopicsMax = positiveInt(
      panel.querySelector('[data-role="break-after-max"]').value,
      1,
      200,
      DEFAULTS.breakAfterTopicsMax
    );
    let longBreakMinMs =
      positiveInt(panel.querySelector('[data-role="min-long-break"]').value, 10, 86400, DEFAULTS.longBreakMinMs / 1000) *
      1000;
    let longBreakMaxMs =
      positiveInt(panel.querySelector('[data-role="max-long-break"]').value, 10, 86400, DEFAULTS.longBreakMaxMs / 1000) *
      1000;
    let maxRunTopicsMin = positiveInt(
      panel.querySelector('[data-role="max-run-topics-min"]').value,
      0,
      10000,
      DEFAULTS.maxRunTopicsMin
    );
    let maxRunTopicsMax = positiveInt(
      panel.querySelector('[data-role="max-run-topics-max"]').value,
      0,
      10000,
      DEFAULTS.maxRunTopicsMax
    );
    let maxRunMinutesMin = positiveInt(
      panel.querySelector('[data-role="max-run-minutes-min"]').value,
      0,
      10080,
      DEFAULTS.maxRunMinutesMin
    );
    let maxRunMinutesMax = positiveInt(
      panel.querySelector('[data-role="max-run-minutes-max"]').value,
      0,
      10080,
      DEFAULTS.maxRunMinutesMax
    );
    let mainPostLikeThresholdMin = positiveInt(
      panel.querySelector('[data-role="like-threshold-min"]').value,
      0,
      1000000,
      DEFAULTS.mainPostLikeThresholdMin
    );
    let mainPostLikeThresholdMax = positiveInt(
      panel.querySelector('[data-role="like-threshold-max"]').value,
      0,
      1000000,
      DEFAULTS.mainPostLikeThresholdMax
    );
    const normalDistribution = panel.querySelector('[data-role="normal-dist"]').checked;

    if (minReadMs > maxReadMs) [minReadMs, maxReadMs] = [maxReadMs, minReadMs];
    if (minPauseMs > maxPauseMs) [minPauseMs, maxPauseMs] = [maxPauseMs, minPauseMs];
    if (scrollStepsMax !== 0 && scrollStepsMin > scrollStepsMax) {
      [scrollStepsMin, scrollStepsMax] = [scrollStepsMax, scrollStepsMin];
    }
    if (breakAfterTopicsMin > breakAfterTopicsMax) {
      [breakAfterTopicsMin, breakAfterTopicsMax] = [breakAfterTopicsMax, breakAfterTopicsMin];
    }
    if (longBreakMinMs > longBreakMaxMs) {
      [longBreakMinMs, longBreakMaxMs] = [longBreakMaxMs, longBreakMinMs];
    }
    // A zero on either side means "unlimited / off": keep the pair all-zero instead of swapping.
    if (maxRunTopicsMin === 0 || maxRunTopicsMax === 0) {
      maxRunTopicsMin = 0;
      maxRunTopicsMax = 0;
    } else if (maxRunTopicsMin > maxRunTopicsMax) {
      [maxRunTopicsMin, maxRunTopicsMax] = [maxRunTopicsMax, maxRunTopicsMin];
    }
    if (maxRunMinutesMin === 0 || maxRunMinutesMax === 0) {
      maxRunMinutesMin = 0;
      maxRunMinutesMax = 0;
    } else if (maxRunMinutesMin > maxRunMinutesMax) {
      [maxRunMinutesMin, maxRunMinutesMax] = [maxRunMinutesMax, maxRunMinutesMin];
    }
    if (mainPostLikeThresholdMin === 0 || mainPostLikeThresholdMax === 0) {
      mainPostLikeThresholdMin = 0;
      mainPostLikeThresholdMax = 0;
    } else if (mainPostLikeThresholdMin > mainPostLikeThresholdMax) {
      [mainPostLikeThresholdMin, mainPostLikeThresholdMax] = [mainPostLikeThresholdMax, mainPostLikeThresholdMin];
    }
    const autoLikeMainPost = panel.querySelector('[data-role="auto-like"]').checked;

    saveState({
      minReadMs,
      maxReadMs,
      minPauseMs,
      maxPauseMs,
      scrollStepsMin,
      scrollStepsMax,
      breakAfterTopicsMin,
      breakAfterTopicsMax,
      longBreakMinMs,
      longBreakMaxMs,
      normalDistribution,
      maxRunTopicsMin,
      maxRunTopicsMax,
      maxRunMinutesMin,
      maxRunMinutesMax,
      mainPostLikeThresholdMin,
      mainPostLikeThresholdMax,
      autoLikeMainPost,
    });
    syncInputsFromState();
  }

  function getMainPostElement() {
    return (
      document.querySelector('[data-post-number="1"]') ||
      document.querySelector("#post_1") ||
      document.querySelector(".topic-post")
    );
  }

  function getMainPostLikeInfo() {
    const post = getMainPostElement();
    if (!post) return null;

    const counter = post.querySelector(
      ".post-controls .discourse-reactions-counter .reactions-counter, .post-controls .discourse-reactions-counter"
    );
    const topicMapLikes = post.querySelector(".topic-map__likes-trigger .number");
    const button = post.querySelector(
      [
        ".post-controls button.btn-toggle-reaction-like.reaction-button",
        '.post-controls button[title*="点赞"]',
        '.post-controls button[aria-label*="点赞"]',
        '.post-controls button[title*="like" i]',
        '.post-controls button[aria-label*="like" i]',
      ].join(",")
    );

    const counterText = counter
      ? [counter.textContent, counter.getAttribute("aria-label"), counter.getAttribute("title")].filter(Boolean).join(" ")
      : "";
    const topicMapLikesText = topicMapLikes ? topicMapLikes.textContent : "";
    const parsed = parseCompactNumber(counterText);
    const topicMapParsed = parseCompactNumber(topicMapLikesText);
    const count = parsed ?? topicMapParsed ?? 0;
    const buttonText = button
      ? [button.textContent, button.getAttribute("aria-label"), button.getAttribute("title"), button.className]
          .filter(Boolean)
          .join(" ")
      : "";
    const alreadyLiked = Boolean(button && (/取消|已赞|liked/i.test(buttonText) || button.querySelector('use[href="#heart"]')));

    return { count, target: button || counter || topicMapLikes || null, button, alreadyLiked };
  }

  async function waitForMainPostLikeInfo() {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const info = getMainPostLikeInfo();
      if (info && (info.button || info.target || info.count > 0)) return info;
      await sleep(500);
    }

    return getMainPostLikeInfo();
  }

  function clearLikeHighlight() {
    document.querySelectorAll(".ldo-roh-like-highlight").forEach((element) => {
      element.classList.remove("ldo-roh-like-highlight");
    });
  }

  function rememberAutoLiked(url) {
    const state = loadState();
    const normalized = normalizeTopicUrl(url);
    if (!normalized) return;
    const autoLiked = [normalized, ...(state.autoLiked || []).filter((item) => item !== normalized)].slice(0, 200);
    saveState({ autoLiked });
  }

  function wasAutoLiked(url) {
    const normalized = normalizeTopicUrl(url);
    return Boolean(normalized && (loadState().autoLiked || []).includes(normalized));
  }

  async function updateLikeAssist() {
    clearLikeHighlight();
    const state = loadState();
    // Sample a fresh threshold per topic so the like decision varies within the range.
    const threshold = sampleRange(state.mainPostLikeThresholdMin, state.mainPostLikeThresholdMax);
    if (!isTopicPage() || threshold <= 0) {
      setLikeHint("");
      return;
    }

    const info = await waitForMainPostLikeInfo();
    if (!info) {
      setLikeHint("未找到主帖点赞信息");
      return;
    }

    if (info.count >= threshold) {
      if (info.target) info.target.classList.add("ldo-roh-like-highlight");
      if (state.autoLikeMainPost && state.enabled) {
        if (info.alreadyLiked || wasAutoLiked(location.href)) {
          setLikeHint(`主帖 ${info.count} 赞，已点赞`);
          return;
        }

        if (info.button) {
          setLikeHint(`主帖 ${info.count} 赞，自动点赞中`);
          await sleep(sampleRange(700, 1800));
          const latest = loadState();
          if (
            !latest.enabled ||
            !latest.autoLikeMainPost ||
            !isTopicPage() ||
            !info.button.isConnected ||
            detectChallenge()
          ) {
            return;
          }
          info.button.click();
          rememberAutoLiked(location.href);
          incrementDailyLikeCount();
          syncDailyReadCount();
          setLikeHint(`主帖 ${info.count} 赞，已自动点赞`);
          return;
        }

        setLikeHint(`主帖 ${info.count} 赞，未找到可点击点赞按钮`);
        return;
      }

      setLikeHint(`主帖 ${info.count} 赞，达到阈值，可手动点赞`);
      return;
    }

    setLikeHint(`主帖 ${info.count} 赞，未达到阈值`);
  }

  function setupPanel() {
    const panel = buildPanel();
    const toggle = panel.querySelector('[data-role="toggle"]');
    const reset = panel.querySelector('[data-role="reset"]');
    const collapse = panel.querySelector('[data-role="collapse"]');
    const inputs = panel.querySelectorAll("input");

    syncInputsFromState();
    syncPanelVisibility();
    syncDailyReadCount();
    applyPanelPosition();
    window.addEventListener("resize", applyPanelPosition);

    let dragState = null;
    let suppressCollapseClick = false;

    const endLogoDrag = (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const dragged = dragState.moved;
      dragState = null;
      if (!dragged) return;

      suppressCollapseClick = true;
      const rect = buildPanel().getBoundingClientRect();
      saveState({
        panelSide: rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right",
        panelY: rect.top,
      });
      const panelNow = buildPanel();
      panelNow.style.transition = "left 0.15s ease, top 0.15s ease";
      applyPanelPosition();
      window.setTimeout(() => {
        buildPanel().style.transition = "";
      }, 220);
    };

    collapse.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || !buildPanel().classList.contains("ldo-roh-collapsed")) return;
      const rect = buildPanel().getBoundingClientRect();
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startLeft: rect.left,
        startTop: rect.top,
        moved: false,
      };
      try {
        collapse.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture unsupported: dragging still works while held */
      }
    });

    collapse.addEventListener("pointermove", (event) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const dx = event.clientX - dragState.startX;
      const dy = event.clientY - dragState.startY;
      if (!dragState.moved && Math.hypot(dx, dy) < 6) return;
      dragState.moved = true;
      const panelNow = buildPanel();
      const left = Math.min(Math.max(dragState.startLeft + dx, 0), Math.max(0, window.innerWidth - 58));
      const top = Math.min(Math.max(dragState.startTop + dy, 0), Math.max(0, window.innerHeight - 58));
      panelNow.style.right = "auto";
      panelNow.style.bottom = "auto";
      panelNow.style.transition = "none";
      panelNow.style.left = `${left}px`;
      panelNow.style.top = `${top}px`;
    });

    collapse.addEventListener("pointerup", endLogoDrag);
    collapse.addEventListener("pointercancel", endLogoDrag);

    collapse.addEventListener("click", () => {
      if (suppressCollapseClick) {
        suppressCollapseClick = false;
        return;
      }
      saveState({ panelCollapsed: !loadState().panelCollapsed });
      syncPanelVisibility();
    });

    toggle.addEventListener("click", () => {
      saveInputsToState();
      const enabled = !loadState().enabled;
      const nextState = loadState();
      saveState({
        enabled,
        idleCycles: 0,
        topicsReadInBatch: 0,
        topicsReadSinceListRefresh: 0,
        breakAfterTarget: sampleRange(nextState.breakAfterTopicsMin, nextState.breakAfterTopicsMax),
        runTopicLimit: enabled ? sampleRange(nextState.maxRunTopicsMin, nextState.maxRunTopicsMax) : nextState.runTopicLimit,
        runMinutesLimit: enabled
          ? sampleRange(nextState.maxRunMinutesMin, nextState.maxRunMinutesMax)
          : nextState.runMinutesLimit,
        runStartedAt: enabled ? Date.now() : 0,
        runCompletedTopics: enabled ? 0 : nextState.runCompletedTopics,
      });
      setStatus(enabled ? "已启动，前往最新贴" : "已停止");
      window.setTimeout(() => {
        if (enabled) {
          location.href = `${location.origin}/latest`;
          return;
        }

        location.reload();
      }, 600);
    });

    reset.addEventListener("click", () => {
      saveState({
        visited: [],
        autoLiked: [],
        idleCycles: 0,
        topicsReadInBatch: 0,
        topicsReadSinceListRefresh: 0,
        runStartedAt: 0,
        runCompletedTopics: 0,
      });
      resetDailyReadCount();
      resetDailyLikeCount();
      resetDailyTopicCount();
      syncDailyReadCount();
      setStatus("已清空浏览记录");
    });

    inputs.forEach((input) => {
      input.addEventListener("change", () => {
        saveInputsToState();
        if (stopIfRunLimitReached()) return;
        setStatus(loadState().enabled ? "设置已保存，继续运行" : "设置已保存");
        updateLikeAssist();
      });
    });

    setStatus(loadState().enabled ? "运行中" : "待机");
  }

  async function scrollTopicLikeReading() {
    const state = loadState();
    const totalReadMs = sampleRange(state.minReadMs, state.maxReadMs);
    const requireBottom = state.scrollStepsMax === 0;
    const steps = requireBottom ? state.scrollStepsMin : sampleRange(state.scrollStepsMin, state.scrollStepsMax);
    const stepDelay = Math.max(2500, Math.floor(totalReadMs / steps));

    for (let i = 0; i < steps; i += 1) {
      if (!loadState().enabled) return false;

      setStatus(`阅读帖子中 ${i + 1}/${steps}`);
      window.scrollBy({
        top: sampleRange(260, 760),
        left: 0,
        behavior: "smooth",
      });
      if (!(await sleepWithRunLimit(stepDelay + sampleRange(-900, 1400)))) return false;

      if (isTopicBottomVisible()) {
        setStatus(`已读到底 ${i + 1}/${steps}`);
        return true;
      }
    }

    if (!requireBottom) {
      setStatus(`完成基础滚动 ${steps}/${steps}`);
      return true;
    }

    let extraStep = 0;
    while (loadState().enabled) {
      if (!loadState().enabled) return false;
      if (isTopicBottomVisible()) {
        setStatus(formatTopicBottomStatus("已读到底"));
        return true;
      }

      extraStep += 1;
      setStatus(formatTopicBottomStatus(`继续下拉到底 ${extraStep}`));
      window.scrollBy({
        top: sampleRange(420, 980),
        left: 0,
        behavior: "smooth",
      });
      if (!(await sleepWithRunLimit(sampleRange(2200, 5200)))) return false;
    }

    return false;
  }

  async function scrollListLikeBrowsingMore() {
    const steps = sampleRange(2, 5);
    for (let i = 0; i < steps; i += 1) {
      if (!loadState().enabled) return;
      setStatus(`列表下拉找新话题 ${i + 1}/${steps}`);
      window.scrollBy({
        top: sampleRange(480, 1250),
        left: 0,
        behavior: "smooth",
      });
      if (!(await sleepWithRunLimit(sampleRange(1800, 5200)))) return;
    }
  }

  function clickTopicLink(anchor) {
    if (detectChallenge()) return;
    anchor.removeAttribute("target");
    anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
    anchor.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    anchor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function isElementVisibleInViewport(element, bottomPadding = 80) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.top < window.innerHeight - bottomPadding && rect.bottom > 0;
  }

  function formatTopicBottomStatus(prefix) {
    const progress = parseTopicTimelineProgress();
    if (!progress) return prefix;
    return `${prefix} ${progress.current}/${progress.total}`;
  }

  function isTopicBottomVisible() {
    if (!isTopicPage()) return false;
    const progress = parseTopicTimelineProgress();
    if (progress && progress.current >= progress.total) return true;

    const doc = document.documentElement;
    const remaining = doc.scrollHeight - (window.scrollY + window.innerHeight);
    if (window.scrollY > window.innerHeight && remaining <= 240) return true;

    return [
      "#topic-footer-buttons",
      ".topic-footer-buttons",
      ".topic-footer-main-buttons",
      ".topic-footer",
      ".topic-above-footer-buttons-outlet",
    ].some((selector) => Array.from(document.querySelectorAll(selector)).some((element) => isElementVisibleInViewport(element)));
  }

  async function runOnTopicPage() {
    if (stopIfRunLimitReached()) return;
    if (!(await waitForChallengeToClear())) return;
    rememberVisited(location.href);
    rememberDailyTopic(location.href);
    syncDailyReadCount();
    saveState({ idleCycles: 0 });
    const state = loadState();
    await updateLikeAssist();
    setStatus("停留阅读中");
    if (!(await sleepWithRunLimit(sampleRange(state.minPauseMs, state.maxPauseMs)))) return;
    const completed = await scrollTopicLikeReading();

    if (loadState().enabled) {
      if (completed) {
        const nextState = loadState();
        const topicsReadInBatch = (nextState.topicsReadInBatch || 0) + 1;
        const topicsReadSinceListRefresh = (nextState.topicsReadSinceListRefresh || 0) + 1;
        const runCompletedTopics = (nextState.runCompletedTopics || 0) + 1;
        incrementDailyReadCount();
        syncDailyReadCount();
        saveState({ topicsReadInBatch, topicsReadSinceListRefresh, runCompletedTopics });
        syncDailyReadCount();

        if (stopIfRunLimitReached()) return;

        if (topicsReadInBatch >= nextState.breakAfterTarget) {
          setStatus(`已读 ${topicsReadInBatch} 篇，休息中`);
          if (!(await sleepWithRunLimit(sampleRange(nextState.longBreakMinMs, nextState.longBreakMaxMs)))) return;
          if (!loadState().enabled) return;
          saveState({
            topicsReadInBatch: 0,
            breakAfterTarget: sampleRange(nextState.breakAfterTopicsMin, nextState.breakAfterTopicsMax),
          });
        }
      } else {
        setStatus("未完成阅读，跳过不计已读");
        await sleepWithRunLimit(sampleRange(state.minPauseMs, state.maxPauseMs));
      }

      setStatus("返回最新列表");
      if (history.length > 1) {
        const beforeUrl = location.href;
        history.back();
        window.setTimeout(() => {
          if (!loadState().enabled) return;
          if (stopIfRunLimitReached()) return;

          if (location.href !== beforeUrl && isListPage()) {
            if (loadState().topicsReadSinceListRefresh >= LIST_REFRESH_AFTER_TOPICS) {
              saveState({ topicsReadSinceListRefresh: 0 });
              setStatus("已读 10 篇，刷新最新列表");
              location.reload();
              return;
            }

            setStatus("已返回列表，继续找下一篇");
            runOnListPage().catch((error) => {
              console.error("[Forum Read-Only Browse Helper]", error);
              setStatus("脚本遇到错误，已停止");
              saveState({ enabled: false });
            });
            return;
          }

          if (location.href === beforeUrl || !isListPage()) {
            location.href = `${location.origin}/latest`;
          }
        }, 3500);
        return;
      }

      location.href = `${location.origin}/latest`;
    }
  }

  async function runOnListPage() {
    if (stopIfRunLimitReached()) return;
    if (!(await waitForChallengeToClear())) return;
    if (!(await sleepWithRunLimit(sampleRange(2000, 5000)))) return;
    if (stopIfRunLimitReached()) return;
    const topic = chooseNextTopic();

    if (!topic) {
      const state = loadState();
      const idleCycles = (state.idleCycles || 0) + 1;
      saveState({ idleCycles });
      setStatus("未找到未读帖子，向下找一找");
      window.scrollBy({ top: sampleRange(650, 1600), left: 0, behavior: "smooth" });
      if (!(await sleepWithRunLimit(sampleRange(9000, 22000)))) return;

      if (!loadState().enabled) return;
      if (idleCycles >= 3) {
        saveState({ idleCycles: 0 });
        setStatus("可见列表读完，继续加载更多话题");
        if (!(await sleepWithRunLimit(sampleRange(4000, 9000)))) return;
        await scrollListLikeBrowsingMore();
        if (!loadState().enabled || stopIfRunLimitReached()) return;
        location.href = `${location.origin}/latest`;
        return;
      }

      location.reload();
      return;
    }

    saveState({ idleCycles: 0 });
    setStatus(`准备打开：${topic.title.slice(0, 26)}`);
    if (!(await sleepWithRunLimit(sampleRange(loadState().minPauseMs, loadState().maxPauseMs)))) return;
    if (loadState().enabled && !stopIfRunLimitReached()) {
      if (detectChallenge()) {
        setStatus("检测到 CF 盾/人机验证，已暂停自动化，请手动完成验证");
        return;
      }
      rememberVisited(topic.url);
      const beforeUrl = location.href;
      setStatus(`点击进入：${topic.title.slice(0, 26)}`);
      clickTopicLink(topic.anchor);
      if (!(await sleepWithRunLimit(3200))) return;
      if (!loadState().enabled) return;

      if (location.href !== beforeUrl) {
        setStatus("已进入话题，重新载入阅读流程");
        location.reload();
        return;
      }

      if (location.href === beforeUrl) {
        setStatus("点击未跳转，兜底打开话题");
        location.assign(topic.url);
      }
    }
  }

  async function main() {
    if (!isHostAllowed()) return;
    setupPanel();
    const state = loadState();
    if (state.enabled && detectChallenge()) {
      if (!(await waitForChallengeToClear())) return;
      setStatus("人机验证已通过，刷新继续");
      location.reload();
      return;
    }
    await updateLikeAssist();
    if (!state.enabled) return;
    if (!state.runStartedAt) saveState({ runStartedAt: Date.now(), runCompletedTopics: state.runCompletedTopics || 0 });
    if (stopIfRunLimitReached()) return;

    if (isTopicPage()) {
      await runOnTopicPage();
      return;
    }

    if (!isListPage()) {
      setStatus("前往最新列表");
      if (!(await sleepWithRunLimit(sampleRange(2000, 5000)))) return;
      if (loadState().enabled) location.href = `${location.origin}/latest`;
      return;
    }

    await runOnListPage();
  }

  main().catch((error) => {
    console.error("[Forum Read-Only Browse Helper]", error);
    setStatus("脚本遇到错误，已停止");
    saveState({ enabled: false });
  });
})();
