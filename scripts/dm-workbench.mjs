#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markDmQueueSent } from "./dm-assistant.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "output");
const DEFAULT_PORT = 4177;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  const queuePath = path.resolve(args.queue ?? path.join(outputDir, "dm-queue.json"));
  const leadsPath = path.resolve(args.leads ?? path.join(outputDir, "legal-leads.json"));
  const port = Number(args.port ?? DEFAULT_PORT);
  const state = { queuePath, leadsPath };

  if (args.check) {
    const data = await readState(state);
    console.log(JSON.stringify(summary(data), null, 2));
    return;
  }

  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, state);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });

  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  console.log(`建联工作台已启动：http://127.0.0.1:${port}`);
  console.log(`队列文件：${queuePath}`);
  console.log(`线索文件：${leadsPath}`);
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function routeRequest(request, response, state) {
  const url = new URL(request.url, "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, workbenchHtml());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, await readState(state));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/mark-sent") {
    const body = await readRequestJson(request);
    const updated = await markSelectedSent(state, body.queueIds ?? []);
    sendJson(response, 200, updated);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/skip") {
    const body = await readRequestJson(request);
    const updated = await markSelectedSkipped(state, body.queueIds ?? []);
    sendJson(response, 200, updated);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

export async function readState(state) {
  const queue = await readJson(state.queuePath);
  const leads = await readJson(state.leadsPath);
  return {
    queuePath: state.queuePath,
    leadsPath: state.leadsPath,
    queue,
    leads,
    summary: summary({ queue, leads })
  };
}

export async function markSelectedSent(state, queueIds, sentAt = new Date().toISOString()) {
  const data = await readState(state);
  const ids = new Set(queueIds);
  if (ids.size === 0) throw new Error("Missing queueIds.");
  const selected = data.queue.filter(item => ids.has(item.queue_id));
  if (selected.length === 0) throw new Error("No matching queue items.");

  const updatedQueue = data.queue.map(item =>
    ids.has(item.queue_id) ? markDmQueueSent([item], sentAt)[0] : item
  );
  const updatedLeads = markLeadsFromQueue(data.leads, selected, sentAt);

  await writeJson(state.queuePath, updatedQueue);
  await writeJson(state.leadsPath, updatedLeads);

  return {
    queue: updatedQueue,
    leads: updatedLeads,
    summary: summary({ queue: updatedQueue, leads: updatedLeads }),
    marked: selected.length
  };
}

export async function markSelectedSkipped(state, queueIds) {
  const data = await readState(state);
  const ids = new Set(queueIds);
  if (ids.size === 0) throw new Error("Missing queueIds.");

  const updatedQueue = data.queue.map(item => {
    if (!ids.has(item.queue_id)) return item;
    return {
      ...item,
      status: "skipped_manual",
      trust_stage: "skipped_manual",
      remarks: appendRemark(item.remarks, "工作台手动跳过")
    };
  });

  await writeJson(state.queuePath, updatedQueue);
  return {
    queue: updatedQueue,
    leads: data.leads,
    summary: summary({ queue: updatedQueue, leads: data.leads }),
    skipped: updatedQueue.filter(item => ids.has(item.queue_id)).length
  };
}

function markLeadsFromQueue(leads, queueItems, sentAt) {
  const keys = new Set(queueItems.map(queueLeadKey).filter(Boolean));
  return leads.map(lead => {
    if (!keys.has(leadKey(lead))) return lead;
    return {
      ...lead,
      status: "first_touch_sent",
      trust_stage: "first_touch_sent",
      first_message_sent_at: sentAt,
      remarks: appendRemark(lead.remarks, "工作台标记首句已发送")
    };
  });
}

function queueLeadKey(item) {
  return String(item.lead_id || item.profile_url || item.account_id || item.account_identity || item.account_name || "").trim();
}

function leadKey(lead) {
  return String(lead.lead_id || lead.profile_url || lead.account_id || lead.account_identity || lead.account_name || "").trim();
}

function summary(data) {
  const queue = data.queue ?? [];
  const leads = data.leads ?? [];
  return {
    queueTotal: queue.length,
    ready: queue.filter(item => item.status === "ready_for_review").length,
    sent: queue.filter(item => item.status === "first_touch_sent").length,
    skipped: queue.filter(item => String(item.status ?? "").startsWith("skipped")).length,
    leadsTotal: leads.length,
    complete: leads.filter(item => item.status === "info_complete").length
  };
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function sendHtml(response, html) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(html);
}

function appendRemark(existing, value) {
  return existing ? `${existing}; ${value}` : value;
}

function workbenchHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>建联工作台</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17202a;
      --muted: #667085;
      --paper: #f7f7f4;
      --panel: #ffffff;
      --line: #d9ded8;
      --green: #1d6b57;
      --blue: #22577a;
      --amber: #a15c18;
      --red: #a23a3a;
      --shadow: 0 8px 24px rgba(23, 32, 42, .08);
      font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--paper); color: var(--ink); }
    .app { min-height: 100vh; display: grid; grid-template-rows: auto auto 1fr; }
    header { padding: 18px 24px 12px; border-bottom: 1px solid var(--line); background: #fbfbf8; }
    h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: 0; }
    .sub { margin-top: 6px; color: var(--muted); font-size: 13px; }
    .metrics { display: flex; gap: 10px; padding: 12px 24px; border-bottom: 1px solid var(--line); overflow-x: auto; }
    .metric { min-width: 104px; padding: 8px 10px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
    .metric b { display: block; font-size: 20px; }
    .metric span { color: var(--muted); font-size: 12px; }
    main { display: grid; grid-template-columns: minmax(360px, 42%) 1fr; min-height: 0; }
    .queue { border-right: 1px solid var(--line); min-height: 0; display: grid; grid-template-rows: auto 1fr; }
    .toolbar { padding: 12px; display: grid; grid-template-columns: 1fr auto auto; gap: 8px; background: #f0f3ee; border-bottom: 1px solid var(--line); }
    input, select { width: 100%; padding: 9px 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; color: var(--ink); font-size: 14px; }
    button { border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 9px 11px; font-size: 14px; cursor: pointer; }
    button.primary { background: var(--green); color: #fff; border-color: var(--green); }
    button.blue { background: var(--blue); color: #fff; border-color: var(--blue); }
    button.warn { background: #fff7ed; color: var(--amber); border-color: #e7c9a4; }
    button:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid rgba(34, 87, 122, .25); outline-offset: 1px; }
    .list { overflow: auto; padding: 10px; }
    .item { width: 100%; text-align: left; margin-bottom: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px; box-shadow: none; }
    .item.active { border-color: var(--blue); box-shadow: var(--shadow); }
    .item .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .name { font-weight: 700; overflow-wrap: anywhere; }
    .badge { flex: none; border-radius: 999px; padding: 3px 7px; font-size: 12px; background: #eef2f7; color: var(--muted); }
    .badge.ready { background: #e7f4ef; color: var(--green); }
    .badge.sent { background: #e7eef7; color: var(--blue); }
    .badge.skip { background: #fff1e6; color: var(--amber); }
    .comment { color: #344054; font-size: 13px; line-height: 1.5; max-height: 42px; overflow: hidden; }
    .detail { min-width: 0; padding: 18px 22px; overflow: auto; }
    .empty { color: var(--muted); padding: 24px; }
    .case-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); padding-bottom: 14px; }
    .case-title { font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
    .case-meta { margin-top: 8px; color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 8px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    .block { margin-top: 14px; padding: 14px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
    .block h2 { margin: 0 0 8px; font-size: 14px; color: var(--muted); font-weight: 700; }
    .text { white-space: pre-wrap; line-height: 1.65; font-size: 14px; overflow-wrap: anywhere; }
    .message { border-left: 4px solid var(--green); background: #f7fbf8; }
    .toast { position: fixed; right: 16px; bottom: 16px; padding: 10px 12px; background: #17202a; color: #fff; border-radius: 6px; opacity: 0; transform: translateY(8px); transition: .18s ease; pointer-events: none; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .hint { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.6; }
    .context-menu { position: fixed; z-index: 20; min-width: 210px; padding: 6px; background: #fff; border: 1px solid var(--line); border-radius: 6px; box-shadow: var(--shadow); display: none; }
    .context-menu.show { display: block; }
    .context-menu button { width: 100%; text-align: left; border: 0; background: transparent; padding: 9px 10px; }
    .context-menu button:hover { background: #f0f3ee; }
    @media (max-width: 840px) {
      main { grid-template-columns: 1fr; }
      .queue { border-right: 0; border-bottom: 1px solid var(--line); max-height: 48vh; }
      .toolbar { grid-template-columns: 1fr 1fr; }
      .toolbar input { grid-column: 1 / -1; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>建联工作台</h1>
      <div class="sub" id="paths">读取队列中...</div>
    </header>
    <section class="metrics" id="metrics"></section>
    <main>
      <section class="queue">
        <div class="toolbar">
          <input id="search" placeholder="搜索账号或评论">
          <select id="status">
            <option value="">全部状态</option>
            <option value="ready_for_review">待发送</option>
            <option value="first_touch_sent">已发送</option>
            <option value="skipped_manual">已跳过</option>
          </select>
          <button id="batchSent" class="blue">批量回写为已发送</button>
        </div>
        <div class="list" id="list"></div>
      </section>
      <section class="detail" id="detail"></section>
    </main>
  </div>
  <div class="toast" id="toast"></div>
  <div class="context-menu" id="contextMenu">
    <button data-action="copy-open">复制话术并打开主页</button>
    <button data-action="copy">复制话术</button>
    <button data-action="open">打开主页</button>
    <button data-action="sent">我已发送，回写状态</button>
    <button data-action="skip">跳过</button>
  </div>
  <script>
    let queue = [];
    let leads = [];
    let selectedId = "";
    let contextId = "";

    const els = {
      paths: document.getElementById("paths"),
      metrics: document.getElementById("metrics"),
      list: document.getElementById("list"),
      detail: document.getElementById("detail"),
      search: document.getElementById("search"),
      status: document.getElementById("status"),
      batchSent: document.getElementById("batchSent"),
      contextMenu: document.getElementById("contextMenu"),
      toast: document.getElementById("toast")
    };

    init();

    async function init() {
      await loadState();
      els.search.addEventListener("input", render);
      els.status.addEventListener("change", render);
      els.batchSent.addEventListener("click", batchMarkVisibleSent);
      document.addEventListener("click", hideContextMenu);
      document.addEventListener("keydown", handleShortcut);
      els.contextMenu.addEventListener("click", handleContextAction);
    }

    async function loadState() {
      const res = await fetch("/api/state");
      const data = await res.json();
      queue = data.queue || [];
      leads = data.leads || [];
      els.paths.textContent = "队列：" + data.queuePath + " ｜ 线索：" + data.leadsPath;
      if (!selectedId && queue.length) selectedId = queue[0].queue_id;
      render();
    }

    function filteredQueue() {
      const term = els.search.value.trim().toLowerCase();
      const status = els.status.value;
      return queue.filter(item => {
        const text = [item.account_name, item.account_identity, item.source_comment, item.first_message, item.dispute_type].join(" ").toLowerCase();
        return (!term || text.includes(term)) && (!status || item.status === status);
      });
    }

    function render() {
      renderMetrics();
      renderList();
      renderDetail();
    }

    function renderMetrics() {
      const stats = [
        ["总队列", queue.length],
        ["待发送", queue.filter(x => x.status === "ready_for_review").length],
        ["已发送", queue.filter(x => x.status === "first_touch_sent").length],
        ["已跳过", queue.filter(x => String(x.status || "").startsWith("skipped")).length],
        ["完整线索", leads.filter(x => x.status === "info_complete").length]
      ];
      els.metrics.innerHTML = stats.map(([label, value]) => '<div class="metric"><b>' + value + '</b><span>' + label + '</span></div>').join("");
    }

    function renderList() {
      const rows = filteredQueue();
      if (!rows.length) {
        els.list.innerHTML = '<div class="empty">没有匹配的队列。</div>';
        return;
      }
      els.list.innerHTML = rows.map(item => {
        const badgeClass = item.status === "first_touch_sent" ? "sent" : String(item.status || "").startsWith("skipped") ? "skip" : "ready";
        return '<button class="item ' + (item.queue_id === selectedId ? 'active' : '') + '" data-id="' + escapeHtml(item.queue_id) + '">' +
          '<div class="top"><span class="name">' + escapeHtml(item.account_name || item.account_identity || "未命名账号") + '</span><span class="badge ' + badgeClass + '">' + escapeHtml(item.status || "") + '</span></div>' +
          '<div class="comment">' + escapeHtml(item.source_comment || "") + '</div>' +
        '</button>';
      }).join("");
      for (const node of els.list.querySelectorAll(".item")) {
        node.addEventListener("click", () => {
          selectedId = node.dataset.id;
          render();
        });
        node.addEventListener("contextmenu", event => {
          event.preventDefault();
          selectedId = node.dataset.id;
          contextId = node.dataset.id;
          render();
          showContextMenu(event.clientX, event.clientY);
        });
      }
    }

    function renderDetail() {
      const item = queue.find(row => row.queue_id === selectedId);
      if (!item) {
        els.detail.innerHTML = '<div class="empty">选择一条队列开始处理。</div>';
        return;
      }
      els.detail.innerHTML =
        '<div class="case-head">' +
          '<div><div class="case-title">' + escapeHtml(item.account_name || item.account_identity || "未命名账号") + '</div>' +
          '<div class="case-meta"><span>' + escapeHtml(item.queue_id) + '</span><span>' + escapeHtml(item.dispute_type || "未识别纠纷") + '</span><span>' + escapeHtml(item.status || "") + '</span></div></div>' +
        '</div>' +
        '<div class="hint">发送动作需在小红书页面完成；工作台只负责复制话术、打开账号页、回写本地状态。快捷键：C 复制，O 打开主页，S 回写已发送，J/K 切换。</div>' +
        '<div class="actions">' +
          '<button class="primary" id="copyOpen">复制话术并打开主页去私信</button>' +
          '<button id="copyMsg">复制话术</button>' +
          '<button id="openProfile">打开主页</button>' +
          '<button class="blue" id="markSent">我已发送，回写状态</button>' +
          '<button class="warn" id="skipOne">跳过</button>' +
        '</div>' +
        '<div class="block message"><h2>首句话术</h2><div class="text">' + escapeHtml(item.first_message || "") + '</div></div>' +
        '<div class="block"><h2>来源评论</h2><div class="text">' + escapeHtml(item.source_comment || "") + '</div></div>' +
        '<div class="block"><h2>主页链接</h2><div class="text">' + escapeHtml(item.profile_url || "无") + '</div></div>';
      document.getElementById("copyOpen").addEventListener("click", () => copyAndOpen(item));
      document.getElementById("copyMsg").addEventListener("click", () => copyText(item.first_message || ""));
      document.getElementById("openProfile").addEventListener("click", () => openProfile(item.profile_url));
      document.getElementById("markSent").addEventListener("click", () => markSent([item.queue_id]));
      document.getElementById("skipOne").addEventListener("click", () => skipItems([item.queue_id]));
    }

    async function copyText(text) {
      await navigator.clipboard.writeText(text);
      toast("已复制话术");
    }

    async function copyAndOpen(item) {
      const copied = navigator.clipboard.writeText(item.first_message || "");
      openProfile(item.profile_url);
      await copied;
      toast("已复制话术，并打开主页");
    }

    function openProfile(url) {
      if (!url) {
        toast("没有主页链接");
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    }

    async function markSent(ids) {
      const res = await fetch("/api/mark-sent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queueIds: ids })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "标记失败");
      queue = data.queue || queue;
      leads = data.leads || leads;
      toast("已标记 " + data.marked + " 条为已发送");
      selectNextReady(ids[0]);
      render();
    }

    async function skipItems(ids) {
      const res = await fetch("/api/skip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queueIds: ids })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "跳过失败");
      queue = data.queue || queue;
      toast("已跳过 " + data.skipped + " 条");
      selectNextReady(ids[0]);
      render();
    }

    async function batchMarkVisibleSent() {
      const ids = filteredQueue().filter(item => item.status === "ready_for_review").map(item => item.queue_id);
      if (!ids.length) {
        toast("当前筛选下没有待发送队列");
        return;
      }
      if (!confirm("确认把当前筛选下的 " + ids.length + " 条回写为已发送？这只更新本地状态，不会发送私信。")) return;
      await markSent(ids);
    }

    function selectNextReady(currentId) {
      const rows = filteredQueue();
      const currentIndex = rows.findIndex(item => item.queue_id === currentId);
      const candidates = [...rows.slice(currentIndex + 1), ...rows.slice(0, Math.max(currentIndex, 0))];
      const next = candidates.find(item => item.status === "ready_for_review") ||
        queue.find(item => item.status === "ready_for_review");
      if (next) selectedId = next.queue_id;
    }

    function selectedItem() {
      return queue.find(item => item.queue_id === selectedId);
    }

    function contextItem() {
      return queue.find(item => item.queue_id === contextId) || selectedItem();
    }

    function showContextMenu(x, y) {
      const menu = els.contextMenu;
      menu.style.left = Math.min(x, window.innerWidth - 230) + "px";
      menu.style.top = Math.min(y, window.innerHeight - 190) + "px";
      menu.classList.add("show");
    }

    function hideContextMenu() {
      els.contextMenu.classList.remove("show");
    }

    async function handleContextAction(event) {
      const action = event.target?.dataset?.action;
      if (!action) return;
      event.stopPropagation();
      hideContextMenu();
      const item = contextItem();
      if (!item) return;
      if (action === "copy-open") await copyAndOpen(item);
      if (action === "copy") await copyText(item.first_message || "");
      if (action === "open") openProfile(item.profile_url);
      if (action === "sent") await markSent([item.queue_id]);
      if (action === "skip") await skipItems([item.queue_id]);
    }

    async function handleShortcut(event) {
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
      const item = selectedItem();
      if (event.key.toLowerCase() === "j") {
        moveSelection(1);
        event.preventDefault();
      }
      if (event.key.toLowerCase() === "k") {
        moveSelection(-1);
        event.preventDefault();
      }
      if (!item) return;
      if (event.key.toLowerCase() === "c") {
        await copyText(item.first_message || "");
        event.preventDefault();
      }
      if (event.key.toLowerCase() === "o") {
        openProfile(item.profile_url);
        event.preventDefault();
      }
      if (event.key.toLowerCase() === "s") {
        await markSent([item.queue_id]);
        event.preventDefault();
      }
    }

    function moveSelection(delta) {
      const rows = filteredQueue();
      if (!rows.length) return;
      const index = rows.findIndex(item => item.queue_id === selectedId);
      const nextIndex = index < 0 ? 0 : (index + delta + rows.length) % rows.length;
      selectedId = rows[nextIndex].queue_id;
      render();
    }

    function toast(message) {
      els.toast.textContent = message;
      els.toast.classList.add("show");
      setTimeout(() => els.toast.classList.remove("show"), 1500);
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
