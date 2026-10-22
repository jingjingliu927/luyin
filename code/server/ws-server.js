const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { AsrSession } = require("./asr-stream");
const { DEFAULT_FUNASR_WS_URL, FunAsrSession } = require("./asr-stream-funasr");
const { XfyunAsrSession } = require("./asr-stream-xfyun");
const { XfyunLlmAsrSession } = require("./asr-stream-xfyun-llm");
const { parseCommand } = require("./command-router");
const { createWavWriter } = require("./audio-utils");
const { createRealtimeSpeakerDiarizer } = require("./speaker-diarizer");
const { searchFea } = require("./xfyun-voiceprint");
const store = require("./store");
const {
  createInitialMeetingSummary,
  triggerMeetingSummary,
} = require("./meeting-summary");
const { BachAgentSession } = require("./bach-agent-client");

const TRANSCRIPT_LOG = path.join(store.RECORDINGS_DIR, "transcripts.jsonl");
const SPEAKERS_FILE = "speakers.json";
// 前端固定以 16kHz / 16bit / 单声道 PCM 推流，写盘与本地分人都以此为准。
const SESSION_SAMPLE_RATE = 16000;

/**
 * 生成 record_YYYYMMDD_HHmmss 形式的时间戳，用于录音文件名。
 * @param {Date} date
 * @returns {string}
 */
function formatRecordingTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}
// 单场会议在快照里最多保留的逐句条目数。
const MEETING_ASSISTANT_MAX_ITEMS = 200;

// 1:N 搜索认人的分数阈值，≥ 该分数才认为匹配成功（文档建议 0.6~1）。
// 用到时再读，「设置」页改完下一次认人即生效。
function getVpMatchThreshold() {
  const value = Number(process.env.XFYUN_VP_MATCH_THRESHOLD || 0.6);
  return Number.isFinite(value) ? value : 0.6;
}

function loadRegisteredSpeakers() {
  const speakers = store.readJSON(SPEAKERS_FILE);
  const featureIdToName = new Map();
  const featureIds = [];
  const llmFeatureIds = [];
  for (const sp of speakers) {
    if (sp.status === "active" && sp.featureId) {
      featureIds.push(sp.featureId);
      featureIdToName.set(sp.featureId, sp.name || sp.id);
      // 只有大模型声纹接口返回的 feature_id 才能传给 xfyun_llm 实时转写。
      if (sp.provider === "xfyun_llm") {
        llmFeatureIds.push(sp.featureId);
      }
    }
  }
  return { featureIdToName, featureIds, llmFeatureIds };
}

function buildDiarizerOptionsFromEnv() {
  // 通过环境变量切换本地说话人分离策略，避免每次都改代码。
  const profile = String(process.env.SPEAKER_PROFILE || "multi").toLowerCase();
  const base = { sampleRate: 16000 };
  if (profile === "single") {
    return {
      ...base,
      // 单人稳定：更难触发"新说话人"。
      matchThreshold: 0.2,
      minNewClusterHits: 4,
      pendingFeatureThreshold: 0.1,
      minVoiceRms: 0.03,
    };
  }
  if (profile === "balanced") {
    return {
      ...base,
      // 平衡模式：在误分与漏分之间取中值。
      matchThreshold: 0.17,
      minNewClusterHits: 3,
      pendingFeatureThreshold: 0.14,
      minVoiceRms: 0.028,
    };
  }
  return {
    ...base,
    // 多人优先：更快切换到新说话人。
    matchThreshold: 0.15,
    minNewClusterHits: 2,
    pendingFeatureThreshold: 0.18,
    minVoiceRms: 0.028,
  };
}

function hasXfyunRealtimeConfig() {
  return Boolean(process.env.XFYUN_APP_ID && process.env.XFYUN_API_KEY);
}

function hasXfyunLlmRealtimeConfig() {
  return Boolean(
    process.env.XFYUN_APP_ID &&
    process.env.XFYUN_ACCESS_KEY_ID &&
    process.env.XFYUN_ACCESS_KEY_SECRET
  );
}

function createXfyunRealtimeSession(commonCallbacks) {
  const appId = process.env.XFYUN_APP_ID;
  const apiKey = process.env.XFYUN_API_KEY;
  if (!appId || !apiKey) return null;

  return new XfyunAsrSession(appId, apiKey, {
    // lang / punc / pd / roleType 等参数均按讯飞 RTASR 文档透传。
    lang: process.env.XFYUN_LANG || "cn",
    punc: process.env.XFYUN_PUNC,
    pd: process.env.XFYUN_PD,
    vadMdn: process.env.XFYUN_VAD_MDN,
    roleType: process.env.XFYUN_ROLE_TYPE,
    engLangType: process.env.XFYUN_ENG_LANG_TYPE,
    onReady: commonCallbacks.onReady,
    onPartialResult: commonCallbacks.onPartialResult,
    onSentenceEnd: commonCallbacks.onSentenceEnd,
    onError: commonCallbacks.onError,
    onCompleted: commonCallbacks.onCompleted,
  });
}

