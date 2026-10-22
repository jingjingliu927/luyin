/**
 * 讯飞办公系接口（大模型实时转写、声纹注册）公共签名工具。
 * 这类接口统一使用“参数升序 + urlencode + HMAC-SHA1 + Base64”方案。
 */

const crypto = require("crypto");

/**
 * 对参数做 URL 编码，和文档中的 urlencode 规则保持一致。
 * @param {string} value
 * @returns {string}
 */
function encodeParam(value) {
  return encodeURIComponent(String(value));
}

/**
 * 生成带时区的时间字符串，格式如 2026-04-19T12:34:56+0800。
 * @param {Date} [date]
 * @returns {string}
 */
function formatOfficeDateTime(date = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());

  // JS 的 getTimezoneOffset 以“本地到 UTC 的分钟差”表示，因此需取反。
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHour = pad(Math.floor(Math.abs(offsetMinutes) / 60));
  const offsetMinute = pad(Math.abs(offsetMinutes) % 60);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}${offsetMinute}`;
}

/**
 * 过滤空值并按参数名升序拼接成待签名字符串。
 * @param {Record<string, string|number|boolean|null|undefined>} params
 * @returns {string}
 */
function buildSortedQueryString(params = {}) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .sort()
    .map((key) => `${encodeParam(key)}=${encodeParam(params[key])}`)
    .join("&");
}

/**
 * 对办公系参数执行 HMAC-SHA1 签名。
 * @param {Record<string, string|number|boolean|null|undefined>} params
 * @param {string} accessKeySecret
 * @returns {string}
 */
function signOfficeParams(params = {}, accessKeySecret = "") {
  const baseString = buildSortedQueryString(params);
  return crypto
    .createHmac("sha1", String(accessKeySecret))
    .update(baseString, "utf8")
    .digest("base64");
}

/**
 * 生成请求幂等/追踪用随机串。
 * @returns {string}
 */
function randomSignatureSeed() {
  return crypto.randomUUID().replace(/-/g, "");
}

module.exports = {
  buildSortedQueryString,
  formatOfficeDateTime,
  randomSignatureSeed,
  signOfficeParams,
};
