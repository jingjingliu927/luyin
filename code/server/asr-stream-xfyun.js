/**
 * 讯飞实时语音转写（RTASR）接入层。
 * 目标：复用现有 onReady / onPartialResult / onSentenceEnd / onCompleted 回调协议，
 * 让上层 ws-server 无需感知底层云厂商差异。
 */

const crypto = require("crypto");
const WebSocket = require("ws");

// 讯飞实时转写标准版 WebSocket 网关。
const XFYUN_RTASR_GATEWAY = "wss://rtasr.xfyun.cn/v1/ws";

/**
 * 生成讯飞 RTASR 鉴权签名。
 * 公式：HmacSHA1(MD5(appid + ts), apiKey)，再做 base64 编码。
 * @param {string} appId
 * @param {string} apiKey
 * @param {string|number} ts
 * @returns {string}
 */
function buildXfyunSigna(appId, apiKey, ts) {
  // 先对 appid + ts 做 MD5，符合讯飞官方鉴权要求。
  const md5 = crypto.createHash("md5").update(`${appId}${ts}`).digest("hex");
  // 再以 apiKey 为密钥执行 HMAC-SHA1，最后做 base64 编码。
  return crypto.createHmac("sha1", apiKey).update(md5).digest("base64");
}

/**
 * 构建讯飞 RTASR 连接地址。
 * @param {object} options
 * @param {string} options.appId
 * @param {string} options.apiKey
 * @param {string} [options.lang]
 * @param {string|number} [options.punc]
 * @param {string} [options.pd]
 * @param {string|number} [options.vadMdn]
 * @param {string|number} [options.roleType]
 * @param {string|number} [options.engLangType]
 * @param {string|number} [options.ts]
 * @returns {string}
 */
function buildXfyunWsUrl(options = {}) {
  // 使用秒级时间戳，和官方文档示例保持一致。
  const ts = String(options.ts || Math.floor(Date.now() / 1000));
  const params = new URLSearchParams();
  params.set("appid", String(options.appId || ""));
  params.set("ts", ts);
  params.set("signa", buildXfyunSigna(options.appId || "", options.apiKey || "", ts));

  // 仅在显式配置时透传可选参数，避免无关参数影响默认行为。
  if (options.lang) params.set("lang", String(options.lang));
  if (options.punc !== undefined && options.punc !== "") {
    params.set("punc", String(options.punc));
  }
  if (options.pd) params.set("pd", String(options.pd));
  if (options.vadMdn !== undefined && options.vadMdn !== "") {
    params.set("vadMdn", String(options.vadMdn));
  }
  if (options.roleType !== undefined && options.roleType !== "") {
    params.set("roleType", String(options.roleType));
  }
  if (options.engLangType !== undefined && options.engLangType !== "") {
    params.set("engLangType", String(options.engLangType));
  }

  return `${XFYUN_RTASR_GATEWAY}?${params.toString()}`;
}

/**
 * 将讯飞 RTASR 结果里的 ws/cw 结构压平成可消费的文本和词列表。
 * @param {object} payload
 * @returns {object|null}
 */
function parseXfyunResultData(payload) {
  // data 既可能是 JSON 字符串，也可能已经被上层预解析成对象。
  const parsed = typeof payload === "string" ? JSON.parse(payload) : payload;
  const st = parsed?.cn?.st;
  if (!st) return null;

  const beginTime = Number(st.bg || 0);
  const resultType = Number(st.type || 0);
  const segments = Array.isArray(st.rt) ? st.rt : [];
  let text = "";
  const words = [];
  let roleId = null;

  for (const segment of segments) {
    const wsList = Array.isArray(segment?.ws) ? segment.ws : [];
    for (const wsItem of wsList) {
      // 讯飞会返回候选词，这里沿用“取第一候选”的简单策略。
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

      // roleType=2 时，讯飞会在角色切换点返回 rl；其余同角色片段可能返回 0。
      const rawRoleId = Number(candidate?.rl ?? wsItem?.rl ?? 0);
      if (rawRoleId > 0) {
        roleId = rawRoleId;
      }
    }
  }

  // 中间结果的 ed 可能不稳定，优先取有效值，否则退回最后一个词的结束时间。
  const rawEndTime = Number(st.ed || 0);
  const derivedEndTime = words.length > 0 ? words[words.length - 1].endTime : beginTime;
  const endTime = rawEndTime > beginTime ? rawEndTime : derivedEndTime;

  return {
    segId: Number(parsed?.seg_id ?? 0),
    text,
    beginTime,
    endTime,
    words,
    resultType,
    roleId,
  };
}

