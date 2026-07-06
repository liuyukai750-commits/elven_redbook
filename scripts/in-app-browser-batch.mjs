import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT_DIR = "D:/Redbook_workflow/output";
const DEFAULT_PROGRESS_PATH = "D:/Redbook_workflow/output/batch-progress.json";
const DEFAULT_COMMENTS_PATH = "D:/Redbook_workflow/output/batch-comments.json";
const DEFAULT_BUSINESS_KEYWORDS = [
  "律师",
  "法律",
  "律所",
  "协议离婚",
  "起诉离婚",
  "诉讼离婚",
  "离婚流程",
  "离婚新规",
  "财产分割",
  "抚养权",
  "离婚协议",
  "民政局",
  "线上起诉",
  "开庭"
];

export async function runXhsBatch(options = {}) {
  const {
    queuePath = "D:/Redbook_workflow/input/urls.csv",
    outputDir = DEFAULT_OUTPUT_DIR,
    progressPath = DEFAULT_PROGRESS_PATH,
    commentsPath = DEFAULT_COMMENTS_PATH,
    dailyLimit = 200,
    minDelayMs = 45_000,
    maxDelayMs = 90_000,
    blockRetries = 1,
    blockRetryDelayMs = 180_000,
    maxScrolls = 18,
    dryRun = false
  } = options;

  if (!globalThis.agent?.browsers) {
    throw new Error("需要在 Codex 内置浏览器环境中运行：先连接 in-app browser。");
  }

  await mkdir(outputDir, { recursive: true });
  const urls = await readUrlQueue(queuePath);
  const progress = await readProgress(progressPath);
  const comments = await readJsonArray(commentsPath);
  const browser = await globalThis.agent.browsers.get("iab");
  const tab = await getOrCreateTab(browser);
  const today = new Date().toISOString().slice(0, 10);
  const todaysCompleted = new Set(progress.days?.[today]?.completedUrls ?? []);

  let processedThisRun = 0;
  for (const url of urls) {
    const normalizedUrl = normalizeXhsUrl(url);
    if (!normalizedUrl) continue;
    if (progress.completedUrls?.includes(normalizedUrl)) continue;
    if (progress.skippedUrls?.includes(normalizedUrl)) continue;
    if (todaysCompleted.size >= dailyLimit || processedThisRun >= dailyLimit) break;

    const startedAt = new Date().toISOString();
    if (dryRun) {
      await markProgress(progressPath, progress, {
        status: "skipped",
        url: normalizedUrl,
        reason: "dry-run",
        startedAt
      });
      continue;
    }

    try {
      await tab.goto(normalizedUrl);
      await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 30_000 });
      const guard = await detectBlockWithRetry(tab, blockRetries, blockRetryDelayMs);
      if (guard.blocked) {
        await markProgress(progressPath, progress, {
          status: "failed",
          url: normalizedUrl,
          reason: guard.reason,
          startedAt
        });
        break;
      }

      await scrollComments(tab, maxScrolls);
      const rows = await extractVisibleComments(tab);
      comments.push(...rows);
      const dedupedComments = dedupeComments(comments);
      await writeFile(commentsPath, JSON.stringify(dedupedComments, null, 2), "utf8");

      await markProgress(progressPath, progress, {
        status: "completed",
        url: normalizedUrl,
        commentCount: rows.length,
        startedAt
      });
      todaysCompleted.add(normalizedUrl);
      processedThisRun += 1;
      await delay(randomInt(minDelayMs, maxDelayMs));
    } catch (error) {
      await markProgress(progressPath, progress, {
        status: "failed",
        url: normalizedUrl,
        reason: error.message,
        startedAt
      });
    }
  }

  return {
    queuePath,
    progressPath,
    commentsPath,
    totalUrls: urls.length,
    processedThisRun,
    totalComments: dedupeComments(comments).length
  };
}

