const { Agent } = require("undici");

const store = require("./store");

const DEFAULT_BASE_URL = "https://v6.kaleido.guru";
const DEFAULT_FINAL_PROMPT = "会议最后总结";

let cachedAuth = null;
// 并发取 token 时复用同一次请求，避免录音开始瞬间打出多次鉴权。
let inflightAuth = null;
let relaxedTlsDispatcher = null;

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/**
 * 读取会议助手配置。
 *
 * AppCode / AppSecret / AgentMatchFlowPath / Base URL / 开关全部来自界面配置
 * （data/meeting-assistant-config.json），不再读 .env。
 * Base URL 未在界面填写时再回退环境变量；结束提示词、TLS 校验仍保留环境变量入口。
 */
function getConfig() {
  const saved = store.readMeetingAssistantConfig();
  return {
    baseUrl: trimTrailingSlash(saved.baseUrl || process.env.BACH_API_BASE_URL || DEFAULT_BASE_URL),
    appCode: saved.appCode,
    appSecret: saved.appSecret,
    // 目前作为 create_conversation 的 super_agent_setting_id 值原样透传。
    agentMatchFlowPath: saved.agentMatchFlowPath,
    finalPrompt: process.env.BACH_FINAL_PROMPT || DEFAULT_FINAL_PROMPT,
    enabled: Boolean(saved.enabled),
    tlsRejectUnauthorized: String(process.env.BACH_TLS_REJECT_UNAUTHORIZED || "1") !== "0",
  };
}

function isConfigured(config = getConfig()) {
  return Boolean(
    config.enabled && config.appCode && config.appSecret && config.agentMatchFlowPath
  );
}

function isAbortError(error) {
  return error?.name === "AbortError" || /aborted/i.test(String(error?.message || ""));
}

function getFetchOptions(config, options = {}) {
  if (config.tlsRejectUnauthorized) return options;
  if (!relaxedTlsDispatcher) {
    // 只对会议助手接口放宽证书链校验，避免全局 NODE_TLS_REJECT_UNAUTHORIZED 影响其它请求。
    relaxedTlsDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return { ...options, dispatcher: relaxedTlsDispatcher };
}

async function readJsonResponse(response, context) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`${context} 返回了无法解析的 JSON`);
  }
  if (!response.ok) {
    throw new Error(`${context} 请求失败（HTTP ${response.status}）`);
  }
  if (data && data.err_code != null && Number(data.err_code) !== 0) {
    throw new Error(data.err_message || `${context} 返回错误码 ${data.err_code}`);
  }
  return data;
}

async function getAuthToken(config = getConfig()) {
  if (!isConfigured(config)) {
    throw new Error("缺少会议助手接口配置");
  }

  const now = Date.now();
  // Base URL 或凭据变了（界面改配置）就不能沿用旧 token。
  const authKey = `${config.baseUrl}|${config.appCode}|${config.appSecret}`;
  if (cachedAuth && cachedAuth.token && cachedAuth.key === authKey && cachedAuth.expiresAt - now > 60_000) {
    return cachedAuth.token;
  }
  if (inflightAuth) return inflightAuth;

  inflightAuth = (async () => {
    const response = await fetch(`${config.baseUrl}/api/bach_api/get_api_auth`, getFetchOptions(config, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_code: config.appCode,
        app_secret: config.appSecret,
      }),
    }));
    const data = await readJsonResponse(response, "会议助手鉴权");
    const token = data?.body?.token;
    if (!token) {
      throw new Error("会议助手鉴权未返回 token");
    }

    // token 有效期由服务端返回秒数，这里提前 2 分钟刷新，避免录音中途过期。
    const ttlMs = Math.max(0, Number(data.body.expiration_time || 0) - 120) * 1000;
    cachedAuth = {
      key: authKey,
      token,
      expiresAt: Date.now() + ttlMs,
    };
    return token;
  })();

  try {
    return await inflightAuth;
  } finally {
    inflightAuth = null;
  }
}

async function createConversation(token, config = getConfig(), options = {}) {
  const url = new URL(`${config.baseUrl}/api/bach_api/create_conversation`);
  url.searchParams.set("super_agent_setting_id", config.agentMatchFlowPath);
  const response = await fetch(url, getFetchOptions(config, {
    method: "POST",
    headers: { token },
    signal: options.signal,
  }));
  const data = await readJsonResponse(response, "会议助手创建会话");
  if (!data?.body) {
    throw new Error("会议助手创建会话未返回 conversationId");
  }
  return data.body;
}

