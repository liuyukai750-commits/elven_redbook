#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DM_DISPLAY_HEADERS,
  DM_EXPORT_HEADERS,
  buildDmQueue,
  createDmOptions,
  extractAccountId,
  normalizeDmReplies,
  toDmCsv,
  toDmQueueCsv,
  toDmSummaryRows,
  updateLeadsFromDmReplies,
  validateDmOptions
} from "./dm-assistant.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_CONFIG = path.join(ROOT, "config", "legal-keywords.json");
const DEFAULT_DM_CONFIG = path.join(ROOT, "config", "dm-assistant.json");
const DEFAULT_OUTPUT_DIR = path.join(ROOT, "output");

const HEADERS = [
  "account_identity",
  "surname_or_title",
  "phone",
  "dispute_type"
];

const DISPLAY_HEADERS = {
  account_identity: "账号ID/账号名",
  surname_or_title: "姓氏/称呼",
  phone: "电话",
  dispute_type: "纠纷"
};

const XLSX_COLUMN_WIDTHS = [24, 16, 18, 24];

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  const args = parseArgs(argv.slice(1));

  if (command === "help" || args.help) {
    printHelp();
    return;
  }

  if (command === "sample") {
    const input = path.join(ROOT, "examples", "sample-comments.json");
    await runFromFile({ ...args, input });
    return;
  }

  if (command === "from-file") {
    await runFromFile(args);
    return;
  }

  if (command === "search") {
    await runSearch(args);
    return;
  }

  if (command === "comments") {
    await runComments(args);
    return;
  }

  if (command === "browser-snippet") {
    console.log(BROWSER_SNIPPET.trim());
    return;
  }

  if (command === "contact-queue") {
    await runContactQueue(args);
    return;
  }

  if (command === "from-replies") {
    await runFromReplies(args);
    return;
  }

  if (command === "dm-queue") {
    await runDmQueue(args);
    return;
  }

  if (command === "dm-replies") {
    await runDmReplies(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

async function runFromFile(args) {
  const input = args.input;
  if (!input) {
    throw new Error("Missing --input <comments.json>. Use `npm run sample` for a demo.");
  }

  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  const config = await loadConfig(args.config ?? DEFAULT_CONFIG);
  const raw = JSON.parse(await readFile(path.resolve(input), "utf8"));
  const comments = normalizeComments(raw);
  const leads = buildLeads(comments, config);

  await mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, "legal-leads.csv");
  const xlsxPath = path.join(outputDir, "legal-leads.xlsx");
  const jsonPath = path.join(outputDir, "legal-leads.json");

  const writtenCsvPath = await writeOutputFile(csvPath, toCsv(leads), "utf8");
  const writtenJsonPath = await writeOutputFile(jsonPath, JSON.stringify(leads, null, 2), "utf8");
  const writtenXlsxPath = await writeOutputFile(xlsxPath, createXlsxBuffer(HEADERS, leads.map(leadToRow), {
    sourceFile: path.basename(input),
    totalComments: comments.length,
    totalLeads: leads.length
  }));
  const groupedOutputs = await writeGroupedNoteOutputs(outputDir, comments, config);

  console.log(`Processed ${comments.length} comments.`);
  console.log(`Generated ${leads.length} qualified leads.`);
  console.log(`CSV: ${writtenCsvPath}`);
  console.log(`XLSX: ${writtenXlsxPath}`);
  console.log(`JSON: ${writtenJsonPath}`);
  if (groupedOutputs.length > 0) {
    console.log("Per-note folders:");
    for (const item of groupedOutputs) {
      console.log(`- ${item.folder}: ${item.leads} leads`);
    }
  }
}

async function runSearch(args) {
  const config = await loadConfig(args.config ?? DEFAULT_CONFIG);
  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });

  const limit = Number(args.limit ?? 5);
  const sort = args.sort ?? "popular";
  const rows = [];

  for (const keyword of config.searchKeywords.slice(0, limit)) {
    const parsed = await runRedbook(["search", keyword, "--sort", sort, "--json"], args);
    rows.push({ keyword, result: parsed });
  }

  const out = path.join(outputDir, "redbook-search-results.json");
  await writeFile(out, JSON.stringify(rows, null, 2), "utf8");
  console.log(`Search results saved: ${out}`);
}

