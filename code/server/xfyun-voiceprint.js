/**
 * 讯飞声纹识别（新）API 封装。
 * 基于官方文档：https://www.xfyun.cn/doc/voiceservice/isv_new/API.html
 *
 * 功能列表：
 * 1. 创建声纹特征库 (createGroup)
 * 2. 删除声纹特征库 (deleteGroup)
 * 3. 添加声纹特征 (createFeature)
 * 4. 删除声纹特征 (deleteFeature)
 * 5. 更新声纹特征 (updateFeature)
 * 6. 查询声纹特征列表 (queryFeatureList)
 * 7. 特征比对1:1 (searchScoreFea)
 * 8. 特征比对1:N (searchFea) — 认人核心
 */

const crypto = require("crypto");

// 声纹识别（新）统一请求地址
const VP_API_URL = "https://api.xf-yun.com/v1/private/s1aa729d0";
const VP_HOST = "api.xf-yun.com";
const VP_PATH = "/v1/private/s1aa729d0";

/* ═══════════════════════════════════════════
   配置 & 鉴权
   ═══════════════════════════════════════════ */

/**
 * 读取声纹 API 所需配置。
 * XFYUN_VP_API_KEY / XFYUN_VP_API_SECRET 若未设置，回退到通用密钥。
 * @returns {{appId: string, apiKey: string, apiSecret: string, groupId: string}}
 */
function getVoiceprintConfig() {
  return {
    appId: process.env.XFYUN_APP_ID || "",
    apiKey: process.env.XFYUN_VP_API_KEY || process.env.XFYUN_API_KEY || "",
    apiSecret: process.env.XFYUN_VP_API_SECRET || process.env.XFYUN_ACCESS_KEY_SECRET || "",
    // 声纹库分组标识，字母数字下划线，≤32 字符
    groupId: process.env.XFYUN_VP_GROUP_ID || "luyin_default",
  };
}

/**
 * 校验声纹接口必需配置是否完整。
 * @returns {string|null} 错误信息或 null 表示通过
 */
function validateVoiceprintConfig() {
  const config = getVoiceprintConfig();
  if (!config.appId || !config.apiKey || !config.apiSecret) {
    return "缺少 XFYUN_APP_ID、声纹 APIKey 或 APISecret 配置";
  }
  return null;
}

/**
 * 按照讯飞文档生成带鉴权参数的请求 URL（HMAC-SHA256）。
 * 步骤：
 *   1. signature_origin = "host: {host}\ndate: {date}\nPOST {path} HTTP/1.1"
 *   2. signature = base64( hmac-sha256(signature_origin, apiSecret) )
 *   3. authorization_origin = 'api_key="...", algorithm="hmac-sha256", headers="host date request-line", signature="..."'
 *   4. authorization = base64(authorization_origin)
 * @returns {string} 带鉴权参数的完整 URL
 */
function buildAuthUrl() {
  const { apiKey, apiSecret } = getVoiceprintConfig();
  // RFC1123 格式 UTC 时间
  const date = new Date().toUTCString();

  // 步骤 1：拼接签名原文
  const signatureOrigin = `host: ${VP_HOST}\ndate: ${date}\nPOST ${VP_PATH} HTTP/1.1`;

  // 步骤 2：HMAC-SHA256 + base64
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signatureOrigin, "utf8")
    .digest("base64");

  // 步骤 3 + 4：拼接并编码 authorization
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin, "utf8").toString("base64");

  // URL 参数
  const params = new URLSearchParams({ authorization, host: VP_HOST, date });
  return `${VP_API_URL}?${params.toString()}`;
}

/* ═══════════════════════════════════════════
   统一请求 / 响应处理
   ═══════════════════════════════════════════ */

/**
 * 统一调用声纹 API 并解析响应。
 * @param {object} body   - 请求体（header / parameter / payload）
 * @param {string} resKey - 响应中 payload 的结果键名（如 "createGroupRes"）
 * @returns {Promise<{ok: boolean, data?: any, sid?: string, code?: number, message?: string, raw?: any}>}
 */
