/**
 * 讯飞大模型声纹接口请求构造测试（node:test）。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildOfficeVoiceprintRequest,
  normalizeVoiceprintAudio,
  validateOfficeVoiceprintConfig,
} = require("./xfyun-llm-voiceprint");

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makePcmWav({ sampleRate = 48000, seconds = 1, channels = 1 } = {}) {
  const frames = sampleRate * seconds;
  const dataSize = frames * channels * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

describe("validateOfficeVoiceprintConfig()", () => {
  it("缺少配置时返回明确错误信息", () => {
    const prev = {
      appId: process.env.XFYUN_APP_ID,
      accessKeyId: process.env.XFYUN_ACCESS_KEY_ID,
      accessKeySecret: process.env.XFYUN_ACCESS_KEY_SECRET,
    };
    delete process.env.XFYUN_APP_ID;
    delete process.env.XFYUN_ACCESS_KEY_ID;
    delete process.env.XFYUN_ACCESS_KEY_SECRET;

    try {
      assert.match(validateOfficeVoiceprintConfig(), /缺少 XFYUN_APP_ID/);
    } finally {
      restoreEnv("XFYUN_APP_ID", prev.appId);
      restoreEnv("XFYUN_ACCESS_KEY_ID", prev.accessKeyId);
      restoreEnv("XFYUN_ACCESS_KEY_SECRET", prev.accessKeySecret);
    }
  });
});

describe("buildOfficeVoiceprintRequest()", () => {
  it("生成带 query 和 signature 请求头的注册地址", () => {
    const prev = {
      appId: process.env.XFYUN_APP_ID,
      accessKeyId: process.env.XFYUN_ACCESS_KEY_ID,
      accessKeySecret: process.env.XFYUN_ACCESS_KEY_SECRET,
    };
    process.env.XFYUN_APP_ID = "app_demo";
    process.env.XFYUN_ACCESS_KEY_ID = "key_demo";
    process.env.XFYUN_ACCESS_KEY_SECRET = "secret_demo";

    try {
      const req = buildOfficeVoiceprintRequest("register", new Date("2026-04-29T10:00:00+08:00"));
      const url = new URL(req.url);
      assert.equal(url.origin + url.pathname, "https://office-api-personal-dx.iflyaisol.com/res/feature/v1/register");
      assert.equal(url.searchParams.get("appId"), "app_demo");
      assert.equal(url.searchParams.get("accessKeyId"), "key_demo");
      assert.ok(url.searchParams.get("dateTime"));
      assert.ok(url.searchParams.get("signatureRandom"));
      assert.ok(req.signature);
    } finally {
      restoreEnv("XFYUN_APP_ID", prev.appId);
      restoreEnv("XFYUN_ACCESS_KEY_ID", prev.accessKeyId);
      restoreEnv("XFYUN_ACCESS_KEY_SECRET", prev.accessKeySecret);
    }
  });
});

describe("normalizeVoiceprintAudio()", () => {
  it("会把 48k WAV 转成 16k raw PCM，降低上传体积", () => {
    const wav = makePcmWav({ sampleRate: 48000, seconds: 1, channels: 1 });
    const out = normalizeVoiceprintAudio(wav);
    const pcm = Buffer.from(out.audioBase64, "base64");
    assert.equal(out.audioType, "raw");
    assert.equal(Math.round(out.durationSeconds), 1);
    assert.equal(pcm.length, 16000 * 2);
  });
});