async function runComments(args) {
  const noteUrl = normalizeNoteUrl(args.url ?? args["note-url"]);
  if (!noteUrl) {
    throw new Error("Missing --url <xiaohongshu note url>.");
  }

  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  const parsed = await runRedbook(["comments", noteUrl, "--all", "--json"], args);
  const out = path.join(outputDir, "redbook-comments.json");
  await writeFile(out, JSON.stringify(parsed, null, 2), "utf8");
  console.log(`Comments saved: ${out}`);
}

async function runContactQueue(args) {
  const input = path.resolve(args.input ?? path.join(DEFAULT_OUTPUT_DIR, "legal-leads.json"));
  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  const template = args.template ?? await readOptionalText(args["template-file"]) ?? "你好，看到你在评论里提到法律问题，如果还需要初步梳理，可以把大概情况发我。";
  const leads = JSON.parse(await readFile(input, "utf8"));
  const queue = buildContactQueue(leads, template);

  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "contact-queue.json");
  const csvPath = path.join(outputDir, "contact-queue.csv");
  await writeOutputFile(jsonPath, JSON.stringify(queue, null, 2), "utf8");
  await writeOutputFile(csvPath, toContactQueueCsv(queue), "utf8");

  console.log(`Generated ${queue.length} contact queue items.`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
}

async function runFromReplies(args) {
  const repliesPath = args.input;
  if (!repliesPath) {
    throw new Error("Missing --input <replies.json>.");
  }

  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  const leadsPath = path.resolve(args.leads ?? path.join(outputDir, "legal-leads.json"));
  const replies = normalizeReplies(JSON.parse(await readFile(path.resolve(repliesPath), "utf8")));
  const leads = JSON.parse(await readFile(leadsPath, "utf8"));
  const updated = updateLeadsFromReplies(leads, replies);

  await mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, "legal-leads.csv");
  const xlsxPath = path.join(outputDir, "legal-leads.xlsx");
  const jsonPath = path.join(outputDir, "legal-leads.json");

  const writtenCsvPath = await writeOutputFile(csvPath, toCsv(updated), "utf8");
  const writtenJsonPath = await writeOutputFile(jsonPath, JSON.stringify(updated, null, 2), "utf8");
  const writtenXlsxPath = await writeOutputFile(xlsxPath, createXlsxBuffer(HEADERS, updated.map(leadToRow)));

  console.log(`Processed ${replies.length} replies.`);
  console.log(`Updated ${updated.filter(lead => lead.phone || lead.surname_or_title).length} leads with contact fields.`);
  console.log(`CSV: ${writtenCsvPath}`);
  console.log(`XLSX: ${writtenXlsxPath}`);
  console.log(`JSON: ${writtenJsonPath}`);
}

async function runDmQueue(args) {
  const input = path.resolve(args.input ?? path.join(DEFAULT_OUTPUT_DIR, "legal-leads.json"));
  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  const options = await loadDmOptions(args);
  validateDmOptions(options);

  const leads = JSON.parse(await readFile(input, "utf8"));
  const queue = buildDmQueue(leads, options);

  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "dm-queue.json");
  const csvPath = path.join(outputDir, "dm-queue.csv");
  await writeOutputFile(jsonPath, JSON.stringify(queue, null, 2), "utf8");
  await writeOutputFile(csvPath, toDmQueueCsv(queue), "utf8");

  console.log(`Generated ${queue.length} DM queue items.`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
}