async function callVoiceprintApi(body, resKey) {
  const missing = validateVoiceprintConfig();
  if (missing) {
    return { ok: false, message: missing };
  }

  const url = buildAuthUrl();
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        host: VP_HOST,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, message: `声纹接口网络错误: ${err.message}` };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    return { ok: false, message: "声纹接口返回了无法解析的响应" };
  }

  // 鉴权失败会返回 401/403 等非 200 状态码
  if (!response.ok) {
    return {
      ok: false,
      message: data?.message || `声纹接口请求失败（HTTP ${response.status}）`,
      raw: data,
    };
  }

  // 业务层错误：header.code !== 0
  const headerCode = data?.header?.code;
  if (headerCode !== 0) {
    return {
      ok: false,
      code: headerCode,
      message: data?.header?.message || "声纹接口调用失败",
      raw: data,
    };
  }

  // 解析 payload 中 base64 编码的 text 字段
  let parsed = {};
  const textB64 = data?.payload?.[resKey]?.text;
  if (textB64) {
    try {
      const decoded = Buffer.from(textB64, "base64").toString("utf8");
      parsed = JSON.parse(decoded);
    } catch {
      parsed = { raw: textB64 };
    }
  }

  return {
    ok: true,
    sid: data?.header?.sid || "",
    data: parsed,
    raw: data,
  };
}

/* ═══════════════════════════════════════════
   声纹特征库管理
   ═══════════════════════════════════════════ */

/**
 * 创建声纹特征库。
 * @param {{groupId?: string, groupName?: string, groupInfo?: string}} options
 */
async function createGroup(options = {}) {
  const config = getVoiceprintConfig();
  const groupId = options.groupId || config.groupId;
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "createGroup",
          groupId,
          groupName: options.groupName || groupId,
          groupInfo: options.groupInfo || "",
          createGroupRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
    },
    "createGroupRes",
  );
}

/**
 * 删除声纹特征库。
 * @param {{groupId?: string}} options
 */
async function deleteGroup(options = {}) {
  const config = getVoiceprintConfig();
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "deleteGroup",
          groupId: options.groupId || config.groupId,
          deleteGroupRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
    },
    "deleteGroupRes",
  );
}

/**
 * 确保默认声纹特征库存在。首次调用时自动创建，已存在（23005）则视为成功。
 */
async function ensureDefaultGroup() {
  const result = await createGroup();
  if (result.ok || result.code === 23005) {
    return { ok: true };
  }
  return result;
}

/* ═══════════════════════════════════════════
   声纹特征 CRUD
   ═══════════════════════════════════════════ */

/**
 * 添加声纹特征（注册声纹）。
 * 音频要求：16k/16bit/单声道 的原始 PCM（或 WAV 去头后的裸 PCM）。
 * @param {{featureId: string, audioBase64: string, featureInfo?: string, groupId?: string}} options
 */
async function createFeature(options = {}) {
  const config = getVoiceprintConfig();
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "createFeature",
          groupId: options.groupId || config.groupId,
          featureId: options.featureId,
          featureInfo: options.featureInfo || "",
          createFeatureRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
      payload: {
        resource: {
          encoding: "raw",
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          status: 3,
          audio: options.audioBase64,
        },
      },
    },
    "createFeatureRes",
  );
}

/**
 * 删除声纹特征。
 * @param {{featureId: string, groupId?: string}} options
 */
async function deleteFeature(options = {}) {
  const config = getVoiceprintConfig();
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "deleteFeature",
          groupId: options.groupId || config.groupId,
          featureId: options.featureId,
          deleteFeatureRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
    },
    "deleteFeatureRes",
  );
}

/**
 * 更新声纹特征。
 * @param {{featureId: string, audioBase64: string, featureInfo?: string, cover?: boolean, groupId?: string}} options
 */
