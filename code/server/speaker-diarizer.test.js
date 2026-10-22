/**
 * 说话人分离与 PCM 切片相关行为的约定测试（node:test）。
 * 依赖未来将实现的 slicePcmByTime 与 createRealtimeSpeakerDiarizer。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// 与 audio-utils 中 PCM 约定一致：16 kHz、单声道、16 位小端
const SAMPLE_RATE = 16000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

const { slicePcmByTime } = require("./audio-utils");
const { createRealtimeSpeakerDiarizer } = require("./speaker-diarizer");

/**
 * 生成指定毫秒长度的 PCM 缓冲区（可区分内容，便于断言切片边界）。
 * @param {number} ms 时长（毫秒）
 * @param {number} fillByte 填充字节（0-255）
 */
function pcmBufferFilledMs(ms, fillByte) {
  const n = Math.max(0, Math.round(ms * BYTES_PER_MS));
  return Buffer.alloc(n, fillByte & 0xff);
}

/**
 * 生成低能量噪声 PCM（用于模拟环境噪声/呼吸声）。
 * @param {number} ms 时长（毫秒）
 * @param {number} amplitude 振幅（0~1，建议极小）
 */
function pcmNoiseMs(ms, amplitude = 0.02) {
  const sampleCount = Math.max(0, Math.round((ms * SAMPLE_RATE) / 1000));
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    const v = (Math.random() * 2 - 1) * amplitude;
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

/**
 * 将若干段 PCM 按时间窗口 [startMs, endMs) 的预期字节切片（用于对照 slicePcmByTime 结果）。
 * @param {Buffer[]} buffers
 * @param {number} startMs
 * @param {number} endMs
 */
function expectedSliceBytes(buffers, startMs, endMs) {
  const full = Buffer.concat(buffers);
  const startByte = Math.floor(startMs * BYTES_PER_MS);
  const endByte = Math.floor(endMs * BYTES_PER_MS);
  return full.subarray(startByte, endByte);
}

describe("slicePcmByTime（audio-utils）", () => {
  it("按毫秒范围对拼接后的 PCM 做切片，且与 16k/mono/16bit 字节对齐", () => {
    // 三段可区分内容：0-100ms 为 0x11，100-250ms 为 0x22，250-400ms 为 0x33
    const a = pcmBufferFilledMs(100, 0x11);
    const b = pcmBufferFilledMs(150, 0x22);
    const c = pcmBufferFilledMs(150, 0x33);
    const startMs = 80;
    const endMs = 280;
    const out = slicePcmByTime([a, b, c], startMs, endMs);
    const want = expectedSliceBytes([a, b, c], startMs, endMs);
    assert.ok(Buffer.isBuffer(out));
    assert.equal(out.length, want.length);
    assert.ok(out.equals(want), "切片字节应与按毫秒换算的起止样本一致");
  });

  it("起止为整段边界时返回完整拼接长度", () => {
    const p1 = pcmBufferFilledMs(50, 0xaa);
    const p2 = pcmBufferFilledMs(50, 0xbb);
    const totalMs = 100;
    const out = slicePcmByTime([p1, p2], 0, totalMs);
    assert.equal(out.length, Buffer.concat([p1, p2]).length);
  });
});

describe("createRealtimeSpeakerDiarizer().resolveSpeaker()", () => {
  it("对相似声音复用同一 speakerLabel", () => {
    const diarizer = createRealtimeSpeakerDiarizer({ sampleRate: SAMPLE_RATE });
    // 较长片段，便于稳定提取特征（由实现决定阈值）
    const segA = pcmBufferFilledMs(600, 0x4a);
    const segSimilar = Buffer.from(segA); // 完全相同拷贝，作为“同一人相似声纹”的最小可测情形
    const r1 = diarizer.resolveSpeaker({ pcm: segA, durationMs: 600 });
    const r2 = diarizer.resolveSpeaker({ pcm: segSimilar, durationMs: 600 });
    assert.ok(typeof r1.speakerLabel === "string" && r1.speakerLabel.length > 0);
    assert.equal(r2.speakerLabel, r1.speakerLabel, "相似片段应复用同一说话人标签");
  });

  it("短句无法稳定提取特征时回退到最近说话人，且 speakerStatus 为 estimated", () => {
    const diarizer = createRealtimeSpeakerDiarizer({ sampleRate: SAMPLE_RATE });
    const longPcm = pcmBufferFilledMs(800, 0x55);
    const first = diarizer.resolveSpeaker({ pcm: longPcm, durationMs: 800 });
    assert.ok(first.speakerStatus === "confirmed" || first.speakerStatus === "estimated");

    // 极短片段：约定实现应判定特征不稳定并回退
    const shortPcm = pcmBufferFilledMs(5, 0x66);
    const fallback = diarizer.resolveSpeaker({
      pcm: shortPcm,
      durationMs: 5,
      featureUnstable: true,
    });
    assert.equal(fallback.speakerStatus, "estimated");
    assert.equal(
      fallback.speakerLabel,
      first.speakerLabel,
      "不稳定时应回退为最近确定的说话人"
    );
  });

  it("低能量噪声片段不会被误判为新说话人", () => {
    const diarizer = createRealtimeSpeakerDiarizer({ sampleRate: SAMPLE_RATE });
    const first = diarizer.resolveSpeaker({
      pcm: pcmBufferFilledMs(700, 0x5a),
      durationMs: 700,
    });
    const noise = diarizer.resolveSpeaker({
      pcm: pcmNoiseMs(500, 0.01),
      durationMs: 500,
    });
    assert.equal(
      noise.speakerLabel,
      first.speakerLabel,
      "低能量噪声应复用最近说话人标签，而不是新建说话人"
    );
    assert.equal(noise.speakerStatus, "estimated");
  });
});
