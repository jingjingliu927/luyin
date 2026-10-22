/**
 * 讯飞实时转写大模型接入层测试（node:test）。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildXfyunLlmWsUrl,
  parseXfyunLlmResult,
} = require("./asr-stream-xfyun-llm");

describe("buildXfyunLlmWsUrl()", () => {
  it("会拼出包含 feature_ids 和 role_type 的握手地址", () => {
    const url = new URL(
      buildXfyunLlmWsUrl({
        appId: "app_demo",
        accessKeyId: "key_demo",
        accessKeySecret: "secret_demo",
        uuid: "uuid_demo",
        utc: "2026-04-19T12:34:56+0800",
        lang: "autodialect",
        audioEncode: "pcm_s16le",
        sampleRate: 16000,
        roleType: 2,
        featureIds: ["f1", "f2"],
        engSpkMatch: 1,
      })
    );

    assert.equal(url.origin + url.pathname, "wss://office-api-ast-dx.iflyaisol.com/ast/communicate/v1");
    assert.equal(url.searchParams.get("appId"), "app_demo");
    assert.equal(url.searchParams.get("accessKeyId"), "key_demo");
    assert.equal(url.searchParams.get("role_type"), "2");
    assert.equal(url.searchParams.get("feature_ids"), "f1,f2");
    assert.equal(url.searchParams.get("eng_spk_match"), "1");
    assert.ok(url.searchParams.get("signature"));
  });
});

describe("parseXfyunLlmResult()", () => {
  it("能解析最终结果、词时间和角色编号", () => {
    const payload = {
      msg_type: "result",
      res_type: "asr",
      data: {
        seg_id: 1,
        ls: false,
        cn: {
          st: {
            bg: 930,
            ed: 2590,
            type: "0",
            rt: [
              {
                ws: [
                  {
                    cw: [{ w: "你好", wp: "n", rl: 1 }],
                    wb: 0,
                    we: 20,
                  },
                  {
                    cw: [{ w: "世界", wp: "n" }],
                    wb: 20,
                    we: 40,
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const result = parseXfyunLlmResult(payload);
    assert.equal(result.segId, 1);
    assert.equal(result.text, "你好世界");
    assert.equal(result.beginTime, 930);
    assert.equal(result.endTime, 2590);
    assert.equal(result.resultType, 0);
    assert.equal(result.roleId, 1);
    assert.equal(result.words.length, 2);
  });

  it("支持直接解析 data 结构字符串", () => {
    const payload = JSON.stringify({
      seg_id: 2,
      ls: true,
      cn: {
        st: {
          bg: 100,
          ed: 300,
          type: "1",
          rt: [
            {
              ws: [
                {
                  cw: [{ w: "测试", wp: "n", rl: 0 }],
                  wb: 0,
                  we: 10,
                },
              ],
            },
          ],
        },
      },
    });

    const result = parseXfyunLlmResult(payload);
    assert.equal(result.segId, 2);
    assert.equal(result.text, "测试");
    assert.equal(result.resultType, 1);
    assert.equal(result.isLastFrame, true);
  });

  it("保留非数字角色标识，供声纹 feature_id 映射姓名", () => {
    const payload = {
      data: {
        seg_id: 3,
        cn: {
          st: {
            bg: 0,
            ed: 100,
            type: "0",
            rt: [
              {
                ws: [
                  {
                    cw: [{ w: "你好", wp: "n", rl: "feature_abc" }],
                    wb: 0,
                    we: 10,
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const result = parseXfyunLlmResult(payload);
    assert.equal(result.roleId, "feature_abc");
  });
});