function createXfyunLlmRealtimeSession(commonCallbacks, registered) {
  const appId = process.env.XFYUN_APP_ID;
  const accessKeyId = process.env.XFYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.XFYUN_ACCESS_KEY_SECRET;
  if (!appId || !accessKeyId || !accessKeySecret) return null;

  const voiceprintFeatureIds = registered.llmFeatureIds;
  // 文档要求 role_type=2 时 feature_ids 才生效；但返回的 role_N 只是角色编号，不能按列表顺序硬映射姓名。
  if (voiceprintFeatureIds.length > 0) {
    console.log(
      `[xfyun_llm] 已加载 ${voiceprintFeatureIds.length} 个大模型声纹，将通过 feature_ids 参与角色分离`
    );
  } else {
    console.log("[xfyun_llm] 无已注册声纹，将仅做盲分。");
  }

  return new XfyunLlmAsrSession({
    appId,
    accessKeyId,
    accessKeySecret,
    // 向大模型实时转写传入已注册声纹，服务端才有机会返回可映射到姓名的角色。
    featureIds: voiceprintFeatureIds,
    lang: process.env.XFYUN_LLM_LANG || "autodialect",
    audioEncode: process.env.XFYUN_LLM_AUDIO_ENCODE || "pcm_s16le",
    sampleRate: Number(process.env.XFYUN_LLM_SAMPLE_RATE || 16000),
    roleType: process.env.XFYUN_LLM_ROLE_TYPE || 2,
    // 未显式配置时，存在声纹就启用声纹库角色匹配。
    engSpkMatch: process.env.XFYUN_LLM_ENG_SPK_MATCH || (voiceprintFeatureIds.length > 0 ? 1 : undefined),
    pd: process.env.XFYUN_LLM_PD,
    engPunc: process.env.XFYUN_LLM_PUNC,
    engVadMdn: process.env.XFYUN_LLM_VAD_MDN,
    onReady: commonCallbacks.onReady,
    onPartialResult: commonCallbacks.onPartialResult,
    onSentenceEnd: commonCallbacks.onSentenceEnd,
    onError: commonCallbacks.onError,
    onCompleted: commonCallbacks.onCompleted,
  });
}

function getFunAsrFallbackProviders() {
  const providers = [];
  if (hasXfyunLlmRealtimeConfig()) providers.push("xfyun_llm");
  if (hasXfyunRealtimeConfig()) providers.push("xfyun");
  return providers;
}

function isFunAsrServiceUnavailable(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return code === "ECONNREFUSED" || message.includes("ECONNREFUSED");
}

function createEmptyMeetingAssistantState(sessionId) {
  return {
    sessionId,
    status: "idle",
    asrStatus: "idle",
    asrProvider: "unknown",
    speakerSource: "unknown",
    speakerProfile: String(process.env.SPEAKER_PROFILE || "multi").toLowerCase(),
    conversationId: "",
    items: [],
    summary: "",
    error: "",
    updatedAt: null,
  };
}

function upsertMeetingAssistantStateItem(state, sentenceId, content) {
  const id = String(sentenceId ?? "");
  if (!id) return;
  const existing = state.items.find((item) => item.sentenceId === id);
  if (existing) {
    existing.content = content || existing.content;
    existing.updatedAt = new Date().toISOString();
    return;
  }
  state.items.push({
    sentenceId: id,
    content: content || "",
    updatedAt: new Date().toISOString(),
  });
  // 长会议的逐句条目会无上限增长，快照也会随之膨胀；只保留最近若干条。
  if (state.items.length > MEETING_ASSISTANT_MAX_ITEMS) {
    state.items.splice(0, state.items.length - MEETING_ASSISTANT_MAX_ITEMS);
  }
}

function applyMeetingAssistantEventToState(state, msg = {}) {
  state.updatedAt = new Date().toISOString();
  switch (msg.type) {
    case "meeting-assistant-status":
      state.status = msg.status || state.status;
      state.conversationId = msg.conversationId || state.conversationId;
      break;
    case "meeting-assistant-asr-status":
      state.asrStatus = msg.asrStatus || state.asrStatus;
      state.asrProvider = msg.asrProvider || state.asrProvider;
      state.speakerSource = msg.speakerSource || state.speakerSource;
      state.speakerProfile = msg.speakerProfile || state.speakerProfile;
      break;
    case "meeting-assistant-delta":
    case "meeting-assistant-final":
      upsertMeetingAssistantStateItem(state, msg.sentenceId, msg.fullContent || msg.content || "");
      break;
    case "meeting-assistant-summary-delta":
    case "meeting-assistant-summary":
      state.summary = msg.fullContent || msg.content || state.summary;
      if (msg.type === "meeting-assistant-summary") state.status = "done";
      break;
    case "meeting-assistant-error":
      state.status = "error";
      state.error = msg.message || "会议助手请求失败";
      break;
  }
}

/**
 * 会议助手事件中枢。
 *
 * 之前状态是进程级单例，`npm run web:lan` 下两个人同时录音会互相覆盖，仪表盘看到的是
 * 两场会议混在一起的内容——这属于内容泄露而不只是显示错乱。这里按 sessionId 分桶，
 * 每条广播都带上 sessionId，订阅端据此只认一场会议。
 */
class MeetingAssistantHub {
  constructor() {
    this.subscribers = new Set();
    this.states = new Map();
  }

