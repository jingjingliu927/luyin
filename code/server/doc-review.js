const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * 为 Trio 生成的 Markdown 文档提供“旁路评论”和版本快照能力。
 * 评论不写回原始 Markdown，避免文档重新生成时丢失评审记录。
 */
function createDocReviewService(store) {
  const REVIEW_DIR = path.join(store.DATA_DIR, "doc-review");
  const SNAPSHOT_DIR = path.join(REVIEW_DIR, "snapshots");
  const SOURCE_CONFIG_FILE = path.join(store.DATA_DIR, "doc-sources.json");
  const VERSION_FILE = path.join(REVIEW_DIR, "doc-versions.json");
  const SOURCE_REVISION_FILE = path.join(REVIEW_DIR, "doc-source-revisions.json");
  const COMMENT_FILE = path.join(REVIEW_DIR, "doc-comments.json");
  const REVIEW_STATUS_FILE = path.join(REVIEW_DIR, "doc-review-statuses.json");
  const REVIEW_STATUS_OPTIONS = {
    not_started: "未开始",
    in_review: "评审中",
    has_issues: "有问题",
    approved: "已通过",
    waiting_regeneration: "等待重新生成",
    needs_recheck: "重新生成后待复核",
  };

  /**
   * 初始化评审模块所需目录，确保首次访问即可写入快照和评论。
   */
  function ensureReviewDirs() {
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }

  /**
   * 读取 JSON 文件；文件缺失或损坏时使用默认值，避免影响主应用启动。
   * @param {string} filename JSON 文件路径
   * @param {*} fallback 默认返回值
   */
  function readJSONFile(filename, fallback) {
    if (!fs.existsSync(filename)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(filename, "utf-8"));
    } catch {
      return fallback;
    }
  }

  /**
   * 写入 JSON 文件；统一格式化便于后续人工检查和 Git 跟踪。
   * @param {string} filename JSON 文件路径
   * @param {*} data 需要写入的数据
   */
  function writeJSONFile(filename, data) {
    ensureReviewDirs();
    fs.writeFileSync(filename, JSON.stringify(data, null, 2), "utf-8");
  }

  /**
   * 计算内容哈希，用于文档版本识别和评论锚点重挂载。
   * @param {string} value 待计算内容
   */
  function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  /**
   * 将任意路径片段归一化为安全的相对 Markdown 路径。
   * @param {string} docPath 前端传入的文档相对路径
   */
  function normalizeDocPath(docPath) {
    const normalized = path.normalize(String(docPath || "").replace(/\\/g, "/"));
    if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) {
      throw new Error("文档路径不合法");
    }
    if (!normalized.toLowerCase().endsWith(".md")) {
      throw new Error("仅支持读取 Markdown 文档");
    }
    return normalized.split(path.sep).join("/");
  }

  /**
   * 构造默认文档源：仓库根目录下的 docs/。其它目录在「文档源」页面里添加。
   */
  function getDefaultSources() {
    return [
      {
        id: "luyin",
        name: "项目文档",
        root: path.join(store.WORKSPACE_ROOT, "docs"),
      },
    ];
  }

  /**
   * 清理文档源配置，只保留存在且可读取的目录。
   * @param {Array} sources 原始文档源配置
   */
  function normalizeSources(sources) {
    return (Array.isArray(sources) ? sources : [])
      .map((source) => ({
        id: String(source.id || "").trim(),
        name: String(source.name || source.id || "").trim(),
        root: path.resolve(String(source.root || "")),
      }))
      .filter((source) => source.id && source.name && fs.existsSync(source.root));
  }

  /**
   * 读取原始文档源配置；管理页面需要看到不可读路径，不能像阅读侧一样直接过滤。
   */
  function readSourceConfig() {
    ensureReviewDirs();
    if (!fs.existsSync(SOURCE_CONFIG_FILE)) {
      writeJSONFile(SOURCE_CONFIG_FILE, getDefaultSources());
    }
    return readJSONFile(SOURCE_CONFIG_FILE, getDefaultSources());
  }

  /**
   * 写入文档源配置，并保持 ID 顺序稳定，方便用户查看 JSON 变更。
   * @param {Array} sources 文档源配置
   */
  function writeSourceConfig(sources) {
    writeJSONFile(SOURCE_CONFIG_FILE, sources);
  }

  /**
   * 读取文档源配置；首次使用时写入默认配置，方便用户后续扩展其他项目。
   */
  function readSources() {
    return normalizeSources(readSourceConfig());
  }

  /**
   * 校验文档源 ID，避免被当成路径或脚本片段使用。
   * @param {string} sourceId 文档源 ID
   */
  function validateSourceId(sourceId) {
    if (!/^[a-zA-Z0-9_-]{2,40}$/.test(sourceId)) {
      throw new Error("文档源 ID 只能包含英文、数字、下划线和中划线，长度 2 到 40 位");
    }
  }

  /**
   * 返回文档源目录状态和 Markdown 数量。
   * @param {object} source 文档源配置
   */
  function getSourceStatus(source) {
    const root = path.resolve(String(source.root || ""));
    const exists = fs.existsSync(root);
    let readable = false;
    let docCount = 0;
    let message = exists ? "目录可读取" : "目录不存在";
    if (exists) {
      try {
        fs.accessSync(root, fs.constants.R_OK);
        readable = fs.statSync(root).isDirectory();
        docCount = readable ? listMarkdownFiles(root).length : 0;
        message = readable ? "目录可读取" : "路径不是目录";
      } catch (error) {
        message = error.message || "目录不可读取";
      }
    }
    return { exists, readable, docCount, message };
  }

  /**
   * 标准化并校验用户提交的文档源配置。
   * @param {object} payload 用户提交内容
   * @param {object} options 校验选项
   */
  function normalizeSourcePayload(payload, options = {}) {
    const source = {
      id: String(options.fixedId || payload.id || "").trim(),
      name: String(payload.name || "").trim(),
      root: path.resolve(String(payload.root || "")),
    };
    validateSourceId(source.id);
    if (!source.name) throw new Error("请输入文档源名称");
    const status = getSourceStatus(source);
    if (!status.readable) throw new Error(`文档源目录不可用：${status.message}`);
    return source;
  }

  /**
   * 读取文档源管理列表，包含可读状态和文档数量。
   */
  function listManagedSources() {
    return readSourceConfig().map((source) => {
      const normalized = {
        id: String(source.id || "").trim(),
        name: String(source.name || source.id || "").trim(),
        root: path.resolve(String(source.root || "")),
      };
      return {
        ...normalized,
        status: getSourceStatus(normalized),
      };
    });
  }

  /**
   * 新增文档源配置。
   * @param {object} payload 用户提交内容
   */
  function createSource(payload) {
    const sources = readSourceConfig();
    const source = normalizeSourcePayload(payload);
    if (sources.some((item) => item.id === source.id)) {
      throw new Error("文档源 ID 已存在");
    }
    sources.push(source);
    writeSourceConfig(sources);
    return { ...source, status: getSourceStatus(source) };
  }

  /**
   * 更新文档源名称或目录；ID 作为评论关联键，不允许编辑。
   * @param {string} sourceId 文档源 ID
   * @param {object} payload 用户提交内容
   */
  function updateSource(sourceId, payload) {
    validateSourceId(String(sourceId || ""));
    const sources = readSourceConfig();
    const index = sources.findIndex((source) => source.id === sourceId);
    if (index === -1) throw new Error("未找到文档源");
    const nextSource = normalizeSourcePayload(payload, { fixedId: sourceId });
    sources[index] = nextSource;
    writeSourceConfig(sources);
    return { ...nextSource, status: getSourceStatus(nextSource) };
  }

  /**
   * 删除文档源配置；旁路评论和快照会保留，重新添加同 ID 后可继续追溯。
   * @param {string} sourceId 文档源 ID
   */
  function deleteSource(sourceId) {
    validateSourceId(String(sourceId || ""));
    const sources = readSourceConfig();
    const index = sources.findIndex((source) => source.id === sourceId);
    if (index === -1) throw new Error("未找到文档源");
    const [removed] = sources.splice(index, 1);
    writeSourceConfig(sources);
    return removed;
  }

  /**
   * 根据 sourceId 找到具体文档源。
   * @param {string} sourceId 文档源 ID
   */
  function getSource(sourceId) {
    const source = readSources().find((item) => item.id === sourceId);
    if (!source) throw new Error("未找到文档源");
    return source;
  }

  /**
   * 将相对路径解析到文档源下，并防止路径逃逸。
   * @param {object} source 文档源
   * @param {string} docPath 文档相对路径
   */
  function resolveDocFile(source, docPath) {
    const relativePath = normalizeDocPath(docPath);
    const filePath = path.resolve(source.root, relativePath);
    const rootWithSep = source.root.endsWith(path.sep) ? source.root : source.root + path.sep;
    if (!filePath.startsWith(rootWithSep)) {
      throw new Error("文档路径越界");
    }
    if (!fs.existsSync(filePath)) {
      throw new Error("文档不存在");
    }
    return { relativePath, filePath };
  }

  /**
   * 递归扫描目录下的 Markdown 文件。
   * @param {string} root 扫描根目录
   * @param {string} current 当前目录
   */
  function listMarkdownFiles(root, current = root) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        files.push(...listMarkdownFiles(root, fullPath));
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      files.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
    return files.sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  /**
   * 从 Markdown 内容中推断展示标题。
   * @param {string} content Markdown 内容
   * @param {string} docPath 文档相对路径
   */
  function getMarkdownTitle(content, docPath) {
    const heading = content.split(/\r?\n/).find((line) => /^#\s+/.test(line));
    if (heading) return heading.replace(/^#\s+/, "").trim();
    return path.basename(docPath, ".md");
  }

  /**
   * 读取版本清单。
   */
  function readVersions() {
    return readJSONFile(VERSION_FILE, []);
  }

  /**
   * 写入版本清单。
   * @param {Array} versions 版本清单
   */
  function writeVersions(versions) {
    writeJSONFile(VERSION_FILE, versions);
  }

  /**
   * 读取文档源级别的目录快照清单。
   */
  function readSourceRevisions() {
    return readJSONFile(SOURCE_REVISION_FILE, []);
  }

  /**
   * 写入文档源级别的目录快照清单。
   * @param {Array} revisions 目录快照清单
   */
  function writeSourceRevisions(revisions) {
    writeJSONFile(SOURCE_REVISION_FILE, revisions);
  }

  /**
   * 确保当前文档内容拥有一条不可变快照记录。
   * @param {object} source 文档源
   * @param {string} docPath 文档相对路径
   * @param {string} content Markdown 内容
   */
  function ensureVersion(source, docPath, content) {
    const now = new Date().toISOString();
    const contentHash = sha256(content);
    const versions = readVersions();
    const existing = versions.find(
      (item) =>
        item.sourceId === source.id &&
        item.path === docPath &&
        item.contentHash === contentHash
    );
    if (existing) {
      existing.lastSeenAt = now;
      writeVersions(versions);
      return existing;
    }

    const sameDocVersions = versions.filter(
      (item) => item.sourceId === source.id && item.path === docPath
    );
    const version = {
      id: sha256(`${source.id}\n${docPath}\n${contentHash}`),
      sourceId: source.id,
      sourceName: source.name,
      path: docPath,
      title: getMarkdownTitle(content, docPath),
      contentHash,
      versionNumber: sameDocVersions.length + 1,
      size: Buffer.byteLength(content, "utf-8"),
      snapshotFile: `${sha256(`${source.id}/${docPath}`).slice(0, 16)}-${contentHash}.md`,
      createdAt: now,
      lastSeenAt: now,
    };
    fs.writeFileSync(path.join(SNAPSHOT_DIR, version.snapshotFile), content, "utf-8");
    versions.push(version);
    writeVersions(versions);
    return version;
  }

  /**
   * 确保整个 docs 目录拥有一条 revision 记录，用于追溯一次 Trio 重新生成后的整体变化。
   * @param {object} source 文档源
   * @param {Array} docs 带 contentHash 和 versionId 的文档列表
   */
  function ensureSourceRevision(source, docs) {
    const now = new Date().toISOString();
    const sortedDocs = [...docs].sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
    const manifest = sortedDocs
      .map((doc) => `${doc.path}:${doc.contentHash}`)
      .join("\n");
    const revisionHash = sha256(manifest);
    const revisions = readSourceRevisions();
    const existing = revisions.find(
      (revision) => revision.sourceId === source.id && revision.revisionHash === revisionHash
    );
    if (existing) {
      existing.lastSeenAt = now;
      writeSourceRevisions(revisions);
      return existing;
    }

    const previous = revisions
      .filter((revision) => revision.sourceId === source.id)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    const previousDocs = new Map((previous?.documents || []).map((doc) => [doc.path, doc.contentHash]));
    const currentDocs = new Map(sortedDocs.map((doc) => [doc.path, doc.contentHash]));
    const added = sortedDocs.filter((doc) => !previousDocs.has(doc.path)).map((doc) => doc.path);
    const modified = sortedDocs
      .filter((doc) => previousDocs.has(doc.path) && previousDocs.get(doc.path) !== doc.contentHash)
      .map((doc) => doc.path);
    const removed = [...previousDocs.keys()].filter((docPath) => !currentDocs.has(docPath));

    const revision = {
      id: sha256(`${source.id}\n${revisionHash}`),
      sourceId: source.id,
      sourceName: source.name,
      revisionHash,
      revisionNumber: revisions.filter((item) => item.sourceId === source.id).length + 1,
      docCount: sortedDocs.length,
      changed: { added, modified, removed },
      documents: sortedDocs.map((doc) => ({
        path: doc.path,
        title: doc.title,
        contentHash: doc.contentHash,
        versionId: doc.versionId,
      })),
      createdAt: now,
      lastSeenAt: now,
    };
    revisions.push(revision);
    writeSourceRevisions(revisions);
    return revision;
  }

  /**
   * 列出某个文档的所有版本，最近出现的版本排在前面。
   * @param {string} sourceId 文档源 ID
   * @param {string} docPath 文档相对路径
   */
  function listVersions(sourceId, docPath) {
    return readVersions()
      .filter((item) => item.sourceId === sourceId && item.path === docPath)
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  }

  /**
   * 从快照中读取历史版本内容。
   * @param {string} versionId 版本 ID
   */
  function readSnapshot(versionId) {
    const version = readVersions().find((item) => item.id === versionId);
    if (!version) throw new Error("未找到文档版本");
    const snapshotPath = path.join(SNAPSHOT_DIR, version.snapshotFile);
    if (!fs.existsSync(snapshotPath)) throw new Error("文档版本快照不存在");
    return {
      version,
      content: fs.readFileSync(snapshotPath, "utf-8"),
    };
  }

  /**
   * 按 Markdown 结构生成可评论锚点，帮助评论在新版本中重新定位。
   * @param {string} content Markdown 内容
   */
  function extractAnchors(content) {
    const lines = content.split(/\r?\n/);
    const anchors = [];
    const headingStack = [];
    let index = 0;

    /**
     * 追加一个可评论块，并保存标题路径、原文和块哈希。
     * @param {string} type 块类型
     * @param {Array<string>} rawLines 块原始行
     */
    function pushAnchor(type, rawLines) {
      const raw = rawLines.join("\n").trim();
      const text = raw
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/[`*_>#|-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return;
      anchors.push({
        id: `block-${index++}`,
        type,
        raw,
        text,
        headingPath: [...headingStack],
        blockHash: sha256(raw),
      });
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        headingStack.length = Math.max(0, level - 1);
        headingStack[level - 1] = heading[2].trim();
        pushAnchor("heading", [line]);
        continue;
      }

      if (line.startsWith("```")) {
        const block = [line];
        while (i + 1 < lines.length) {
          i += 1;
          block.push(lines[i]);
          if (lines[i].startsWith("```")) break;
        }
        pushAnchor("code", block);
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line)) {
        const block = [line];
        while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) {
          i += 1;
          block.push(lines[i]);
        }
        pushAnchor("table", block);
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const block = [line];
        while (
          i + 1 < lines.length &&
          (/^\s*[-*+]\s+/.test(lines[i + 1]) || /^\s*\d+\.\s+/.test(lines[i + 1]))
        ) {
          i += 1;
          block.push(lines[i]);
        }
        pushAnchor("list", block);
        continue;
      }

      const block = [line];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim() &&
        !/^(#{1,6})\s+/.test(lines[i + 1]) &&
        !lines[i + 1].startsWith("```") &&
        !/^\s*\|.*\|\s*$/.test(lines[i + 1]) &&
        !/^\s*[-*+]\s+/.test(lines[i + 1]) &&
        !/^\s*\d+\.\s+/.test(lines[i + 1])
      ) {
        i += 1;
        block.push(lines[i]);
      }
      pushAnchor("paragraph", block);
    }

    return anchors;
  }

  /**
   * 将标题路径转成稳定签名，辅助版本对比时识别同一章节下的改写块。
   * @param {Array<string>} headingPath 标题路径
   */
  function headingSignature(headingPath) {
    return (Array.isArray(headingPath) ? headingPath : []).join(" > ");
  }

  /**
   * 对比两个版本的 Markdown 块，返回新增、删除、修改和未变化块。
   * @param {Array} baseAnchors 基准版本锚点
   * @param {Array} currentAnchors 当前版本锚点
   */
  function diffAnchors(baseAnchors, currentAnchors) {
    const baseByHash = new Map(baseAnchors.map((anchor) => [anchor.blockHash, anchor]));
    const currentByHash = new Map(currentAnchors.map((anchor) => [anchor.blockHash, anchor]));
    const unchanged = currentAnchors
      .filter((anchor) => baseByHash.has(anchor.blockHash))
      .map((anchor) => ({ type: "unchanged", current: anchor }));
    const removedCandidates = baseAnchors.filter((anchor) => !currentByHash.has(anchor.blockHash));
    const addedCandidates = currentAnchors.filter((anchor) => !baseByHash.has(anchor.blockHash));
    const usedAdded = new Set();
    const modified = [];

    for (const removed of removedCandidates) {
      const matchIndex = addedCandidates.findIndex((added, index) => {
        if (usedAdded.has(index)) return false;
        return (
          added.type === removed.type &&
          headingSignature(added.headingPath) === headingSignature(removed.headingPath)
        );
      });
      if (matchIndex === -1) continue;
      usedAdded.add(matchIndex);
      modified.push({
        type: "modified",
        before: removed,
        after: addedCandidates[matchIndex],
      });
    }

    const modifiedRemoved = new Set(modified.map((item) => item.before.blockHash));
    const added = addedCandidates
      .filter((_anchor, index) => !usedAdded.has(index))
      .map((anchor) => ({ type: "added", current: anchor }));
    const removed = removedCandidates
      .filter((anchor) => !modifiedRemoved.has(anchor.blockHash))
      .map((anchor) => ({ type: "removed", before: anchor }));

    return {
      summary: {
        added: added.length,
        removed: removed.length,
        modified: modified.length,
        unchanged: unchanged.length,
      },
      items: [...modified, ...added, ...removed, ...unchanged],
    };
  }

  /**
   * 计算评论在指定版本锚点中的定位状态。
   * @param {object} comment 评论对象
   * @param {Array} anchors 当前展示版本锚点
   * @param {string} currentVersionId 当前展示版本 ID
   */
  function locateComment(comment, anchors, currentVersionId) {
    const target = comment.target || {};
    const exact = anchors.find((anchor) => anchor.blockHash === target.blockHash);
    if (exact) {
      return { type: "current", blockHash: exact.blockHash, label: "当前定位" };
    }

    const quote = String(target.selectedText || target.quote || "").trim();
    if (quote) {
      const remapped = anchors.find((anchor) => anchor.text.includes(quote));
      if (remapped) {
        return { type: "remapped", blockHash: remapped.blockHash, label: "已重挂载" };
      }
    }

    const isSameVersion = comment.versionId === currentVersionId;
    return {
      type: isSameVersion ? "lost" : "history",
      blockHash: target.blockHash || "",
      label: isSameVersion ? "位置失效" : "历史版本",
    };
  }

  /**
   * 读取评论清单。
   */
  function readComments() {
    return readJSONFile(COMMENT_FILE, []);
  }

  /**
   * 写入评论清单。
   * @param {Array} comments 评论清单
   */
  function writeComments(comments) {
    writeJSONFile(COMMENT_FILE, comments);
  }

  /**
   * 读取文档评审状态清单。
   */
  function readReviewStatuses() {
    return readJSONFile(REVIEW_STATUS_FILE, []);
  }

  /**
   * 写入文档评审状态清单。
   * @param {Array} statuses 评审状态清单
   */
  function writeReviewStatuses(statuses) {
    writeJSONFile(REVIEW_STATUS_FILE, statuses);
  }

  /**
   * 生成文档评审状态的复合键。
   * @param {string} sourceId 文档源 ID
   * @param {string} docPath 文档相对路径
   */
  function reviewStatusKey(sourceId, docPath) {
    return `${sourceId}::${docPath}`;
  }

  /**
   * 获取文档当前评审状态；未设置时返回“未开始”。
   * @param {string} sourceId 文档源 ID
   * @param {string} docPath 文档相对路径
   */
  function getReviewStatus(sourceId, docPath) {
    const relativePath = normalizeDocPath(docPath);
    const status = readReviewStatuses().find(
      (item) => item.key === reviewStatusKey(sourceId, relativePath)
    );
    return (
      status
        ? {
            ...status,
            statusLabel: REVIEW_STATUS_OPTIONS[status.status] || REVIEW_STATUS_OPTIONS.not_started,
          }
        : {
        key: reviewStatusKey(sourceId, relativePath),
        sourceId,
        path: relativePath,
        status: "not_started",
        statusLabel: REVIEW_STATUS_OPTIONS.not_started,
        note: "",
        versionId: "",
        contentHash: "",
        updatedAt: null,
      }
    );
  }

  /**
   * 更新某篇文档的评审状态。
   * @param {object} payload 状态更新内容
   */
  function updateReviewStatus(payload) {
    const source = getSource(payload.sourceId);
    const docPath = normalizeDocPath(payload.path);
    const nextStatus = String(payload.status || "");
    if (!REVIEW_STATUS_OPTIONS[nextStatus]) throw new Error("不支持的评审状态");

    const now = new Date().toISOString();
    const statuses = readReviewStatuses();
    const key = reviewStatusKey(source.id, docPath);
    const index = statuses.findIndex((item) => item.key === key);
    const record = {
      key,
      sourceId: source.id,
      sourceName: source.name,
      path: docPath,
      status: nextStatus,
      statusLabel: REVIEW_STATUS_OPTIONS[nextStatus],
      note: String(payload.note || "").trim(),
      versionId: String(payload.versionId || ""),
      contentHash: String(payload.contentHash || ""),
      updatedAt: now,
    };
    if (index === -1) statuses.unshift(record);
    else statuses[index] = { ...statuses[index], ...record };
    writeReviewStatuses(statuses);
    return record;
  }

  /**
   * 根据文档评论和版本判断是否需要复核。
   * @param {object} docInfo 文档信息
   * @param {Array} docComments 文档评论
   * @param {object} reviewStatus 当前评审状态
   */
  function getReviewAttention(docInfo, docComments, reviewStatus) {
    const openComments = docComments.filter((comment) => comment.status !== "resolved").length;
    const hasNewerVersion =
      reviewStatus.contentHash && reviewStatus.contentHash !== docInfo.contentHash;
    if (openComments > 0) return "有未解决评论";
    if (hasNewerVersion) return "文档已更新，建议复核";
    if (reviewStatus.status === "not_started") return "尚未开始评审";
    return "";
  }

  /**
   * 列出所有文档的评审闭环状态，作为看板数据源。
   * @param {object} filters 筛选条件
   */
  function listReviewWorkflow(filters = {}) {
    const statusFilter = String(filters.status || "all");
    const sourceFilter = String(filters.sourceId || "all");
    const keyword = String(filters.q || "").trim().toLowerCase();
    const comments = readComments();
    const statuses = readReviewStatuses();
    const statusByKey = new Map(statuses.map((item) => [item.key, item]));
    const docs = [];

    for (const source of readSources()) {
      if (sourceFilter !== "all" && source.id !== sourceFilter) continue;
      for (const docPath of listMarkdownFiles(source.root)) {
        const content = fs.readFileSync(path.join(source.root, docPath), "utf-8");
        const version = ensureVersion(source, docPath, content);
        const key = reviewStatusKey(source.id, docPath);
        const storedStatus = statusByKey.get(key) || {};
        const reviewStatus = {
          key,
          sourceId: source.id,
          sourceName: source.name,
          path: docPath,
          status: storedStatus.status || "not_started",
          statusLabel: REVIEW_STATUS_OPTIONS[storedStatus.status] || REVIEW_STATUS_OPTIONS.not_started,
          note: storedStatus.note || "",
          updatedAt: storedStatus.updatedAt || null,
          contentHash: storedStatus.contentHash || "",
        };
        const docComments = comments.filter(
          (comment) => comment.sourceId === source.id && comment.path === docPath
        );
        const title = getMarkdownTitle(content, docPath);
        docs.push({
          sourceId: source.id,
          sourceName: source.name,
          path: docPath,
          title,
          moduleName: docPath.split("/")[1] || docPath.split("/")[0] || "未分组",
          versionId: version.id,
          contentHash: version.contentHash,
          reviewStatus,
          openComments: docComments.filter((comment) => comment.status !== "resolved").length,
          totalComments: docComments.length,
          attention: getReviewAttention(
            { contentHash: version.contentHash },
            docComments,
            reviewStatus
          ),
          updatedAt: reviewStatus.updatedAt || version.lastSeenAt,
        });
      }
    }

    const filtered = docs.filter((doc) => {
      const haystack = [doc.title, doc.path, doc.sourceName, doc.moduleName].join(" ").toLowerCase();
      if (statusFilter !== "all" && doc.reviewStatus.status !== statusFilter) return false;
      if (keyword && !haystack.includes(keyword)) return false;
      return true;
    });
    const summary = docs.reduce(
      (acc, doc) => {
        acc.total += 1;
        acc.status[doc.reviewStatus.status] = (acc.status[doc.reviewStatus.status] || 0) + 1;
        acc.openComments += doc.openComments;
        acc.sources[doc.sourceId] = doc.sourceName;
        if (doc.attention) acc.attention += 1;
        return acc;
      },
      { total: 0, status: {}, openComments: 0, attention: 0, sources: {} }
    );
    return {
      docs: filtered.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)),
      summary,
      statusOptions: REVIEW_STATUS_OPTIONS,
      filters: { sourceId: sourceFilter, status: statusFilter, q: filters.q || "" },
    };
  }

  /**
   * 构建文档树，并带上评论数量，方便目录中提示待处理评审。
   */
  function getTree() {
    const comments = readComments();
    const sources = readSources().map((source) => {
      const docs = listMarkdownFiles(source.root).map((docPath) => {
        const filePath = path.join(source.root, docPath);
        const content = fs.readFileSync(filePath, "utf-8");
        const version = ensureVersion(source, docPath, content);
        const docComments = comments.filter(
          (comment) => comment.sourceId === source.id && comment.path === docPath
        );
        return {
          path: docPath,
          title: getMarkdownTitle(content, docPath),
          contentHash: version.contentHash,
          versionId: version.id,
          versionNumber: version.versionNumber,
          openComments: docComments.filter((comment) => comment.status !== "resolved").length,
          totalComments: docComments.length,
        };
      });
      const revision = ensureSourceRevision(source, docs);
      const revisions = readSourceRevisions()
        .filter((item) => item.sourceId === source.id)
        .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
      return { ...source, docs, revision, revisions };
    });
    return { sources };
  }

  /**
   * 读取当前文档或历史快照，并返回版本和锚点信息。
   * @param {string} sourceId 文档源 ID
   * @param {string} docPath 文档相对路径
   * @param {string} versionId 可选历史版本 ID
   */
  function readDocument(sourceId, docPath, versionId = "") {
    if (versionId) {
      const snapshot = readSnapshot(versionId);
      return {
        source: getSource(snapshot.version.sourceId),
        path: snapshot.version.path,
        title: snapshot.version.title,
        content: snapshot.content,
        version: snapshot.version,
        reviewStatus: getReviewStatus(snapshot.version.sourceId, snapshot.version.path),
        versions: listVersions(snapshot.version.sourceId, snapshot.version.path),
        anchors: extractAnchors(snapshot.content),
      };
    }

    const source = getSource(sourceId);
    const resolved = resolveDocFile(source, docPath);
    const content = fs.readFileSync(resolved.filePath, "utf-8");
    const version = ensureVersion(source, resolved.relativePath, content);
    return {
      source,
      path: resolved.relativePath,
      title: getMarkdownTitle(content, resolved.relativePath),
      content,
      version,
      reviewStatus: getReviewStatus(source.id, resolved.relativePath),
      versions: listVersions(source.id, resolved.relativePath),
      anchors: extractAnchors(content),
    };
  }

  /**
   * 读取某个文档的评论；默认包含历史版本评论，方便追溯。
   * @param {string} sourceId 文档源 ID
   * @param {string} docPath 文档相对路径
   */
  function listComments(sourceId, docPath) {
    const relativePath = normalizeDocPath(docPath);
    return readComments()
      .filter((comment) => comment.sourceId === sourceId && comment.path === relativePath)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }

  /**
   * 读取评论所在文档的当前锚点；文档被删除时退回到最近快照。
   * @param {object} comment 评论对象
   */
  function readCommentDocumentContext(comment) {
    try {
      const doc = readDocument(comment.sourceId, comment.path);
      return {
        sourceName: doc.source.name,
        title: doc.title,
        versionId: doc.version.id,
        contentHash: doc.version.contentHash,
        anchors: doc.anchors,
        exists: true,
      };
    } catch {
      const latestVersion = listVersions(comment.sourceId, comment.path)[0];
      if (!latestVersion) {
        return {
          sourceName: comment.sourceName || comment.sourceId,
          title: path.basename(comment.path || "", ".md"),
          versionId: comment.versionId || "",
          contentHash: comment.contentHash || "",
          anchors: [],
          exists: false,
        };
      }
      const snapshot = readSnapshot(latestVersion.id);
      return {
        sourceName: latestVersion.sourceName || comment.sourceName || comment.sourceId,
        title: latestVersion.title,
        versionId: latestVersion.id,
        contentHash: latestVersion.contentHash,
        anchors: extractAnchors(snapshot.content),
        exists: false,
      };
    }
  }

  /**
   * 构建评论中心使用的富化评论对象。
   * @param {object} comment 原始评论
   */
  function enrichComment(comment) {
    const context = readCommentDocumentContext(comment);
    return {
      ...comment,
      docTitle: context.title,
      sourceName: context.sourceName,
      currentVersionId: context.versionId,
      currentContentHash: context.contentHash,
      documentExists: context.exists,
      location: locateComment(comment, context.anchors, context.versionId),
      replyCount: Array.isArray(comment.replies) ? comment.replies.length : 0,
    };
  }

  /**
   * 读取全局评论中心列表，支持按状态、定位状态、文档源和关键词筛选。
   * @param {object} filters 筛选条件
   */
  function listCommentCenter(filters = {}) {
    const sourceId = String(filters.sourceId || "all");
    const status = String(filters.status || "all");
    const location = String(filters.location || "all");
    const keyword = String(filters.q || "").trim().toLowerCase();
    const enriched = readComments().map(enrichComment);
    const filtered = enriched.filter((comment) => {
      const quote = comment.target?.selectedText || comment.target?.quote || "";
      const haystack = [
        comment.body,
        comment.path,
        comment.docTitle,
        comment.sourceName,
        quote,
      ]
        .join(" ")
        .toLowerCase();
      if (sourceId !== "all" && comment.sourceId !== sourceId) return false;
      if (status !== "all" && comment.status !== status) return false;
      if (location !== "all" && comment.location?.type !== location) return false;
      if (keyword && !haystack.includes(keyword)) return false;
      return true;
    });
    const summary = enriched.reduce(
      (acc, comment) => {
        acc.total += 1;
        acc.status[comment.status] = (acc.status[comment.status] || 0) + 1;
        acc.location[comment.location.type] = (acc.location[comment.location.type] || 0) + 1;
        acc.sources[comment.sourceId] = comment.sourceName;
        return acc;
      },
      {
        total: 0,
        status: { open: 0, resolved: 0 },
        location: { current: 0, remapped: 0, history: 0, lost: 0 },
        sources: {},
      }
    );
    return {
      comments: filtered.sort(
        (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
      ),
      summary,
      filters: { sourceId, status, location, q: filters.q || "" },
    };
  }

  /**
   * 新增一条文档评论。
   * @param {object} payload 前端提交的评论数据
   */
  function createComment(payload) {
    const source = getSource(payload.sourceId);
    const docPath = normalizeDocPath(payload.path);
    const body = String(payload.body || "").trim();
    if (!body) throw new Error("请输入评论内容");

    const now = new Date().toISOString();
    const comments = readComments();
    const comment = {
      id: store.generateId(),
      sourceId: source.id,
      sourceName: source.name,
      path: docPath,
      versionId: String(payload.versionId || ""),
      contentHash: String(payload.contentHash || ""),
      target: payload.target || {},
      body,
      replies: [],
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    comments.unshift(comment);
    writeComments(comments);
    store.logActivity("note", "新增文档评论", `${docPath}：${body.slice(0, 40)}`);
    return comment;
  }

  /**
   * 更新评论状态或正文，保留原始锚点便于追溯。
   * @param {string} id 评论 ID
   * @param {object} patch 更新内容
   */
  function updateComment(id, patch) {
    const comments = readComments();
    const index = comments.findIndex((comment) => comment.id === id);
    if (index === -1) throw new Error("未找到评论");

    const now = new Date().toISOString();
    const nextStatus = patch.status || comments[index].status;
    comments[index] = {
      ...comments[index],
      body: patch.body !== undefined ? String(patch.body || "").trim() : comments[index].body,
      status: nextStatus,
      resolvedAt: nextStatus === "resolved" ? now : null,
      updatedAt: now,
    };
    writeComments(comments);
    return comments[index];
  }

  /**
   * 给评论追加回复，形成类似飞书的线程。
   * @param {string} id 评论 ID
   * @param {string} body 回复内容
   */
  function addReply(id, body) {
    const replyBody = String(body || "").trim();
    if (!replyBody) throw new Error("请输入回复内容");

    const comments = readComments();
    const index = comments.findIndex((comment) => comment.id === id);
    if (index === -1) throw new Error("未找到评论");

    const now = new Date().toISOString();
    comments[index].replies = Array.isArray(comments[index].replies)
      ? comments[index].replies
      : [];
    comments[index].replies.push({
      id: store.generateId(),
      body: replyBody,
      createdAt: now,
    });
    comments[index].updatedAt = now;
    writeComments(comments);
    return comments[index];
  }

  /**
   * 将评论手动重新绑定到当前版本的某个选区或块。
   * @param {string} id 评论 ID
   * @param {object} payload 新锚点信息
   */
  function rebindComment(id, payload) {
    const comments = readComments();
    const index = comments.findIndex((comment) => comment.id === id);
    if (index === -1) throw new Error("未找到评论");

    const now = new Date().toISOString();
    const target = payload.target || {};
    if (!target.blockHash) throw new Error("缺少新的评论锚点");

    comments[index] = {
      ...comments[index],
      versionId: String(payload.versionId || comments[index].versionId || ""),
      contentHash: String(payload.contentHash || comments[index].contentHash || ""),
      target: {
        ...target,
        manuallyReboundAt: now,
      },
      rebindHistory: [
        ...(Array.isArray(comments[index].rebindHistory) ? comments[index].rebindHistory : []),
        {
          target: comments[index].target,
          versionId: comments[index].versionId,
          contentHash: comments[index].contentHash,
          reboundAt: now,
        },
      ],
      status: comments[index].status === "resolved" ? "open" : comments[index].status,
      updatedAt: now,
    };
    writeComments(comments);
    return comments[index];
  }

  /**
   * 对比当前版本和基准版本，并附带评论重挂载统计。
   * @param {string} sourceId 文档源 ID
   * @param {string} docPath 文档相对路径
   * @param {string} currentVersionId 当前版本 ID
   * @param {string} baseVersionId 基准版本 ID
   */
  function compareVersions(sourceId, docPath, currentVersionId = "", baseVersionId = "") {
    const currentDoc = readDocument(sourceId, docPath, currentVersionId);
    const versions = listVersions(currentDoc.source.id, currentDoc.path).sort(
      (a, b) => b.versionNumber - a.versionNumber
    );
    const currentIndex = versions.findIndex((version) => version.id === currentDoc.version.id);
    const baseVersion =
      versions.find((version) => version.id === baseVersionId) ||
      versions[currentIndex + 1] ||
      versions[currentIndex - 1];
    if (!baseVersion) {
      return {
        currentVersion: currentDoc.version,
        baseVersion: null,
        summary: { added: 0, removed: 0, modified: 0, unchanged: currentDoc.anchors.length },
        items: currentDoc.anchors.map((anchor) => ({ type: "unchanged", current: anchor })),
        commentStates: [],
      };
    }

    const baseSnapshot = readSnapshot(baseVersion.id);
    const baseAnchors = extractAnchors(baseSnapshot.content);
    const diff = diffAnchors(baseAnchors, currentDoc.anchors);
    const comments = listComments(currentDoc.source.id, currentDoc.path);
    const commentStates = comments.map((comment) => ({
      id: comment.id,
      status: comment.status,
      body: comment.body,
      target: comment.target,
      location: locateComment(comment, currentDoc.anchors, currentDoc.version.id),
    }));

    return {
      currentVersion: currentDoc.version,
      baseVersion,
      summary: diff.summary,
      items: diff.items,
      commentStates,
    };
  }

  return {
    listManagedSources,
    createSource,
    updateSource,
    deleteSource,
    listReviewWorkflow,
    updateReviewStatus,
    getTree,
    readDocument,
    listVersions,
    listComments,
    listCommentCenter,
    createComment,
    updateComment,
    addReply,
    rebindComment,
    compareVersions,
  };
}

/**
 * 注册文档评审相关 API。
 * @param {import("express").Express} app Express 应用
 * @param {object} store 本地存储模块
 */
function registerDocReviewRoutes(app, store) {
  const service = createDocReviewService(store);

  /**
   * 将业务错误统一转换为 JSON 响应，保持现有 API 风格。
   * @param {import("express").Response} res Express 响应对象
   * @param {Error} error 错误对象
   */
  function sendError(res, error) {
    res.status(400).json({ success: false, message: error.message || "文档评审操作失败" });
  }

  app.get("/api/docs/tree", (_req, res) => {
    try {
      res.json({ success: true, data: service.getTree() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/sources", (_req, res) => {
    try {
      res.json({ success: true, data: service.listManagedSources() });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/docs/sources", (req, res) => {
    try {
      res.json({ success: true, data: service.createSource(req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put("/api/docs/sources/:id", (req, res) => {
    try {
      res.json({ success: true, data: service.updateSource(req.params.id, req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.delete("/api/docs/sources/:id", (req, res) => {
    try {
      res.json({ success: true, data: service.deleteSource(req.params.id) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/review-workflow", (req, res) => {
    try {
      res.json({ success: true, data: service.listReviewWorkflow(req.query || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put("/api/docs/review-status", (req, res) => {
    try {
      res.json({ success: true, data: service.updateReviewStatus(req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/file", (req, res) => {
    try {
      const doc = service.readDocument(req.query.sourceId, req.query.path, req.query.versionId);
      res.json({
        success: true,
        data: {
          ...doc,
          comments: service.listComments(doc.source.id, doc.path),
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/versions", (req, res) => {
    try {
      res.json({
        success: true,
        data: service.listVersions(req.query.sourceId, req.query.path),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/compare", (req, res) => {
    try {
      res.json({
        success: true,
        data: service.compareVersions(
          req.query.sourceId,
          req.query.path,
          req.query.currentVersionId,
          req.query.baseVersionId
        ),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/comments", (req, res) => {
    try {
      res.json({
        success: true,
        data: service.listComments(req.query.sourceId, req.query.path),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get("/api/docs/comment-center", (req, res) => {
    try {
      res.json({
        success: true,
        data: service.listCommentCenter(req.query || {}),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/docs/comments", (req, res) => {
    try {
      res.json({ success: true, data: service.createComment(req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put("/api/docs/comments/:id", (req, res) => {
    try {
      res.json({ success: true, data: service.updateComment(req.params.id, req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put("/api/docs/comments/:id/rebind", (req, res) => {
    try {
      res.json({ success: true, data: service.rebindComment(req.params.id, req.body || {}) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/docs/comments/:id/replies", (req, res) => {
    try {
      res.json({ success: true, data: service.addReply(req.params.id, req.body?.body) });
    } catch (error) {
      sendError(res, error);
    }
  });
}

module.exports = { registerDocReviewRoutes };
