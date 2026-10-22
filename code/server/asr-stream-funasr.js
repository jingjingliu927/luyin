/**
 * FunASR / SenseVoice 本地实时识别接入层。
 * 目标：把本地 WebSocket ASR 服务适配成现有 onReady / onPartialResult / onSentenceEnd 协议。
 */

const crypto = require("crypto");
const WebSocket = require("ws");

const DEFAULT_FUNASR_WS_URL = "ws://127.0.0.1:10095";

function parseChunkSize(value) {
  if (Array.isArray(value)) return value.map(Number).filter((n) => Number.isFinite(n));
  return String(value || "5,10,5")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n));
}

function toBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === "") return defaultValue;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function buildFunAsrStartMessage(options = {}) {
  const mode = options.mode || "2pass";
  return {
    mode,
    chunk_size: parseChunkSize(options.chunkSize),
    chunk_interval: Number(options.chunkInterval || 10),
    wav_name: options.wavName || `luyin_${crypto.randomUUID()}`,
    is_speaking: true,
    hotwords: options.hotwords || "",
    itn: toBoolean(options.itn, true),
  };
}

function extractFunAsrTime(msg = {}) {
  const sentence = Array.isArray(msg.stamp_sents) && msg.stamp_sents.length > 0
    ? msg.stamp_sents[msg.stamp_sents.length - 1]
    : null;
  if (sentence) {
    return {
      beginTime: Number(sentence.start || sentence.start_ms || 0),
      endTime: Number(sentence.end || sentence.end_ms || sentence.ts || 0),
    };
  }

  const timestamp = Array.isArray(msg.timestamp) && msg.timestamp.length > 0
    ? msg.timestamp[msg.timestamp.length - 1]
    : null;
  if (Array.isArray(timestamp)) {
    return {
      beginTime: Number(timestamp[0] || 0),
      endTime: Number(timestamp[1] || timestamp[0] || 0),
    };
  }

  return {
    beginTime: Number(msg.begin_time || msg.beginTime || 0),
    endTime: Number(msg.end_time || msg.endTime || msg.time || 0),
  };
}

function parseFunAsrMessage(payload) {
  const msg = typeof payload === "string" ? JSON.parse(payload) : payload;
  const text = String(msg?.text || msg?.result || msg?.sentence || "").trim();
  if (!text) return null;

  const mode = String(msg?.mode || msg?.type || "").toLowerCase();
  const explicitFinal = msg?.is_final === true || msg?.final === true;
  const explicitPartial = msg?.is_final === false || msg?.partial === true;
  // FunASR 2pass 通常用 *-online 表示增量，用 *-offline 表示最终修正结果。
  const isFinal = explicitFinal || mode.includes("offline") || mode === "final";
  const isPartial = !isFinal && (explicitPartial || mode.includes("online") || mode === "partial");
  const { beginTime, endTime } = extractFunAsrTime(msg);

  return {
    text,
    mode,
    isFinal,
    isPartial,
    beginTime,
    endTime,
    raw: msg,
  };
}

class FunAsrSession {
  constructor(options = {}) {
    this.url = options.url || DEFAULT_FUNASR_WS_URL;
    this.mode = options.mode || "2pass";
    this.chunkSize = options.chunkSize;
    this.chunkInterval = options.chunkInterval;
    this.hotwords = options.hotwords || "";
    this.itn = options.itn;
    this.ws = null;
    this.started = false;
    this.closed = false;
    this.completed = false;
    this.sentenceIndex = 0;
    this.lastPartial = null;
    this.lastFinalText = "";
    this.completeTimer = null;

    this.onPartialResult = options.onPartialResult || (() => {});
    this.onSentenceEnd = options.onSentenceEnd || (() => {});
    this.onError = options.onError || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onCompleted = options.onCompleted || (() => {});
  }

  async connect() {
    return new Promise((resolve, reject) => {
      // 官方 Python FunASR websocket 服务会校验 binary 子协议，否则握手返回 400。
      this.ws = new WebSocket(this.url, "binary", { perMessageDeflate: false });
      const connectTimeout = setTimeout(() => {
        reject(new Error("FunASR WebSocket 连接超时"));
        this.close();
      }, 10_000);

      this.ws.on("open", () => {
        clearTimeout(connectTimeout);
        this.started = true;
        // FunASR 服务通常需要先接收一条配置消息，再开始接收 PCM 音频帧。
        this.ws.send(JSON.stringify(buildFunAsrStartMessage({
          mode: this.mode,
          chunkSize: this.chunkSize,
          chunkInterval: this.chunkInterval,
          hotwords: this.hotwords,
          itn: this.itn,
        })));
        this.onReady();
        resolve();
      });

      this.ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        try {
          this._handleMessage(JSON.parse(data.toString()));
        } catch (error) {
          this.onError(new Error(`FunASR 消息解析失败: ${error.message}`));
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(connectTimeout);
        if (!this.started) {
          reject(error);
          return;
        }
        this.onError(new Error(`FunASR WebSocket 错误: ${error.message}`));
      });

      this.ws.on("close", () => {
        this.closed = true;
        if (this.started) this._complete();
      });
    });
  }

  _handleMessage(msg) {
    const parsed = parseFunAsrMessage(msg);
    if (!parsed) return;

    if (parsed.isFinal || (!parsed.isPartial && this.mode === "offline")) {
      this._emitFinal(parsed);
      return;
    }

    this.lastPartial = parsed;
    this.onPartialResult({
      text: parsed.text,
      index: this.sentenceIndex,
      time: parsed.endTime,
    });
  }

  _emitFinal(parsed) {
    if (!parsed.text || parsed.text === this.lastFinalText) return;
    const index = this.sentenceIndex;
    this.sentenceIndex += 1;
    this.lastFinalText = parsed.text;
    this.lastPartial = null;
    this.onSentenceEnd({
      text: parsed.text,
      index,
      beginTime: parsed.beginTime,
      time: parsed.endTime,
      words: [],
      confidence: 0,
    });
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.started) {
      this.ws.send(pcmBuffer);
    }
  }

  async stop() {
    if (!this.ws || this.closed) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      // is_speaking=false 会提示 FunASR 刷出最终 2pass 结果。
      this.ws.send(JSON.stringify({ is_speaking: false }));
      clearTimeout(this.completeTimer);
      this.completeTimer = setTimeout(() => this.close(), 1500);
    }
  }

  close() {
    clearTimeout(this.completeTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
    if (this.started) this._complete();
  }

  _complete() {
    if (!this.started) return;
    if (this.completed) return;
    if (this.lastPartial && this.lastPartial.text !== this.lastFinalText) {
      // 有些在线模式只返回增量文本；结束时把最后一次增量固化，避免录音归档为空。
      this._emitFinal({ ...this.lastPartial, isFinal: true });
    }
    this.completed = true;
    this.onCompleted();
  }
}

module.exports = {
  DEFAULT_FUNASR_WS_URL,
  FunAsrSession,
  buildFunAsrStartMessage,
  parseFunAsrMessage,
};
