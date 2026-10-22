/**
 * 讯飞实时语音转写大模型接入层。
 * 该通道支持 role_type + feature_ids，用于“说话人分离 + 声纹认人”场景。
 */

const WebSocket = require("ws");

const {
  buildSortedQueryString,
  formatOfficeDateTime,
  randomSignatureSeed,
  signOfficeParams,
} = require("./xfyun-office-auth");

const XFYUN_LLM_GATEWAY = "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1";

/**
 * 构建讯飞实时转写大模型握手地址。
 * @param {object} options
 * @returns {string}
 */
function buildXfyunLlmWsUrl(options = {}) {
  const query = {
    accessKeyId: options.accessKeyId || "",
    appId: options.appId || "",
    uuid: options.uuid || randomSignatureSeed(),
    utc: options.utc || formatOfficeDateTime(),
    audio_encode: options.audioEncode || "pcm_s16le",
    lang: options.lang || "autodialect",
    samplerate: Number(options.sampleRate || 16000),
  };

  if (options.roleType !== undefined && options.roleType !== "") {
    query.role_type = Number(options.roleType);
  }
  if (Array.isArray(options.featureIds) && options.featureIds.length > 0) {
    query.feature_ids = options.featureIds.join(",");
  }
  if (options.engSpkMatch !== undefined && options.engSpkMatch !== "") {
    query.eng_spk_match = Number(options.engSpkMatch);
  }
  if (options.pd) query.pd = String(options.pd);
  if (options.engPunc !== undefined && options.engPunc !== "") {
    query.eng_punc = String(options.engPunc);
  }
  if (options.engVadMdn !== undefined && options.engVadMdn !== "") {
    query.eng_vad_mdn = Number(options.engVadMdn);
  }

  query.signature = signOfficeParams(query, options.accessKeySecret || "");
  return `${XFYUN_LLM_GATEWAY}?${buildSortedQueryString(query)}`;
}

/**
 * 将大模型结果解析成统一结构。
 * @param {object|string} payload
 * @returns {object|null}
 */
function parseXfyunLlmResult(payload) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const content = data?.data || data;
  const st = content?.cn?.st;
  if (!st) return null;

  const beginTime = Number(st.bg || 0);
  const endTime = Number(st.ed || beginTime);
  const resultType = Number(st.type || 0);
  const segId = Number(content?.seg_id ?? 0);
  const ls = Boolean(content?.ls);

  const words = [];
  let text = "";
  let roleId = null;

  const rtList = Array.isArray(st.rt) ? st.rt : [];
  for (const rt of rtList) {
    const wsList = Array.isArray(rt?.ws) ? rt.ws : [];
    for (const wsItem of wsList) {
      const candidate = Array.isArray(wsItem?.cw) && wsItem.cw.length > 0
        ? wsItem.cw[0]
        : null;
      const token = String(candidate?.w || "");
      const wb = Number(wsItem?.wb || 0);
      const we = Number(wsItem?.we || wb);
      text += token;
      words.push({
        text: token,
        startTime: beginTime + wb * 10,
        endTime: beginTime + we * 10,
      });

      const rawRoleId = candidate?.rl ?? wsItem?.rl;
      if (rawRoleId !== undefined && rawRoleId !== null && String(rawRoleId) !== "0") {
        // 大模型声纹模式可能返回数字角色，也可能返回声纹相关标识；保留原始值供上层映射。
        roleId = rawRoleId;
        if (process.env.XFYUN_LLM_DEBUG_SPEAKER === "1") {
          console.log("[xfyun_llm] speaker candidate:", JSON.stringify(candidate));
        }
      }
    }
  }

  return {
    segId,
    text,
    beginTime,
    endTime: endTime > beginTime
      ? endTime
      : words.length > 0
      ? words[words.length - 1].endTime
      : beginTime,
    words,
    roleId,
    resultType,
    isLastFrame: ls,
  };
}