  subscribe(clientWs) {
    this.subscribers.add(clientWs);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({
        type: "meeting-assistant-snapshot",
        sessions: [...this.states.values()],
        // 仪表盘默认跟随最近一次开始的录音。
        activeSessionId: this.latestSessionId(),
      }));
    }
  }

  unsubscribe(clientWs) {
    this.subscribers.delete(clientWs);
  }

  latestSessionId() {
    let latest = null;
    for (const state of this.states.values()) {
      if (!latest || String(state.updatedAt || "") > String(latest.updatedAt || "")) {
        latest = state;
      }
    }
    return latest?.sessionId || null;
  }

  reset(sessionId) {
    const state = createEmptyMeetingAssistantState(sessionId);
    state.status = "connecting";
    state.updatedAt = new Date().toISOString();
    this.states.set(sessionId, state);
    this._fanout({ type: "meeting-assistant-reset", sessionId });
  }

  publish(sessionId, msg = {}) {
    const state = this.states.get(sessionId);
    // 已经 drop 的会话不再复活：迟到的回调若能重新建桶，这条 state 将永远没人回收，
    // 还会因为 updatedAt 最新而被 latestSessionId() 当成活跃会话下发给仪表盘。
    if (!state) return;
    applyMeetingAssistantEventToState(state, msg);
    this._fanout({ ...msg, sessionId });
  }

  drop(sessionId) {
    this.states.delete(sessionId);
  }

  _fanout(msg) {
    const payload = JSON.stringify(msg);
    this.subscribers.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    });
  }
}

const meetingAssistantHub = new MeetingAssistantHub();

