/**
 * 会议助手接入配置的行为测试（node:test）。
 * 关注点：配置只来自界面文件（不再回退 .env）、AppSecret 不明文回显、
 * 三项齐全才算配置完成。
 */

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let store;
let configPath;
let userDataDir;

before(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "luyin-ma-config-"));
  process.env.LUYIN_USER_DATA = userDataDir;
  store = require("./store");
  configPath = path.join(store.DATA_DIR, "meeting-assistant-config.json");
});

after(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(configPath, { force: true });
});

describe("readMeetingAssistantConfig()", () => {
  it("文件不存在时返回未配置且关闭的默认值", () => {
    const config = store.readMeetingAssistantConfig();
    assert.deepEqual(
      { ...config, updatedAt: null },
      {
        enabled: false,
        baseUrl: "",
        appCode: "",
        appSecret: "",
        agentMatchFlowPath: "",
        updatedAt: null,
      }
    );
  });

  it("文件损坏时退回默认值而不是抛异常", () => {
    fs.writeFileSync(configPath, "{ 这不是 JSON", "utf-8");
    const config = store.readMeetingAssistantConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.baseUrl, "");
    assert.equal(config.appCode, "");
  });

  it("不读取 .env：设置了 BACH_APP_CODE 也不生效", () => {
    process.env.BACH_APP_CODE = "来自环境变量";
    try {
      assert.equal(store.readMeetingAssistantConfig().appCode, "");
    } finally {
      delete process.env.BACH_APP_CODE;
    }
  });
});

describe("writeMeetingAssistantConfig()", () => {
  it("只保留已知字段，忽略界面多传的键", () => {
    store.writeMeetingAssistantConfig({
      appCode: "code-1",
      appSecret: "secret-1",
      agentMatchFlowPath: "flow-1",
      baseUrl: "https://api.example.com",
      enabled: true,
      来路不明的字段: "应当被丢弃",
    });

    const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepEqual(Object.keys(saved).sort(), [
      "agentMatchFlowPath",
      "appCode",
      "appSecret",
      "baseUrl",
      "enabled",
      "updatedAt",
    ]);
  });

  it("未提供的字段保留原值，可以只翻开关", () => {
    store.writeMeetingAssistantConfig({
      appCode: "code-1",
      appSecret: "secret-1",
      agentMatchFlowPath: "flow-1",
      baseUrl: "https://api.example.com",
      enabled: true,
    });
    store.writeMeetingAssistantConfig({ enabled: false });

    const config = store.readMeetingAssistantConfig();
    assert.equal(config.enabled, false);
    assert.equal(config.appCode, "code-1");
    assert.equal(config.appSecret, "secret-1");
    assert.equal(config.baseUrl, "https://api.example.com");
    assert.equal(config.agentMatchFlowPath, "flow-1");
  });

  it("只改配置不会把开启状态弄丢", () => {
    store.writeMeetingAssistantConfig({
      appCode: "code-1",
      appSecret: "secret-1",
      agentMatchFlowPath: "flow-1",
      enabled: true,
    });
    // 界面上「修改配置」不带 enabled 字段提交，此时必须保持已开启。
    store.writeMeetingAssistantConfig({ appCode: "code-2", agentMatchFlowPath: "flow-2" });

    const config = store.readMeetingAssistantConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.appCode, "code-2");
    assert.equal(config.appSecret, "secret-1");
  });

  it("字段两端空白会被去掉", () => {
    store.writeMeetingAssistantConfig({
      baseUrl: " https://api.example.com/ ",
      appCode: "  code-2  ",
      agentMatchFlowPath: " flow-2 ",
    });
    const config = store.readMeetingAssistantConfig();
    assert.equal(config.baseUrl, "https://api.example.com/");
    assert.equal(config.appCode, "code-2");
    assert.equal(config.agentMatchFlowPath, "flow-2");
  });

  it("enabled 只认布尔真，字符串不会被当成开启", () => {
    store.writeMeetingAssistantConfig({ enabled: "true" });
    assert.equal(store.readMeetingAssistantConfig().enabled, false);
  });
});

describe("maskMeetingAssistantConfig()", () => {
  it("不回显 AppSecret 明文，只给尾 4 位", () => {
    store.writeMeetingAssistantConfig({
      appCode: "code-1",
      appSecret: "abcdef123456",
      agentMatchFlowPath: "flow-1",
      baseUrl: "https://api.example.com",
    });

    const masked = store.maskMeetingAssistantConfig();
    assert.equal(masked.hasAppSecret, true);
    assert.equal(masked.baseUrl, "https://api.example.com");
    assert.equal(masked.appSecretMasked, "********3456");
    assert.equal(masked.appSecret, undefined);
    assert.ok(!JSON.stringify(masked).includes("abcdef123456"));
  });

  it("没填过 AppSecret 时不给出打码串", () => {
    const masked = store.maskMeetingAssistantConfig();
    assert.equal(masked.hasAppSecret, false);
    assert.equal(masked.appSecretMasked, "");
  });
});

describe("会议助手启用判定", () => {
  beforeEach(() => {
    // bach-agent-client 通过 store 读配置，需要清掉模块缓存以拿到新的 store 实例状态。
    delete require.cache[require.resolve("./bach-agent-client")];
  });

  it("三项齐全且开关打开才算已配置", () => {
    const { getConfig, isConfigured } = require("./bach-agent-client");

    store.writeMeetingAssistantConfig({
      appCode: "code-1",
      appSecret: "secret-1",
      agentMatchFlowPath: "flow-1",
      enabled: true,
    });
    assert.equal(isConfigured(getConfig()), true);

    store.writeMeetingAssistantConfig({ enabled: false });
    assert.equal(isConfigured(getConfig()), false);
  });

  it("缺任意一项都算未配置", () => {
    const { getConfig, isConfigured } = require("./bach-agent-client");

    for (const missing of ["appCode", "appSecret", "agentMatchFlowPath"]) {
      store.writeMeetingAssistantConfig({
        appCode: "code-1",
        appSecret: "secret-1",
        agentMatchFlowPath: "flow-1",
        enabled: true,
        [missing]: "",
      });
      assert.equal(isConfigured(getConfig()), false, `缺少 ${missing} 时应判为未配置`);
    }
  });

  it("AgentMatchFlowPath 作为 super_agent_setting_id 透传", () => {
    const { getConfig } = require("./bach-agent-client");
    store.writeMeetingAssistantConfig({ agentMatchFlowPath: "flow-abc" });
    assert.equal(getConfig().agentMatchFlowPath, "flow-abc");
  });

  it("界面 Base URL 优先于环境变量，未填写时继续回退环境变量", () => {
    const { getConfig } = require("./bach-agent-client");
    process.env.BACH_API_BASE_URL = "https://env.example.com";
    try {
      store.writeMeetingAssistantConfig({ baseUrl: "" });
      assert.equal(getConfig().baseUrl, "https://env.example.com");

      store.writeMeetingAssistantConfig({ baseUrl: "https://ui.example.com/" });
      assert.equal(getConfig().baseUrl, "https://ui.example.com");
    } finally {
      delete process.env.BACH_API_BASE_URL;
    }
  });
});