export async function runXhsSearchBatch(options = {}) {
  const {
    keyword = "离婚",
    outputDir = DEFAULT_OUTPUT_DIR,
    progressPath = path.join(outputDir, "search-progress.json"),
    commentsPath = path.join(outputDir, "search-comments.json"),
    screeningPath = path.join(outputDir, "search-screening.json"),
    searchLimit = 10,
    dailyLimit = 10,
    minDelayMs = 45_000,
    maxDelayMs = 90_000,
    blockRetries = 1,
    blockRetryDelayMs = 180_000,
    maxSearchScrolls = 8,
    maxScrolls = 18,
    businessKeywords = DEFAULT_BUSINESS_KEYWORDS,
    dryRun = false
  } = options;

  if (!globalThis.agent?.browsers) {
    throw new Error("Need to run inside the Codex in-app browser runtime first.");
  }

  await mkdir(outputDir, { recursive: true });
  const progress = await readProgress(progressPath);
  const comments = await readJsonArray(commentsPath);
  const browser = await globalThis.agent.browsers.get("iab");
  const tab = await getOrCreateTab(browser);
  const today = new Date().toISOString().slice(0, 10);
  const todaysCompleted = new Set(progress.days?.[today]?.completedUrls ?? []);

  const candidates = await collectSearchCandidates(tab, {
    keyword,
    limit: searchLimit,
    maxSearchScrolls,
    businessKeywords
  });
  const selected = candidates.filter(candidate => candidate.isBusiness).slice(0, searchLimit);
  await writeFile(screeningPath, JSON.stringify({ keyword, candidates, selected }, null, 2), "utf8");

  let processedThisRun = 0;
  for (const candidate of selected) {
    const progressKey = `search:${keyword}:${candidate.noteId}`;
    if (progress.completedUrls?.includes(progressKey)) continue;
    if (progress.skippedUrls?.includes(progressKey)) continue;
    if (todaysCompleted.size >= dailyLimit || processedThisRun >= dailyLimit) break;

    const startedAt = new Date().toISOString();
    if (dryRun) {
      await markProgress(progressPath, progress, {
        status: "skipped",
        url: progressKey,
        reason: "dry-run",
        startedAt
      });
      continue;
    }

    try {
      const opened = await openSearchCandidate(tab, { keyword, candidate, maxSearchScrolls });
      if (!opened.opened) {
        await markProgress(progressPath, progress, {
          status: "failed",
          url: progressKey,
          reason: opened.reason,
          startedAt
        });
        continue;
      }

      const guard = await detectBlockWithRetry(tab, blockRetries, blockRetryDelayMs);
      if (guard.blocked) {
        await markProgress(progressPath, progress, {
          status: "failed",
          url: progressKey,
          reason: guard.reason,
          startedAt
        });
        break;
      }

      await scrollComments(tab, maxScrolls);
      const rows = await extractVisibleComments(tab);
      comments.push(...rows.map(row => ({ ...row, searchKeyword: keyword, coverText: candidate.text })));
      const dedupedComments = dedupeComments(comments);
      await writeFile(commentsPath, JSON.stringify(dedupedComments, null, 2), "utf8");

      await markProgress(progressPath, progress, {
        status: "completed",
        url: progressKey,
        noteUrl: opened.url,
        commentCount: rows.length,
        startedAt
      });
      todaysCompleted.add(progressKey);
      processedThisRun += 1;
      await delay(randomInt(minDelayMs, maxDelayMs));
    } catch (error) {
      await markProgress(progressPath, progress, {
        status: "failed",
        url: progressKey,
        reason: error.message,
        startedAt
      });
    }
  }

  return {
    keyword,
    screeningPath,
    progressPath,
    commentsPath,
    totalCandidates: candidates.length,
    selectedCandidates: selected.length,
    processedThisRun,
    totalComments: dedupeComments(comments).length
  };
}

export async function readUrlQueue(queuePath) {
  const raw = await readFile(queuePath, "utf8");
  return raw
    .split(/\r?\n/)
    .flatMap(line => line.split(","))
    .map(value => value.trim().replace(/^"|"$/g, ""))
    .filter(value => value && !value.startsWith("#"))
    .filter(value => value.includes("xiaohongshu.com/explore/"));
}

async function collectSearchCandidates(tab, options) {
  const { keyword, limit, maxSearchScrolls, businessKeywords } = options;
  await tab.goto(buildSearchUrl(keyword));
  await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 30_000 });
  await tab.playwright.waitForTimeout(1_500);

  let candidates = [];
  for (let step = 0; step < maxSearchScrolls && candidates.length < limit; step += 1) {
    candidates = await tab.playwright.evaluate((input) => {
      const rows = [...document.querySelectorAll(".note-item")]
        .map((item, index) => {
          const link = item.querySelector('a[href*="/explore/"]');
          const href = link ? new URL(link.getAttribute("href"), location.origin).href : "";
          const noteId = href.match(/\/explore\/([^/?#]+)/)?.[1] ?? "";
          const text = (item.innerText ?? "").replace(/\s+/g, " ").trim();
          const score = input.businessKeywords.reduce((sum, word) => sum + (text.includes(word) ? 1 : 0), 0);
          return {
            index,
            noteId,
            href,
            text,
            score,
            isBusiness: Boolean(noteId && score > 0)
          };
        })
        .filter(row => row.noteId && row.text);
      const seen = new Set();
      return rows.filter(row => {
        if (seen.has(row.noteId)) return false;
        seen.add(row.noteId);
        return true;
      }).slice(0, input.limit);
    }, { limit, businessKeywords }, { timeoutMs: 10_000 });

    if (candidates.length >= limit) break;
    await tab.playwright.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)), undefined, { timeoutMs: 3_000 });
    await tab.playwright.waitForTimeout(800);
  }

  return candidates;
}

