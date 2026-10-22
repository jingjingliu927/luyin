const path = require("path");
const fs = require("fs");

const CODE_ROOT = path.join(__dirname, "..");
const WORKSPACE_ROOT = path.join(CODE_ROOT, "..");
const _envPathCandidates = process.env.LUYIN_USER_DATA
  ? [
      path.join(process.env.LUYIN_USER_DATA, ".env"),
      path.join(process.resourcesPath || "", ".env"),
    ]
  : [path.join(WORKSPACE_ROOT, ".env")];
// 演示包允许内置 .env 作为兜底；用户目录 .env 仍然拥有最高优先级。
const _envPath = _envPathCandidates.find((candidate) => candidate && fs.existsSync(candidate));
require("dotenv").config({ path: _envPath });

const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const EventEmitter = require("events");

const store = require("./store");
const { parseCommand } = require("./command-router");
const { registerDocReviewRoutes } = require("./doc-review");
const { initWebSocket } = require("./ws-server");
const envSettings = require("./env-settings");
const {
  buildBatchMeetingSummaryRecord,
  createInitialMeetingSummary,
  requestMeetingSummary,
  summarizeAndPersist,
  triggerMeetingSummary,
} = require("./meeting-summary");
const {
  deleteOfficeVoiceprints,
  normalizeVoiceprintAudio,
  registerOfficeVoiceprint,
  updateOfficeVoiceprint,
  validateOfficeVoiceprintConfig,
} = require("./xfyun-llm-voiceprint");

const emitter = new EventEmitter();

const PROJECT_ROOT = CODE_ROOT;

/**
 * 获取当前运行模式。
 * Electron 启动时由主进程写入环境变量，纯 Web 启动默认走浏览器模式。
 */
function getRuntimeMode() {
  return process.env.LUYIN_RUNTIME === "electron" ? "electron" : "web";
}

/**
 * 返回前端可见的能力开关，避免 Web 版误展示桌面专属入口。
 */
function getRuntimeCapabilities() {
  const mode = getRuntimeMode();
  return {
    mode,
    desktop: mode === "electron",
    screenshot: mode === "electron",
    tray: mode === "electron",
    floatingWindow: mode === "electron",
    desktopNotification: mode === "electron",
  };
}

/* ───────── 常量 ───────── */
const DEFAULT_KALEIDO_AUTH_URL = "https://v5.kaleido.guru/api/bach_api/get_api_auth";
// 任务智能体是可选集成：三项都配置了才调用，否则「创建任务」只在本地建任务。
// 用到时再读环境变量，「设置」页改完后下一次调用即生效。
function getKaleidoConfig() {
  return {
    authUrl: process.env.KALEIDO_AUTH_URL || DEFAULT_KALEIDO_AUTH_URL,
    agentUrl: process.env.KALEIDO_TASK_AGENT_URL || "",
    appCode: process.env.KALEIDO_APP_CODE || "",
    appSecret: process.env.KALEIDO_APP_SECRET || "",
  };
}

let cachedToken = null;
// 缓存的 token 属于哪组凭据；凭据变了就重新鉴权。
let cachedTokenKey = "";
let tokenExpiresAt = 0;

const TRANSCRIPT_LOG = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");

/* ───────── Express 应用 ───────── */
const app = express();
app.use(express.json());
app.use(express.static(path.join(PROJECT_ROOT, "public")));
app.use(
  "/lib/recorder-core",
  express.static(path.join(PROJECT_ROOT, "node_modules", "recorder-core"))
);
app.use("/recordings", express.static(store.RECORDINGS_DIR));
app.use("/data/screenshots", express.static(store.SCREENSHOTS_DIR));

app.get("/api/runtime", (_req, res) => {
  res.json(getRuntimeCapabilities());
});

// 文档评审模块以旁路数据保存评论和版本快照，避免改写 Trio 生成的 Markdown。
registerDocReviewRoutes(app, store);

/* ───────── Multer 配置 ───────── */
const storage = multer.diskStorage({
  destination: store.RECORDINGS_DIR,
  filename(_req, _file, cb) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "_",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds()),
    ].join("");
    cb(null, `record_${ts}.wav`);
  },
});
const upload = multer({ storage });
// 声纹样本只需暂存到内存，避免把注册样本落盘到用户录音目录。
const voiceprintUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/**
 * 读取人物/声纹列表。
 * @returns {Array}
 */
function readSpeakers() {
  return store.readJSON("speakers.json");
}

/**
 * 写回人物/声纹列表。
 * @param {Array} speakers
 */
function writeSpeakers(speakers) {
  store.writeJSON("speakers.json", speakers);
}

/**
 * 将上传的声纹样本归一化为大模型声纹接口所需的音频载荷。
 * @param {Express.Multer.File} file
 * @returns {{audioBase64: string, audioType: string, durationSeconds: number|null}}
 */
