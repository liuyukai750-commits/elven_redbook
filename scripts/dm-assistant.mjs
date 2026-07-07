const DEFAULT_FIRST_MESSAGE_TEMPLATE =
  "您好，看到你在评论里提到法律相关问题。我是{{律所名}}这边的助理，可以先帮你做个简单情况整理，不收费，也不会强制咨询。\n\n如果你还需要了解处理思路，可以简单说一下目前是哪类纠纷、现在进展到哪一步。我整理后再看是否适合安排律师进一步沟通。";

const TRUST_MESSAGE_TEMPLATE =
  "收到。我们是{{律所名}}，办公电话是{{律所电话}}，你也可以自行搜索律所名称核验。为了方便律师判断是否适合跟进，我先登记一下：怎么称呼您？主要是哪类纠纷？";

const PHONE_MESSAGE_TEMPLATE =
  "好的，我先按{{纠纷类型}}记录。方便留一个联系电话吗？律师看完情况后，如果适合跟进，会由律所电话联系你；不方便留也没关系。";

const COMPLETE_MESSAGE = "好的，已登记。后续会由律所工作人员根据你提供的信息联系。";

const REJECTION_PATTERNS = [
  /不用/,
  /不需要/,
  /别联系/,
  /不要联系/,
  /勿扰/,
  /算了/,
  /没事了/,
  /不咨询/
];

const TRUST_PATTERNS = [
  /你是谁/,
  /哪家/,
  /律所/,
  /靠谱吗/,
  /真的假的/,
  /怎么证明/,
  /电话多少/,
  /收费吗/
];

const DISPUTE_KEYWORDS = [
  ["婚姻家事", ["离婚", "抚养权", "抚养费", "财产分割", "家暴", "彩礼"]],
  ["劳动争议", ["劳动仲裁", "拖欠工资", "辞退", "工伤", "社保", "赔偿金"]],
  ["债务纠纷", ["欠款", "借钱", "还钱", "债务", "老赖"]],
  ["合同纠纷", ["合同", "违约", "定金", "退款"]],
  ["交通事故", ["交通事故", "车祸", "赔偿", "伤残"]],
  ["房产纠纷", ["房产", "房子", "房贷", "买房", "卖房", "租赁", "拆迁"]],
  ["一般纠纷/诉讼", ["起诉", "立案", "开庭", "法院", "被告", "原告", "调解"]]
];

const SKIP_QUEUE_STATUSES = new Set([
  "do_not_contact",
  "first_touch_sent",
  "queued_first_touch",
  "replied",
  "trust_explained",
  "surname_needed",
  "phone_needed",
  "dispute_needed",
  "info_complete"
]);

export const DM_EXPORT_HEADERS = [
  "account_identity",
  "surname_or_title",
  "phone",
  "dispute_type"
];

export const DM_DISPLAY_HEADERS = {
  account_identity: "账号ID/账号名",
  surname_or_title: "姓氏/称呼",
  phone: "电话",
  dispute_type: "纠纷"
};

export function createDmOptions(options = {}) {
  return {
    firmName: options.firmName ?? options.firm_name ?? "",
    firmPhone: options.firmPhone ?? options.firm_phone ?? "",
    firstMessageTemplate: options.firstMessageTemplate ?? options.first_message_template ?? DEFAULT_FIRST_MESSAGE_TEMPLATE,
    trustMessageTemplate: options.trustMessageTemplate ?? options.trust_message_template ?? TRUST_MESSAGE_TEMPLATE,
    phoneMessageTemplate: options.phoneMessageTemplate ?? options.phone_message_template ?? PHONE_MESSAGE_TEMPLATE,
    dailySendLimit: Number(options.dailySendLimit ?? options.daily_send_limit ?? 30),
    minScore: Number(options.minScore ?? options.min_score ?? 25)
  };
}

export function validateDmOptions(options) {
  const missing = [];
  if (!options.firmName) missing.push("firmName");
  if (!options.firmPhone) missing.push("firmPhone");
  if (missing.length > 0) {
    throw new Error(`Missing DM config: ${missing.join(", ")}. Pass --firm-name and --firm-phone or use --dm-config.`);
  }
}