async function openSearchCandidate(tab, options) {
  const { keyword, candidate, maxSearchScrolls } = options;
  await tab.goto(buildSearchUrl(keyword));
  await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 30_000 });
  await tab.playwright.waitForTimeout(1_500);

  let card = { found: false };
  for (let step = 0; step < maxSearchScrolls; step += 1) {
    card = await findSearchCard(tab, candidate.noteId);
    if (card.found) break;
    await tab.playwright.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)), undefined, { timeoutMs: 3_000 });
    await tab.playwright.waitForTimeout(800);
  }

  if (!card.found) {
    return { opened: false, reason: "search-card-not-found" };
  }

  await tab.playwright.evaluate(top => window.scrollTo(0, Math.max(0, top - 120)), card.absoluteTop, { timeoutMs: 3_000 });
  await tab.playwright.waitForTimeout(500);
  const center = await tab.playwright.evaluate((noteId) => {
    const card = getSearchCard(noteId);
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + Math.min(160, rect.height / 2))
    };

    function getSearchCard(noteId) {
      const href = `/explore/${noteId}`;
      const link =
        document.querySelector(`a[href="${href}"]`) ||
        document.querySelector(`a[href="https://www.xiaohongshu.com${href}"]`);
      return link?.closest(".note-item") || link;
    }
  }, candidate.noteId, { timeoutMs: 10_000 });

  if (!center) {
    return { opened: false, reason: "search-card-not-visible" };
  }

  await tab.cua.click(center);
  await tab.playwright.waitForTimeout(3_500);
  return { opened: true, url: await tab.url(), title: await tab.title() };
}

async function findSearchCard(tab, noteId) {
  return tab.playwright.evaluate((noteId) => {
    const card = getSearchCard(noteId);
    if (!card) {
      return {
        found: false,
        scrollY: window.scrollY,
        itemCount: document.querySelectorAll(".note-item").length
      };
    }
    const rect = card.getBoundingClientRect();
    return {
      found: true,
      absoluteTop: rect.top + window.scrollY,
      text: (card.innerText ?? "").replace(/\s+/g, " ").trim()
    };

    function getSearchCard(noteId) {
      const href = `/explore/${noteId}`;
      const link =
        document.querySelector(`a[href="${href}"]`) ||
        document.querySelector(`a[href="https://www.xiaohongshu.com${href}"]`);
      return link?.closest(".note-item") || link;
    }
  }, noteId, { timeoutMs: 10_000 });
}

function buildSearchUrl(keyword) {
  const url = new URL("https://www.xiaohongshu.com/search_result");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("source", "web_explore_feed");
  return url.href;
}

export function normalizeXhsUrl(value) {
  try {
    const url = new URL(value);
    if (!url.hostname.includes("xiaohongshu.com")) return "";
    if (!url.pathname.includes("/explore/")) return "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

async function getOrCreateTab(browser) {
  const tabs = await browser.tabs.list();
  const existing = tabs.find(tab => (tab.url ?? "").includes("xiaohongshu.com"));
  return existing ? browser.tabs.get(existing.id) : browser.tabs.new();
}

async function detectBlock(tab) {
  const state = await tab.playwright.evaluate(() => {
    const text = document.body?.innerText?.replace(/\s+/g, " ").slice(0, 1500) ?? "";
    return {
      url: location.href,
      title: document.title,
      text,
      commentCount: document.querySelectorAll(".comment-item").length
    };
  }, undefined, { timeoutMs: 10_000 });

  if (state.url.includes("/login") || /登录|扫码|验证码|获取验证码/.test(state.text)) {
    return { blocked: true, reason: "需要登录或重新扫码" };
  }
  if (/验证码|安全验证|访问频繁|操作频繁|稍后再试/.test(state.text)) {
    return { blocked: true, reason: "触发验证码或风控" };
  }
  return { blocked: false, reason: "" };
}

async function detectBlockWithRetry(tab, blockRetries, blockRetryDelayMs) {
  let guard = await detectBlock(tab);
  for (let attempt = 0; guard.blocked && attempt < blockRetries; attempt += 1) {
    if (guard.reason.includes("登录")) break;
    await delay(blockRetryDelayMs);
    await tab.reload();
    await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 30_000 });
    guard = await detectBlock(tab);
  }
  return guard;
}

