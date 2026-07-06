#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLeads, createXlsxBuffer, toCsv } from "./legal-leads.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 9222;
const DEFAULT_PROFILE = "D:/Redbook_workflow/chrome-profile";
const DEFAULT_OUTPUT = "D:/Redbook_workflow/red_output";
const DEFAULT_CONFIG = path.join(ROOT, "config", "legal-keywords.json");
const BUSINESS_KEYWORDS = [
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
  "开庭",
  "婚姻法",
  "婚姻家事"
];
const XLSX_HEADERS = ["account_identity", "surname_or_title", "phone", "dispute_type"];

async function launchChrome(args) {
  const port = Number(args.port ?? DEFAULT_PORT);
  const profile = String(args.profile ?? DEFAULT_PROFILE);
  const keyword = String(args.keyword ?? "离婚");
  const chromePath = String(args.chrome ?? "C:/Program Files/Google/Chrome/Application/chrome.exe");
  const url = buildSearchUrl(keyword);
  await mkdir(profile, { recursive: true });

  const child = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--new-window",
    url
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  child.unref();
  console.log(`Chrome 已启动：${url}`);
  console.log(`调试端口：http://127.0.0.1:${port}`);
  console.log(`用户数据目录：${profile}`);
  console.log("请在这个 Chrome 窗口里登录小红书，确认搜索页能正常显示后再运行 collect。");
}

async function collect(args) {
  const port = Number(args.port ?? DEFAULT_PORT);
  const keyword = String(args.keyword ?? "离婚");
  const limit = Number(args.limit ?? 10);
  const outputRoot = path.resolve(String(args.output ?? DEFAULT_OUTPUT));
  const config = JSON.parse(await readFile(String(args.config ?? DEFAULT_CONFIG), "utf8"));

  await mkdir(outputRoot, { recursive: true });
  for (let index = 0; index < limit; index += 1) {
    await mkdir(path.join(outputRoot, String(index)), { recursive: true });
  }

  const cdp = await CdpClient.connect(port);
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const screening = await collectCandidates(cdp, keyword, limit);
    await writeJson(path.join(outputRoot, "screening.json"), screening);

    const summary = [];
    for (let index = 0; index < limit; index += 1) {
      const folder = path.join(outputRoot, String(index));
      const candidate = screening.selected[index];
      if (!candidate) {
        const event = {
          index,
          status: "skipped",
          reason: "没有足够的业务相关搜索结果",
          finishedAt: new Date().toISOString()
        };
        summary.push(event);
        await writeJson(path.join(folder, "status.json"), event);
        continue;
      }

      try {
        const opened = await openCandidate(cdp, keyword, candidate);
        if (!opened.ok) {
          const event = {
            index,
            status: "failed",
            candidate,
            ...opened,
            finishedAt: new Date().toISOString()
          };
          summary.push(event);
          await writeJson(path.join(folder, "status.json"), event);
          continue;
        }

        const comments = await extractComments(cdp, index, keyword, candidate);
        await writeJson(path.join(folder, "comments.json"), comments);
        await writeLeadFiles(folder, comments, config);
        const event = {
          index,
          status: "completed",
          candidate,
          opened: opened.state,
          commentCount: comments.length,
          commentsPath: path.join(folder, "comments.json"),
          finishedAt: new Date().toISOString()
        };
        summary.push(event);
        await writeJson(path.join(folder, "status.json"), event);
        await delay(1500);
      } catch (error) {
        const event = {
          index,
          status: "failed",
          candidate,
          reason: error.message,
          finishedAt: new Date().toISOString()
        };
        summary.push(event);
        await writeJson(path.join(folder, "status.json"), event);
      }
    }

    await writeJson(path.join(outputRoot, "run-summary.json"), summary);
    console.log(JSON.stringify({
      outputRoot,
      selected: screening.selected.length,
      completed: summary.filter(item => item.status === "completed").length,
      failed: summary.filter(item => item.status === "failed").length,
      skipped: summary.filter(item => item.status === "skipped").length
    }, null, 2));
  } finally {
    cdp.close();
  }
}