async function invokeAgent({ token, conversationId, content, signal }, config = getConfig()) {
  const response = await fetch(
    `${config.baseUrl}/api/super_agent/conversations/${conversationId}/invoke`,
    getFetchOptions(config, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        token,
      },
      body: JSON.stringify({
        content,
        return_method: "sse",
      }),
      signal,
    })
  );
  const data = await readJsonResponse(response, "会议助手调用智能体");
  const jobId = data?.body?.job_id;
  if (!jobId) {
    throw new Error("会议助手调用智能体未返回 job_id");
  }
  return {
    jobId,
    conversationId: data.body.conversation_id || conversationId,
    sseHubUrl: data.body.sse_hub_url,
    dialogId: data.body.dialog_id,
  };
}

function normalizeAssistantEvent(payload) {
  const first = Array.isArray(payload?.arguments) ? payload.arguments[0] : payload;
  if (!first || typeof first !== "object") return null;
  return {
    status: first.status,
    content: first.content || "",
    fullContent: first.full_content || first.content || "",
    reasoningContent: first.reasoning_content || "",
    reasoningFullContent: first.reasoning_full_content || "",
    dialogId: first.dialog_id || payload?.dialog_id || "",
    messageType: first.message_type || "text",
  };
}

/**
 * 解析单行 SSE 内容。
 * @param {string} line
 * @returns {object|null} 非 JSON 心跳、注释行和 [DONE] 返回 null
 */
function parseSseLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  const dataLine = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
  if (!dataLine || dataLine === "[DONE]") return null;
  try {
    return JSON.parse(dataLine);
  } catch {
    // 有些服务会把非 JSON 心跳写入 SSE，忽略即可。
    return null;
  }
}

/**
 * 有状态的 SSE 解析器。
 *
 * 一条 data: 行经常被 TCP 分片切成两个 chunk，如果对每个 chunk 独立做 JSON.parse，
 * 半截 JSON 会被静默丢弃——表现为流式内容偶尔少一截，且流的最后一帧被切断时
 * 结果会永久停在倒数第二帧。这里只在完整换行处切分，行尾残片留到下一个 chunk。
 */
function createSseParser() {
  let buffer = "";
  return {
    push(text) {
      buffer += String(text || "");
      const payloads = [];
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const payload = parseSseLine(line);
        if (payload) payloads.push(payload);
      }
      return payloads;
    },
    /** 流结束时取出末尾没有换行结尾的残留行。 */
    flush() {
      const rest = buffer;
      buffer = "";
      const payload = parseSseLine(rest);
      return payload ? [payload] : [];
    },
  };
}