async function scrollComments(tab, maxScrolls) {
  let lastCount = 0;
  let stableRounds = 0;
  for (let i = 0; i < maxScrolls; i += 1) {
    await tab.playwright.evaluate(() => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)), undefined, { timeoutMs: 3_000 });
    await tab.playwright.waitForTimeout(700);
    const count = await tab.playwright.evaluate(() => document.querySelectorAll(".comment-item").length, undefined, { timeoutMs: 3_000 });
    stableRounds = count === lastCount ? stableRounds + 1 : 0;
    lastCount = count;
    if (stableRounds >= 4) break;
  }
}

async function extractVisibleComments(tab) {
  return tab.playwright.evaluate(() => {
    const noteUrl = location.href;
    const noteTitle = document.title;
    const noteAuthorLink =
      document.querySelector('.author-wrapper a[href*="/user/profile/"]') ||
      document.querySelector('.author-container a[href*="/user/profile/"]') ||
      document.querySelector('.author a[href*="/user/profile/"]');
    const noteAuthorProfileUrl = noteAuthorLink ? new URL(noteAuthorLink.getAttribute("href"), location.origin).href : "";
    const noteAuthorId = noteAuthorLink?.getAttribute("data-user-id") || extractUserId(noteAuthorProfileUrl);
    const noteAuthorName = (noteAuthorLink?.innerText ?? "").replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll(".comment-item:not(.comment-item-sub)")]
      .map((item, index) => {
        const nameLink = item.querySelector('a.name[href*="/user/profile/"]');
        const avatarLink = item.querySelector('a[href*="/user/profile/"]');
        const link = nameLink || avatarLink;
        const accountName = (item.querySelector(".name")?.innerText ?? "").replace(/\s+/g, " ").trim();
        const comment = (item.querySelector(".content")?.innerText ?? "").replace(/\s+/g, " ").trim();
        const profileUrl = link ? new URL(link.getAttribute("href"), location.origin).href : "";
        const commenterId = link?.getAttribute("data-user-id") || extractUserId(profileUrl);
        return {
          noteUrl,
          noteTitle,
          noteAuthorId,
          noteAuthorName,
          noteAuthorProfileUrl,
          commentId: item.id || `visible-${index + 1}`,
          accountName,
          userId: commenterId,
          profileUrl,
          comment,
          isReply: false,
          isNoteAuthor: Boolean(noteAuthorId && commenterId && noteAuthorId === commenterId),
          createdAt: new Date().toISOString()
        };
      })
      .filter(row => row.accountName && row.comment && !row.isNoteAuthor);

    function extractUserId(value) {
      try {
        const url = new URL(value);
        return url.pathname.match(/\/user\/profile\/([^/?#]+)/)?.[1] ?? "";
      } catch {
        return "";
      }
    }
  }, undefined, { timeoutMs: 15_000 });
}

async function readProgress(progressPath) {
  try {
    const progress = JSON.parse(await readFile(progressPath, "utf8"));
    return {
      completedUrls: progress.completedUrls ?? [],
      failedUrls: progress.failedUrls ?? [],
      skippedUrls: progress.skippedUrls ?? [],
      days: progress.days ?? {},
      events: progress.events ?? []
    };
  } catch {
    return { completedUrls: [], failedUrls: [], skippedUrls: [], days: {}, events: [] };
  }
}

async function readJsonArray(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function markProgress(progressPath, progress, event) {
  const today = new Date().toISOString().slice(0, 10);
  progress.days[today] ??= { completedUrls: [] };
  if (event.status === "completed") {
    pushUnique(progress.completedUrls, event.url);
    pushUnique(progress.days[today].completedUrls, event.url);
  } else if (event.status === "failed") {
    pushUnique(progress.failedUrls, event.url);
  } else if (event.status === "skipped") {
    pushUnique(progress.skippedUrls, event.url);
  }
  progress.events.push({ ...event, finishedAt: new Date().toISOString() });
  await writeFile(progressPath, JSON.stringify(progress, null, 2), "utf8");
}

function dedupeComments(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = [row.accountName, normalizeXhsUrl(row.noteUrl) || row.noteUrl, row.comment].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pushUnique(array, value) {
  if (!array.includes(value)) array.push(value);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
