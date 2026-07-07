import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  analyzeComment,
  buildContactQueue,
  buildLeads,
  createXlsxBuffer,
  main,
  normalizeComments,
  normalizeReplies,
  updateLeadsFromReplies,
  toCsv
} from "../scripts/legal-leads.mjs";
import {
  buildSkippedDmQueue,
  buildDmQueue,
  findCompetitorMatches,
  isCompetitorAccount,
  markDmQueueSent,
  normalizeDmReplies,
  toDmCsv,
  toDmSummaryRows,
  updateLeadsFromDmReplies
} from "../scripts/dm-assistant.mjs";
import { normalizeXhsUrl } from "../scripts/in-app-browser-batch.mjs";

const config = {
  intentKeywords: {
    lawyerNeed: ["需要律师", "找律师"],
    dispute: ["起诉", "纠纷"],
    family: ["离婚", "抚养权"],
    labor: ["劳动仲裁", "拖欠工资"],
    debt: ["欠款"],
    contract: ["合同"],
    traffic: ["交通事故"],
    realEstate: ["房产"]
  },
  consentKeywords: ["怎么联系", "私信我"],
  inboundKeywords: ["咨询", "怎么办"],
  negativeKeywords: ["学习了"]
};

test("analyzeComment scores high-intent legal comments", () => {
  const result = analyzeComment("我想咨询离婚抚养权，需要律师的话怎么联系？", config);
  assert.equal(result.qualified, true);
  assert.equal(result.hasConsent, true);
  assert.ok(result.score >= 70);
  assert.ok(result.disputeTypes.includes("婚姻家事"));
});

test("analyzeComment filters low-intent comments", () => {
  const result = analyzeComment("学习了，谢谢分享", config);
  assert.equal(result.qualified, false);
  assert.equal(result.score, 0);
});

test("normalizeComments supports common redbook-like shapes", () => {
  const comments = normalizeComments({
    data: {
      comments: [
        {
          id: "1",
          content: "公司拖欠工资，可以劳动仲裁吗？",
          user: { nickname: "打工人", id: "u1" },
          note: { title: "仲裁流程", url: "https://example.test/note" }
        }
      ]
    }
  });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].accountName, "打工人");
  assert.equal(comments[0].noteTitle, "仲裁流程");
});

test("buildLeads dedupes and extracts phone/title from consented comments", () => {
  const comments = normalizeComments([
    {
      commentId: "a",
      accountName: "王女士",
      userId: "u1",
      comment: "我姓王，电话13800138000，合同纠纷想咨询，私信我",
      noteUrl: "https://example.test/1"
    },
    {
      commentId: "a",
      accountName: "王女士",
      userId: "u1",
      comment: "我姓王，电话13800138000，合同纠纷想咨询，私信我",
      noteUrl: "https://example.test/1"
    }
  ]);

  const leads = buildLeads(comments, config);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, "13800138000");
  assert.equal(leads[0].surname_or_title, "王先生/女士");
  assert.equal(leads[0].status, "consented");
});

test("buildLeads does not export phone/title without consent", () => {
  const comments = normalizeComments([
    {
      commentId: "b",
      accountName: "李先生",
      userId: "u2",
      comment: "我姓李，电话13900139000，欠款纠纷需要律师",
      noteUrl: "https://example.test/2"
    }
  ]);

  const leads = buildLeads(comments, config);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].phone, "");
  assert.equal(leads[0].surname_or_title, "");
  assert.equal(leads[0].status, "new");
});

test("buildLeads skips replies and note author comments", () => {
  const comments = normalizeComments([
    {
      commentId: "reply",
      accountName: "回复用户",
      userId: "u1",
      comment: "离婚财产怎么分？",
      noteUrl: "https://example.test/1",
      isReply: true
    },
    {
      commentId: "author",
      accountName: "博主",
      userId: "author1",
      noteAuthorId: "author1",
      comment: "需要律师可以私信我",
      noteUrl: "https://example.test/1"
    },
    {
      commentId: "root",
      accountName: "真实评论人",
      userId: "u2",
      noteAuthorId: "author1",
      comment: "离婚财产和抚养权想咨询",
      noteUrl: "https://example.test/1"
    }
  ]);

  const leads = buildLeads(comments, config);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].account_name, "真实评论人");
});

test("exports CSV with BOM and creates an xlsx zip", () => {
  const lead = {
    lead_id: "lead_1",
    account_name: "测试",
    source_comment: "离婚问题，需要律师"
  };
  const csv = toCsv([lead]);
  assert.equal(csv.charCodeAt(0), 0xfeff);

  const xlsx = createXlsxBuffer(["a"], [["b"]]);
  assert.equal(xlsx.subarray(0, 4).toString("hex"), "504b0304");
});

