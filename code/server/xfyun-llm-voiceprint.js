/**
 * 讯飞大模型实时转写配套声纹接口封装。
 * 文档地址：https://www.xfyun.cn/doc/spark/asr_llm/voice_print.html
 */

const {
  buildSortedQueryString,
  formatOfficeDateTime,
  randomSignatureSeed,
  signOfficeParams,
} = require("./xfyun-office-auth");

const OFFICE_VP_BASE_URL = "https://office-api-personal-dx.iflyaisol.com/res/feature/v1";
const VOICEPRINT_SAMPLE_RATE = 16000;

/**
 * 读取大模型声纹接口所需配置。
 * @returns {{appId: string, accessKeyId: string, accessKeySecret: string}}
 */
function getOfficeVoiceprintConfig() {
  return {
    appId: process.env.XFYUN_APP_ID || "",
    accessKeyId: process.env.XFYUN_ACCESS_KEY_ID || "",
    accessKeySecret: process.env.XFYUN_ACCESS_KEY_SECRET || "",
  };
}

/**
 * 校验大模型声纹接口配置是否完整。
 * @returns {string|null} 错误信息或 null 表示通过
 */
function validateOfficeVoiceprintConfig() {
  const config = getOfficeVoiceprintConfig();
  if (!config.appId || !config.accessKeyId || !config.accessKeySecret) {
    return "缺少 XFYUN_APP_ID、XFYUN_ACCESS_KEY_ID 或 XFYUN_ACCESS_KEY_SECRET 配置";
  }
  return null;
}

/**
 * 从 WAV Buffer 中解析 PCM 元信息。
 * @param {Buffer} buffer
 * @returns {{data: Buffer, sampleRate: number, channels: number, bitsPerSample: number}|null}
 */
function parseWavPcm(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
      };
    }
    if (chunkId === "data") {
      data = buffer.subarray(chunkStart, chunkStart + chunkSize);
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    return null;
  }
  return {
    data,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
  };
}

/**
 * 读取指定采样点的混合单声道样本。
 * @param {Buffer} pcm
 * @param {number} frameIndex
 * @param {number} channels
 * @returns {number}
 */
function readMonoSample(pcm, frameIndex, channels) {
  let sum = 0;
  for (let channel = 0; channel < channels; channel += 1) {
    const offset = (frameIndex * channels + channel) * 2;
    sum += pcm.readInt16LE(offset);
  }
  return sum / channels;
}

/**
 * 将 16-bit PCM 重采样为 16k 单声道，降低声纹注册 payload 大小。
 * @param {{data: Buffer, sampleRate: number, channels: number}} wav
 * @returns {Buffer}
 */
function resampleWavToVoiceprintPcm(wav) {
  const sourceFrames = Math.floor(wav.data.length / (wav.channels * 2));
  const targetFrames = Math.max(0, Math.round((sourceFrames * VOICEPRINT_SAMPLE_RATE) / wav.sampleRate));
  const output = Buffer.alloc(targetFrames * 2);
  const ratio = wav.sampleRate / VOICEPRINT_SAMPLE_RATE;

  for (let i = 0; i < targetFrames; i += 1) {
    const sourceIndex = i * ratio;
    const leftIndex = Math.min(sourceFrames - 1, Math.floor(sourceIndex));
    const rightIndex = Math.min(sourceFrames - 1, leftIndex + 1);
    const frac = sourceIndex - leftIndex;
    const left = readMonoSample(wav.data, leftIndex, wav.channels);
    const right = readMonoSample(wav.data, rightIndex, wav.channels);
    const value = Math.round(left * (1 - frac) + right * frac);
    output.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }

  return output;
}

/**
 * 将上传音频归一化为大模型声纹接口推荐的 16k/16bit/mono raw PCM。
 * @param {Buffer} buffer
 * @returns {{audioBase64: string, audioType: string, durationSeconds: number|null}}
 */