async function runDmReplies(args) {
  const repliesPath = args.input;
  if (!repliesPath) {
    throw new Error("Missing --input <dm-replies.json>.");
  }

  const outputDir = path.resolve(args["output-dir"] ?? DEFAULT_OUTPUT_DIR);
  const leadsPath = path.resolve(args.leads ?? path.join(outputDir, "legal-leads.json"));
  const options = await loadDmOptions(args);
  validateDmOptions(options);

  const replies = normalizeDmReplies(JSON.parse(await readFile(path.resolve(repliesPath), "utf8")));
  const leads = JSON.parse(await readFile(leadsPath, "utf8"));
  const updated = updateLeadsFromDmReplies(leads, replies, options);
  const summaryRows = toDmSummaryRows(updated, { onlyComplete: args["include-partial"] !== true });

  await mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "legal-leads.json");
  const summaryJsonPath = path.join(outputDir, "dm-summary.json");
  const csvPath = path.join(outputDir, "dm-summary.csv");
  const xlsxPath = path.join(outputDir, "dm-summary.xlsx");

  const writtenJsonPath = await writeOutputFile(jsonPath, JSON.stringify(updated, null, 2), "utf8");
  const writtenSummaryJsonPath = await writeOutputFile(summaryJsonPath, JSON.stringify(summaryRows, null, 2), "utf8");
  const writtenCsvPath = await writeOutputFile(csvPath, toDmCsv(summaryRows), "utf8");
  const writtenXlsxPath = await writeOutputFile(
    xlsxPath,
    createXlsxBuffer(DM_EXPORT_HEADERS.map(header => DM_DISPLAY_HEADERS[header] ?? header), summaryRows.map(row =>
      DM_EXPORT_HEADERS.map(header => String(row[header] ?? ""))
    ))
  );

  console.log(`Processed ${replies.length} DM replies.`);
  console.log(`Updated ${updated.filter(lead => lead.reply_text).length} replied leads.`);
  console.log(`Summary rows: ${summaryRows.length}`);
  console.log(`CSV: ${writtenCsvPath}`);
  console.log(`XLSX: ${writtenXlsxPath}`);
  console.log(`Summary JSON: ${writtenSummaryJsonPath}`);
  console.log(`Full JSON: ${writtenJsonPath}`);
}

async function runRedbook(redbookArgs, args) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const fullArgs = ["--yes", "--package", "@lucasygu/redbook", "redbook", ...redbookArgs];
  const env = { ...process.env };

  if (args["cookie-string-env"]) {
    const value = process.env[args["cookie-string-env"]];
    if (!value) throw new Error(`Environment variable ${args["cookie-string-env"]} is empty.`);
    env.REDBOOK_COOKIE_STRING = value;
  }

  if (args["cookie-file"]) {
    env.REDBOOK_COOKIE_FILE = path.resolve(args["cookie-file"]);
  }

  const { stdout, stderr, code } = await spawnCapture(executable, fullArgs, env);
  if (code !== 0) {
    const safeError = redactSecrets(stderr || stdout);
    if (/captcha/i.test(safeError)) {
      throw new Error(`redbook captcha gate hit. Use \`npm run browser-snippet\` on the opened note page.\n${safeError}`);
    }
    throw new Error(safeError);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

function spawnCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/c", command, ...args], { env, cwd: ROOT, shell: false })
      : spawn(command, args, { env, cwd: ROOT, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => resolve({ stdout, stderr, code }));
  });
}

function normalizeNoteUrl(value) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.hostname.includes("xiaohongshu.com") && url.pathname.includes("/explore/")) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    return value;
  }
  return value;
}

async function writeOutputFile(targetPath, data, encoding) {
  try {
    await writeFile(targetPath, data, encoding);
    return targetPath;
  } catch (error) {
    if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
    const parsed = path.parse(targetPath);
    const stampedPath = path.join(parsed.dir, `${parsed.name}-${timestampForFile()}${parsed.ext}`);
    await writeFile(stampedPath, data, encoding);
    return stampedPath;
  }
}

function timestampForFile() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function loadConfig(configPath) {
  return JSON.parse(await readFile(path.resolve(configPath), "utf8"));
}