async function readAssistantResponse(
  { token, conversationId, jobId, sseHubUrl, onEvent, signal },
  config = getConfig()
) {
  const url = sseHubUrl?.startsWith("http")
    ? sseHubUrl
    : `${config.baseUrl}${sseHubUrl || `/api/super_agent/sse_hub/${conversationId}/${jobId}`}`;
  const response = await fetch(url, getFetchOptions(config, {
    method: "POST",
    headers: { token },
    signal,
  }));

  if (!response.ok) {
    throw new Error(`会议助手 SSE 请求失败（HTTP ${response.status}）`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const data = await readJsonResponse(response, "会议助手 SSE");
    const event = normalizeAssistantEvent(data);
    if (event) onEvent?.(event);
    return event?.fullContent || "";
  }

  const decoder = new TextDecoder();
  const parser = createSseParser();
  let fullContent = "";

  const consume = (payloads) => {
    for (const payload of payloads) {
      const event = normalizeAssistantEvent(payload);
      if (!event) continue;
      fullContent = event.fullContent || fullContent;
      onEvent?.(event);
    }
  };

  for await (const chunk of response.body) {
    consume(parser.push(decoder.decode(chunk, { stream: true })));
  }
  // 收尾：先冲掉解码器里残留的多字节序列，再取出最后一行未换行的内容。
  consume(parser.push(decoder.decode()));
  consume(parser.flush());

  return fullContent;
}

class BachAgentSession {
  constructor(options = {}) {
    this.config = options.config || getConfig();
    this.token = null;
    this.conversationId = null;
    // 显式队列而非 promise 链，这样会议结束时可以把还没开跑的逐句任务整体丢弃。
    this.pending = [];
    this.running = false;
    this.controllers = new Set();
    this.closed = false;
    // 会议已进入结束流程，不再接受新的逐句请求。
    this.finalizing = false;
  }

  get finalPrompt() {
    return this.config.finalPrompt || DEFAULT_FINAL_PROMPT;
  }

  get enabled() {
    return isConfigured(this.config);
  }

  /** 当前排队等待发送的逐句任务数，用于观测积压。 */
  get backlog() {
    return this.pending.length;
  }

  async start() {
    if (!this.enabled) return null;
    this.token = await getAuthToken(this.config);
    this.conversationId = await createConversation(this.token, this.config);
    return this.conversationId;
  }

  _abortInflight() {
    for (const controller of this.controllers) {
      try { controller.abort(); } catch {}
    }
    this.controllers.clear();
  }

  _dropPending() {
    const dropped = this.pending.length;
    for (const job of this.pending) job.resolve(null);
    this.pending = [];
    return dropped;
  }

  enqueue({ content, sentenceId, onEvent, onError }) {
    // finalizing 之后不再接受逐句请求：stopAsr 是在 asr.stop() 之前就发起总结的，
    // 之后还会 flush 出若干尾句，若继续入队会与总结请求并发打同一个 conversation，
    // 既浪费配额，又会让迟到的 delta 把面板状态从"已完成"打回"处理中"。
    if (!this.enabled || !content || this.closed || this.finalizing) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.pending.push({ content, sentenceId, onEvent, onError, resolve });
      this._drain();
    });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0 && !this.closed) {
        const job = this.pending.shift();
        try {
          job.resolve(await this.send(job));
        } catch (error) {
          // 单句失败不应该卡住后续句子；调用方通过 onError 感知。
          job.onError?.(error);
          job.resolve(null);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * 生成会议结束输出。
   *
   * 会先丢弃仍在排队的逐句任务并中止在途请求：会议已经结束，逐句点评不再有价值，
   * 而总结不能排在几十条积压后面——那样用户在面板关闭前根本等不到结果。
   * @returns {Promise<{content: string, dropped: number}>}
   */
  async finalize({ content, onEvent } = {}) {
    if (!this.enabled) return { content: "", dropped: 0 };
    this.finalizing = true;
    const dropped = this._dropPending();
    this._abortInflight();
    const result = await this.send({
      content: content || this.finalPrompt,
      final: true,
      onEvent,
    });
    return { content: result?.content || "", dropped };
  }

  async send({ content, sentenceId, final = false, onEvent }) {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      // 每次都走一次带缓存的取 token：长会议里 token 会过期，只在 start() 取一次会中途 401。
      this.token = await getAuthToken(this.config);
      if (!this.conversationId) {
        this.conversationId = await createConversation(this.token, this.config, {
          signal: controller.signal,
        });
      }

      const invokeResult = await invokeAgent({
        token: this.token,
        conversationId: this.conversationId,
        content,
        signal: controller.signal,
      }, this.config);

      const fullContent = await readAssistantResponse({
        token: this.token,
        conversationId: invokeResult.conversationId,
        jobId: invokeResult.jobId,
        sseHubUrl: invokeResult.sseHubUrl,
        onEvent,
        signal: controller.signal,
      }, this.config);

      return {
        sentenceId,
        final,
        content: fullContent,
        conversationId: invokeResult.conversationId,
        jobId: invokeResult.jobId,
      };
    } catch (error) {
      // 主动取消（会议结束/会话销毁）不是故障，不要冒泡成用户可见的错误。
      if (isAbortError(error)) return null;
      throw error;
    } finally {
      this.controllers.delete(controller);
    }
  }

  /** 会话销毁：丢弃排队任务并中止在途请求，避免关掉悬浮球后继续消耗配额。 */
  close() {
    this.closed = true;
    this._dropPending();
    this._abortInflight();
  }
}

module.exports = {
  BachAgentSession,
  DEFAULT_FINAL_PROMPT,
  getConfig,
  isConfigured,
  createSseParser,
  parseSseLine,
  normalizeAssistantEvent,
};