async function updateFeature(options = {}) {
  const config = getVoiceprintConfig();
  const paramObj = {
    func: "updateFeature",
    groupId: options.groupId || config.groupId,
    featureId: options.featureId,
    updateFeatureRes: { encoding: "utf8", compress: "raw", format: "json" },
  };
  if (options.featureInfo !== undefined) {
    paramObj.featureInfo = options.featureInfo;
  }
  if (options.cover !== undefined) {
    paramObj.cover = options.cover;
  }
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: { s1aa729d0: paramObj },
      payload: {
        resource: {
          encoding: "raw",
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          status: 3,
          audio: options.audioBase64,
        },
      },
    },
    "updateFeatureRes",
  );
}

/**
 * 查询声纹特征库中已注册的特征列表。
 * @param {{groupId?: string}} options
 */
async function queryFeatureList(options = {}) {
  const config = getVoiceprintConfig();
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "queryFeatureList",
          groupId: options.groupId || config.groupId,
          queryFeatureListRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
    },
    "queryFeatureListRes",
  );
}

/* ═══════════════════════════════════════════
   声纹比对 — 认人核心
   ═══════════════════════════════════════════ */

/**
 * 1:1 特征比对 — 将音频与指定 featureId 比对。
 * 返回 score（0~1），建议 ≥0.6 判定为同一人。
 * @param {{featureId: string, audioBase64: string, groupId?: string}} options
 */
async function searchScoreFea(options = {}) {
  const config = getVoiceprintConfig();
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "searchScoreFea",
          groupId: options.groupId || config.groupId,
          dstFeatureId: options.featureId,
          searchScoreFeaRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
      payload: {
        resource: {
          encoding: "raw",
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          status: 3,
          audio: options.audioBase64,
        },
      },
    },
    "searchScoreFeaRes",
  );
}

/**
 * 1:N 特征比对 — 在整个声纹库中搜索最匹配的 topK 个人。
 * 这是"认人"的核心 API。
 * 返回 scoreList: [{ score, featureInfo, featureId }, ...]
 * @param {{audioBase64: string, topK?: number, groupId?: string}} options
 */
async function searchFea(options = {}) {
  const config = getVoiceprintConfig();
  return callVoiceprintApi(
    {
      header: { app_id: config.appId, status: 3 },
      parameter: {
        s1aa729d0: {
          func: "searchFea",
          groupId: options.groupId || config.groupId,
          topK: options.topK || 3,
          searchFeaRes: { encoding: "utf8", compress: "raw", format: "json" },
        },
      },
      payload: {
        resource: {
          encoding: "raw",
          sample_rate: 16000,
          channels: 1,
          bit_depth: 16,
          status: 3,
          audio: options.audioBase64,
        },
      },
    },
    "searchFeaRes",
  );
}

/* ═══════════════════════════════════════════
   辅助：从 WAV Buffer 中剥离文件头，仅保留 PCM 裸数据
   ═══════════════════════════════════════════ */

/**
 * 判断 buffer 是否是标准 RIFF/WAVE 文件，是则跳过文件头返回纯 PCM 数据。
 * 非 WAV 文件直接原样返回（假设调用方已经是裸 PCM）。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function stripWavHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
  // RIFF + WAVE 标识
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE") {
    // 搜索 "data" 子块起始位置
    let offset = 12;
    while (offset + 8 < buf.length) {
      const chunkId = buf.toString("ascii", offset, offset + 4);
      const chunkSize = buf.readUInt32LE(offset + 4);
      if (chunkId === "data") {
        return buf.subarray(offset + 8, offset + 8 + chunkSize);
      }
      offset += 8 + chunkSize;
    }
    // 没找到 data 子块，退而求其次直接跳过前 44 字节
    return buf.subarray(44);
  }
  return buf;
}

module.exports = {
  getVoiceprintConfig,
  validateVoiceprintConfig,
  ensureDefaultGroup,
  createGroup,
  deleteGroup,
  createFeature,
  deleteFeature,
  updateFeature,
  queryFeatureList,
  searchScoreFea,
  searchFea,
  stripWavHeader,
};
