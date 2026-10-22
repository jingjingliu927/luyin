const crypto = require("crypto");
const WebSocket = require("ws");

const NLS_META_URL = "https://nls-meta.cn-shanghai.aliyuncs.com/";
const NLS_GATEWAY = "wss://nls-gateway-cn-shanghai.aliyuncs.com/ws/v1";

let cachedNlsToken = null;
let nlsTokenExpiresAt = 0;

/* ── 阿里云 RPC 签名工具 ── */

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/\*/g, "%2A");
}

function buildSignature(params, accessKeySecret) {
  const sorted = Object.keys(params).sort();
  const canonicalized = sorted
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalized)}`;
  return crypto
    .createHmac("sha1", accessKeySecret + "&")
    .update(stringToSign)
    .digest("base64");
}

/* ── 获取 NLS Token ── */

async function getNlsToken() {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;

  if (!accessKeyId || !accessKeySecret) {
    throw new Error("缺少阿里云 AccessKey 配置");
  }

  if (cachedNlsToken && Date.now() < nlsTokenExpiresAt) {
    return cachedNlsToken;
  }

  const params = {
    Action: "CreateToken",
    Version: "2019-02-28",
    Format: "JSON",
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  };

  params.Signature = buildSignature(params, accessKeySecret);

  const body = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");

  const resp = await fetch(NLS_META_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await resp.json();

  if (!data.Token || !data.Token.Id) {
    throw new Error(`获取 NLS Token 失败: ${JSON.stringify(data)}`);
  }

  cachedNlsToken = data.Token.Id;
  nlsTokenExpiresAt = data.Token.ExpireTime * 1000 - 60_000;
  console.log("NLS Token 已获取，有效期至", new Date(nlsTokenExpiresAt).toLocaleString());
  return cachedNlsToken;
}

/* ── ASR 会话类 ── */

class AsrSession {
  constructor(appKey, options = {}) {
    this.appKey = appKey;
    this.taskId = crypto.randomUUID().replace(/-/g, "");
    this.ws = null;
    this.started = false;
    this.closed = false;

    this.onPartialResult = options.onPartialResult || (() => {});
    this.onSentenceEnd = options.onSentenceEnd || (() => {});
    this.onError = options.onError || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onCompleted = options.onCompleted || (() => {});
  }

  async connect() {
    const token = await getNlsToken();

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${NLS_GATEWAY}?token=${token}`, {
        perMessageDeflate: false,
      });

      const connectTimeout = setTimeout(() => {
        reject(new Error("ASR WebSocket 连接超时"));
        this.close();
      }, 10_000);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this._sendStartTranscription();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg, resolve, reject);
        } catch (e) {
          console.error("ASR 消息解析失败:", e.message);
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(connectTimeout);
        console.error("ASR WebSocket 错误:", err.message);
        this.onError(err);
        if (!this.started) reject(err);
      });

      this.ws.on("close", () => {
        this.closed = true;
        if (!this.started) reject(new Error("ASR WebSocket 意外关闭"));
      });
    });
  }

  _sendStartTranscription() {
    const msg = {
      header: {
        message_id: crypto.randomUUID().replace(/-/g, ""),
        task_id: this.taskId,
        namespace: "SpeechTranscriber",
        name: "StartTranscription",
        appkey: this.appKey,
      },
      payload: {
        format: "pcm",
        sample_rate: 16000,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  _handleMessage(msg, resolveConnect, rejectConnect) {
    const name = msg.header?.name;
    const status = msg.header?.status;

    if (status && status !== 20000000) {
      const errMsg = msg.header?.status_text || `ASR 错误 ${status}`;
      console.error("ASR 服务端错误:", errMsg);
      this.onError(new Error(errMsg));
      if (!this.started && rejectConnect) rejectConnect(new Error(errMsg));
      return;
    }

    switch (name) {
      case "TranscriptionStarted":
        this.started = true;
        console.log("ASR 实时转写已启动, taskId:", this.taskId);
        this.onReady();
        if (resolveConnect) resolveConnect();
        break;

      case "TranscriptionResultChanged":
        this.onPartialResult({
          text: msg.payload?.result || "",
          index: msg.payload?.index ?? 0,
          time: msg.payload?.time ?? 0,
        });
        break;

      case "SentenceEnd":
        this.onSentenceEnd({
          text: msg.payload?.result || "",
          index: msg.payload?.index ?? 0,
          time: msg.payload?.time ?? 0,
          beginTime: msg.payload?.begin_time ?? 0,
          words: msg.payload?.words || [],
          confidence: msg.payload?.confidence ?? 0,
        });
        break;

      case "TranscriptionCompleted":
        console.log("ASR 转写完成, taskId:", this.taskId);
        this.onCompleted();
        break;
    }
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.started) {
      this.ws.send(pcmBuffer);
    }
  }

  async stop() {
    if (!this.ws || this.closed || !this.started) return;
    const msg = {
      header: {
        message_id: crypto.randomUUID().replace(/-/g, ""),
        task_id: this.taskId,
        namespace: "SpeechTranscriber",
        name: "StopTranscription",
        appkey: this.appKey,
      },
    };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {}
  }

  close() {
    this.closed = true;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

module.exports = { getNlsToken, AsrSession };