function fileToVoiceprintPayload(file) {
  if (!Buffer.isBuffer(file?.buffer)) {
    return { audioBase64: "", audioType: "raw", durationSeconds: null };
  }
  return normalizeVoiceprintAudio(file.buffer);
}

/* ───────── 语音转写（本地 Whisper 常驻进程 —— 离线兜底） ───────── */
let whisperProc = null;
let whisperReady = null;
const whisperQueue = [];

function ensureWhisper() {
  if (whisperProc && whisperReady) return whisperReady;

  whisperReady = new Promise((resolveReady) => {
    const script = path.join(__dirname, "transcribe_server.py");
    whisperProc = spawn("python3", ["-u", script], {
      env: { ...process.env, HF_ENDPOINT: "https://hf-mirror.com" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    whisperProc.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.status === "ready") {
            console.log("Whisper 模型已就绪（离线兜底）");
            resolveReady();
            continue;
          }
          if (whisperQueue.length) whisperQueue.shift()(msg.text);
        } catch {}
      }
    });

    whisperProc.stderr.on("data", (d) =>
      console.error("whisper:", d.toString().trim())
    );

    whisperProc.on("close", () => {
      whisperProc = null;
      whisperReady = null;
      while (whisperQueue.length) whisperQueue.shift()("（转写服务已关闭）");
    });
  });

  return whisperReady;
}

async function transcribe(wavPath) {
  await ensureWhisper();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("（转写超时）"), 60_000);
    whisperQueue.push((text) => {
      clearTimeout(timeout);
      resolve(text || "（未识别到清晰语音）");
    });
    whisperProc.stdin.write(wavPath + "\n");
  });
}

/* ───────── Kaleido Token ───────── */
async function getToken() {
  const { authUrl, appCode, appSecret } = getKaleidoConfig();
  const tokenKey = `${authUrl}:${appCode}:${appSecret}`;
  if (cachedToken && cachedTokenKey === tokenKey && Date.now() < tokenExpiresAt) return cachedToken;
  const resp = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_code: appCode, app_secret: appSecret }),
  });
  const data = await resp.json();
  if (data.err_code !== 0)
    throw new Error(`获取token失败: ${data.err_message}`);
  cachedToken = data.body.token;
  cachedTokenKey = tokenKey;
  tokenExpiresAt = Date.now() + (data.body.expiration_time - 60) * 1000;
  return cachedToken;
}

async function callKaleidoPost(url, text, token) {
  let fullUrl = url.trim();
  if (fullUrl.endsWith("content="))
    fullUrl += encodeURIComponent(text);
  else if (fullUrl.includes("?"))
    fullUrl += `&content=${encodeURIComponent(text)}`;
  else fullUrl += `?content=${encodeURIComponent(text)}`;
  const resp = await fetch(fullUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", token },
    body: "{}",
  });
  return await resp.json();
}

function extractReplyContent(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (typeof body.content === "string") return body.content;
  return JSON.stringify(body);
}

async function callTaskAgent(text) {
  const { agentUrl, appCode, appSecret } = getKaleidoConfig();
  if (!agentUrl || !appCode || !appSecret) return { agentReply: null };
  const token = await getToken();
  const data = await callKaleidoPost(agentUrl, text, token);
  if (data.err_code && data.err_code !== 0)
    return { agentReply: null, error: data.err_message };
  const reply = extractReplyContent(data.body);
  return { agentReply: reply };
}

/* ═══════════════════════════════════════════
   截图功能
   ═══════════════════════════════════════════ */
function takeScreenshot() {
  return new Promise((resolve, reject) => {
    if (getRuntimeMode() !== "electron") {
      reject(new Error("截图功能仅在桌面版可用"));
      return;
    }

    const id = store.generateId();
    const filename = `screenshot_${Date.now()}.png`;
    const filepath = path.join(store.SCREENSHOTS_DIR, filename);

    emitter.emit("take-screenshot", {
      savePath: filepath,
      callback(err) {
        if (err) return reject(err);
        const record = {
          id,
          filename,
          description: "",
          createdAt: new Date().toISOString(),
        };
        const list = store.readJSON("screenshots.json");
        list.unshift(record);
        store.writeJSON("screenshots.json", list);
        store.logActivity("screenshot", "屏幕截图", filename);
        resolve(record);
      },
    });
  });
}

/* ═══════════════════════════════════════════
   计算器
   ═══════════════════════════════════════════ */