test("normalizeXhsUrl strips tracking query params", () => {
  const value = normalizeXhsUrl("https://www.xiaohongshu.com/explore/abc123?xsec_token=secret&source=feed");
  assert.equal(value, "https://www.xiaohongshu.com/explore/abc123");
});

test("buildContactQueue creates manual-send queue items", () => {
  const queue = buildContactQueue([
    {
      account_name: "测试账号",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "离婚财产怎么分？",
      dispute_type: "婚姻家事"
    }
  ], "你好 {{账号名}}，看到你说：{{评论内容}}");

  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "pending_manual_send");
  assert.match(queue[0].first_message, /测试账号/);
  assert.match(queue[0].first_message, /离婚财产/);
});

test("buildContactQueue skips do-not-contact leads", () => {
  const queue = buildContactQueue([
    {
      account_name: "拒绝用户",
      profile_url: "https://www.xiaohongshu.com/user/profile/rejected",
      source_comment: "欠款起诉",
      dispute_type: "债务纠纷",
      status: "do_not_contact"
    }
  ], "你好 {{账号名}}，看到你提到{{纠纷类型}}。");

  assert.equal(queue.length, 0);
});

test("updateLeadsFromReplies fills phone and surname after replies", () => {
  const leads = [
    {
      account_name: "财运当头",
      phone: "",
      surname_or_title: "",
      source_comment: "婚后加名房子怎么分？"
    }
  ];
  const replies = normalizeReplies([
    {
      accountName: "财运当头",
      text: "我姓李，电话13900139000，想问房子问题。"
    }
  ]);
  const updated = updateLeadsFromReplies(leads, replies);

  assert.equal(updated[0].phone, "13900139000");
  assert.equal(updated[0].surname_or_title, "李先生/女士");
});

test("updateLeadsFromReplies handles common surname wording", () => {
  const leads = [
    { account_name: "A", phone: "", surname_or_title: "", source_comment: "评论A" },
    { account_name: "B", phone: "", surname_or_title: "", source_comment: "评论B" },
    { account_name: "C", phone: "", surname_or_title: "", source_comment: "评论C" }
  ];
  const replies = normalizeReplies([
    { accountName: "A", text: "我叫张三，电话13700137000。" },
    { accountName: "B", text: "免贵姓欧阳，电话13600136000。" },
    { accountName: "C", text: "王女士，电话13500135000。" }
  ]);
  const updated = updateLeadsFromReplies(leads, replies);

  assert.equal(updated[0].surname_or_title, "张先生/女士");
  assert.equal(updated[1].surname_or_title, "欧阳先生/女士");
  assert.equal(updated[2].surname_or_title, "王先生/女士");
});

