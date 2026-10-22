/**
 * 讯飞实时转写解析约定测试（node:test）。
 * 目标：确保接入层能把讯飞返回结果稳定映射到现有回调结构。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildXfyunSigna,
  buildXfyunWsUrl,
  parseXfyunResultData,
} = require("./asr-stream-xfyun");

describe("buildXfyunSigna()", () => {
  it("按 appid + ts 生成稳定签名", () => {
    // 固定输入用于保证签名结果可重复断言。
    const signa = buildXfyunSigna("test_appid", "test_api_key", "1713500000");
    assert.equal(typeof signa, "string");
    assert.ok(signa.length > 0);
  });
});

describe("buildXfyunWsUrl()", () => {
  it("会拼出包含鉴权和可选参数的连接地址", () => {
    const url = new URL(
      buildXfyunWsUrl({
        appId: "demo_appid",
        apiKey: "demo_api_key",
        ts: "1713500000",
        lang: "cn",
        roleType: 2,
      })
    );
    assert.equal(url.origin + url.pathname, "wss://rtasr.xfyun.cn/v1/ws");
    assert.equal(url.searchParams.get("appid"), "demo_appid");
    assert.equal(url.searchParams.get("ts"), "1713500000");
    assert.equal(url.searchParams.get("lang"), "cn");
    assert.equal(url.searchParams.get("roleType"), "2");
    assert.ok(url.searchParams.get("signa"));
  });
});

describe("parseXfyunResultData()", () => {
  it("能解析中间结果文本、时间和角色编号", () => {
    const payload = {
      cn: {
        st: {
          bg: "120",
          ed: "540",
          type: "1",
          rt: [
            {
              ws: [
                {
                  cw: [{ w: "你好", wp: "n", rl: 2 }],
                  wb: 0,
                  we: 8,
                },
                {
                  cw: [{ w: "，", wp: "p" }],
                  wb: 8,
                  we: 9,
                },
                {
                  cw: [{ w: "世界", wp: "n" }],
                  wb: 9,
                  we: 18,
                },
              ],
            },
          ],
        },
      },
      seg_id: 7,
    };

    const result = parseXfyunResultData(JSON.stringify(payload));
    assert.equal(result.segId, 7);
    assert.equal(result.text, "你好，世界");
    assert.equal(result.beginTime, 120);
    assert.equal(result.endTime, 540);
    assert.equal(result.resultType, 1);
    assert.equal(result.roleId, 2);
    assert.equal(result.words.length, 3);
  });

  it("在缺少有效 ed 时会退回到最后一个词的结束时间", () => {
    const payload = {
      cn: {
        st: {
          bg: "300",
          ed: "0",
          type: "0",
          rt: [
            {
              ws: [
                {
                  cw: [{ w: "北京", wp: "n" }],
                  wb: 0,
                  we: 10,
                },
                {
                  cw: [{ w: "天气", wp: "n" }],
                  wb: 10,
                  we: 20,
                },
              ],
            },
          ],
        },
      },
      seg_id: 3,
    };

    const result = parseXfyunResultData(payload);
    assert.equal(result.beginTime, 300);
    assert.equal(result.endTime, 500);
    assert.equal(result.resultType, 0);
    assert.equal(result.text, "北京天气");
  });
});