async function loadDmOptions(args) {
  const configPath = args["dm-config"] ?? DEFAULT_DM_CONFIG;
  const config = await readOptionalJson(configPath);
  const template = args.template ?? await readOptionalText(args["template-file"]);
  return createDmOptions({
    ...config,
    firmName: args["firm-name"] ?? config.firmName ?? config.firm_name,
    firmPhone: args["firm-phone"] ?? config.firmPhone ?? config.firm_phone,
    firstMessageTemplate: template || config.firstMessageTemplate || config.first_message_template,
    dailySendLimit: args["daily-send-limit"] ?? config.dailySendLimit ?? config.daily_send_limit,
    minScore: args["min-score"] ?? config.minScore ?? config.min_score
  });
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

export function normalizeComments(raw) {
  const source = Array.isArray(raw)
    ? raw
    : raw.comments ?? raw.data?.comments ?? raw.data?.items ?? raw.items ?? [];

  return source.map((item, index) => {
    const user = item.user ?? item.author ?? item.userInfo ?? {};
    const note = item.note ?? item.sourceNote ?? {};
    const comment = item.comment ?? item.content ?? item.text ?? item.desc ?? "";
    const accountName = item.accountName ?? item.nickname ?? user.nickname ?? user.name ?? item.authorName ?? "";
    const userId = item.userId ?? user.userId ?? user.id ?? user.user_id ?? "";
    const profileUrl = item.profileUrl ?? user.profileUrl ?? user.url ?? (userId ? `https://www.xiaohongshu.com/user/profile/${userId}` : "");
    const noteAuthorId = item.noteAuthorId ?? item.note_author_id ?? note.authorId ?? note.author_id ?? note.userId ?? note.user_id ?? "";
    const noteAuthorName = item.noteAuthorName ?? item.noteAuthor ?? note.authorName ?? note.author ?? "";
    const noteAuthorProfileUrl = item.noteAuthorProfileUrl ?? note.authorProfileUrl ?? note.authorUrl ?? "";

    return {
      commentId: String(item.commentId ?? item.id ?? item.comment_id ?? `row-${index + 1}`),
      accountName: String(accountName).trim(),
      userId: String(userId).trim(),
      profileUrl: String(profileUrl).trim(),
      comment: stripWhitespace(String(comment)),
      noteUrl: String(item.noteUrl ?? item.url ?? note.url ?? item.sourceUrl ?? ""),
      noteTitle: String(item.noteTitle ?? item.title ?? note.title ?? ""),
      noteAuthor: String(noteAuthorName),
      noteAuthorId: String(noteAuthorId).trim(),
      noteAuthorProfileUrl: String(noteAuthorProfileUrl).trim(),
      isReply: Boolean(item.isReply ?? item.is_reply ?? item.replyToCommentId ?? item.parentCommentId),
      isNoteAuthor: Boolean(item.isNoteAuthor ?? item.is_note_author ?? (noteAuthorId && userId && String(noteAuthorId) === String(userId))),
      createdAt: String(item.createdAt ?? item.time ?? item.createTime ?? "")
    };
  }).filter(item => item.comment);
}

async function writeGroupedNoteOutputs(outputDir, comments, config) {
  const groups = groupCommentsByNote(comments);
  const usedFolders = new Set();
  const outputs = [];

  for (const group of groups) {
    const folderName = uniqueFolderName(noteFolderName(group), usedFolders);
    const folder = path.join(outputDir, folderName);
    const leads = buildLeads(group.comments, config);
    await mkdir(folder, { recursive: true });
    await writeOutputFile(path.join(folder, "comments.json"), JSON.stringify(group.comments, null, 2), "utf8");
    await writeOutputFile(path.join(folder, "legal-leads.json"), JSON.stringify(leads, null, 2), "utf8");
    await writeOutputFile(path.join(folder, "legal-leads.csv"), toCsv(leads), "utf8");
    await writeOutputFile(path.join(folder, "legal-leads.xlsx"), createXlsxBuffer(HEADERS, leads.map(leadToRow), {
      sourceFile: group.noteTitle || group.noteUrl,
      totalComments: group.comments.length,
      totalLeads: leads.length
    }));
    outputs.push({ folder, comments: group.comments.length, leads: leads.length });
  }

  return outputs;
}

function groupCommentsByNote(comments) {
  const groups = new Map();
  for (const comment of comments) {
    const noteKey = normalizeNoteUrl(comment.noteUrl) || comment.noteUrl || "unknown-note";
    if (!groups.has(noteKey)) {
      groups.set(noteKey, {
        noteUrl: noteKey,
        noteTitle: comment.noteTitle,
        noteAuthorId: comment.noteAuthorId,
        noteAuthorProfileUrl: comment.noteAuthorProfileUrl,
        comments: []
      });
    }
    groups.get(noteKey).comments.push(comment);
  }
  return [...groups.values()];
}

function noteFolderName(group) {
  const authorId = group.noteAuthorId || extractXhsUserId(group.noteAuthorProfileUrl);
  const noteId = extractXhsNoteId(group.noteUrl);
  if (authorId) return sanitizePathSegment(authorId);
  if (noteId) return sanitizePathSegment(`note_${noteId}`);
  return "unknown_note";
}

function uniqueFolderName(baseName, usedFolders) {
  let candidate = baseName;
  let index = 2;
  while (usedFolders.has(candidate)) {
    candidate = `${baseName}_${index}`;
    index += 1;
  }
  usedFolders.add(candidate);
  return candidate;
}

function extractXhsNoteId(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/explore\/([^/?#]+)/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function extractXhsUserId(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/user\/profile\/([^/?#]+)/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function sanitizePathSegment(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "unknown";
}

export function buildLeads(comments, config) {
  const seen = new Set();
  const leads = [];

  for (const comment of comments) {
    if (comment.isReply || comment.isNoteAuthor) continue;
    const analysis = analyzeComment(comment.comment, config);
    if (!analysis.qualified) continue;

    const key = [
      comment.userId || comment.accountName,
      comment.noteUrl,
      comment.comment.slice(0, 80)
    ].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const extracted = analysis.hasConsent
      ? extractInboundInfo(comment.comment)
      : { phone: "", surnameOrTitle: "" };
    const lead = {
      lead_id: createLeadId(comment, leads.length + 1),
      account_id: comment.userId || extractAccountId(comment.profileUrl) || "",
      account_identity: comment.userId || extractAccountId(comment.profileUrl) || comment.accountName,
      account_name: comment.accountName,
      surname_or_title: extracted.surnameOrTitle,
      phone: extracted.phone,
      dispute_type: analysis.disputeTypes.join("; "),
      problem_summary: summarizeProblem(comment.comment),
      source_note_title: comment.noteTitle,
      source_note_url: comment.noteUrl,
      source_comment: comment.comment,
      profile_url: comment.profileUrl,
      score: analysis.score,
      matched_tags: analysis.tags.join("; "),
      consent_source: analysis.hasConsent ? "公开评论中明确表达可联系/咨询意愿" : "",
      status: analysis.hasConsent ? "consented" : "new",
      suggested_message: createSuggestedMessage(analysis.disputeTypes, comment.comment),
      remarks: analysis.hasConsent ? "可进入主动咨询/明确同意后的自动整理流程" : "仅生成待确认草稿，不自动私信陌生用户"
    };
    leads.push(lead);
  }

  return leads.sort((a, b) => Number(b.score) - Number(a.score));
}

export function buildContactQueue(leads, template) {
  const seen = new Set();
  return leads
    .filter(lead => lead.account_name && lead.source_comment)
    .filter(lead => {
      const key = lead.profile_url || lead.account_name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((lead, index) => ({
      queue_id: `contact_${String(index + 1).padStart(4, "0")}`,
      account_name: lead.account_name,
      profile_url: lead.profile_url ?? "",
      first_message: renderContactTemplate(template, lead),
      source_comment: lead.source_comment,
      status: "pending_manual_send",
      created_at: new Date().toISOString()
    }));
}

export function normalizeReplies(raw) {
  const source = Array.isArray(raw) ? raw : raw.replies ?? raw.messages ?? [];
  return source.map(item => ({
    accountName: String(item.accountName ?? item.account_name ?? item.name ?? "").trim(),
    profileUrl: String(item.profileUrl ?? item.profile_url ?? "").trim(),
    text: stripWhitespace(String(item.text ?? item.message ?? item.transcript ?? item.content ?? "")),
    createdAt: String(item.createdAt ?? item.created_at ?? new Date().toISOString())
  })).filter(item => item.accountName && item.text);
}

export function updateLeadsFromReplies(leads, replies) {
  return leads.map(lead => {
    const reply = replies.find(item =>
      item.accountName === lead.account_name ||
      (item.profileUrl && lead.profile_url && item.profileUrl === lead.profile_url)
    );
    if (!reply) return lead;

    const extracted = extractInboundInfo(reply.text);
    return {
      ...lead,
      surname_or_title: extracted.surnameOrTitle || lead.surname_or_title || "",
      phone: extracted.phone || lead.phone || "",
      remarks: appendRemark(lead.remarks, `私聊回复已处理：${reply.createdAt}`)
    };
  });
}

function renderContactTemplate(template, lead) {
  return template
    .replaceAll("{{账号名}}", lead.account_name ?? "")
    .replaceAll("{{评论内容}}", lead.source_comment ?? "")
    .replaceAll("{{纠纷类型}}", lead.dispute_type ?? "");
}

function appendRemark(existing, value) {
  return existing ? `${existing}; ${value}` : value;
}

async function readOptionalText(filePath) {
  if (!filePath) return "";
  return readFile(path.resolve(filePath), "utf8");
}

function toContactQueueCsv(queue) {
  const headers = ["队列ID", "账号名", "用户主页", "首条消息", "评论内容", "状态", "创建时间"];
  const rows = queue.map(item => [
    item.queue_id,
    item.account_name,
    item.profile_url,
    item.first_message,
    item.source_comment,
    item.status,
    item.created_at
  ]);
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\n")}\n`;
}

export function analyzeComment(text, config) {
  const tags = [];
  const disputeTypes = [];
  let score = 0;

  for (const [group, keywords] of Object.entries(config.intentKeywords)) {
    const hits = keywords.filter(keyword => text.includes(keyword));
    if (hits.length > 0) {
      tags.push(`${group}:${hits.join("/")}`);
      disputeTypes.push(mapDisputeType(group));
      score += group === "lawyerNeed" ? 35 : 20 + Math.min(hits.length, 3) * 5;
    }
  }

  const inboundHits = (config.inboundKeywords ?? []).filter(keyword => text.includes(keyword));
  if (inboundHits.length > 0) {
    tags.push(`inbound:${inboundHits.join("/")}`);
    score += 15;
  }

  const consentHits = (config.consentKeywords ?? []).filter(keyword => text.includes(keyword));
  const hasConsent = consentHits.length > 0;
  if (hasConsent) {
    tags.push(`consent:${consentHits.join("/")}`);
    score += 20;
  }

  const negativeHits = (config.negativeKeywords ?? []).filter(keyword => text.includes(keyword));
  if (negativeHits.length > 0) {
    tags.push(`negative:${negativeHits.join("/")}`);
    score -= 30;
  }

  score = Math.max(0, Math.min(100, score));
  return {
    qualified: score >= 25 && disputeTypes.length > 0,
    score,
    tags: [...new Set(tags)],
    disputeTypes: [...new Set(disputeTypes)],
    hasConsent
  };
}

function mapDisputeType(group) {
  const mapping = {
    lawyerNeed: "律师需求",
    dispute: "一般纠纷/诉讼",
    family: "婚姻家事",
    labor: "劳动争议",
    debt: "债务纠纷",
    contract: "合同纠纷",
    traffic: "交通事故",
    realEstate: "房产纠纷"
  };
  return mapping[group] ?? group;
}

function extractInboundInfo(text) {
  const phoneMatch = text.match(/(?<!\d)(?:1[3-9]\d{9})(?!\d)/);
  const surnameMatch =
    text.match(/(?:我姓|本人姓|免贵姓|姓)([\u4e00-\u9fa5]{1,2})/) ||
    text.match(/我叫([\u4e00-\u9fa5]{2,4})/) ||
    text.match(/([\u4e00-\u9fa5]{1,2})(?:先生|女士|律师)/);
  const surname = normalizeSurname(surnameMatch?.[1] ?? "");
  return {
    phone: phoneMatch?.[0] ?? "",
    surnameOrTitle: surname ? `${surname}先生/女士` : ""
  };
}

function normalizeSurname(value) {
  if (!value) return "";
  const compound = ["欧阳", "司马", "上官", "诸葛", "东方", "尉迟", "公孙", "令狐", "夏侯", "南宫"];
  const trimmed = value.trim();
  const matchedCompound = compound.find(name => trimmed.startsWith(name));
  if (matchedCompound) return matchedCompound;
  return trimmed.slice(0, 1);
}

function summarizeProblem(text) {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

function createSuggestedMessage(types, comment) {
  const type = types[0] ?? "法律问题";
  return `看到你提到${type}相关情况。如果你还需要法律方向上的初步梳理，可以先发我大概情况；若你愿意继续咨询，再提供称呼、电话和所在城市，我会整理给律所跟进。`;
}

function createLeadId(comment, index) {
  const base = `${comment.userId || comment.accountName}-${comment.commentId}-${index}`;
  return `lead_${hashString(base).toString(16).padStart(8, "0")}`;
}

function stripWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function redactSecrets(value) {
  return value.replace(/(a1|web_session|webId|gid|xsecappid)=([^;\s]+)/gi, "$1=[REDACTED]");
}

export function toCsv(leads) {
  const rows = [HEADERS.map(header => DISPLAY_HEADERS[header] ?? header), ...leads.map(leadToRow)];
  return `\uFEFF${rows.map(row => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function leadToRow(lead) {
  return HEADERS.map(header => String(lead[header] ?? ""));
}

function csvEscape(value) {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function createXlsxBuffer(headers, rows, meta = {}) {
  const displayHeaders = headers.map(header => DISPLAY_HEADERS[header] ?? header);
  const dataStartRow = 1;
  const tableEndRow = dataStartRow + rows.length;
  const lastColumn = columnName(headers.length);
  const sheetRows = [
    xlsxRow(dataStartRow, displayHeaders, 3),
    ...rows.map((row, index) => xlsxRow(dataStartRow + index + 1, row, 4))
  ].join("");
  const columnXml = XLSX_COLUMN_WIDTHS
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join("");

  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Legal Leads</dc:title><dc:creator>redbook-legal-leads</dc:creator></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>redbook-legal-leads</Application></Properties>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="法律线索" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": xlsxStylesXml(),
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columnXml}</cols><sheetData>${sheetRows}</sheetData><autoFilter ref="A${dataStartRow}:${lastColumn}${Math.max(tableEndRow, dataStartRow)}"/></worksheet>`
  };

  return createZip(files);
}

function xlsxRow(rowNumber, cells, styleId) {
  const height = rowNumber === 1 ? 24 : rowNumber > 1 ? 64 : 22;
  return `<row r="${rowNumber}" ht="${height}" customHeight="1">${cells.map((cell, cellIndex) => {
    const ref = `${columnName(cellIndex + 1)}${rowNumber}`;
    return `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t>${xmlEscape(String(cell ?? ""))}</t></is></c>`;
  }).join("")}</row>`;
}

function xlsxStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="5"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><sz val="10"/><color rgb="FF4B5563"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font><font><sz val="10"/><color rgb="FF111827"/><name val="Microsoft YaHei"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF2F8"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9E2EC"/></left><right style="thin"><color rgb="FFD9E2EC"/></right><top style="thin"><color rgb="FFD9E2EC"/></top><bottom style="thin"><color rgb="FFD9E2EC"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs></styleSheet>`;
}

function createZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuffer, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function columnName(index) {
  let name = "";
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function xmlEscape(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function printHelp() {
  console.log(`
redbook-legal-leads

Commands:
  sample
    Process examples/sample-comments.json and write output/legal-leads.csv/.xlsx.

  from-file --input <comments.json> [--output-dir output] [--config config/legal-keywords.json]
    Process exported comments from redbook or the browser DOM fallback.

  search [--limit 5] [--sort popular] [--cookie-string-env REDBOOK_COOKIE_STRING] [--cookie-file .redbook/cookies.json]
    Run redbook search for configured legal keywords and save raw JSON.

  comments --url <noteUrl> [--cookie-string-env REDBOOK_COOKIE_STRING] [--cookie-file .redbook/cookies.json]
    Run redbook comments for one note and save raw JSON.

  browser-snippet
    Print a browser-console fallback snippet for visible comment pages.
`);
}

export const BROWSER_SNIPPET = `
(() => {
  const rows = [];
  const legalWords = ["需要律师", "找律师", "律师咨询", "纠纷", "离婚", "起诉", "劳动仲裁", "欠款", "合同", "赔偿", "抚养权", "交通事故"];
  const noteAuthorLink =
    document.querySelector('.author-wrapper a[href*="/user/profile/"]') ||
    document.querySelector('.author-container a[href*="/user/profile/"]') ||
    document.querySelector('.author a[href*="/user/profile/"]');
  const noteAuthorProfileUrl = noteAuthorLink ? new URL(noteAuthorLink.getAttribute("href"), location.origin).href : "";
  const noteAuthorId = noteAuthorLink?.getAttribute("data-user-id") || extractUserId(noteAuthorProfileUrl);
  const noteAuthorName = (noteAuthorLink?.innerText || "").replace(/\\s+/g, " ").trim();
  const nodes = [...document.querySelectorAll(".comment-item:not(.comment-item-sub)")];
  for (const node of nodes) {
    const text = (node.querySelector(".content")?.innerText || node.innerText || "").replace(/\\s+/g, " ").trim();
    if (!text || text.length < 8 || text.length > 600) continue;
    if (!legalWords.some(word => text.includes(word))) continue;
    const link = node.querySelector('a.name[href*="/user/profile/"]') || node.querySelector('a[href*="/user/profile/"]');
    const profileUrl = link ? new URL(link.getAttribute("href"), location.origin).href : "";
    const userId = link?.getAttribute("data-user-id") || extractUserId(profileUrl);
    if (noteAuthorId && userId && noteAuthorId === userId) continue;
    const accountName = node.querySelector(".name")?.innerText?.trim() || link?.innerText?.trim() || "";
    rows.push({
      noteUrl: location.href,
      noteTitle: document.title,
      noteAuthorId,
      noteAuthorName,
      noteAuthorProfileUrl,
      accountName,
      userId,
      profileUrl,
      comment: text,
      isReply: false,
      isNoteAuthor: false,
      createdAt: new Date().toISOString()
    });
  }
  const seen = new Set();
  const deduped = rows.filter(row => {
    const key = [row.accountName, row.profileUrl, row.comment.slice(0, 80)].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blob = new Blob([JSON.stringify(deduped, null, 2)], { type: "application/json;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "xhs-visible-legal-comments.json";
  a.click();
  URL.revokeObjectURL(a.href);
  console.log("Exported visible legal comments:", deduped.length);
  function extractUserId(value) {
    try {
      const url = new URL(value);
      return url.pathname.match(/\\/user\\/profile\\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  }
})();
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
