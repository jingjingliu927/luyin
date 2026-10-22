const store = require("./store");

const DEFAULT_TIMEOUT_MS = 30_000;

function nowIso() {
  return new Date().toISOString();
}

function getTranscriptText(record = {}) {
  const text = String(record.text || "").trim();
  if (text) return text;
  const utterances = Array.isArray(record.utterances) ? record.utterances : [];
  return utterances.map((item) => String(item.text || "").trim()).filter(Boolean).join(" ");
}

function hasSummarizableText(record = {}) {
  const text = getTranscriptText(record);
  return Boolean(text) && !text.startsWith("（");
}

function buildMeetingSummaryContext(record = {}) {
  const utterances = Array.isArray(record.utterances) ? record.utterances : [];
  return {
    recordingId: record.wav || record.id || record.time || "",
    wav: record.wav || "",
    text: getTranscriptText(record),
    utterances: utterances.map((item) => ({
      sentenceId: item.sentenceId,
      text: item.text || "",
      speakerLabel: item.speakerLabel || "说话人",
      speakerRawId: item.speakerRawId || item.speakerClusterId || "",
      speakerStatus: item.speakerStatus || "pending",
      startMs: item.startMs,
      endMs: item.endMs,
    })),
    speakerMap: record.speakerMap || {},
    startedAt: record.startedAt || record.time || "",
    endedAt: record.endedAt || "",
  };
}

function buildBatchMeetingSummaryRecord(records = []) {
  const selected = records.filter(Boolean);
  const utterances = [];
  const speakerMap = {};
  const text = selected
    .map((record, index) => {
      const title = record.time || record.wav || `录音${index + 1}`;
      const content = getTranscriptText(record);
      const recordUtterances = Array.isArray(record.utterances) ? record.utterances : [];
      for (const item of recordUtterances) {
        utterances.push({
          ...item,
          recordingId: record.wav || title,
          recordingTime: record.time || "",
        });
      }
      Object.assign(speakerMap, record.speakerMap || {});
      return content ? `【${title}】\n${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    id: `batch_${Date.now()}`,
    wav: "",
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    text,
    utterances,
    speakerMap,
    recordings: selected.map((record) => ({
      wav: record.wav || "",
      time: record.time || "",
      text: getTranscriptText(record),
    })),
  };
}

function createInitialMeetingSummary(record = {}) {
  if (!hasSummarizableText(record)) {
    return {
      status: "skipped",
      message: "暂无可总结内容",
      updatedAt: nowIso(),
    };
  }
  return {
    status: "pending",
    message: "会议总结生成中",
    updatedAt: nowIso(),
  };
}

function buildHeaders() {
  const headers = { "Content-Type": "application/json" };
  const customHeader = process.env.MEETING_SUMMARY_AUTH_HEADER;
  const customValue = process.env.MEETING_SUMMARY_AUTH_VALUE;
  if (customHeader && customValue) {
    headers[customHeader] = customValue;
  } else if (process.env.MEETING_SUMMARY_API_KEY) {
    headers.Authorization = `Bearer ${process.env.MEETING_SUMMARY_API_KEY}`;
  } else if (process.env.MEETING_SUMMARY_API_TOKEN) {
    headers.token = process.env.MEETING_SUMMARY_API_TOKEN;
  }
  return headers;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function normalizeSummaryResponse(body) {
  const payload = body?.body || body?.data || body?.result || body || {};
  return {
    status: "ready",
    summary: String(payload.summary || payload.content || payload.text || ""),
    decisions: normalizeList(payload.decisions || payload.keyPoints || payload.conclusions),
    actionItems: normalizeList(payload.actionItems || payload.actions || payload.todos),
    risks: normalizeList(payload.risks || payload.blockers || payload.pendingItems),
    raw: body,
    updatedAt: nowIso(),
  };
}

async function postSummaryRequest(context) {
  const url = String(process.env.MEETING_SUMMARY_API_URL || "").trim();
  if (!url) {
    throw new Error("未配置会议总结接口");
  }

  const timeoutMs = Number(process.env.MEETING_SUMMARY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify(context),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { content: text };
    }
    if (!response.ok) {
      const message = body?.message || body?.error || `会议总结接口返回 ${response.status}`;
      throw new Error(message);
    }
    return normalizeSummaryResponse(body);
  } finally {
    clearTimeout(timer);
  }
}

async function requestMeetingSummary(record = {}) {
  if (!hasSummarizableText(record)) {
    return createInitialMeetingSummary(record);
  }

  try {
    const result = await postSummaryRequest(buildMeetingSummaryContext(record));
    if (!result.summary && result.actionItems.length === 0 && result.decisions.length === 0) {
      return {
        status: "failed",
        message: "会议总结接口返回内容为空",
        updatedAt: nowIso(),
      };
    }
    return result;
  } catch (error) {
    return {
      status: "failed",
      message: error.name === "AbortError" ? "会议总结接口超时" : error.message,
      updatedAt: nowIso(),
    };
  }
}

async function summarizeAndPersist(record = {}) {
  const result = await requestMeetingSummary(record);
  if (record.wav) {
    store.updateTranscriptMeetingSummary(record.wav, result);
  }
  return result;
}

function triggerMeetingSummary(record = {}) {
  if (!record.wav || record.meetingSummary?.status === "skipped") return;
  summarizeAndPersist(record).catch((error) => {
    store.updateTranscriptMeetingSummary(record.wav, {
      status: "failed",
      message: error.message,
      updatedAt: nowIso(),
    });
  });
}

module.exports = {
  buildBatchMeetingSummaryRecord,
  buildMeetingSummaryContext,
  createInitialMeetingSummary,
  hasSummarizableText,
  requestMeetingSummary,
  summarizeAndPersist,
  triggerMeetingSummary,
};
