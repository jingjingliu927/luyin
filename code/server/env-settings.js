/**
 * 界面可编辑的 .env 配置。
 *
 * 只开放下面白名单里的键：读取时密钥打码，保存时同时写回 .env 文件并更新 process.env。
 * 这些键在服务端都是用到时才读 process.env，所以保存后下一次录音 / 请求即生效，不用重启。
 * 会议助手的 AppCode / AppSecret / AgentMatchFlowPath 走自己的界面配置（data/meeting-assistant-config.json），不在这里。
 */

const fs = require("fs");
const path = require("path");

const WORKSPACE_ROOT = path.join(__dirname, "..", "..");

/** 识别引擎：value 与 ws-server.js startAsr 里的 provider 取值一致。 */
const ASR_PROVIDERS = [
  { value: "xfyun", label: "讯飞实时转写（标准版）", group: "xfyun" },
  { value: "xfyun_llm", label: "讯飞实时转写大模型", group: "xfyun_llm" },
  { value: "aliyun", label: "阿里云智能语音", group: "aliyun" },
  { value: "funasr", label: "本地 FunASR / SenseVoice", group: "funasr" },
];

const SETTINGS_GROUPS = [
  {
    id: "asr",
    title: "识别引擎",
    description: "录音时用哪家做实时转写。本地 FunASR 连不上时，会自动改用已配置好的讯飞。",
    fields: [
      {
        key: "ASR_PROVIDER",
        label: "当前识别引擎",
        type: "select",
        defaultValue: "xfyun",
        options: ASR_PROVIDERS.map(({ value, label }) => ({ value, label })),
      },
    ],
  },
  {
    id: "xfyun",
    title: "讯飞实时转写（标准版）",
    description: "在讯飞开放平台「实时语音转写」应用里获取。AppID 同时用于大模型版和声纹。",
    fields: [
      { key: "XFYUN_APP_ID", label: "AppID", type: "text", required: true },
      { key: "XFYUN_API_KEY", label: "APIKey", type: "secret", required: true },
      { key: "XFYUN_LANG", label: "识别语种", type: "text", placeholder: "cn", advanced: true, help: "cn 中文，en 英文" },
      { key: "XFYUN_ROLE_TYPE", label: "角色分离", type: "text", placeholder: "不设置", advanced: true, help: "2 表示开启讯飞角色分离" },
      { key: "XFYUN_PUNC", label: "标点过滤", type: "text", placeholder: "不设置", advanced: true, help: "0 表示返回结果不带标点" },
      { key: "XFYUN_PD", label: "垂直领域", type: "text", placeholder: "不设置", advanced: true, help: "如 edu、court、finance 等领域个性化参数" },
      { key: "XFYUN_VAD_MDN", label: "远近场模式", type: "text", placeholder: "不设置", advanced: true, help: "1 远场，2 近场" },
      { key: "XFYUN_ENG_LANG_TYPE", label: "语言识别模式", type: "text", placeholder: "不设置", advanced: true, help: "按讯飞文档填写 engLangType" },
    ],
  },
  {
    id: "xfyun_llm",
    title: "讯飞实时转写大模型",
    description: "开放平台控制台里的 APIKey / APISecret 对应下面两项；AppID 与标准版共用。",
    fields: [
      { key: "XFYUN_ACCESS_KEY_ID", label: "APIKey（accessKeyId）", type: "secret", required: true },
      { key: "XFYUN_ACCESS_KEY_SECRET", label: "APISecret（accessKeySecret）", type: "secret", required: true },
      { key: "XFYUN_LLM_LANG", label: "识别语种", type: "text", placeholder: "autodialect", advanced: true, help: "autodialect 为中文及方言自动识别" },
      { key: "XFYUN_LLM_ROLE_TYPE", label: "角色分离", type: "text", placeholder: "2", advanced: true, help: "2 表示开启说话人分离" },
      { key: "XFYUN_LLM_ENG_SPK_MATCH", label: "声纹匹配", type: "text", placeholder: "有声纹时自动为 1", advanced: true, help: "1 表示用已注册声纹匹配说话人" },
      { key: "XFYUN_LLM_PD", label: "垂直领域", type: "text", placeholder: "不设置", advanced: true },
      { key: "XFYUN_LLM_PUNC", label: "标点", type: "text", placeholder: "不设置", advanced: true },
      { key: "XFYUN_LLM_VAD_MDN", label: "远近场模式", type: "text", placeholder: "不设置", advanced: true },
      { key: "XFYUN_LLM_SAMPLE_RATE", label: "采样率", type: "number", placeholder: "16000", advanced: true, help: "需与录音格式一致，一般不要改" },
      { key: "XFYUN_LLM_AUDIO_ENCODE", label: "音频编码", type: "text", placeholder: "pcm_s16le", advanced: true, help: "需与录音格式一致，一般不要改" },
    ],
  },
  {
    id: "aliyun",
    title: "阿里云智能语音",
    description: "在阿里云智能语音交互控制台获取项目 AppKey，以及有权限的 AccessKey。",
    fields: [
      { key: "ASR_APP_KEY", label: "项目 AppKey", type: "text", required: true },
      { key: "ALIBABA_CLOUD_ACCESS_KEY_ID", label: "AccessKey ID", type: "secret", required: true },
      { key: "ALIBABA_CLOUD_ACCESS_KEY_SECRET", label: "AccessKey Secret", type: "secret", required: true },
    ],
  },
  {
    id: "funasr",
    title: "本地 FunASR / SenseVoice",
    description: "免费的本地识别，需要先在本机启动 FunASR WebSocket 服务。",
    fields: [
      { key: "FUNASR_WS_URL", label: "服务地址", type: "text", placeholder: "ws://127.0.0.1:10095", pattern: "^wss?://", patternMessage: "服务地址必须以 ws:// 或 wss:// 开头" },
      {
        key: "FUNASR_MODE",
        label: "识别模式",
        type: "select",
        defaultValue: "2pass",
        options: [
          { value: "2pass", label: "2pass：边说边出，句末再纠正" },
          { value: "online", label: "online：只要实时结果" },
          { value: "offline", label: "offline：只要整句结果" },
        ],
      },
      { key: "FUNASR_ITN", label: "数字规整（ITN）", type: "toggle", defaultValue: "1", help: "把「一百二十」写成「120」" },
      { key: "FUNASR_HOTWORDS", label: "热词", type: "textarea", placeholder: "不设置", help: "按 FunASR 服务要求的格式填写" },
      { key: "FUNASR_CHUNK_SIZE", label: "分片大小", type: "text", placeholder: "5,10,5", advanced: true },
      { key: "FUNASR_CHUNK_INTERVAL", label: "分片间隔", type: "number", placeholder: "10", advanced: true },
    ],
  },
  {
    id: "speaker",
    title: "说话人与声纹",
    description: "本地分人策略和讯飞声纹 1:N 认人。声纹密钥不填时复用讯飞标准版的 APIKey / 大模型的 APISecret。",
    fields: [
      {
        key: "SPEAKER_PROFILE",
        label: "分人策略",
        type: "select",
        defaultValue: "multi",
        options: [
          { value: "single", label: "单人稳定：基本只有一个人说话" },
          { value: "balanced", label: "平衡" },
          { value: "multi", label: "多人优先：会议、多人讨论" },
        ],
      },
      { key: "XFYUN_VP_MATCH_THRESHOLD", label: "声纹匹配阈值", type: "number", placeholder: "0.6", min: 0, max: 1, step: 0.05, help: "0~1，分数达到这个值才认定是某个人" },
      { key: "XFYUN_VP_GROUP_ID", label: "声纹库分组", type: "text", placeholder: "luyin_default", pattern: "^[A-Za-z0-9_]{0,32}$", patternMessage: "声纹库分组只能用字母、数字、下划线，最长 32 位" },
      { key: "XFYUN_VP_API_KEY", label: "声纹 APIKey", type: "secret", advanced: true },
      { key: "XFYUN_VP_API_SECRET", label: "声纹 APISecret", type: "secret", advanced: true },
    ],
  },
  {
    id: "meeting",
    title: "会议助手（补充项）",
    description: "AppCode、AppSecret、AgentMatchFlowPath 和开关在「会议助手」页配置，这里是其余几项。",
    fields: [
      { key: "BACH_FINAL_PROMPT", label: "会议结束提示词", type: "text", placeholder: "会议最后总结", help: "停止录音时发给智能体的那句话" },
      { key: "BACH_TLS_REJECT_UNAUTHORIZED", label: "校验 HTTPS 证书", type: "toggle", defaultValue: "1", help: "内网自签证书连不上时才关闭" },
      { key: "BACH_API_BASE_URL", label: "备用 API Base URL", type: "text", placeholder: "https://v6.kaleido.guru", pattern: "^https?://", patternMessage: "备用 API Base URL 必须是 http 或 https 地址", advanced: true, help: "只在会议助手页没填 Base URL 时使用" },
    ],
  },
  {
    id: "summary",
    title: "会议总结接口",
    description: "「语音录入」里生成会议纪要时调用的接口。鉴权三选一：自定义请求头 > Bearer API Key > token 头。",
    fields: [
      { key: "MEETING_SUMMARY_API_URL", label: "接口地址", type: "text", placeholder: "未配置时不生成纪要", pattern: "^https?://", patternMessage: "会议总结接口地址必须是 http 或 https 地址" },
      { key: "MEETING_SUMMARY_API_KEY", label: "API Key（Bearer）", type: "secret" },
      { key: "MEETING_SUMMARY_API_TOKEN", label: "token 请求头", type: "secret" },
      { key: "MEETING_SUMMARY_AUTH_HEADER", label: "自定义请求头名称", type: "text", placeholder: "如 X-Api-Key", advanced: true },
      { key: "MEETING_SUMMARY_AUTH_VALUE", label: "自定义请求头值", type: "secret", advanced: true },
      { key: "MEETING_SUMMARY_TIMEOUT_MS", label: "超时（毫秒）", type: "number", placeholder: "30000", min: 1000, advanced: true },
    ],
  },
  {
    id: "agent",
    title: "任务智能体",
    description: "可选：说「创建任务…」「提交 bug…」时，把内容同时发给一个 Kaleido 超级智能体处理。三项都填才会调用，否则只在本地建任务。",
    fields: [
      { key: "KALEIDO_TASK_AGENT_URL", label: "智能体调用地址", type: "text", placeholder: "未配置时不调用", pattern: "^https?://", patternMessage: "智能体调用地址必须是 http 或 https 地址" },
      { key: "KALEIDO_APP_CODE", label: "AppCode", type: "text", placeholder: "未配置" },
      { key: "KALEIDO_APP_SECRET", label: "AppSecret", type: "secret", placeholder: "未配置" },
      { key: "KALEIDO_AUTH_URL", label: "鉴权地址", type: "text", placeholder: "https://v5.kaleido.guru/api/bach_api/get_api_auth", pattern: "^https?://", patternMessage: "鉴权地址必须是 http 或 https 地址", advanced: true },
    ],
  },
];