function safeCalculate(expr) {
  let e = expr
    .replace(/[×✕]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/加/g, "+")
    .replace(/减/g, "-")
    .replace(/乘以?/g, "*")
    .replace(/除以?/g, "/")
    .replace(/的平方/g, "**2")
    .replace(/的立方/g, "**3")
    .replace(/平方根/g, "Math.sqrt")
    .replace(/[^\d+\-*/().%\s**Math.sqrtpowlogPI]/gi, "");

  if (/[a-zA-Z]/.test(e.replace(/Math\.\w+/g, "").replace(/PI/g, "")))
    throw new Error("不支持的表达式");

  e = e.replace(/PI/g, "Math.PI");
  const result = Function('"use strict"; return (' + e + ")")();
  if (!isFinite(result)) throw new Error("计算结果无效");
  return result;
}

/* ═══════════════════════════════════════════
   闹钟 / 定时器
   ═══════════════════════════════════════════ */
const activeTimers = new Map();

function scheduleAlarm(alarm) {
  const delay = new Date(alarm.time).getTime() - Date.now();
  if (delay <= 0) return;
  const timer = setTimeout(() => {
    emitter.emit("notify", { title: "闹钟提醒", body: alarm.title });
    emitter.emit("alarm-triggered", { id: alarm.id, title: alarm.title });
    const alarms = store.readJSON("alarms.json");
    const idx = alarms.findIndex((a) => a.id === alarm.id);
    if (idx !== -1) {
      alarms[idx].triggered = true;
      store.writeJSON("alarms.json", alarms);
    }
    activeTimers.delete(alarm.id);
    store.logActivity("alarm", "闹钟响铃", alarm.title);
  }, delay);
  activeTimers.set(alarm.id, timer);
}

function restoreAlarms() {
  store
    .readJSON("alarms.json")
    .filter((a) => !a.triggered && new Date(a.time) > new Date())
    .forEach(scheduleAlarm);
}

/* ═══════════════════════════════════════════
   命令执行（导出给 ws-server 使用）
   ═══════════════════════════════════════════ */