class XfyunLlmAsrSession {
  /**
   * @param {object} options
   */
  constructor(options = {}) {
    this.appId = options.appId || "";
    this.accessKeyId = options.accessKeyId || "";
    this.accessKeySecret = options.accessKeySecret || "";
    this.featureIds = Array.isArray(options.featureIds) ? options.featureIds : [];
    this.roleType = options.roleType;
    this.engSpkMatch = options.engSpkMatch;
    this.lang = options.lang || "autodialect";
    this.audioEncode = options.audioEncode || "pcm_s16le";
    this.sampleRate = Number(options.sampleRate || 16000);
    this.pd = options.pd || "";
    this.engPunc = options.engPunc;
    this.engVadMdn = options.engVadMdn;
    this.uuid = options.uuid || randomSignatureSeed();
    this.sessionId = this.uuid;
    this.ws = null;
    this.started = false;
    this.closed = false;
    this.completed = false;
    this.lastSpeakerId = null;

    this.onPartialResult = options.onPartialResult || (() => {});
    this.onSentenceEnd = options.onSentenceEnd || (() => {});
    this.onError = options.onError || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onCompleted = options.onCompleted || (() => {});
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = buildXfyunLlmWsUrl({
        appId: this.appId,
        accessKeyId: this.accessKeyId,
        accessKeySecret: this.accessKeySecret,
        uuid: this.uuid,
        lang: this.lang,
        audioEncode: this.audioEncode,
        sampleRate: this.sampleRate,
        roleType: this.roleType,
        featureIds: this.featureIds,
        engSpkMatch: this.engSpkMatch,
        pd: this.pd,
        engPunc: this.engPunc,
        engVadMdn: this.engVadMdn,
      });

      this.ws = new WebSocket(url, { perMessageDeflate: false });
      const connectTimeout = setTimeout(() => {
        reject(new Error("讯飞大模型 ASR WebSocket 连接超时"));
        this.close();
      }, 10_000);

      this.ws.on("open", () => {
        // 大模型接口无需额外 start 消息，连接建立后即可发送音频。
        clearTimeout(connectTimeout);
        this.started = true;
        this.onReady();
        resolve();
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (error) {
          this.onError(new Error(`讯飞大模型 ASR 消息解析失败: ${error.message}`));
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (!this.started) {
          reject(error);
          return;
        }
        this.onError(new Error(`讯飞大模型 ASR WebSocket 错误: ${error.message}`));
      });

      this.ws.on("close", () => {
        this.closed = true;
        if (this.started && !this.completed) {
          this.completed = true;
          this.onCompleted();
        } else if (!this.started) {
          reject(new Error("讯飞大模型 ASR WebSocket 意外关闭"));
        }
      });
    });
  }

  /**
   * 处理讯飞大模型消息。
   * @param {object} msg
   */
  _handleMessage(msg) {
    // 文档中的异常结果为 msg_type=result + res_type=frc。
    if (msg?.res_type === "frc" || msg?.data?.normal === false) {
      const detail = msg?.data?.desc || "讯飞大模型实时转写返回异常";
      this.onError(new Error(detail));
      return;
    }

    // 某些版本会返回 action/code/data 形式，这里做兼容。
    if (msg?.action === "error" || (msg?.code && String(msg.code) !== "0")) {
      this.onError(new Error(msg?.desc || `讯飞大模型 ASR 错误 ${msg?.code}`));
      return;
    }

    const parsed = parseXfyunLlmResult(msg);
    if (!parsed || !parsed.text) return;

    if (parsed.roleId) {
      const roleText = String(parsed.roleId);
      // 数字角色沿用 role_N，非数字则按服务端原始声纹标识传给上层。
      this.lastSpeakerId = /^\d+$/.test(roleText) ? `role_${roleText}` : roleText;
    }
    const speakerId = this.lastSpeakerId;

    if (parsed.resultType === 1) {
      this.onPartialResult({
        text: parsed.text,
        index: parsed.segId,
        time: parsed.endTime,
        speakerId,
      });
      return;
    }

    this.onSentenceEnd({
      text: parsed.text,
      index: parsed.segId,
      time: parsed.endTime,
      beginTime: parsed.beginTime,
      words: parsed.words,
      confidence: 0,
      speakerId,
    });
  }

  /**
   * 发送音频块。
   * @param {Buffer} pcmBuffer
   */
  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.started) {
      this.ws.send(pcmBuffer);
    }
  }

  /**
   * 通知服务端输入结束。
   */
  async stop() {
    if (!this.ws || this.closed || !this.started) return;
    try {
      this.ws.send(JSON.stringify({ end: true, sessionId: this.sessionId }));
    } catch {}
  }

  /**
   * 主动关闭底层连接。
   */
  close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

module.exports = {
  XfyunLlmAsrSession,
  buildXfyunLlmWsUrl,
  parseXfyunLlmResult,
};