const FIELDS = new Map();
for (const group of SETTINGS_GROUPS) {
  for (const field of group.fields) FIELDS.set(field.key, { ...field, group: group.id });
}

/** 各识别引擎必须配齐的键（与 ws-server.js 里开始录音前的校验保持一致）。 */
const PROVIDER_REQUIREMENTS = {
  xfyun: ["XFYUN_APP_ID", "XFYUN_API_KEY"],
  xfyun_llm: ["XFYUN_APP_ID", "XFYUN_ACCESS_KEY_ID", "XFYUN_ACCESS_KEY_SECRET"],
  aliyun: ["ASR_APP_KEY", "ALIBABA_CLOUD_ACCESS_KEY_ID", "ALIBABA_CLOUD_ACCESS_KEY_SECRET"],
  funasr: [],
};

/**
 * 保存到哪个 .env：桌面版写用户数据目录（安装包里那份只读），Web 版写仓库根目录，
 * 与 index.js 启动时的读取顺序一致。
 */
function getEnvWritePath(env = process.env) {
  if (env.LUYIN_USER_DATA) return path.join(env.LUYIN_USER_DATA, ".env");
  return path.join(WORKSPACE_ROOT, ".env");
}

/** 桌面版第一次保存时，以安装包内置的 .env 为底稿，避免丢掉没在界面里出现的配置。 */
function getEnvSeedPath(env = process.env) {
  const candidates = env.LUYIN_USER_DATA
    ? [path.join(env.LUYIN_USER_DATA, ".env"), process.resourcesPath && path.join(process.resourcesPath, ".env")]
    : [path.join(WORKSPACE_ROOT, ".env")];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function normalizeProvider(value) {
  const p = String(value || "xfyun").toLowerCase();
  if (p === "isi") return "aliyun";
  if (p === "sensevoice") return "funasr";
  return PROVIDER_REQUIREMENTS[p] ? p : "xfyun";
}

function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "";
  return `********${s.slice(-4)}`;
}