export function buildDmQueue(leads, options = {}) {
  const config = createDmOptions(options);
  const seen = new Set();
  const queue = [];
  const sorted = [...leads].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));

  for (const lead of sorted) {
    const accountIdentity = resolveAccountIdentity(lead);
    const dedupeKey = String(lead.profile_url || accountIdentity).trim().toLowerCase();
    const score = Number(lead.score ?? 0);
    if (!accountIdentity || !lead.source_comment) continue;
    if (SKIP_QUEUE_STATUSES.has(lead.status)) continue;
    if (score && score < config.minScore) continue;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    queue.push({
      queue_id: `dm_${String(queue.length + 1).padStart(4, "0")}`,
      lead_id: lead.lead_id ?? "",
      account_identity: accountIdentity,
      account_id: lead.account_id ?? extractAccountId(lead.profile_url) ?? "",
      account_name: lead.account_name ?? "",
      profile_url: lead.profile_url ?? "",
      first_message: renderDmTemplate(config.firstMessageTemplate, lead, config),
      source_comment: lead.source_comment ?? "",
      dispute_type: lead.dispute_type || inferDisputeType(lead.source_comment) || "",
      trust_stage: "first_touch_ready",
      status: "queued_first_touch",
      risk_flags: [],
      remarks: "首句使用固定律所助理模板；发送前必须人工确认。",
      created_at: new Date().toISOString()
    });
  }

  return queue.slice(0, config.dailySendLimit);
}

export function markDmQueueSent(queue, sentAt = new Date().toISOString()) {
  return queue.map(item => ({
    ...item,
    status: "first_touch_sent",
    trust_stage: "first_touch_sent",
    first_message_sent_at: sentAt,
    remarks: appendRemark(item.remarks, "首句已由人工发送")
  }));
}

export function normalizeDmReplies(raw) {
  const source = Array.isArray(raw) ? raw : raw.replies ?? raw.messages ?? raw.items ?? [];
  return source.map(item => ({
    lead_id: String(item.lead_id ?? item.leadId ?? "").trim(),
    account_identity: String(item.account_identity ?? item.accountIdentity ?? "").trim(),
    account_id: String(item.account_id ?? item.accountId ?? item.userId ?? "").trim(),
    account_name: String(item.account_name ?? item.accountName ?? item.name ?? "").trim(),
    profile_url: String(item.profile_url ?? item.profileUrl ?? "").trim(),
    text: stripWhitespace(String(item.text ?? item.message ?? item.transcript ?? item.content ?? "")),
    created_at: String(item.created_at ?? item.createdAt ?? new Date().toISOString())
  })).filter(item => item.text && (item.lead_id || item.account_identity || item.account_id || item.account_name || item.profile_url));
}

export function updateLeadsFromDmReplies(leads, replies, options = {}) {
  const config = createDmOptions(options);
  return leads.map(lead => {
    const reply = findReplyForLead(lead, replies);
    if (!reply) return lead;

    const existingDispute = lead.dispute_type ?? "";
    const extracted = extractDmInfo(reply.text);
    const dispute = extracted.disputeType || existingDispute || inferDisputeType(`${lead.source_comment ?? ""} ${reply.text}`) || "";
    const next = buildNextReply({
      text: reply.text,
      surnameOrTitle: extracted.surnameOrTitle || lead.surname_or_title || "",
      phone: extracted.phone || lead.phone || "",
      disputeType: dispute,
      options: config
    });

    return {
      ...lead,
      account_identity: resolveAccountIdentity(lead),
      account_id: lead.account_id ?? extractAccountId(lead.profile_url) ?? "",
      surname_or_title: extracted.surnameOrTitle || lead.surname_or_title || "",
      phone: extracted.phone || lead.phone || "",
      dispute_type: dispute,
      reply_text: reply.text,
      reply_received_at: reply.created_at,
      trust_stage: next.trustStage,
      status: next.status,
      next_suggested_reply: next.message,
      risk_flags: next.riskFlags,
      remarks: appendRemark(lead.remarks, `私信回复已处理：${reply.created_at}`)
    };
  });
}

export function buildNextReply({ text, surnameOrTitle, phone, disputeType, options }) {
  const riskFlags = [];
  if (isRejected(text)) {
    return {
      status: "do_not_contact",
      trustStage: "do_not_contact",
      message: "",
      riskFlags: ["user_rejected"]
    };
  }

  if (phone && surnameOrTitle && disputeType) {
    return {
      status: "info_complete",
      trustStage: "info_complete",
      message: COMPLETE_MESSAGE,
      riskFlags
    };
  }

  if (needsTrustExplanation(text)) {
    return {
      status: "replied",
      trustStage: "trust_explained",
      message: renderDmTemplate(options.trustMessageTemplate, { dispute_type: disputeType }, options),
      riskFlags
    };
  }

  if (!surnameOrTitle || !disputeType) {
    return {
      status: !surnameOrTitle ? "surname_needed" : "dispute_needed",
      trustStage: !surnameOrTitle ? "surname_needed" : "dispute_needed",
      message: renderDmTemplate(options.trustMessageTemplate, { dispute_type: disputeType }, options),
      riskFlags
    };
  }

  if (!phone) {
    return {
      status: "phone_needed",
      trustStage: "phone_needed",
      message: renderDmTemplate(options.phoneMessageTemplate, { dispute_type: disputeType }, options),
      riskFlags
    };
  }

  riskFlags.push("unclear_reply");
  return {
    status: "replied",
    trustStage: "replied",
    message: renderDmTemplate(options.trustMessageTemplate, { dispute_type: disputeType }, options),
    riskFlags
  };
}

