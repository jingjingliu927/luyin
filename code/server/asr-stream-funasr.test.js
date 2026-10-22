/**
 * FunASR 本地实时识别接入层测试（node:test）。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildFunAsrStartMessage,
  parseFunAsrMessage,
} = require("./asr-stream-funasr");

describe("buildFunAsrStartMessage()", () => {
  it("会生成 FunASR 2pass 启动配置", () => {
    const msg = buildFunAsrStartMessage({
      mode: "2pass",
      chunkSize: "5,10,5",
      chunkInterval: 10,
      wavName: "demo",
      hotwords: "录音助手 10",
      itn: "1",
    });

    assert.equal(msg.mode, "2pass");
    assert.deepEqual(msg.chunk_size, [5, 10, 5]);
    assert.equal(msg.chunk_interval, 10);
    assert.equal(msg.wav_name, "demo");
    assert.equal(msg.is_speaking, true);
    assert.equal(msg.hotwords, "录音助手 10");
    assert.equal(msg.itn, true);
  });
});

describe("parseFunAsrMessage()", () => {
  it("能解析 online 增量结果", () => {
    const parsed = parseFunAsrMessage({
      mode: "2pass-online",
      text: "打开面",
      timestamp: [[0, 320]],
      is_final: false,
    });

    assert.equal(parsed.text, "打开面");
    assert.equal(parsed.isPartial, true);
    assert.equal(parsed.isFinal, false);
    assert.equal(parsed.beginTime, 0);
    assert.equal(parsed.endTime, 320);
  });

  it("能解析 offline 最终结果和句子时间", () => {
    const parsed = parseFunAsrMessage(JSON.stringify({
      mode: "2pass-offline",
      text: "打开面板",
      stamp_sents: [{ start: 100, end: 900 }],
    }));

    assert.equal(parsed.text, "打开面板");
    assert.equal(parsed.isFinal, true);
    assert.equal(parsed.isPartial, false);
    assert.equal(parsed.beginTime, 100);
    assert.equal(parsed.endTime, 900);
  });
});