test("buildDmQueue dedupes accounts and uses fixed first-touch template", () => {
  const leads = [
    {
      lead_id: "lead_1",
      account_id: "u1",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "离婚财产怎么分？",
      dispute_type: "婚姻家事",
      score: 80
    },
    {
      lead_id: "lead_2",
      account_id: "u1",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "抚养权问题想问问",
      dispute_type: "婚姻家事",
      score: 75
    }
  ];

  const queue = buildDmQueue(leads, {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "ready_for_review");
  assert.equal(queue[0].account_identity, "u1");
  assert.match(queue[0].first_message, /测试律所/);
  assert.match(queue[0].first_message, /法律相关问题/);
});

test("buildDmQueue keeps the highest-score lead when deduping accounts", () => {
  const queue = buildDmQueue([
    {
      lead_id: "low",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "离婚问题想问问",
      dispute_type: "婚姻家事",
      score: 40
    },
    {
      lead_id: "high",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "离婚财产和抚养权都需要律师咨询",
      dispute_type: "婚姻家事",
      score: 90
    }
  ], {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(queue.length, 1);
  assert.equal(queue[0].lead_id, "high");
  assert.match(queue[0].source_comment, /抚养权/);
});

test("buildDmQueue skips leads already in conversation states", () => {
  const statuses = [
    "queued_first_touch",
    "first_touch_sent",
    "replied",
    "trust_explained",
    "surname_needed",
    "phone_needed",
    "dispute_needed",
    "info_complete",
    "do_not_contact"
  ];
  const leads = statuses.map((status, index) => ({
    lead_id: `lead_${index}`,
    account_identity: `u${index}`,
    account_name: `用户${index}`,
    profile_url: `https://www.xiaohongshu.com/user/profile/u${index}`,
    source_comment: "离婚财产怎么分？",
    dispute_type: "婚姻家事",
    score: 80,
    status
  }));

  const queue = buildDmQueue(leads, {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(queue.length, 0);
});

test("buildDmQueue skips possible lawyer or legal-service accounts", () => {
  const leads = [
    {
      lead_id: "lawyer",
      account_identity: "u1",
      account_name: "长沙离婚律师王律",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "离婚财产怎么分？",
      dispute_type: "婚姻家事",
      score: 90
    },
    {
      lead_id: "client",
      account_identity: "u2",
      account_name: "想咨询的小刘",
      profile_url: "https://www.xiaohongshu.com/user/profile/u2",
      source_comment: "离婚财产和抚养权都想咨询律师",
      dispute_type: "婚姻家事",
      score: 90
    }
  ];

  const options = {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  };
  const queue = buildDmQueue(leads, options);
  const skipped = buildSkippedDmQueue(leads, options);

  assert.equal(isCompetitorAccount(leads[0]), true);
  assert.equal(isCompetitorAccount(leads[1]), false);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].lead_id, "client");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].status, "skipped_competitor");
});

test("buildDmQueue skips competitor behavior found in source comments", () => {
  const lead = {
    lead_id: "comment_competitor",
    account_identity: "u3",
    account_name: "小明",
    profile_url: "https://www.xiaohongshu.com/user/profile/u3",
    source_comment: "我是长沙执业律师，可以私信咨询。",
    dispute_type: "婚姻家事",
    score: 90
  };
  const options = {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  };
  const queue = buildDmQueue([lead], options);
  const skipped = buildSkippedDmQueue([lead], options);

  assert.equal(isCompetitorAccount(lead), true);
  assert.deepEqual(findCompetitorMatches(lead), ["评论自称律师", "评论招揽法律咨询", "评论提到执业律师"]);
  assert.equal(queue.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].remarks, /评论自称律师/);
});

test("buildDmQueue keeps ordinary client comments that mention lawyers", () => {
  const lead = {
    lead_id: "client_lawyer_word",
    account_identity: "u4",
    account_name: "普通咨询用户",
    profile_url: "https://www.xiaohongshu.com/user/profile/u4",
    source_comment: "我想找律师咨询离婚财产和抚养权问题",
    dispute_type: "婚姻家事",
    score: 90
  };
  const queue = buildDmQueue([lead], {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(isCompetitorAccount(lead), false);
  assert.equal(queue.length, 1);
});

test("markDmQueueSent marks queue items after manual sending", () => {
  const marked = markDmQueueSent([
    {
      queue_id: "dm_0001",
      lead_id: "lead_1",
      status: "ready_for_review",
      remarks: "首句使用固定律所助理模板"
    }
  ], "2026-07-07T12:00:00.000Z");

  assert.equal(marked[0].status, "first_touch_sent");
  assert.equal(marked[0].first_message_sent_at, "2026-07-07T12:00:00.000Z");
  assert.match(marked[0].remarks, /首句已由人工发送/);
});

test("dm-mark-sent updates queue and matching leads json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "redbook-dm-"));
  const queuePath = path.join(dir, "dm-queue.json");
  const leadsPath = path.join(dir, "legal-leads.json");
  await writeFile(queuePath, JSON.stringify([
    {
      queue_id: "dm_0001",
      lead_id: "lead_1",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      status: "ready_for_review"
    },
    {
      queue_id: "dm_0002",
      lead_id: "lead_2",
      account_identity: "u2",
      account_name: "李先生",
      profile_url: "https://www.xiaohongshu.com/user/profile/u2",
      status: "ready_for_review"
    }
  ], null, 2), "utf8");
  await writeFile(leadsPath, JSON.stringify([
    {
      lead_id: "lead_1",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      status: "new"
    },
    {
      lead_id: "lead_2",
      account_identity: "u2",
      account_name: "李先生",
      profile_url: "https://www.xiaohongshu.com/user/profile/u2",
      status: "new"
    }
  ], null, 2), "utf8");

  await main([
    "dm-mark-sent",
    "--input", queuePath,
    "--leads", leadsPath,
    "--queue-id", "dm_0001",
    "--sent-at", "2026-07-07T12:00:00.000Z"
  ]);

  const queue = JSON.parse(await readFile(queuePath, "utf8"));
  const leads = JSON.parse(await readFile(leadsPath, "utf8"));
  assert.equal(queue[0].status, "first_touch_sent");
  assert.equal(queue[1].status, "ready_for_review");
  assert.equal(leads[0].status, "first_touch_sent");
  assert.equal(leads[1].status, "new");
});

test("dm-queue works with CLI firm options when dm config file is missing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "redbook-dm-queue-"));
  const input = path.join(dir, "legal-leads.json");
  await writeFile(input, JSON.stringify([
    {
      lead_id: "lead_1",
      account_identity: "u1",
      account_name: "王女士",
      profile_url: "https://www.xiaohongshu.com/user/profile/u1",
      source_comment: "离婚财产和抚养权想咨询律师",
      dispute_type: "婚姻家事",
      score: 90
    }
  ], null, 2), "utf8");

  await main([
    "dm-queue",
    "--input", input,
    "--output-dir", dir,
    "--dm-config", path.join(dir, "missing-dm-config.json"),
    "--firm-name", "测试律所",
    "--firm-phone", "010-12345678"
  ]);

  const queue = JSON.parse(await readFile(path.join(dir, "dm-queue.json"), "utf8"));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, "ready_for_review");
  assert.match(queue[0].first_message, /测试律所/);
});

