const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROJECT_ROOT = path.join(__dirname, "..");
const WORKSPACE_ROOT = path.join(PROJECT_ROOT, "..");
// 开发态按当前项目约定写入 code/ 下，打包态仍使用 LUYIN_USER_DATA 指定的用户目录。
const USER_DATA = process.env.LUYIN_USER_DATA || PROJECT_ROOT;
const DATA_DIR = path.join(USER_DATA, "data");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
const RECORDINGS_DIR = path.join(USER_DATA, "recordings");

[DATA_DIR, SCREENSHOTS_DIR, RECORDINGS_DIR].forEach((d) =>
  fs.mkdirSync(d, { recursive: true })
);

function readJSON(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeJSON(filename, data) {
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify(data, null, 2),
    "utf-8"
  );
}

function generateId() {
  return crypto.randomUUID();
}

const MEETING_ASSISTANT_CONFIG_FILE = "meeting-assistant-config.json";

/**
 * 读取会议助手配置。
 * 配置只来自界面文件；接口 Base URL 可以为空，调用侧会继续回退 .env 和默认地址。
 * @returns {{enabled: boolean, baseUrl: string, appCode: string, appSecret: string, agentMatchFlowPath: string, updatedAt: string|null}}
 */
function readMeetingAssistantConfig() {
  const fp = path.join(DATA_DIR, MEETING_ASSISTANT_CONFIG_FILE);
  let saved = {};
  if (fs.existsSync(fp)) {
    try {
      saved = JSON.parse(fs.readFileSync(fp, "utf-8")) || {};
    } catch {
      saved = {};
    }
  }
  return {
    enabled: saved.enabled === true,
    baseUrl: String(saved.baseUrl || ""),
    appCode: String(saved.appCode || ""),
    appSecret: String(saved.appSecret || ""),
    agentMatchFlowPath: String(saved.agentMatchFlowPath || ""),
    updatedAt: saved.updatedAt || null,
  };
}

/**
 * 写入会议助手配置。只接受已知字段，避免界面传来的多余键被持久化。
 * @param {object} patch 需要更新的字段；未提供的字段保留原值
 */
function writeMeetingAssistantConfig(patch = {}) {
  const current = readMeetingAssistantConfig();
  const next = {
    enabled: patch.enabled === undefined ? current.enabled : patch.enabled === true,
    baseUrl: patch.baseUrl === undefined ? current.baseUrl : String(patch.baseUrl || "").trim(),
    appCode: patch.appCode === undefined ? current.appCode : String(patch.appCode || "").trim(),
    appSecret:
      patch.appSecret === undefined ? current.appSecret : String(patch.appSecret || "").trim(),
    agentMatchFlowPath:
      patch.agentMatchFlowPath === undefined
        ? current.agentMatchFlowPath
        : String(patch.agentMatchFlowPath || "").trim(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(DATA_DIR, MEETING_ASSISTANT_CONFIG_FILE),
    JSON.stringify(next, null, 2),
    "utf-8"
  );
  return next;
}

/**
 * 把配置转成可以安全下发给前端的形式：AppSecret 只回显尾部 4 位。
 * @param {object} config
 */
function maskMeetingAssistantConfig(config = readMeetingAssistantConfig()) {
  const secret = String(config.appSecret || "");
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    appCode: config.appCode,
    agentMatchFlowPath: config.agentMatchFlowPath,
    hasAppSecret: Boolean(secret),
    // 只暴露尾部片段用于确认"填过且是这一份"，不足 4 位时整体打码。
    appSecretMasked: secret ? `${"*".repeat(8)}${secret.slice(-4)}` : "",
    updatedAt: config.updatedAt,
  };
}

function logActivity(type, title, detail = "") {
  const list = readJSON("activities.json");
  list.unshift({
    id: generateId(),
    type,
    title,
    detail,
    time: new Date().toISOString(),
  });
  if (list.length > 500) list.length = 500;
  writeJSON("activities.json", list);
}