async function executeCommand(cmd, originalText) {
  switch (cmd.intent) {
    case "screenshot": {
      const rec = await takeScreenshot();
      return { action: "screenshot", message: "截图已保存", data: rec };
    }
    case "calculator": {
      const expr = cmd.params.expression;
      const result = safeCalculate(expr);
      const record = {
        id: store.generateId(),
        expression: expr,
        result: String(result),
        createdAt: new Date().toISOString(),
      };
      const hist = store.readJSON("calc-history.json");
      hist.unshift(record);
      if (hist.length > 100) hist.length = 100;
      store.writeJSON("calc-history.json", hist);
      store.logActivity("calculator", `${expr} = ${result}`);
      return {
        action: "calculator",
        message: `${expr} = ${result}`,
        data: record,
      };
    }
    case "alarm":
    case "pomodoro": {
      const minutes = cmd.params.minutes;
      const title = cmd.params.title;
      const alarm = {
        id: store.generateId(),
        title,
        minutes,
        time: new Date(Date.now() + minutes * 60000).toISOString(),
        type: cmd.intent === "pomodoro" ? "pomodoro" : "alarm",
        triggered: false,
        createdAt: new Date().toISOString(),
      };
      const alarms = store.readJSON("alarms.json");
      alarms.unshift(alarm);
      store.writeJSON("alarms.json", alarms);
      scheduleAlarm(alarm);
      const timeDesc = minutes >= 1
        ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`
        : `${Math.round(minutes * 60)} 秒`;
      const label =
        cmd.intent === "pomodoro"
          ? `专注 ${timeDesc}已开始`
          : `${timeDesc}后提醒：${title}`;
      store.logActivity("alarm", label, title);
      return { action: cmd.intent, message: label, data: alarm };
    }
    case "agent_task": {
      const taskTitle = cmd.params.title || "未命名任务";
      const taskType = cmd.params.type || "task";

      const task = {
        id: store.generateId(),
        title: taskTitle,
        description: cmd.params.text,
        status: "pending",
        priority: taskType === "bug" ? "high" : "medium",
        type: taskType,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      const tasks = store.readJSON("tasks.json");
      tasks.unshift(task);
      store.writeJSON("tasks.json", tasks);

      let agentReply = "";
      try {
        const agentResult = await callTaskAgent(cmd.params.text);
        agentReply = agentResult.agentReply || "";
        if (agentReply) {
          task.agentReply = agentReply;
          const updated = store.readJSON("tasks.json");
          const idx = updated.findIndex((t) => t.id === task.id);
          if (idx !== -1) {
            updated[idx].agentReply = agentReply;
            store.writeJSON("tasks.json", updated);
          }
        }
      } catch {}

      const label = taskType === "bug" ? "创建Bug" : "创建任务";
      store.logActivity("task", label, taskTitle);
      return {
        action: "agent_task",
        message: `${label}：${taskTitle}`,
        data: task,
      };
    }
    case "task_done": {
      const tasks = store.readJSON("tasks.json");
      const kw = cmd.params.keyword;
      const idx = tasks.findIndex(
        (t) => t.status !== "done" && t.title.includes(kw)
      );
      if (idx === -1)
        return { action: "task_done", message: `未找到匹配的任务：${kw}` };
      tasks[idx].status = "done";
      tasks[idx].completedAt = new Date().toISOString();
      store.writeJSON("tasks.json", tasks);
      store.logActivity("task", "完成任务", tasks[idx].title);
      return {
        action: "task_done",
        message: `任务已完成：${tasks[idx].title}`,
        data: tasks[idx],
      };
    }
    case "note": {
      const note = {
        id: store.generateId(),
        title: "",
        content: cmd.params.content || originalText,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const notes = store.readJSON("notes.json");
      notes.unshift(note);
      store.writeJSON("notes.json", notes);
      store.logActivity("note", "新建笔记", note.content.slice(0, 50));
      return { action: "note", message: "笔记已保存", data: note };
    }
    case "dashboard": {
      emitter.emit("open-dashboard");
      return { action: "dashboard", message: "正在打开仪表盘" };
    }
    case "unknown":
      return { action: "unknown", message: "未识别到有效指令" };
    default:
      return { action: "none", message: "" };
  }
}

/* ═══════════════════════════════════════════
   API 路由 — 录音 & 语音命令（本地 Whisper 兜底）
   ═══════════════════════════════════════════ */
app.post("/api/save", upload.single("audio"), async (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false, message: "缺少音频文件" });

  const wavPath = req.file.path;
  let text;
  try {
    text = await transcribe(wavPath);
  } catch {
    text = "（转写失败）";
  }

  const cmd = parseCommand(text);
  let commandResult = null;
  let agent = null;

  if (cmd.intent !== "none") {
    try {
      commandResult = await executeCommand(cmd, text);
      if (cmd.intent === "agent" && commandResult.data) {
        agent = commandResult.data;
        commandResult = null;
      }
    } catch (e) {
      commandResult = { action: cmd.intent, message: `执行失败：${e.message}` };
    }
  }

  const record = {
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    wav: req.file.filename,
    text,
    command: commandResult || undefined,
    agent: agent || undefined,
  };
  record.meetingSummary = createInitialMeetingSummary(record);
  fs.appendFileSync(TRANSCRIPT_LOG, JSON.stringify(record) + "\n", "utf-8");
  triggerMeetingSummary(record);

  if (text && !text.startsWith("（")) {
    store.logActivity("recording", "语音录入", text.slice(0, 60));
  }

  res.json({ success: true, ...record });
});

/* ─── 文本直接执行命令 ─── */
app.post("/api/command", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ success: false, message: "缺少文本" });

  const cmd = parseCommand(text);
  let commandResult = null;
  let agent = null;

  if (cmd.intent !== "none") {
    try {
      commandResult = await executeCommand(cmd, text);
      if (cmd.intent === "agent" && commandResult.data) {
        agent = commandResult.data;
        commandResult = null;
      }
    } catch (e) {
      commandResult = { action: cmd.intent, message: `执行失败：${e.message}` };
    }
  }

  const record = {
    time: new Date().toLocaleString("zh-CN", { hour12: false }),
    text,
    source: "realtime",
    command: commandResult || undefined,
    agent: agent || undefined,
  };
  fs.appendFileSync(TRANSCRIPT_LOG, JSON.stringify(record) + "\n", "utf-8");

  if (text && !text.startsWith("（")) {
    store.logActivity("recording", "语音指令", text.slice(0, 60));
  }

  res.json({ success: true, ...record });
});

/* ─── 仅归档音频 ─── */
app.post("/api/save-audio", upload.single("audio"), (req, res) => {
  if (!req.file)
    return res.status(400).json({ success: false });
  res.json({ success: true, wav: req.file.filename });
});

/* ─── 会议助手配置 ─── */
function isValidMeetingAssistantBaseUrl(value) {
  // Base URL 允许留空走兜底；填写时必须是 http(s) 源地址，避免后续拼接口路径失败。
  if (!String(value || "").trim()) return true;
  try {
    const url = new URL(String(value).trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/* ───────── 设置（界面编辑 .env） ───────── */
app.get("/api/settings", (_req, res) => {
  res.json(envSettings.readSettings());
});

app.put("/api/settings", (req, res) => {
  try {
    res.json({ success: true, data: envSettings.updateSettings(req.body?.values) });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false,
      message: err.status ? err.message : `保存失败：${err.message}`,
      data: envSettings.readSettings(),
    });
  }
});

app.get("/api/meeting-assistant/config", (_req, res) => {
  res.json(store.maskMeetingAssistantConfig());
});

app.put("/api/meeting-assistant/config", (req, res) => {
  const { enabled, baseUrl, appCode, appSecret, agentMatchFlowPath } = req.body || {};

  if (baseUrl !== undefined && !isValidMeetingAssistantBaseUrl(baseUrl)) {
    return res.status(400).json({
      success: false,
      message: "API Base URL 必须是 http 或 https 地址",
      data: store.maskMeetingAssistantConfig(),
    });
  }

  const patch = { baseUrl, appCode, agentMatchFlowPath };
  // 前端回显的是打码串；只有用户真的重新输入时才覆盖已保存的 AppSecret。
  if (typeof appSecret === "string" && appSecret.trim() && !/^\*+/.test(appSecret)) {
    patch.appSecret = appSecret;
  }
  if (enabled !== undefined) patch.enabled = enabled === true;

  const merged = store.writeMeetingAssistantConfig(patch);

  // 开启时必须三项齐全，否则录音时才发现没配会很晚。
  if (merged.enabled) {
    const missing = [];
    if (!merged.appCode) missing.push("AppCode");
    if (!merged.appSecret) missing.push("AppSecret");
    if (!merged.agentMatchFlowPath) missing.push("AgentMatchFlowPath");
    if (missing.length > 0) {
      // 配置不全就不要停留在"已开启"状态，回滚开关但保留用户已填的内容。
      store.writeMeetingAssistantConfig({ enabled: false });
      return res.status(400).json({
        success: false,
        message: `缺少 ${missing.join("、")}，无法开启会议助手`,
        data: store.maskMeetingAssistantConfig(),
      });
    }
  }

  store.logActivity(
    "recording",
    merged.enabled ? "开启会议助手" : "关闭会议助手",
    merged.agentMatchFlowPath ? `Flow: ${merged.agentMatchFlowPath}` : ""
  );
  res.json({ success: true, data: store.maskMeetingAssistantConfig(merged) });
});

/* ─── 录音列表 ─── */
app.get("/api/recordings", (_req, res) => {
  res.json(store.readTranscripts());
});

/**
 * 清空全部录音记录及其音频文件。
 * 只删被记录引用到的 wav：正在录制的会话已经打开了一个还没写进索引的文件，
 * 直接清空目录会把它一起删掉。
 */
app.delete("/api/recordings/all", (_req, res) => {
  const result = store.clearTranscripts();
  let audioRemoved = 0;

  for (const record of result.data) {
    if (!record.wav) continue;
    const wavPath = store.resolveRecordingPath(record.wav);
    if (!wavPath || !fs.existsSync(wavPath)) continue;
    try {
      fs.unlinkSync(wavPath);
      audioRemoved += 1;
    } catch (error) {
      console.error("删除录音文件失败:", record.wav, error.message);
    }
  }

  if (result.data.length > 0) {
    store.logActivity("recording", "清空录音", `共 ${result.data.length} 条`);
  }
  res.json({ success: true, removed: result.data.length, audioRemoved });
});

/**
 * 删除一条录音记录及其音频文件。
 * 用请求体传标识而不是路径参数：没采到音频的记录 wav 为 null，无法拼进 URL。
 */
app.delete("/api/recordings", (req, res) => {
  const { wav, time } = req.body || {};
  const result = store.deleteTranscriptRecord({ wav, time });
  if (!result.ok) {
    return res.status(404).json({ success: false, message: result.message });
  }

  let audioRemoved = false;
  if (result.data.wav) {
    // wav 名来自客户端，必须先归一化到 recordings 目录内再删。
    const wavPath = store.resolveRecordingPath(result.data.wav);
    if (wavPath && fs.existsSync(wavPath)) {
      try {
        fs.unlinkSync(wavPath);
        audioRemoved = true;
      } catch (error) {
        console.error("删除录音文件失败:", error.message);
      }
    }
  }

  store.logActivity(
    "recording",
    "删除录音",
    `${result.data.wav || result.data.time || ""}`.slice(0, 80)
  );
  res.json({ success: true, audioRemoved });
});

app.put("/api/recordings/:wav/speakers", (req, res) => {
  const { speakerId, name } = req.body || {};
  const result = store.updateTranscriptSpeakerLabel(req.params.wav, speakerId, name);
  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.message });
  }
  store.logActivity("recording", "标注说话人", `${req.params.wav}：${name}`);
  res.json({ success: true, data: result.data });
});

app.post("/api/recordings/:wav/meeting-summary/retry", async (req, res) => {
  const record = store.readTranscripts().find((item) => item.wav === req.params.wav);
  if (!record) {
    return res.status(404).json({ success: false, message: "未找到录音记录" });
  }
  const pending = {
    status: "pending",
    message: "会议总结生成中",
    updatedAt: new Date().toISOString(),
  };
  store.updateTranscriptMeetingSummary(req.params.wav, pending);
  const meetingSummary = await summarizeAndPersist({ ...record, meetingSummary: pending });
  if (meetingSummary.status === "failed") {
    return res.status(502).json({ success: false, message: meetingSummary.message, data: meetingSummary });
  }
  res.json({ success: true, data: meetingSummary });
});

app.post("/api/meeting-summary", async (req, res) => {
  const wavs = Array.isArray(req.body?.wavs) ? req.body.wavs.map(String) : [];
  const selected = store.readTranscripts().filter((record) => wavs.includes(record.wav));
  if (!selected.length) {
    return res.status(400).json({ success: false, message: "请选择需要总结的录音" });
  }

  const batchRecord = buildBatchMeetingSummaryRecord(selected);
  const meetingSummary = await requestMeetingSummary(batchRecord);
  if (meetingSummary.status === "failed") {
    return res.status(502).json({ success: false, message: meetingSummary.message, data: meetingSummary });
  }
  if (meetingSummary.status === "skipped") {
    return res.status(400).json({ success: false, message: meetingSummary.message, data: meetingSummary });
  }
  res.json({ success: true, data: meetingSummary, recordings: selected.map((item) => item.wav) });
});

/* ═══════════════════════════════════════════
   API 路由 — 人物 / 声纹
   ═══════════════════════════════════════════ */
app.get("/api/speakers", (_req, res) => {
  const speakers = readSpeakers();
  const voiceprintConfigReady = !validateOfficeVoiceprintConfig();
  res.json({ data: speakers, meta: { voiceprintConfigReady } });
});

app.post("/api/speakers", (req, res) => {
  const { name, role } = req.body || {};
  const trimmedName = String(name || "").trim();
  if (!trimmedName) {
    return res.status(400).json({ success: false, message: "缺少人物名称" });
  }

  const speakers = readSpeakers();
  const speaker = {
    id: store.generateId(),
    name: trimmedName,
    role: String(role || "").trim(),
    provider: "xfyun",
    featureId: "",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  speakers.unshift(speaker);
  writeSpeakers(speakers);
  res.json({ success: true, data: speaker });
});

app.put("/api/speakers/:id", (req, res) => {
  const speakers = readSpeakers();
  const idx = speakers.findIndex((item) => item.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "未找到对应人物" });
  }

  const name = req.body?.name;
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ success: false, message: "人物名称不能为空" });
  }

  speakers[idx] = {
    ...speakers[idx],
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  writeSpeakers(speakers);
  res.json({ success: true, data: speakers[idx] });
});

app.delete("/api/speakers/:id", async (req, res) => {
  const speakers = readSpeakers();
  const idx = speakers.findIndex((item) => item.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "未找到对应人物" });
  }

  const [removed] = speakers.splice(idx, 1);
  writeSpeakers(speakers);

  // 若人物已绑定大模型声纹，尽量同步清理远端声纹，失败也不阻塞本地删除。
  if (removed.featureId) {
    try {
      await deleteOfficeVoiceprints({ featureIds: [removed.featureId] });
    } catch {}
  }

  res.json({ success: true, data: removed });
});

app.post("/api/speakers/:id/enroll", voiceprintUpload.single("audio"), async (req, res) => {
  const speakers = readSpeakers();
  const idx = speakers.findIndex((item) => item.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "未找到对应人物" });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: "缺少声纹样本音频" });
  }

  // 若已有旧声纹，先尝试删除（忽略失败，避免注册失败时丢失本地人物）。
  if (speakers[idx].featureId) {
    try { await deleteOfficeVoiceprints({ featureIds: [speakers[idx].featureId] }); } catch {}
  }

  const voiceprintPayload = fileToVoiceprintPayload(req.file);
  const result = await registerOfficeVoiceprint({
    audioBase64: voiceprintPayload.audioBase64,
    audioType: voiceprintPayload.audioType,
    // uid 使用本地人物 ID，方便在讯飞侧排查注册来源。
    uid: speakers[idx].id,
  });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.message, raw: result.raw });
  }
  const featureId = result.data?.feature_id || result.data?.featureId;
  if (!featureId) {
    return res.status(400).json({ success: false, message: "大模型声纹接口未返回 feature_id", raw: result.raw });
  }

  speakers[idx] = {
    ...speakers[idx],
    featureId,
    provider: "xfyun_llm",
    updatedAt: new Date().toISOString(),
  };
  writeSpeakers(speakers);
  res.json({ success: true, data: speakers[idx], remote: result.data });
});

app.post("/api/speakers/:id/update-voiceprint", voiceprintUpload.single("audio"), async (req, res) => {
  const speakers = readSpeakers();
  const idx = speakers.findIndex((item) => item.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "未找到对应人物" });
  }
  if (!req.file) {
    return res.status(400).json({ success: false, message: "缺少声纹样本音频" });
  }
  if (!speakers[idx].featureId) {
    return res.status(400).json({ success: false, message: "当前人物尚未注册声纹" });
  }

  const voiceprintPayload = fileToVoiceprintPayload(req.file);
  const result = await updateOfficeVoiceprint({
    featureId: speakers[idx].featureId,
    audioBase64: voiceprintPayload.audioBase64,
    audioType: voiceprintPayload.audioType,
  });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.message, raw: result.raw });
  }

  speakers[idx] = {
    ...speakers[idx],
    updatedAt: new Date().toISOString(),
  };
  writeSpeakers(speakers);
  res.json({ success: true, data: speakers[idx], remote: result.data });
});

app.delete("/api/speakers/:id/voiceprint", async (req, res) => {
  const speakers = readSpeakers();
  const idx = speakers.findIndex((item) => item.id === req.params.id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "未找到对应人物" });
  }
  if (!speakers[idx].featureId) {
    return res.status(400).json({ success: false, message: "当前人物没有可删除的声纹" });
  }

  const result = await deleteOfficeVoiceprints({ featureIds: [speakers[idx].featureId] });
  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.message, raw: result.raw });
  }

  speakers[idx] = {
    ...speakers[idx],
    featureId: "",
    updatedAt: new Date().toISOString(),
  };
  writeSpeakers(speakers);
  res.json({ success: true, data: speakers[idx] });
});

/* ═══════════════════════════════════════════
   API 路由 — 截图
   ═══════════════════════════════════════════ */
app.post("/api/screenshot", async (_req, res) => {
  try {
    const rec = await takeScreenshot();
    res.json({ success: true, data: rec });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

app.get("/api/screenshots", (_req, res) => {
  res.json(store.readJSON("screenshots.json"));
});

app.delete("/api/screenshots/:id", (req, res) => {
  const list = store.readJSON("screenshots.json");
  const idx = list.findIndex((s) => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  const [removed] = list.splice(idx, 1);
  store.writeJSON("screenshots.json", list);
  const fp = path.join(store.SCREENSHOTS_DIR, removed.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ success: true });
});

/* ═══════════════════════════════════════════
   API 路由 — 笔记
   ═══════════════════════════════════════════ */
app.get("/api/notes", (_req, res) => {
  res.json(store.readJSON("notes.json"));
});

app.post("/api/notes", (req, res) => {
  const { title, content } = req.body;
  const note = {
    id: store.generateId(),
    title: title || "",
    content: content || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const list = store.readJSON("notes.json");
  list.unshift(note);
  store.writeJSON("notes.json", list);
  store.logActivity("note", "新建笔记", (content || "").slice(0, 50));
  res.json({ success: true, data: note });
});

app.put("/api/notes/:id", (req, res) => {
  const list = store.readJSON("notes.json");
  const idx = list.findIndex((n) => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  Object.assign(list[idx], req.body, { updatedAt: new Date().toISOString() });
  store.writeJSON("notes.json", list);
  res.json({ success: true, data: list[idx] });
});

app.delete("/api/notes/:id", (req, res) => {
  const list = store.readJSON("notes.json");
  const idx = list.findIndex((n) => n.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  list.splice(idx, 1);
  store.writeJSON("notes.json", list);
  res.json({ success: true });
});

/* ═══════════════════════════════════════════
   API 路由 — 任务
   ═══════════════════════════════════════════ */
app.get("/api/tasks", (_req, res) => {
  res.json(store.readJSON("tasks.json"));
});

app.post("/api/tasks", (req, res) => {
  const { title, description, priority } = req.body;
  const task = {
    id: store.generateId(),
    title: title || "未命名任务",
    description: description || "",
    status: "pending",
    priority: priority || "medium",
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  const list = store.readJSON("tasks.json");
  list.unshift(task);
  store.writeJSON("tasks.json", list);
  store.logActivity("task", "创建任务", task.title);
  res.json({ success: true, data: task });
});

app.put("/api/tasks/:id", (req, res) => {
  const list = store.readJSON("tasks.json");
  const idx = list.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  const prev = list[idx].status;
  Object.assign(list[idx], req.body);
  if (req.body.status === "done" && prev !== "done") {
    list[idx].completedAt = new Date().toISOString();
    store.logActivity("task", "完成任务", list[idx].title);
  }
  store.writeJSON("tasks.json", list);
  res.json({ success: true, data: list[idx] });
});

app.delete("/api/tasks/:id", (req, res) => {
  const list = store.readJSON("tasks.json");
  const idx = list.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  list.splice(idx, 1);
  store.writeJSON("tasks.json", list);
  res.json({ success: true });
});

/* ═══════════════════════════════════════════
   API 路由 — 闹钟
   ═══════════════════════════════════════════ */
app.get("/api/alarms", (_req, res) => {
  res.json(store.readJSON("alarms.json"));
});

app.post("/api/alarms", (req, res) => {
  const { title, minutes, type } = req.body;
  const alarm = {
    id: store.generateId(),
    title: title || "定时提醒",
    minutes: minutes || 5,
    time: new Date(Date.now() + (minutes || 5) * 60000).toISOString(),
    type: type || "alarm",
    triggered: false,
    createdAt: new Date().toISOString(),
  };
  const list = store.readJSON("alarms.json");
  list.unshift(alarm);
  store.writeJSON("alarms.json", list);
  scheduleAlarm(alarm);
  store.logActivity("alarm", `设置${alarm.type === "pomodoro" ? "番茄钟" : "闹钟"}`, `${minutes}分钟 - ${title}`);
  res.json({ success: true, data: alarm });
});

app.delete("/api/alarms/:id", (req, res) => {
  const list = store.readJSON("alarms.json");
  const idx = list.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  const timer = activeTimers.get(req.params.id);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(req.params.id);
  }
  list.splice(idx, 1);
  store.writeJSON("alarms.json", list);
  res.json({ success: true });
});

/* ═══════════════════════════════════════════
   API 路由 — 计算器
   ═══════════════════════════════════════════ */
app.post("/api/calculate", (req, res) => {
  try {
    const { expression } = req.body;
    const result = safeCalculate(expression);
    const record = {
      id: store.generateId(),
      expression,
      result: String(result),
      createdAt: new Date().toISOString(),
    };
    const hist = store.readJSON("calc-history.json");
    hist.unshift(record);
    if (hist.length > 100) hist.length = 100;
    store.writeJSON("calc-history.json", hist);
    store.logActivity("calculator", `${expression} = ${result}`);
    res.json({ success: true, data: record });
  } catch (e) {
    res.status(400).json({ success: false, message: e.message });
  }
});

app.get("/api/calculator/history", (_req, res) => {
  res.json(store.readJSON("calc-history.json"));
});

/* ═══════════════════════════════════════════
   API 路由 — 活动 & 搜索 & 统计
   ═══════════════════════════════════════════ */
app.get("/api/activities", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const list = store.readJSON("activities.json");
  res.json(list.slice(0, limit));
});

app.get("/api/stats", (_req, res) => {
  res.json({
    recordings: store.readTranscripts().length,
    screenshots: store.readJSON("screenshots.json").length,
    notes: store.readJSON("notes.json").length,
    tasks: store.readJSON("tasks.json").length,
    tasksDone: store.readJSON("tasks.json").filter((t) => t.status === "done")
      .length,
    alarms: store.readJSON("alarms.json").length,
  });
});

app.get("/api/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  if (!q) return res.json([]);

  const results = [];

  store.readTranscripts().forEach((r) => {
    if ((r.text || "").toLowerCase().includes(q))
      results.push({ type: "recording", title: r.text, time: r.time, data: r });
  });
  store.readJSON("notes.json").forEach((n) => {
    if (
      (n.content || "").toLowerCase().includes(q) ||
      (n.title || "").toLowerCase().includes(q)
    )
      results.push({
        type: "note",
        title: n.title || n.content.slice(0, 40),
        time: n.createdAt,
        data: n,
      });
  });
  store.readJSON("tasks.json").forEach((t) => {
    if ((t.title || "").toLowerCase().includes(q))
      results.push({ type: "task", title: t.title, time: t.createdAt, data: t });
  });

  res.json(results.slice(0, 50));
});

/* ─── 仪表盘页面 ─── */
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(PROJECT_ROOT, "public", "dashboard.html"));
});

/* ═══════════════════════════════════════════
   启动
   ═══════════════════════════════════════════ */
function start(port = process.env.PORT || 3456, host = process.env.HOST || "") {
  restoreAlarms();
  ensureWhisper();

  // 大模型声纹接口不需要预创建特征库；启动时只提示配置状态。
  const voiceprintConfigError = validateOfficeVoiceprintConfig();
  if (voiceprintConfigError) {
    console.warn("[voiceprint] 大模型声纹配置未就绪:", voiceprintConfigError);
  } else {
    console.log("[voiceprint] 大模型声纹配置就绪");
  }

  const normalizedPort = Number(port) || 3456;
  const onListening = () => {
    const displayHost = host && host !== "0.0.0.0" ? host : "localhost";
    console.log(`录音助手已启动: http://${displayHost}:${normalizedPort}`);
    if (host === "0.0.0.0") {
      console.log(`局域网访问: http://<本机局域网IP>:${normalizedPort}`);
    }
  };

  const httpServer = host
    ? app.listen(normalizedPort, host, onListening)
    : app.listen(normalizedPort, onListening);

  initWebSocket(httpServer, executeCommand, emitter);
  return httpServer;
}

if (require.main === module) {
  start();
}

module.exports = { start, emitter, getRuntimeCapabilities };