function isMaskedValue(value) {
  return /^\*{4,}/.test(String(value || ""));
}

function hasValue(env, key) {
  return String(env[key] ?? "").trim() !== "";
}

/** 读取界面要展示的配置：密钥只给打码串和「是否已填」。 */
function readSettings(env = process.env) {
  const groups = SETTINGS_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    description: group.description,
    fields: group.fields.map((field) => {
      const raw = String(env[field.key] ?? "");
      const base = {
        key: field.key,
        label: field.label,
        type: field.type,
        required: Boolean(field.required),
        advanced: Boolean(field.advanced),
        placeholder: field.placeholder || "",
        help: field.help || "",
        options: field.options || null,
        defaultValue: field.defaultValue ?? "",
        min: field.min,
        max: field.max,
        step: field.step,
      };
      if (field.type === "secret") {
        return { ...base, value: "", hasValue: raw.trim() !== "", masked: maskSecret(raw) };
      }
      return { ...base, value: raw, hasValue: raw.trim() !== "" };
    }),
  }));

  const current = normalizeProvider(env.ASR_PROVIDER);
  const providers = ASR_PROVIDERS.map((p) => {
    const missing = PROVIDER_REQUIREMENTS[p.value]
      .filter((key) => !hasValue(env, key))
      .map((key) => FIELDS.get(key).label);
    return { ...p, ready: missing.length === 0, missing, current: p.value === current };
  });

  return {
    envFile: getEnvWritePath(env),
    provider: current,
    providerReady: providers.find((p) => p.current).ready,
    providers,
    groups,
  };
}