async function collectCandidates(cdp, keyword, limit) {
  await navigate(cdp, buildSearchUrl(keyword));
  const guard = await pageState(cdp);
  if (isBlocked(guard) && guard.noteCount === 0) {
    return { keyword, guard, candidates: [], selected: [] };
  }

  const seen = new Set();
  const candidates = [];
  const selected = [];
  for (let step = 0; step < 24 && selected.length < limit; step += 1) {
    const rows = await evaluate(cdp, (businessKeywords) => {
      return [...document.querySelectorAll(".note-item")]
        .map((item, index) => {
          const link =
            item.querySelector('a[href*="/explore/"]') ||
            item.querySelector('a[href*="/search_result/"]');
          const links = [...item.querySelectorAll("a[href]")]
            .map(anchor => new URL(anchor.getAttribute("href"), location.origin).href);
          const href = link ? new URL(link.getAttribute("href"), location.origin).href : links[0] ?? "";
          const noteId =
            href.match(/\/explore\/([^/?#]+)/)?.[1] ??
            href.match(/\/search_result\/([^/?#]+)/)?.[1] ??
            "";
          const xsecHref = links.find(value => value.includes(noteId) && value.includes("xsec_token")) ?? "";
          const text = (item.innerText ?? "").replace(/\s+/g, " ").trim();
          const matched = businessKeywords.filter(word => text.includes(word));
          return {
            index,
            noteId,
            href,
            xsecHref,
            text,
            matched,
            score: matched.length,
            isBusiness: Boolean(noteId && matched.length > 0)
          };
        })
        .filter(row => row.noteId && row.text);
    }, BUSINESS_KEYWORDS);

    for (const row of rows) {
      if (seen.has(row.noteId)) continue;
      seen.add(row.noteId);
      candidates.push(row);
      if (row.isBusiness && selected.length < limit) selected.push(row);
    }
    if (selected.length >= limit) break;
    await evaluate(cdp, () => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
    await delay(900);
  }

  return { keyword, candidates, selected };
}

async function openCandidate(cdp, keyword, candidate) {
  if (candidate.xsecHref) {
    await navigate(cdp, candidate.xsecHref);
    const state = await pageState(cdp);
    if (!state.is404 && state.url.includes(candidate.noteId)) {
      return { ok: true, state };
    }
    return { ok: false, reason: "带 xsec_token 的候选链接打开失败", state, attemptedHref: candidate.xsecHref };
  }

  await navigate(cdp, buildSearchUrl(keyword));
  let cardCenter = null;
  for (let step = 0; step < 24; step += 1) {
    cardCenter = await evaluate(cdp, (noteId) => {
      const card = getSearchCard(noteId);
      if (!card) return null;
      card.scrollIntoView({ block: "center", inline: "center" });
      const rect = card.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(Math.min(rect.bottom - 30, Math.max(180, rect.top + rect.height / 2)));
      const visibleLink = document.elementFromPoint(x, y)?.closest?.("a");
      return {
        x,
        y,
        href: visibleLink?.href ?? ""
      };

      function getSearchCard(id) {
        const href = `/explore/${id}`;
        const link =
          document.querySelector(`a[href*="${id}"][href*="xsec_token"]`) ||
          document.querySelector(`a[href="${href}"]`) ||
          document.querySelector(`a[href="https://www.xiaohongshu.com${href}"]`);
        return link?.closest(".note-item") || link;
      }
    }, candidate.noteId);
    if (cardCenter) break;
    await evaluate(cdp, () => window.scrollBy(0, Math.floor(window.innerHeight * 0.9)));
    await delay(800);
  }
  if (!cardCenter) return { ok: false, reason: "搜索页没有找到该卡片" };

  if (cardCenter.href) {
    await navigate(cdp, cardCenter.href);
  } else {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cardCenter.x, y: cardCenter.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cardCenter.x, y: cardCenter.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cardCenter.x, y: cardCenter.y, button: "left", clickCount: 1 });
    await delay(3500);
  }
  const state = await pageState(cdp);
  if (state.is404 || !state.url.includes(candidate.noteId)) {
    return { ok: false, reason: "打开后不是目标帖子或被重定向", state };
  }
  return { ok: true, state };
}

async function extractComments(cdp, folderIndex, keyword, candidate) {
  let lastCount = -1;
  let stable = 0;
  for (let index = 0; index < 10; index += 1) {
    await evaluate(cdp, () => window.scrollBy(0, Math.floor(window.innerHeight * 0.75)));
    await delay(650);
    const count = await evaluate(cdp, () => document.querySelectorAll(".comment-item:not(.comment-item-sub)").length);
    stable = count === lastCount ? stable + 1 : 0;
    lastCount = count;
    if (stable >= 3) break;
  }

  return evaluate(cdp, ({ folderIndex, keyword, candidate }) => {
    const noteUrl = location.href;
    const noteTitle = document.title;
    const authorLink =
      document.querySelector('.author-wrapper a[href*="/user/profile/"]') ||
      document.querySelector('.author-container a[href*="/user/profile/"]') ||
      document.querySelector('.author a[href*="/user/profile/"]');
    const noteAuthorProfileUrl = authorLink ? new URL(authorLink.getAttribute("href"), location.origin).href : "";
    const noteAuthorId = authorLink?.getAttribute("data-user-id") || extractUserId(noteAuthorProfileUrl);
    const noteAuthorName = (authorLink?.innerText ?? "").replace(/\s+/g, " ").replace(/\s*关注.*/, "").trim();

    const rows = [...document.querySelectorAll(".comment-item:not(.comment-item-sub)")]
      .map((item, index) => {
        const link = item.querySelector('a.name[href*="/user/profile/"]') || item.querySelector('a[href*="/user/profile/"]');
        const accountName = (item.querySelector(".name")?.innerText ?? "").replace(/\s+/g, " ").trim();
        const comment = (item.querySelector(".content")?.innerText ?? "").replace(/\s+/g, " ").trim();
        const profileUrl = link ? new URL(link.getAttribute("href"), location.origin).href : "";
        const userId = link?.getAttribute("data-user-id") || extractUserId(profileUrl);
        return {
          folderIndex,
          keyword,
          coverText: candidate.text,
          matched: candidate.matched,
          noteId: candidate.noteId,
          noteUrl,
          noteTitle,
          noteAuthorId,
          noteAuthorName,
          noteAuthorProfileUrl,
          commentId: item.id || `${candidate.noteId}-visible-${index + 1}`,
          accountName,
          userId,
          profileUrl,
          comment,
          isReply: false,
          isNoteAuthor: Boolean((noteAuthorId && userId && noteAuthorId === userId) || (noteAuthorName && accountName && noteAuthorName === accountName)),
          createdAt: new Date().toISOString()
        };
      })
      .filter(row => row.accountName && row.comment && !row.isNoteAuthor);

    const seen = new Set();
    return rows.filter(row => {
      const key = [row.accountName, row.comment].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    function extractUserId(value) {
      try {
        return new URL(value).pathname.match(/\/user\/profile\/([^/?#]+)/)?.[1] ?? "";
      } catch {
        return "";
      }
    }
  }, { folderIndex, keyword, candidate });
}

async function writeLeadFiles(folder, comments, config) {
  const leads = buildLeads(comments, config);
  await writeJson(path.join(folder, "legal-leads.json"), leads);
  await writeFile(path.join(folder, "legal-leads.csv"), toCsv(leads), "utf8");
  const rows = leads.map(lead => XLSX_HEADERS.map(header => String(lead[header] ?? "")));
  await writeFile(path.join(folder, "legal-leads.xlsx"), createXlsxBuffer(XLSX_HEADERS, rows));
}

async function pageState(cdp) {
  return evaluate(cdp, () => {
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 1200);
    return {
      url: location.href,
      title: document.title,
      text,
      noteCount: document.querySelectorAll(".note-item").length,
      commentCount: document.querySelectorAll(".comment-item").length,
      is404: location.href.includes("/404") || document.title.includes("不见了") || text.includes("暂时无法浏览")
    };
  });
}

function isBlocked(state) {
  return /登录|扫码|验证码|安全验证|访问频繁|暂时无法浏览|请稍后/.test(state.text) || state.is404;
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await delay(2500);
}

async function evaluate(cdp, fn, arg) {
  const expression = `(${fn})(${JSON.stringify(arg)})`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return result.result?.value;
}

function buildSearchUrl(keyword) {
  const url = new URL("https://www.xiaohongshu.com/search_result");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("source", "web_explore_feed");
  return url.href;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs(tokens) {
  const args = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = tokens[index + 1];
    args[key] = next && !next.startsWith("--") ? tokens[++index] : true;
  }
  return args;
}

function printHelp() {
  console.log(`
chrome-cdp-redbook

Commands:
  launch [--keyword 离婚] [--port 9222] [--profile D:/Redbook_workflow/chrome-profile]
    打开一个专用 Chrome 窗口。请在该窗口登录小红书。

  collect [--keyword 离婚] [--limit 10] [--output D:/Redbook_workflow/red_output] [--port 9222]
    连接已启动的调试 Chrome，搜索关键词，筛选业务相关帖子，并按 0..9 文件夹输出。
`);
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    });
  }

  static async connect(port) {
    const list = await fetchJson(`http://127.0.0.1:${port}/json/list`);
    const page =
      list.find(item => item.type === "page" && item.url?.includes("xiaohongshu.com")) ??
      list.find(item => item.type === "page") ??
      list[0];
    if (!page?.webSocketDebuggerUrl) {
      throw new Error(`没有找到可连接的 Chrome 调试页面，请先运行 launch 并保持窗口打开。`);
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  close() {
    this.socket.close();
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`无法连接 Chrome 调试端口：${url}`);
  }
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2] ?? "help";
  const args = parseArgs(process.argv.slice(3));
  if (command === "launch") {
    await launchChrome(args);
  } else if (command === "collect") {
    await collect(args);
  } else {
    printHelp();
  }
}