test("updateLeadsFromDmReplies extracts complete contact info and summary rows", () => {
  const leads = [
    {
      lead_id: "lead_1",
      account_identity: "u1",
      account_name: "王女士",
      phone: "",
      surname_or_title: "",
      dispute_type: "婚姻家事",
      source_comment: "离婚财产怎么分？",
      status: "first_touch_sent"
    }
  ];
  const replies = normalizeDmReplies([
    {
      lead_id: "lead_1",
      text: "可以，我姓王，电话13800138000，主要是离婚财产和孩子抚养问题。"
    }
  ]);

  const updated = updateLeadsFromDmReplies(leads, replies, {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });
  const rows = toDmSummaryRows(updated);

  assert.equal(updated[0].status, "info_complete");
  assert.equal(updated[0].surname_or_title, "王先生/女士");
  assert.equal(updated[0].phone, "13800138000");
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ["account_identity", "surname_or_title", "phone", "dispute_type"]);
});

test("updateLeadsFromDmReplies asks only for phone when dispute and surname exist", () => {
  const leads = [
    {
      account_identity: "u2",
      account_name: "李先生",
      surname_or_title: "",
      phone: "",
      dispute_type: "",
      source_comment: "合同退款问题",
      status: "first_touch_sent"
    }
  ];
  const replies = normalizeDmReplies([
    { account_identity: "u2", text: "我姓李，是合同纠纷，想问退款怎么处理。" }
  ]);

  const updated = updateLeadsFromDmReplies(leads, replies, {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(updated[0].status, "phone_needed");
  assert.equal(updated[0].surname_or_title, "李先生/女士");
  assert.equal(updated[0].dispute_type, "合同纠纷");
  assert.match(updated[0].next_suggested_reply, /联系电话/);
});

test("updateLeadsFromDmReplies explains trust when user asks who we are", () => {
  const leads = [
    {
      account_identity: "u3",
      account_name: "咨询者",
      surname_or_title: "",
      phone: "",
      dispute_type: "劳动争议",
      source_comment: "拖欠工资怎么办",
      status: "first_touch_sent"
    }
  ];
  const replies = normalizeDmReplies([
    { account_identity: "u3", text: "你们是谁？哪家律所？" }
  ]);

  const updated = updateLeadsFromDmReplies(leads, replies, {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(updated[0].status, "replied");
  assert.equal(updated[0].trust_stage, "trust_explained");
  assert.match(updated[0].next_suggested_reply, /测试律所/);
  assert.match(updated[0].next_suggested_reply, /010-12345678/);
});

test("updateLeadsFromDmReplies stops on rejection and excludes final summary", () => {
  const leads = [
    {
      account_identity: "u4",
      account_name: "拒绝用户",
      surname_or_title: "",
      phone: "",
      dispute_type: "债务纠纷",
      source_comment: "欠款起诉",
      status: "first_touch_sent"
    }
  ];
  const replies = normalizeDmReplies([
    { account_identity: "u4", text: "不用了，不需要联系。" }
  ]);

  const updated = updateLeadsFromDmReplies(leads, replies, {
    firmName: "测试律所",
    firmPhone: "010-12345678"
  });

  assert.equal(updated[0].status, "do_not_contact");
  assert.equal(toDmSummaryRows(updated, { onlyComplete: false }).length, 0);
});

test("toDmCsv exports the four delivery columns", () => {
  const csv = toDmCsv([
    {
      account_identity: "u1",
      surname_or_title: "王先生/女士",
      phone: "13800138000",
      dispute_type: "婚姻家事"
    }
  ]);

  assert.match(csv, /^﻿账号ID\/账号名,姓氏\/称呼,电话,纠纷/);
  assert.match(csv, /13800138000/);
});