/** 校验并整理前端提交的改动；返回 { changes: {KEY: value|null}, error }。null 表示删除该键。 */
function normalizePatch(patch) {
  const changes = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { changes, error: "配置格式不正确" };
  }
  for (const [key, rawValue] of Object.entries(patch)) {
    const field = FIELDS.get(key);
    // 白名单之外的键一律拒绝，避免借设置接口改 PATH、NODE_OPTIONS 之类的进程变量。
    if (!field) return { changes, error: `不支持修改 ${key}` };
    // 显式传 null 表示清空（密钥只能这样清掉，因为空字符串代表「不修改」）。
    if (rawValue === null) {
      changes[key] = null;
      continue;
    }
    let value = typeof rawValue === "boolean" ? (rawValue ? "1" : "0") : String(rawValue ?? "");
    value = field.type === "textarea" ? value.replace(/\r\n/g, "\n").trim() : value.trim();

    // 密钥回显的是打码串；没有重新输入就不动原值。
    if (field.type === "secret" && (value === "" || isMaskedValue(value))) continue;
    if (field.type !== "textarea" && /[\r\n]/.test(value)) return { changes, error: `${field.label}不能包含换行` };
    if (value === "") {
      changes[key] = null;
      continue;
    }
    if (field.type === "select" && !field.options.some((o) => o.value === value)) {
      return { changes, error: `${field.label}的取值不正确` };
    }
    if (field.type === "toggle" && !["0", "1"].includes(value)) {
      return { changes, error: `${field.label}的取值不正确` };
    }
    if (field.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) return { changes, error: `${field.label}必须是数字` };
      if (field.min !== undefined && n < field.min) return { changes, error: `${field.label}不能小于 ${field.min}` };
      if (field.max !== undefined && n > field.max) return { changes, error: `${field.label}不能大于 ${field.max}` };
    }
    if (field.pattern && !new RegExp(field.pattern, "i").test(value)) {
      return { changes, error: field.patternMessage || `${field.label}格式不正确` };
    }
    changes[key] = value;
  }
  return { changes, error: null };
}

