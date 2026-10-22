/**
 * 声纹 API 快速诊断脚本。
 * 用法：node code/server/test-voiceprint-api.js
 * 逐步测试：鉴权 → 创建特征库 → 查询特征列表 → 1:N 搜索
 */

const path = require("path");
// 诊断脚本从 code/server 执行，开发态配置文件固定读取仓库根目录。
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const {
  getVoiceprintConfig,
  validateVoiceprintConfig,
  ensureDefaultGroup,
  queryFeatureList,
  searchFea,
} = require("./xfyun-voiceprint");

async function main() {
  console.log("=== 声纹 API 诊断 ===\n");

  // 1. 检查配置
  const config = getVoiceprintConfig();
  console.log("1) 当前配置:");
  console.log("   appId:", config.appId || "(空)");
  console.log("   apiKey:", config.apiKey ? config.apiKey.slice(0, 8) + "..." : "(空)");
  console.log("   apiSecret:", config.apiSecret ? config.apiSecret.slice(0, 8) + "..." : "(空)");
  console.log("   groupId:", config.groupId);

  const missing = validateVoiceprintConfig();
  if (missing) {
    console.error("\n   配置不完整:", missing);
    return;
  }
  console.log("   配置校验: 通过\n");

  // 2. 创建/确认特征库
  console.log("2) 确认声纹特征库...");
  const groupResult = await ensureDefaultGroup();
  console.log("   结果:", JSON.stringify(groupResult, null, 2), "\n");

  // 3. 查询特征列表
  console.log("3) 查询特征列表...");
  const listResult = await queryFeatureList();
  if (listResult.ok) {
    const features = Array.isArray(listResult.data) ? listResult.data : [];
    console.log(`   特征库中有 ${features.length} 个声纹:`);
    features.forEach((f) => {
      console.log(`   - featureId: ${f.featureId}, featureInfo: ${f.featureInfo || "(无)"}`);
    });
  } else {
    console.log("   查询失败:", listResult.message);
    if (listResult.raw) console.log("   raw:", JSON.stringify(listResult.raw));
  }
  console.log();

  // 4. 尝试用一段静音做 1:N 搜索（预期返回分数很低或失败）
  console.log("4) 测试 1:N 搜索接口（用 1 秒静音数据）...");
  // 1 秒 16kHz 16bit mono = 32000 字节
  const silentPcm = Buffer.alloc(32000, 0);
  const searchResult = await searchFea({
    audioBase64: silentPcm.toString("base64"),
    topK: 3,
  });
  if (searchResult.ok) {
    console.log("   搜索成功，返回 scoreList:", JSON.stringify(searchResult.data));
  } else {
    console.log("   搜索失败:", searchResult.message);
    if (searchResult.raw) console.log("   raw:", JSON.stringify(searchResult.raw));
  }

  console.log("\n=== 诊断完成 ===");
}

main().catch((e) => console.error("诊断脚本异常:", e));