class XfyunAsrSession {
  /**
   * @param {string} appId 讯飞应用 APPID
   * @param {string} apiKey 讯飞应用 APIKey
   * @param {object} options
   */
  constructor(appId, apiKey, options = {}) {
    this.appId = appId;
    this.apiKey = apiKey;
    this.ws = null;
    this.started = false;
    this.closed = false;
    this.completed = false;

    // 将讯飞可选参数挂在实例上，便于统一构建连接 URL。
    this.lang = options.lang || "cn";
    this.punc = options.punc;
    this.pd = options.pd;
    this.vadMdn = options.vadMdn;
    this.roleType = options.roleType;
    this.engLangType = options.engLangType;

    // 当开启 roleType=2 时，讯飞只在切换点返回 rl，需要本地记住最近角色。
    this.lastSpeakerId = null;

    this.onPartialResult = options.onPartialResult || (() => {});
    this.onSentenceEnd = options.onSentenceEnd || (() => {});
    this.onError = options.onError || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onCompleted = options.onCompleted || (() => {});
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = buildXfyunWsUrl({
        appId: this.appId,
        apiKey: this.apiKey,
        lang: this.lang,
        punc: this.punc,
        pd: this.pd,
        vadMdn: this.vadMdn,
        roleType: this.roleType,
        engLangType: this.engLangType,
      });

      this.ws = new WebSocket(url, { perMessageDeflate: false });

      // RTASR 握手成功后会主动返回 started，这里等待服务端确认。
      const connectTimeout = setTimeout(() => {
        reject(new Error("讯飞 ASR WebSocket 连接超时"));
        this.close();
      }, 10_000);

      this.ws.on("open", () => {
        // 讯飞 RTASR 无需额外发送 StartTranscription 指令，握手完成即可开始发音频。
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg, () => {
            clearTimeout(connectTimeout);
            resolve();
          }, (err) => {
            clearTimeout(connectTimeout);
            reject(err);
          });
        } catch (error) {
          this.onError(new Error(`讯飞 ASR 消息解析失败: ${error.message}`));
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (!this.started) {
          reject(error);
          return;
        }
        this.onError(new Error(`讯飞 ASR WebSocket 错误: ${error.message}`));
      });

      this.ws.on("close", () => {
        this.closed = true;
        // 对讯飞来说，正常结束通常表现为结果发送完成后断开连接。
        if (this.started && !this.completed) {
          this.completed = true;
          this.onCompleted();
        } else if (!this.started) {
          reject(new Error("讯飞 ASR WebSocket 意外关闭"));
        }
      });
    });
  }

  /**
   * 处理讯飞 RTASR 文本消息。
   * @param {object} msg
   * @param {Function} resolveConnect
   * @param {Function} rejectConnect
   */
  _handleMessage(msg, resolveConnect, rejectConnect) {
    const action = msg?.action;
    const code = String(msg?.code ?? "");
    if (action === "error" || (code && code !== "0")) {
      const err = new Error(msg?.desc || `讯飞 ASR 错误 ${code}`);
      if (!this.started) {
        rejectConnect(err);
        return;
      }
      this.onError(err);
      return;
    }

    if (action === "started") {
      this.started = true;
      this.onReady();
      resolveConnect();
      return;
    }

    if (action !== "result") return;

    const parsed = parseXfyunResultData(msg?.data);
    if (!parsed || !parsed.text) return;

    // 角色分离模式下只有切换点返回正数 rl，其余结果复用最近一次角色。
    if (parsed.roleId) {
      this.lastSpeakerId = `role_${parsed.roleId}`;
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
   * 向讯飞发送 PCM 音频块。
   * @param {Buffer} pcmBuffer
   */
  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.started) {
      this.ws.send(pcmBuffer);
    }
  }

  /**
   * 通知讯飞音频发送结束。
   */
  async stop() {
    if (!this.ws || this.closed || !this.started) return;
    try {
      this.ws.send(JSON.stringify({ end: true }));
    } catch {}
  }

  /**
   * 主动关闭底层 WebSocket。
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
  XfyunAsrSession,
  buildXfyunSigna,
  buildXfyunWsUrl,
  parseXfyunResultData,
};