function readTranscripts() {
  const fp = path.join(RECORDINGS_DIR, "transcripts.jsonl");
  if (!fs.existsSync(fp)) return [];
  return fs
    .readFileSync(fp, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function updateTranscriptRecord(wav, updater) {
  const fp = path.join(RECORDINGS_DIR, "transcripts.jsonl");
  if (!fs.existsSync(fp)) {
    return { ok: false, message: "未找到转写记录文件" };
  }

  const targetWav = String(wav || "").trim();
  if (!targetWav || typeof updater !== "function") {
    return { ok: false, message: "缺少录音或更新函数" };
  }

  const lines = fs.readFileSync(fp, "utf-8").split("\n");
  let updatedRecord = null;
  const nextLines = lines.map((line) => {
    if (!line.trim()) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (record.wav !== targetWav) return line;

    const nextRecord = updater(record);
    if (!nextRecord) return line;
    nextRecord.updatedAt = new Date().toISOString();
    updatedRecord = nextRecord;
    return JSON.stringify(nextRecord);
  });

  if (!updatedRecord) {
    return { ok: false, message: "未找到录音记录" };
  }

  fs.writeFileSync(fp, nextLines.join("\n"), "utf-8");
  return { ok: true, data: updatedRecord };
}

/**
 * 删除一条转写记录。
 *
 * 记录没有独立主键：绝大多数场景 wav 文件名唯一，但归档时没采到音频的记录 wav 为 null，
 * 历史数据里也可能出现同名 wav。所以同时用 wav 和 time 定位，并且只删第一条匹配项，
 * 避免一次误删多条。
 *
 * @param {{wav?: string|null, time?: string}} identity
 * @returns {{ok: boolean, data?: object, message?: string}}
 */
function deleteTranscriptRecord(identity = {}) {
  const fp = path.join(RECORDINGS_DIR, "transcripts.jsonl");
  if (!fs.existsSync(fp)) {
    return { ok: false, message: "未找到转写记录文件" };
  }

  const targetWav = String(identity.wav || "").trim();
  const targetTime = String(identity.time || "").trim();
  if (!targetWav && !targetTime) {
    return { ok: false, message: "缺少录音标识" };
  }

  const lines = fs.readFileSync(fp, "utf-8").split("\n");
  let removed = null;
  const nextLines = [];

  for (const line of lines) {
    if (removed || !line.trim()) {
      nextLines.push(line);
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      nextLines.push(line);
      continue;
    }

    const wavMatches = targetWav
      ? String(record.wav || "") === targetWav
      : !record.wav;
    const timeMatches = targetTime ? String(record.time || "") === targetTime : true;
    if (wavMatches && timeMatches) {
      removed = record;
      continue;
    }
    nextLines.push(line);
  }

  if (!removed) {
    return { ok: false, message: "未找到录音记录" };
  }

  fs.writeFileSync(fp, nextLines.join("\n"), "utf-8");
  return { ok: true, data: removed };
}

/**
 * 清空全部转写记录。
 *
 * 返回被清掉的记录，调用方据此删除对应音频文件——只删被记录引用到的 wav，
 * 不要直接清空目录：正在录制的会话已经打开了一个还没写进索引的 wav 文件。
 *
 * @returns {{ok: boolean, data: object[]}}
 */
function clearTranscripts() {
  const fp = path.join(RECORDINGS_DIR, "transcripts.jsonl");
  if (!fs.existsSync(fp)) return { ok: true, data: [] };

  const removed = readTranscripts();
  fs.writeFileSync(fp, "", "utf-8");
  return { ok: true, data: removed };
}

/**
 * 把客户端传来的 wav 名解析成 recordings 目录内的真实路径。
 * wav 名来自请求参数，必须防止 ../ 之类的路径穿越把 unlink 指到目录外。
 * @param {string} wav
 * @returns {string|null} 不合法时返回 null
 */
function resolveRecordingPath(wav) {
  const name = String(wav || "").trim();
  if (!name || name === "." || name === "..") return null;
  // 只接受纯文件名：带分隔符的一律拒绝，而不是用 basename 悄悄改写成目录内的另一个文件。
  if (name !== path.basename(name)) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
  // transcripts.jsonl 是索引文件本身，不允许当作录音删掉。
  if (name === "transcripts.jsonl") return null;

  const root = path.resolve(RECORDINGS_DIR);
  const full = path.resolve(root, name);
  if (full !== path.join(root, name)) return null;
  return full;
}

function updateTranscriptMeetingSummary(wav, meetingSummary) {
  return updateTranscriptRecord(wav, (record) => ({
    ...record,
    meetingSummary,
  }));
}

/**
 * 将某条录音中的同一说话人角色批量标注为人工姓名。
 * @param {string} wav 录音文件名
 * @param {string} speakerId 句子里的 speakerRawId / speakerClusterId
 * @param {string} speakerName 人工确认的姓名
 */
function updateTranscriptSpeakerLabel(wav, speakerId, speakerName) {
  const fp = path.join(RECORDINGS_DIR, "transcripts.jsonl");
  if (!fs.existsSync(fp)) {
    return { ok: false, message: "未找到转写记录文件" };
  }

  const targetWav = String(wav || "").trim();
  const targetSpeakerId = String(speakerId || "").trim();
  const targetSpeakerName = String(speakerName || "").trim();
  if (!targetWav || !targetSpeakerId || !targetSpeakerName) {
    return { ok: false, message: "缺少录音、说话人或姓名" };
  }

  const result = updateTranscriptRecord(targetWav, (record) => {
    const utterances = Array.isArray(record.utterances) ? record.utterances : [];
    let changed = false;
    for (const utterance of utterances) {
      const rawId = utterance.speakerRawId || utterance.speakerClusterId;
      if (rawId === targetSpeakerId) {
        utterance.speakerLabel = targetSpeakerName;
        utterance.speakerStatus = "manual";
        changed = true;
      }
    }
    if (!changed) return null;

    record.speakerMap = {
      ...(record.speakerMap || {}),
      [targetSpeakerId]: targetSpeakerName,
    };
    return record;
  });
  if (!result.ok && result.message === "未找到录音记录") {
    return { ok: false, message: "未找到可标注的说话人" };
  }
  return result;
}

module.exports = {
  PROJECT_ROOT,
  WORKSPACE_ROOT,
  DATA_DIR,
  SCREENSHOTS_DIR,
  RECORDINGS_DIR,
  readJSON,
  writeJSON,
  generateId,
  readMeetingAssistantConfig,
  writeMeetingAssistantConfig,
  maskMeetingAssistantConfig,
  logActivity,
  readTranscripts,
  deleteTranscriptRecord,
  clearTranscripts,
  resolveRecordingPath,
  updateTranscriptRecord,
  updateTranscriptMeetingSummary,
  updateTranscriptSpeakerLabel,
};