/** 按 dotenv 能原样读回的方式给值加引号。 */
function serializeEnvValue(value) {
  const s = String(value);
  // dotenv 只在双引号里把 \n 还原成换行，不处理其它转义，所以这里也只转换行。
  if (s.includes("\n")) return `"${s.replace(/\n/g, "\\n").replace(/"/g, "'")}"`;
  if (/^[^\s#"'`\\]*$/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `\`${s.replace(/`/g, "'")}\``;
}

/**
 * 把改动套到 .env 文本上：已有的键原地替换（保留注释和顺序），被清空的键删掉，
 * 新键追加到文件末尾。纯函数，便于测试。
 */
function applyEnvPatch(text, changes) {
  const pending = new Map(Object.entries(changes));
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !pending.has(match[1])) {
      out.push(line);
      continue;
    }
    const key = match[1];
    const value = pending.get(key);
    // 同一个键在文件里写了多次时，只改第一处，其余重复行删掉，免得 dotenv 读到旧值。
    pending.set(key, undefined);
    if (value === undefined || value === null) continue;
    out.push(`${key}=${serializeEnvValue(value)}`);
  }
  const appended = [...pending.entries()].filter(([, v]) => v !== undefined && v !== null);
  if (appended.length) {
    while (out.length && out[out.length - 1].trim() === "") out.pop();
    out.push("", "# 以下由「设置」页面写入");
    for (const [key, value] of appended) out.push(`${key}=${serializeEnvValue(value)}`);
  }
  return out.join("\n").replace(/\n*$/, "\n");
}

/** 保存设置：写 .env 文件并同步 process.env，返回最新的界面数据。 */
function updateSettings(patch, env = process.env) {
  const { changes, error } = normalizePatch(patch);
  if (error) {
    const err = new Error(error);
    err.status = 400;
    throw err;
  }
  if (Object.keys(changes).length === 0) return readSettings(env);

  const target = getEnvWritePath(env);
  const seed = fs.existsSync(target) ? target : getEnvSeedPath(env);
  const before = seed ? fs.readFileSync(seed, "utf8") : "";
  const next = applyEnvPatch(before, changes);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 先写临时文件再改名，避免写到一半崩溃留下半截 .env。
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, target);

  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return readSettings(env);
}

module.exports = {
  ASR_PROVIDERS,
  SETTINGS_GROUPS,
  PROVIDER_REQUIREMENTS,
  getEnvWritePath,
  readSettings,
  updateSettings,
  normalizePatch,
  applyEnvPatch,
  serializeEnvValue,
  maskSecret,
};