export function extractDmInfo(text) {
  const phoneMatch = text.match(/(?<!\d)1[3-9]\d{9}(?!\d)/);
  const surnameMatch =
    text.match(/(?:我姓|本人姓|免贵姓|姓)([\u4e00-\u9fa5]{1,2})/) ||
    text.match(/我叫([\u4e00-\u9fa5]{2,4})/) ||
    text.match(/([\u4e00-\u9fa5]{1,2})(?:先生|女士|律师)/);
  const surname = normalizeSurname(surnameMatch?.[1] ?? "");
  return {
    phone: phoneMatch?.[0] ?? "",
    surnameOrTitle: surname ? `${surname}先生/女士` : "",
    disputeType: inferDisputeType(text)
  };
}

export function toDmSummaryRows(leads, { onlyComplete = true } = {}) {
  return leads
    .filter(lead => !onlyComplete || lead.status === "info_complete")
    .filter(lead => lead.status !== "do_not_contact")
    .map(lead => ({
      account_identity: resolveAccountIdentity(lead),
      surname_or_title: lead.surname_or_title ?? "",
      phone: lead.phone ?? "",
      dispute_type: lead.dispute_type ?? ""
    }));
}

export function toDmCsv(rows) {
  const outputRows = [
    DM_EXPORT_HEADERS.map(header => DM_DISPLAY_HEADERS[header] ?? header),
    ...rows.map(row => DM_EXPORT_HEADERS.map(header => String(row[header] ?? "")))
  ];
  return `\uFEFF${outputRows.map(row => row.map(csvEscape).join(",")).join("\n")}\n`;
}

export function toDmQueueCsv(queue) {
  const headers = ["队列ID", "账号ID/账号名", "账号名", "用户主页", "首句", "纠纷", "状态", "创建时间"];
  const rows = queue.map(item => [
    item.queue_id,
    item.account_identity,
    item.account_name,
    item.profile_url,
    item.first_message,
    item.dispute_type,
    item.status,
    item.created_at
  ]);
  return `\uFEFF${[headers, ...rows].map(row => row.map(csvEscape).join(",")).join("\n")}\n`;
}

export function renderDmTemplate(template, lead, options = {}) {
  const disputeType = lead.dispute_type || inferDisputeType(lead.source_comment ?? "") || "法律";
  return template
    .replaceAll("{{账号名}}", lead.account_name ?? "")
    .replaceAll("{{评论内容}}", lead.source_comment ?? "")
    .replaceAll("{{纠纷类型}}", disputeType)
    .replaceAll("{{律所名}}", options.firmName ?? "")
    .replaceAll("{{律所电话}}", options.firmPhone ?? "");
}

export function resolveAccountIdentity(lead) {
  return String(
    lead.account_identity ||
    lead.account_id ||
    lead.user_id ||
    lead.userId ||
    extractAccountId(lead.profile_url) ||
    lead.account_name ||
    ""
  ).trim();
}

export function extractAccountId(profileUrl = "") {
  const value = String(profileUrl || "");
  const match = value.match(/\/user\/profile\/([^/?#]+)/);
  return match?.[1] ?? "";
}

export function inferDisputeType(text = "") {
  for (const [type, keywords] of DISPUTE_KEYWORDS) {
    if (keywords.some(keyword => text.includes(keyword))) return type;
  }
  return "";
}

function isRejected(text) {
  return REJECTION_PATTERNS.some(pattern => pattern.test(text));
}

function needsTrustExplanation(text) {
  return TRUST_PATTERNS.some(pattern => pattern.test(text));
}

function findReplyForLead(lead, replies) {
  const leadIdentity = resolveAccountIdentity(lead);
  const leadAccountId = String(lead.account_id || extractAccountId(lead.profile_url) || "").trim();
  return replies.find(item =>
    (item.lead_id && lead.lead_id && item.lead_id === lead.lead_id) ||
    (item.account_id && leadAccountId && item.account_id === leadAccountId) ||
    (item.account_identity && leadIdentity && item.account_identity === leadIdentity) ||
    (item.profile_url && lead.profile_url && item.profile_url === lead.profile_url) ||
    (item.account_name && lead.account_name && item.account_name === lead.account_name)
  );
}

function normalizeSurname(value) {
  if (!value) return "";
  const compound = ["欧阳", "司马", "上官", "诸葛", "东方", "尉迟", "公孙", "令狐", "夏侯", "南宫"];
  const trimmed = value.trim();
  const matchedCompound = compound.find(name => trimmed.startsWith(name));
  if (matchedCompound) return matchedCompound;
  return trimmed.slice(0, 1);
}

function appendRemark(existing, value) {
  return existing ? `${existing}; ${value}` : value;
}

function stripWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
