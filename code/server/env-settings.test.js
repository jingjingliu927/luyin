/**
 * 「设置」页读写 .env 的行为测试（node:test）。
 * 关注点：保留原文件注释和顺序、密钥不明文回显、只允许白名单里的键、写完 dotenv 能原样读回。
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");

const settings = require("./env-settings");

let dir;
let env;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-env-settings-"));
  // 用独立的 env 对象模拟 process.env，测试之间互不影响。
  env = { LUYIN_USER_DATA: dir };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function envFile() {
  return path.join(dir, ".env");
}

describe("applyEnvPatch", () => {
  it("原地替换已有键，保留注释和顺序", () => {
    const before = "# 识别\nASR_PROVIDER=funasr\n\n# 讯飞\nXFYUN_APP_ID=old\n";
    const after = settings.applyEnvPatch(before, { ASR_PROVIDER: "xfyun_llm" });
    assert.equal(after, "# 识别\nASR_PROVIDER=xfyun_llm\n\n# 讯飞\nXFYUN_APP_ID=old\n");
  });

  it("清空的键整行删除，新键追加到末尾", () => {
    const before = "A_KEY=1\nFUNASR_HOTWORDS=x\n";
    const after = settings.applyEnvPatch(before, { FUNASR_HOTWORDS: null, SPEAKER_PROFILE: "single" });
    assert.equal(after, "A_KEY=1\n\n# 以下由「设置」页面写入\nSPEAKER_PROFILE=single\n");
  });

  it("同一个键写了多次时只留一处，免得读到旧值", () => {
    const after = settings.applyEnvPatch("X=1\nASR_PROVIDER=a\nASR_PROVIDER=b\n", { ASR_PROVIDER: "aliyun" });
    assert.equal(after, "X=1\nASR_PROVIDER=aliyun\n");
  });

  it("不碰注释掉的同名键", () => {
    const after = settings.applyEnvPatch("# XFYUN_VP_API_KEY=xxx\n", { XFYUN_VP_API_KEY: "k" });
    assert.match(after, /^# XFYUN_VP_API_KEY=xxx\n/);
    assert.match(after, /\nXFYUN_VP_API_KEY=k\n$/);
  });

  it("特殊字符加引号后 dotenv 能原样读回", () => {
    const values = {
      BACH_FINAL_PROMPT: "会议 最后#总结",
      MEETING_SUMMARY_AUTH_VALUE: `a'b"c`,
      FUNASR_HOTWORDS: "阿里巴巴 20\n达摩院 30",
      XFYUN_APP_ID: "abc123",
    };
    const parsed = dotenv.parse(settings.applyEnvPatch("", values));
    assert.deepEqual(parsed, values);
  });
});

describe("readSettings", () => {
  it("密钥只回显打码串，不回显明文", () => {
    env.XFYUN_API_KEY = "supersecretvalue1234";
    const data = settings.readSettings(env);
    const field = data.groups.flatMap((g) => g.fields).find((f) => f.key === "XFYUN_API_KEY");
    assert.equal(field.value, "");
    assert.equal(field.hasValue, true);
    assert.equal(field.masked, "********1234");
    assert.ok(!JSON.stringify(data).includes("supersecretvalue"));
  });

  it("按当前引擎给出缺哪些配置", () => {
    env.ASR_PROVIDER = "xfyun_llm";
    env.XFYUN_APP_ID = "id";
    const data = settings.readSettings(env);
    assert.equal(data.provider, "xfyun_llm");
    assert.equal(data.providerReady, false);
    const llm = data.providers.find((p) => p.value === "xfyun_llm");
    assert.deepEqual(llm.missing, ["APIKey（accessKeyId）", "APISecret（accessKeySecret）"]);
    assert.equal(data.providers.find((p) => p.value === "funasr").ready, true);
  });

  it("老取值 isi / sensevoice 归一到 aliyun / funasr", () => {
    assert.equal(settings.readSettings({ ASR_PROVIDER: "isi" }).provider, "aliyun");
    assert.equal(settings.readSettings({ ASR_PROVIDER: "sensevoice" }).provider, "funasr");
  });
});

describe("updateSettings", () => {
  it("写回文件并同步到 env，保留文件里界面不管的键", () => {
    fs.writeFileSync(envFile(), "# 备注\nOTHER_KEY=keep\nASR_PROVIDER=funasr\n");
    const data = settings.updateSettings({ ASR_PROVIDER: "xfyun", XFYUN_APP_ID: "app" }, env);
    assert.equal(env.ASR_PROVIDER, "xfyun");
    assert.equal(env.XFYUN_APP_ID, "app");
    assert.equal(data.provider, "xfyun");
    const text = fs.readFileSync(envFile(), "utf8");
    assert.match(text, /^# 备注\nOTHER_KEY=keep\nASR_PROVIDER=xfyun\n/);
    assert.match(text, /XFYUN_APP_ID=app\n$/);
  });

  it("密钥留空或提交打码串时不覆盖原值，传 null 才清掉", () => {
    fs.writeFileSync(envFile(), "XFYUN_API_KEY=origin\n");
    env.XFYUN_API_KEY = "origin";
    settings.updateSettings({ XFYUN_API_KEY: "" }, env);
    settings.updateSettings({ XFYUN_API_KEY: "********igin" }, env);
    assert.equal(env.XFYUN_API_KEY, "origin");
    assert.equal(fs.readFileSync(envFile(), "utf8"), "XFYUN_API_KEY=origin\n");

    settings.updateSettings({ XFYUN_API_KEY: null }, env);
    assert.equal(env.XFYUN_API_KEY, undefined);
    assert.equal(fs.readFileSync(envFile(), "utf8"), "\n");
  });

  it("普通字段清空即删除该键，回到默认值", () => {
    fs.writeFileSync(envFile(), "SPEAKER_PROFILE=single\n");
    env.SPEAKER_PROFILE = "single";
    settings.updateSettings({ SPEAKER_PROFILE: "" }, env);
    assert.equal("SPEAKER_PROFILE" in env, false);
  });

  it("拒绝白名单之外的键，文件不变", () => {
    fs.writeFileSync(envFile(), "ASR_PROVIDER=xfyun\n");
    assert.throws(
      () => settings.updateSettings({ ASR_PROVIDER: "aliyun", NODE_OPTIONS: "--inspect" }, env),
      (err) => err.status === 400 && /NODE_OPTIONS/.test(err.message)
    );
    assert.equal(fs.readFileSync(envFile(), "utf8"), "ASR_PROVIDER=xfyun\n");
    assert.equal(env.NODE_OPTIONS, undefined);
  });

  it("校验取值：下拉、数字范围、地址格式、换行", () => {
    const bad = [
      [{ ASR_PROVIDER: "baidu" }, /取值不正确/],
      [{ XFYUN_VP_MATCH_THRESHOLD: "1.5" }, /不能大于 1/],
      [{ XFYUN_VP_MATCH_THRESHOLD: "abc" }, /必须是数字/],
      [{ FUNASR_WS_URL: "http://127.0.0.1:10095" }, /ws:\/\//],
      [{ XFYUN_APP_ID: "a\nB_KEY=1" }, /不能包含换行/],
      [{ FUNASR_ITN: "yes" }, /取值不正确/],
    ];
    for (const [patch, pattern] of bad) {
      assert.throws(() => settings.updateSettings(patch, env), pattern, JSON.stringify(patch));
    }
    assert.equal(fs.existsSync(envFile()), false);
  });

  it("开关接受布尔值并写成 1 / 0", () => {
    settings.updateSettings({ BACH_TLS_REJECT_UNAUTHORIZED: false, FUNASR_ITN: true }, env);
    assert.equal(env.BACH_TLS_REJECT_UNAUTHORIZED, "0");
    assert.equal(env.FUNASR_ITN, "1");
  });
});