function initWebSocket(httpServer, executeCommand, emitter) {
  // 必须用 noServer + 手动路由：如果两个 WebSocket.Server 都用 { server, path } 挂在同一个
  // http server 上，两者都会收到 upgrade 事件，路径不匹配的那个会对*已经握手成功*的 socket
  // 调用 abortHandshake()，把一段 HTTP 400 响应写进 WebSocket 流并销毁连接。
  // 表现为客户端报 "RSV1 must be clear" 后立刻断开，整条实时转写链路不可用。
  const wss = new WebSocket.Server({ noServer: true });
  const meetingAssistantWss = new WebSocket.Server({ noServer: true });

  const upgradeRoutes = new Map([
    ["/ws/asr", wss],
    ["/ws/meeting-assistant", meetingAssistantWss],
  ]);

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    const target = upgradeRoutes.get(pathname);
    if (!target) {
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit("connection", ws, req);
    });
  });

  if (emitter) {
    emitter.on("alarm-triggered", (data) => {
      const msg = JSON.stringify({ type: "alarm-triggered", title: data.title, id: data.id });
      wss.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
      });
    });
  }

  wss.on("connection", (clientWs) => {
    console.log("前端 WebSocket 已连接");
    const session = new ClientSession(clientWs, executeCommand);

    clientWs.on("message", (data, isBinary) => {
      if (isBinary) {
        session.onAudio(data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // onControl 是 async 且内部会做文件 IO：必须接住拒绝，
      // 否则单个客户端的异常会以 unhandledRejection 终止整个服务进程。
      Promise.resolve(session.onControl(msg)).catch((error) => {
        console.error("处理控制消息失败:", error.message);
        session.send({ type: "error", message: `处理失败: ${error.message}` });
      });
    });

    clientWs.on("close", () => {
      console.log("前端 WebSocket 断开");
      session.destroy();
    });

    clientWs.on("error", (err) => {
      console.error("前端 WebSocket 错误:", err.message);
      session.destroy();
    });
  });

  meetingAssistantWss.on("connection", (clientWs) => {
    // 控制面板打开时先拿一份快照，再接收后续实时增量。
    meetingAssistantHub.subscribe(clientWs);
    clientWs.on("close", () => meetingAssistantHub.unsubscribe(clientWs));
    clientWs.on("error", () => meetingAssistantHub.unsubscribe(clientWs));
  });

  console.log("WebSocket ASR 服务已就绪 (ws://localhost:PORT/ws/asr)");
  return wss;
}

class ClientSession {
  constructor(clientWs, executeCommand) {
    this.clientWs = clientWs;
    this.executeCommand = executeCommand;
    // 会议助手事件按 sessionId 分桶广播，避免多客户端串台。
    this.sessionId = crypto.randomUUID();
    this.asr = null;
    // 音频边录边写盘，不再把整场 PCM 堆在内存里（见 audio-utils.createWavWriter）。
    this.wavWriter = null;
    this.wavFilename = null;
    this.startedAt = null;
    this.stopTimer = null;
    this.utterances = [];
    this.commandResults = {};
    this.sentenceIndex = 0;
    this.diarizer = createRealtimeSpeakerDiarizer(buildDiarizerOptionsFromEnv());
    // 默认实时识别走讯飞；保留 aliyun 作为兼容兜底。
    this.asrProvider = "xfyun";
    this.externalSpeakerMap = new Map();
    this.lastStableSpeakerLabel = null;
    this.pendingSpeakerSwitch = null;
    this.lastSpeakerSwitchAt = 0;
    this.candidateFeatureIds = [];
    // featureId → 人名 映射表，启动 ASR 时从 speakers.json 加载
    this.featureIdToName = new Map();
    // roleId → 已识别人名 的缓存，避免对同一角色重复调用 1:N 搜索
    this.roleToIdentifiedName = new Map();
    // 正在进行 1:N 搜索的 roleId 集合，防止并发重复请求
    this.pendingVpSearchRoles = new Set();
    // 人工标注映射。实时会话中标注后，后续同一 role/cluster 会直接显示姓名。
    this.manualSpeakerLabels = new Map();
    // 会议助手是旁路能力，不影响 ASR、命令和归档主流程。
    this.meetingAssistant = null;
    this.destroyed = false;
  }

  send(msg) {
    if (this.clientWs.readyState === WebSocket.OPEN) {
      this.clientWs.send(JSON.stringify(msg));
    }
  }

  sendMeetingAssistant(msg) {
    this.send(msg);
    meetingAssistantHub.publish(this.sessionId, msg);
  }

  broadcastAsrStatus(statusPatch = {}) {
    const msg = {
      type: "meeting-assistant-asr-status",
      asrStatus: statusPatch.asrStatus || "online",
      asrProvider: statusPatch.asrProvider || this.asrProvider,
      speakerProfile: String(process.env.SPEAKER_PROFILE || "multi").toLowerCase(),
    };
    // 只在明确知道来源时才带上 speakerSource，否则会把已识别出的来源覆盖成 unknown。
    if (statusPatch.speakerSource) msg.speakerSource = statusPatch.speakerSource;
    meetingAssistantHub.publish(this.sessionId, msg);
  }

  async onControl(msg) {
    switch (msg.type) {
      case "start":
        await this.startAsr(msg);
        break;
      case "stop":
        await this.stopAsr();
        break;
      case "label-speaker":
        this.labelSpeaker(msg);
        break;
    }
  }

  labelSpeaker(msg = {}) {
    const roleId = String(msg.roleId || "").trim();
    const speakerLabel = String(msg.name || "").trim();
    if (!roleId || !speakerLabel) {
      this.send({ type: "error", message: "缺少说话人或姓名" });
      return;
    }

    this.manualSpeakerLabels.set(roleId, speakerLabel);
    this.roleToIdentifiedName.set(roleId, speakerLabel);
    this.externalSpeakerMap.set(roleId, speakerLabel);

    for (const utterance of this.utterances) {
      const rawId = utterance.speakerRawId || utterance.speakerClusterId || utterance.speakerLabel;
      if (rawId === roleId || utterance.speakerLabel === roleId) {
        utterance.speakerLabel = speakerLabel;
        utterance.speakerStatus = "manual";
      }
    }

    this.send({
      type: "speaker-labeled",
      roleId,
      speakerLabel,
    });
  }

  onAudio(buffer) {
    if (!this.asr) return;
    this.wavWriter?.write(Buffer.from(buffer));
    this.asr.sendAudio(buffer);
  }

  /**
   * provider 配置缺失导致启动失败时的收尾：报错给前端，并关闭刚打开的空 WAV 文件。
   * @param {string} message
   */
  _abortStart(message) {
    this.send({ type: "error", message });
    const writer = this.wavWriter;
    this.wavWriter = null;
    this.wavFilename = null;
    writer?.close();
  }

  /**
   * 打开本场录音的 WAV 文件。
   *
   * 文件名只精确到秒，而文件现在会被整场录音持有（不再是归档瞬间一次写完），
   * 所以同一秒内启动的两场录音会打开同一路径并互相截断。这里用 "wx+" 独占创建，
   * 撞名就换后缀重试，保证每场录音各自独立。
   */
  _openSessionWav() {
    const base = `record_${formatRecordingTimestamp(this.startedAt)}`;
    for (let attempt = 0; attempt < 50; attempt++) {
      const filename = attempt === 0 ? `${base}.wav` : `${base}_${attempt + 1}.wav`;
      try {
        this.wavWriter = createWavWriter(path.join(store.RECORDINGS_DIR, filename), {
          sampleRate: SESSION_SAMPLE_RATE,
          exclusive: true,
        });
        this.wavFilename = filename;
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    throw new Error("录音文件名冲突次数过多");
  }

  async startAsr(options = {}) {
    if (this.asr) {
      this.asr.close();
    }

    // 上一段会话若未归档（例如连续两次 start），先落盘再开新文件，避免 fd 泄漏。
    if (this.wavWriter) this._archiveSession();

    this.startedAt = new Date();
    // 录音开始即打开文件，音频到达就追加；进程异常退出时已写入的部分仍然保留。
    try {
      this._openSessionWav();
    } catch (error) {
      console.error("创建录音文件失败:", error.message);
      this.send({ type: "error", message: `创建录音文件失败: ${error.message}` });
      return;
    }

    this.utterances = [];
    this.commandResults = {};
    this.sentenceIndex = 0;
    this.diarizer = createRealtimeSpeakerDiarizer(buildDiarizerOptionsFromEnv());
    this.externalSpeakerMap = new Map();
    this.lastStableSpeakerLabel = null;
    this.pendingSpeakerSwitch = null;
    this.lastSpeakerSwitchAt = 0;
    this.candidateFeatureIds = Array.isArray(options.featureIds)
      ? options.featureIds.filter(Boolean)
      : [];
    // 加载已注册声纹的 featureId → 人名映射，用于 1:N 搜索结果转译
    const registered = loadRegisteredSpeakers();
    this.featureIdToName = registered.featureIdToName;
    this.roleToIdentifiedName = new Map();
    this.pendingVpSearchRoles = new Set();
    // 会议助手在 ASR provider 配置校验通过后才启动，见下方 connect 之前的调用点。
    this.meetingAssistant?.close();
    this.meetingAssistant = null;

    // 统一 provider 名称：老配置 isi 视为 aliyun；funasr/sensevoice 走本地免费识别链路。
    const provider = String(process.env.ASR_PROVIDER || "xfyun").toLowerCase();
    if (provider === "aliyun" || provider === "isi") {
      this.asrProvider = "aliyun";
    } else if (provider === "xfyun_llm") {
      this.asrProvider = "xfyun_llm";
    } else if (provider === "funasr" || provider === "sensevoice") {
      this.asrProvider = "funasr";
    } else {
      this.asrProvider = "xfyun";
    }
    const commonCallbacks = {
      onReady: () => {
        this.send({ type: "ready" });
        this.broadcastAsrStatus({ asrStatus: "online" });
        this.send({
          type: "session-meta",
          asrProvider: this.asrProvider,
          // 讯飞云端可返回角色编号；阿里云/FunASR 则继续使用本地匿名分人。
          speakerMode:
            this.asrProvider === "xfyun" || this.asrProvider === "xfyun_llm"
              ? "provider_or_local"
              : "local_only",
          speakerProfile: String(process.env.SPEAKER_PROFILE || "multi").toLowerCase(),
        });
      },

      onPartialResult: ({ text, index }) => {
        this.send({ type: "partial", text, sentenceId: index });
      },

      onSentenceEnd: async ({
        text,
        index,
        confidence,
        beginTime,
        time,
        words,
        speakerId,
      }) => {
        if (!text || this.destroyed) return;

        this.sentenceIndex = index;
        const utterance = {
          sentenceId: index,
          text,
          startMs: Math.max(0, beginTime ?? 0),
          endMs: Math.max(beginTime ?? 0, time ?? 0),
          words: Array.isArray(words) ? words : [],
          speakerLabel: "识别中",
          speakerStatus: "pending",
        };
        this.utterances.push(utterance);

        // 当云端 provider 返回 speakerId 时，优先采用云端标签，再回退本地分人。
        if (speakerId) {
          utterance.speakerClusterId = speakerId;
          // 保留云端原始角色编号，方便后续排查“角色分离”和“认人”问题。
          utterance.speakerRawId = speakerId;
          utterance.speakerLabel = this._resolveExternalSpeakerLabel(speakerId);
          // 已通过 1:N 搜索确认过的角色直接 confirmed，否则 pending 等待异步识别
          utterance.speakerStatus = this.roleToIdentifiedName.has(speakerId) ? "confirmed" : "pending";
          this.send({
            type: "final",
            text,
            sentenceId: index,
            speakerLabel: utterance.speakerLabel,
            speakerStatus: utterance.speakerStatus,
            roleId: speakerId,
            speakerSource: this.asrProvider,
          });
          this.broadcastAsrStatus({ speakerSource: this.asrProvider });
          // 云端已给出角色，标签此刻就是最终值，可以直接入队。
          this._enqueueMeetingAssistantSentence(utterance);
          // 异步启动 1:N 声纹搜索（仅当有已注册声纹且该角色尚未识别时）
          this._tryVoiceprintSearch(utterance);
        } else {
          this.send({
            type: "final",
            text,
            sentenceId: index,
            speakerLabel: utterance.speakerLabel,
            speakerStatus: utterance.speakerStatus,
            speakerSource: "local",
          });
          this.broadcastAsrStatus({ speakerSource: "local" });
          // 旁路做本地说话人识别：允许标签晚于文字 1 个节拍返回。
          setTimeout(() => {
            if (this.destroyed) return;
            const sentencePcm = this.wavWriter
              ? this.wavWriter.slice(utterance.startMs, utterance.endMs)
              : Buffer.alloc(0);
            const speaker = this.diarizer.resolveSpeaker({
              pcm: sentencePcm,
              durationMs: Math.max(0, utterance.endMs - utterance.startMs),
            });
            const stableSpeaker = this._stabilizeSpeakerLabel(speaker);
            utterance.speakerClusterId = speaker.clusterId || null;
            const localRoleId = utterance.speakerClusterId || stableSpeaker.speakerLabel || "说话人1";
            const manualLabel =
              this.manualSpeakerLabels.get(localRoleId) ||
              this.manualSpeakerLabels.get(stableSpeaker.speakerLabel);
            utterance.speakerLabel = manualLabel || stableSpeaker.speakerLabel || "说话人1";
            utterance.speakerStatus = manualLabel ? "manual" : stableSpeaker.speakerStatus || "estimated";
            this.send({
              type: "speaker-update",
              sentenceId: utterance.sentenceId,
              speakerLabel: utterance.speakerLabel,
              speakerStatus: utterance.speakerStatus,
              roleId: localRoleId,
              speakerSource: "local",
            });
            this.broadcastAsrStatus({ speakerSource: "local" });
            // 必须等本地分人落定后再入队，否则智能体收到的永远是没有说话人的裸句子。
            this._enqueueMeetingAssistantSentence(utterance);
          }, 300);
        }

        const cmd = parseCommand(text);
        const isRealCommand = cmd.intent !== "none" && cmd.intent !== "unknown";

        if (isRealCommand) {
          try {
            const result = await this.executeCommand(cmd, text);
            this.commandResults[index] = result;
            if (cmd.intent === "agent" && result.data) {
              this.send({ type: "agent", data: result.data, sentenceId: index });
            } else if (result) {
              this.send({ type: "command", result, sentenceId: index });
            }
          } catch (e) {
            const errResult = { action: cmd.intent, message: `执行失败：${e.message}` };
            this.commandResults[index] = errResult;
            this.send({ type: "command", result: errResult, sentenceId: index });
          }
        }
      },

      onError: (err) => {
        this.send({ type: "error", message: err.message });
        this.broadcastAsrStatus({ asrStatus: "error" });
      },

      onCompleted: () => {
        this._archiveSession();
      },
    };

    if (this.asrProvider === "xfyun") {
      const realtimeAsr = createXfyunRealtimeSession(commonCallbacks);
      if (!realtimeAsr) {
        this._abortStart("缺少 XFYUN_APP_ID 或 XFYUN_API_KEY 配置");
        return;
      }
      this.asr = realtimeAsr;
    } else if (this.asrProvider === "xfyun_llm") {
      const llmAsr = createXfyunLlmRealtimeSession(commonCallbacks, registered);
      if (!llmAsr) {
        this._abortStart(
          "缺少 XFYUN_APP_ID、XFYUN_ACCESS_KEY_ID 或 XFYUN_ACCESS_KEY_SECRET 配置"
        );
        return;
      }
      this.asr = llmAsr;
    } else if (this.asrProvider === "funasr") {
      this.asr = new FunAsrSession({
        // 默认连接本机 FunASR websocket 服务，便于先试本地免费识别。
        url: process.env.FUNASR_WS_URL,
        mode: process.env.FUNASR_MODE || "2pass",
        chunkSize: process.env.FUNASR_CHUNK_SIZE,
        chunkInterval: process.env.FUNASR_CHUNK_INTERVAL,
        hotwords: process.env.FUNASR_HOTWORDS,
        itn: process.env.FUNASR_ITN,
        onReady: commonCallbacks.onReady,
        onPartialResult: commonCallbacks.onPartialResult,
        onSentenceEnd: commonCallbacks.onSentenceEnd,
        onError: commonCallbacks.onError,
        onCompleted: commonCallbacks.onCompleted,
      });
    } else {
      // 保留阿里云实时听写通道，方便逐步迁移或回滚。
      const appKey = process.env.ASR_APP_KEY;
      if (!appKey) {
        this._abortStart("缺少 ASR_APP_KEY 配置");
        return;
      }
      this.asr = new AsrSession(appKey, commonCallbacks);
    }

    // provider 配置齐备后才建会议助手会话，避免配置缺失时白白打一次鉴权 + 建会话。
    this.meetingAssistant = new BachAgentSession();
    this._startMeetingAssistant();

    try {
      await this.asr.connect();
    } catch (e) {
      console.error("ASR 连接失败:", e.message);
      if (this.asrProvider === "funasr" && isFunAsrServiceUnavailable(e)) {
        const configuredUrl = process.env.FUNASR_WS_URL || DEFAULT_FUNASR_WS_URL;
        let lastFallbackError = null;

        for (const fallbackProvider of getFunAsrFallbackProviders()) {
          const fallbackAsr = fallbackProvider === "xfyun_llm"
            ? createXfyunLlmRealtimeSession(commonCallbacks, registered)
            : createXfyunRealtimeSession(commonCallbacks);
          if (!fallbackAsr) continue;

          console.warn(
            `[asr] 本地 FunASR 服务不可用 (${configuredUrl})，自动切换到 ${fallbackProvider}`
          );
          this.asr.close();
          this.asrProvider = fallbackProvider;
          this.asr = fallbackAsr;
          try {
            await this.asr.connect();
            return;
          } catch (fallbackError) {
            lastFallbackError = fallbackError;
            console.error(`[asr] ${fallbackProvider} 兜底连接失败:`, fallbackError.message);
            this.asr.close();
          }
        }

        console.error(
          `[asr] 本地 FunASR 服务不可用 (${configuredUrl})，且讯飞兜底不可用`
        );
        this.send({
          type: "error",
          message: `ASR 连接失败: ${(lastFallbackError || e).message}`,
        });
        this.broadcastAsrStatus({ asrStatus: "error" });
        this.asr = null;
        return;
      }
      this.send({ type: "error", message: `ASR 连接失败: ${e.message}` });
      this.broadcastAsrStatus({ asrStatus: "error" });
      this.asr = null;
    }
  }

  _stabilizeSpeakerLabel(rawSpeaker) {
    // 通过"切换候选 + 连续命中"抑制说话人标签抖动。
    const nextLabel = rawSpeaker?.speakerLabel || "说话人1";
    const nextStatus = rawSpeaker?.speakerStatus || "estimated";
    if (!this.lastStableSpeakerLabel) {
      this.lastStableSpeakerLabel = nextLabel;
      this.lastSpeakerSwitchAt = Date.now();
      return { speakerLabel: nextLabel, speakerStatus: nextStatus };
    }

    if (nextLabel === this.lastStableSpeakerLabel) {
      this.pendingSpeakerSwitch = null;
      return { speakerLabel: nextLabel, speakerStatus: nextStatus };
    }

    // 多人优先：缩短稳定窗口，让真实换人更快反映到 UI。
    const now = Date.now();
    const SWITCH_GUARD_MS = 700;
    if (now - this.lastSpeakerSwitchAt < SWITCH_GUARD_MS) {
      return {
        speakerLabel: this.lastStableSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    if (!this.pendingSpeakerSwitch || this.pendingSpeakerSwitch.label !== nextLabel) {
      // 先记录候选，等待下一句再次命中再切换，避免单句抖动误切。
      this.pendingSpeakerSwitch = { label: nextLabel, hits: 0 };
      return {
        speakerLabel: this.lastStableSpeakerLabel,
        speakerStatus: "estimated",
      };
    }

    this.pendingSpeakerSwitch.hits += 1;
    // 多人优先：命中一次候选即可切换，强调"换人响应速度"。
    if (this.pendingSpeakerSwitch.hits >= 1) {
      this.lastStableSpeakerLabel = nextLabel;
      this.pendingSpeakerSwitch = null;
      this.lastSpeakerSwitchAt = now;
      return { speakerLabel: nextLabel, speakerStatus: "confirmed" };
    }

    return {
      speakerLabel: this.lastStableSpeakerLabel,
      speakerStatus: "estimated",
    };
  }

  async stopAsr() {
    if (!this.asr) return;
    try {
      this.broadcastAsrStatus({ asrStatus: "stopping" });
      this._enqueueMeetingAssistantFinalSummary();
      await this.asr.stop();
      // 留一点时间等尾句 flush 回来；期间若会话被销毁，这个回调必须整体跳过，
      // 否则它会在 hub.drop() 之后又把 state 塞回去，造成永不回收的僵尸会话。
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        if (this.destroyed) return;
        if (this.asr) {
          this.asr.close();
          this.asr = null;
        }
        this.broadcastAsrStatus({ asrStatus: "stopped" });
        this._archiveSession();
      }, 3000);
    } catch {
      this.broadcastAsrStatus({ asrStatus: "stopped" });
      this._enqueueMeetingAssistantFinalSummary();
      this.asr?.close();
      this.asr = null;
      this._archiveSession();
    }
  }

  _startMeetingAssistant() {
    meetingAssistantHub.reset(this.sessionId);
    if (!this.meetingAssistant?.enabled) {
      this.sendMeetingAssistant({ type: "meeting-assistant-status", status: "disabled" });
      return;
    }
    this.meetingAssistant
      .start()
      .then((conversationId) => {
        if (!conversationId || this.destroyed) return;
        this.sendMeetingAssistant({
          type: "meeting-assistant-status",
          status: "ready",
          conversationId,
        });
      })
      .catch((error) => {
        if (this.destroyed) return;
        this.sendMeetingAssistant({
          type: "meeting-assistant-error",
          message: `会议助手初始化失败: ${error.message}`,
        });
      });
  }

  _formatMeetingAssistantSentence(utterance) {
    const label = utterance.speakerLabel && utterance.speakerLabel !== "识别中"
      ? `${utterance.speakerLabel}：`
      : "";
    // 给智能体稳定的逐句输入格式，便于最后按会话上下文汇总。
    return `第 ${utterance.sentenceId + 1} 句：${label}${utterance.text}`;
  }

  _enqueueMeetingAssistantSentence(utterance) {
    if (!this.meetingAssistant?.enabled || !utterance?.text) return;
    const sentenceId = utterance.sentenceId;
    this.sendMeetingAssistant({
      type: "meeting-assistant-status",
      status: "thinking",
      sentenceId,
    });
    this.meetingAssistant
      .enqueue({
        sentenceId,
        content: this._formatMeetingAssistantSentence(utterance),
        onEvent: (event) => {
          if (this.destroyed) return;
          this.sendMeetingAssistant({
            type: "meeting-assistant-delta",
            sentenceId,
            content: event.content,
            fullContent: event.fullContent,
          });
        },
        onError: (error) => {
          if (this.destroyed) return;
          this.sendMeetingAssistant({
            type: "meeting-assistant-error",
            sentenceId,
            message: `会议助手请求失败: ${error.message}`,
          });
        },
      })
      .then((result) => {
        if (this.destroyed || !result) return;
        this.sendMeetingAssistant({
          type: "meeting-assistant-final",
          sentenceId,
          content: result.content,
        });
      });
  }

  _enqueueMeetingAssistantFinalSummary() {
    if (!this.meetingAssistant?.enabled) return;
    this.sendMeetingAssistant({
      type: "meeting-assistant-status",
      status: "finalizing",
    });
    // finalize 会先丢掉还在排队的逐句任务：会议已结束，总结不能排在积压后面。
    this.meetingAssistant
      .finalize({
        onEvent: (event) => {
          if (this.destroyed) return;
          this.sendMeetingAssistant({
            type: "meeting-assistant-summary-delta",
            content: event.content,
            fullContent: event.fullContent,
          });
        },
      })
      .then((result) => {
        if (this.destroyed || !result) return;
        if (result.dropped > 0) {
          console.log(`[meeting-assistant] 会议结束，跳过 ${result.dropped} 条积压的逐句请求`);
        }
        this.sendMeetingAssistant({
          type: "meeting-assistant-summary",
          content: result.content,
          dropped: result.dropped,
        });
      })
      .catch((error) => {
        if (this.destroyed) return;
        this.sendMeetingAssistant({
          type: "meeting-assistant-error",
          message: `会议助手总结失败: ${error.message}`,
        });
      });
  }

  _archiveSession() {
    // 音频是边录边写的，无论有没有转写结果都要先关闭文件回填 WAV 头。
    const writer = this.wavWriter;
    this.wavWriter = null;
    const written = writer ? writer.close() : null;
    const wavFilename = this.wavFilename;
    this.wavFilename = null;

    if (this.utterances.length === 0) return;

    const now = new Date();
    const fullText = this.utterances.map((u) => u.text).join(" ");
    const sentences = this.utterances.map((u) => u.text);
    const commands = Object.keys(this.commandResults).length > 0
      ? this.commandResults
      : undefined;
    const record = {
      time: now.toLocaleString("zh-CN", { hour12: false }),
      // 没采到音频时 close() 会删掉空文件并返回 null，此时不要留下悬空的 wav 引用。
      wav: written ? wavFilename : null,
      startedAt: this.startedAt ? this.startedAt.toISOString() : undefined,
      durationMs: written ? Math.round(written.durationMs) : 0,
      text: fullText,
      sentences,
      utterances: this.utterances.map((u) => ({
        sentenceId: u.sentenceId,
        text: u.text,
        startMs: u.startMs,
        endMs: u.endMs,
        speakerRawId: u.speakerRawId || null,
        speakerClusterId: u.speakerClusterId || null,
        speakerLabel: u.speakerLabel,
        speakerStatus: u.speakerStatus,
      })),
      speakerMap:
        this.externalSpeakerMap.size > 0
          ? Object.fromEntries(this.externalSpeakerMap.entries())
          : this.diarizer.exportSpeakerMap(),
      commands,
      source: "stream",
      provider: this.asrProvider,
    };
    record.meetingSummary = createInitialMeetingSummary(record);

    try {
      fs.appendFileSync(TRANSCRIPT_LOG, JSON.stringify(record) + "\n", "utf-8");
    } catch {}
    triggerMeetingSummary(record);

    if (fullText && !fullText.startsWith("（")) {
      store.logActivity("recording", "语音录入（流式）", fullText.slice(0, 80));
    }

    this.utterances = [];
    this.commandResults = {};
  }

  _resolveExternalSpeakerLabel(rawSpeakerId) {
    // 若 1:N 搜索已识别出该角色对应的人名，直接使用
    if (this.roleToIdentifiedName.has(rawSpeakerId)) {
      return this.roleToIdentifiedName.get(rawSpeakerId);
    }
    // 仅当服务端直接返回 feature_id 时，才可安全通过本地 featureId → 姓名映射命中。
    if (this.featureIdToName.has(rawSpeakerId)) {
      const matchedName = this.featureIdToName.get(rawSpeakerId);
      this.roleToIdentifiedName.set(rawSpeakerId, matchedName);
      this.externalSpeakerMap.set(rawSpeakerId, matchedName);
      return matchedName;
    }
    // 从临时标签缓存取
    if (this.externalSpeakerMap.has(rawSpeakerId)) {
      return this.externalSpeakerMap.get(rawSpeakerId);
    }

    // 讯飞实时结果当前只稳定返回“角色编号”，并没有明确返回“命中的具体人物姓名”。
    // 为避免把 role_1 / role_2 错误地硬映射成 具体人名，这里只展示稳定的“角色N”。
    const match = String(rawSpeakerId).match(/^role_(\d+)$/);
    if (match) {
      const label = `说话人${match[1]}`;
      this.externalSpeakerMap.set(rawSpeakerId, label);
      return label;
    }

    // 兜底
    const label = `说话人${this.externalSpeakerMap.size + 1}`;
    this.externalSpeakerMap.set(rawSpeakerId, label);
    return label;
  }

  /**
   * 异步调用声纹 1:N 搜索来识别说话人。
   * 对每个 roleId 只搜索一次（首次出现时），搜到后缓存映射并回溯更新所有历史句子。
   */
  async _tryVoiceprintSearch(utterance) {
    const roleId = utterance.speakerRawId;
    // 没有已注册声纹、角色已识别、或正在搜索中 → 跳过
    if (this.featureIdToName.size === 0) return;
    if (this.roleToIdentifiedName.has(roleId)) return;
    if (this.pendingVpSearchRoles.has(roleId)) return;

    // 确保音频时长 >= 0.5 秒（声纹 API 要求有效帧 > 0.5s）
    const durationMs = utterance.endMs - utterance.startMs;
    if (durationMs < 500) return;

    this.pendingVpSearchRoles.add(roleId);

    try {
      const sentencePcm = this.wavWriter
        ? this.wavWriter.slice(utterance.startMs, utterance.endMs)
        : Buffer.alloc(0);
      if (!sentencePcm || sentencePcm.length < 16000) {
        this.pendingVpSearchRoles.delete(roleId);
        return;
      }

      const audioBase64 = sentencePcm.toString("base64");
      const result = await searchFea({ audioBase64, topK: 3 });

      if (!result.ok) {
        console.warn(`[voiceprint] 1:N 搜索失败 (${roleId}):`, result.message);
        this.pendingVpSearchRoles.delete(roleId);
        return;
      }

      const scoreList = Array.isArray(result.data?.scoreList) ? result.data.scoreList : [];
      const bestMatch = scoreList.length > 0 ? scoreList[0] : null;

      if (bestMatch && bestMatch.score >= getVpMatchThreshold()) {
        const matchedName = this.featureIdToName.get(bestMatch.featureId);
        if (matchedName) {
          console.log(
            `[voiceprint] ${roleId} -> ${matchedName} (score=${bestMatch.score})`
          );
          this.roleToIdentifiedName.set(roleId, matchedName);
          this.externalSpeakerMap.set(roleId, matchedName);

          // 回溯更新所有属于该角色的历史句子
          for (const u of this.utterances) {
            if (u.speakerRawId === roleId) {
              u.speakerLabel = matchedName;
              u.speakerStatus = "confirmed";
            }
          }

          // 通知前端批量更新该角色的所有句子标签
          this.send({
            type: "speaker-identified",
            roleId,
            speakerLabel: matchedName,
            score: bestMatch.score,
          });
        }
      } else {
        console.log(
          `[voiceprint] ${roleId} 未匹配到已注册人物`,
          bestMatch ? `(最高 score=${bestMatch.score})` : "(无结果)"
        );
      }
    } catch (err) {
      console.error(`[voiceprint] 1:N 搜索异常 (${roleId}):`, err.message);
    } finally {
      this.pendingVpSearchRoles.delete(roleId);
    }
  }

  destroy() {
    this.destroyed = true;
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.asr) {
      this.asr.close();
      this.asr = null;
    }
    // 丢弃排队任务并中止在途请求，否则关掉悬浮球后积压的请求仍在消耗配额。
    this.meetingAssistant?.close();
    this.meetingAssistant = null;
    meetingAssistantHub.drop(this.sessionId);
    this._archiveSession();
  }
}

module.exports = { initWebSocket };