function normalizeVoiceprintAudio(buffer) {
  const wav = parseWavPcm(buffer);
  if (!wav) {
    return {
      audioBase64: Buffer.isBuffer(buffer) ? buffer.toString("base64") : "",
      audioType: "raw",
      durationSeconds: null,
    };
  }

  const pcm = wav.sampleRate === VOICEPRINT_SAMPLE_RATE && wav.channels === 1
    ? wav.data
    : resampleWavToVoiceprintPcm(wav);
  return {
    audioBase64: pcm.toString("base64"),
    audioType: "raw",
    durationSeconds: pcm.length / (VOICEPRINT_SAMPLE_RATE * 2),
  };
}

/**
 * 生成办公系声纹接口的 URL 与 signature 请求头。
 * @param {string} action register / update / delete
 * @param {Date} [now]
 * @returns {{url: string, signature: string}}
 */
function buildOfficeVoiceprintRequest(action, now = new Date()) {
  const config = getOfficeVoiceprintConfig();
  const query = {
    appId: config.appId,
    accessKeyId: config.accessKeyId,
    dateTime: formatOfficeDateTime(now),
    // 文档要求每次请求携带随机串；截取 16 位便于排查和复现。
    signatureRandom: randomSignatureSeed().slice(0, 16),
  };
  const signature = signOfficeParams(query, config.accessKeySecret);
  return {
    url: `${OFFICE_VP_BASE_URL}/${action}?${buildSortedQueryString(query)}`,
    signature,
  };
}

/**
 * 统一调用大模型声纹接口，并解析 data 字符串。
 * @param {string} action register / update / delete
 * @param {object} body JSON 请求体
 * @returns {Promise<{ok: boolean, data?: object, code?: string|number, message?: string, raw?: object}>}
 */
async function callOfficeVoiceprintApi(action, body) {
  const missing = validateOfficeVoiceprintConfig();
  if (missing) {
    return { ok: false, message: missing };
  }

  const { url, signature } = buildOfficeVoiceprintRequest(action);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        signature,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, message: `大模型声纹接口网络错误: ${error.message}` };
  }

  let raw = null;
  try {
    raw = await response.json();
  } catch {
    return { ok: false, message: "大模型声纹接口返回了无法解析的响应" };
  }

  const code = raw?.code;
  if (!response.ok || (code !== "000000" && code !== 0)) {
    return {
      ok: false,
      code,
      message: raw?.desc || raw?.message || `大模型声纹接口请求失败（HTTP ${response.status}）`,
      raw,
    };
  }

  let data = {};
  if (typeof raw?.data === "string" && raw.data.trim()) {
    try {
      data = JSON.parse(raw.data);
    } catch {
      data = { raw: raw.data };
    }
  } else if (raw?.data && typeof raw.data === "object") {
    data = raw.data;
  }

  return { ok: true, data, raw };
}

/**
 * 注册大模型转写可使用的声纹特征。
 * @param {{audioBase64: string, audioType?: string, uid?: string}} options
 */
function registerOfficeVoiceprint(options = {}) {
  return callOfficeVoiceprintApi("register", {
    audio_data: options.audioBase64 || "",
    audio_type: options.audioType || "raw",
    uid: options.uid || undefined,
  });
}

/**
 * 更新已注册的大模型声纹特征。
 * @param {{featureId: string, audioBase64: string, audioType?: string}} options
 */
function updateOfficeVoiceprint(options = {}) {
  return callOfficeVoiceprintApi("update", {
    audio_data: options.audioBase64 || "",
    audio_type: options.audioType || "raw",
    feature_id: options.featureId,
  });
}

/**
 * 删除一个或多个大模型声纹特征。
 * @param {{featureIds: string[]}} options
 */
function deleteOfficeVoiceprints(options = {}) {
  return callOfficeVoiceprintApi("delete", {
    feature_ids: Array.isArray(options.featureIds) ? options.featureIds : [],
  });
}

module.exports = {
  getOfficeVoiceprintConfig,
  validateOfficeVoiceprintConfig,
  buildOfficeVoiceprintRequest,
  normalizeVoiceprintAudio,
  registerOfficeVoiceprint,
  updateOfficeVoiceprint,
  deleteOfficeVoiceprints,
};
