/**
 * 讯飞办公系签名工具测试（node:test）。
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSortedQueryString,
  formatOfficeDateTime,
  signOfficeParams,
} = require("./xfyun-office-auth");

describe("buildSortedQueryString()", () => {
  it("会按 key 升序并跳过空值", () => {
    const out = buildSortedQueryString({
      b: "2",
      a: "1",
      c: "",
      d: null,
      e: "中 文",
    });
    assert.equal(out, "a=1&b=2&e=%E4%B8%AD%20%E6%96%87");
  });
});

describe("formatOfficeDateTime()", () => {
  it("会输出带时区偏移的标准时间串", () => {
    const out = formatOfficeDateTime(new Date("2026-04-19T12:34:56+08:00"));
    assert.match(out, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/);
  });
});

describe("signOfficeParams()", () => {
  it("对同一组参数生成稳定签名", () => {
    const params = {
      accessKeyId: "demo_key",
      appId: "demo_app",
      utc: "2026-04-19T12:34:56+0800",
      uuid: "abc123",
    };
    const sign1 = signOfficeParams(params, "secret_xxx");
    const sign2 = signOfficeParams(params, "secret_xxx");
    assert.equal(sign1, sign2);
    assert.ok(sign1.length > 0);
  });
});
