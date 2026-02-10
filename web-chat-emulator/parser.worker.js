const ATTACHMENT_LABELS = {
  photo: "[фото]",
  video: "[видео]",
  audio_message: "[голосовое]",
  audio: "[аудио]",
  sticker: "[стикер]",
  doc: "[документ]",
  link: "[ссылка]",
  wall: "[запись]",
  gift: "[подарок]",
};

const HTML_ATTACHMENT_LABELS = {
  image: "[фото]",
  video: "[видео]",
  audio: "[аудио]",
  document: "[документ]",
  link: "[ссылка]",
};

self.onmessage = async (event) => {
  const payload = event.data;
  if (!payload || typeof payload !== "object") {
    return;
  }

  try {
    if (payload.type === "parse-file") {
      await parseJsonFile(payload.file);
      return;
    }

    if (payload.type === "parse-html-directory") {
      await parseHtmlDirectory(payload.entries);
      return;
    }
  } catch (error) {
    postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

async function parseJsonFile(file) {
  if (!(file instanceof File)) {
    throw new Error("Некорректный файл");
  }

  postMessage({ type: "progress", phase: "reading", progress: 0.05, format: "json" });
  const rawSource = await file.text();

  postMessage({ type: "progress", phase: "parsing", progress: 0.3, format: "json" });
  const parsed = parseDialogPayload(rawSource);

  const sourceMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const sourceProfiles = Array.isArray(parsed.profiles)
    ? parsed.profiles
    : Array.isArray(parsed.users)
      ? parsed.users
      : [];

  const profiles = normalizeProfiles(sourceProfiles);
  const profileMap = new Map(profiles.map((profile) => [profile.id, profile]));

  const participantCounter = new Map();
  const normalizedMessages = new Array(sourceMessages.length);
  const totalMessages = Math.max(1, sourceMessages.length);

  let normalizedIndex = 0;

  for (let sourceIndex = sourceMessages.length - 1; sourceIndex >= 0; sourceIndex -= 1) {
    const message = sourceMessages[sourceIndex] || {};
    const fromNumber = numberOrNull(message.from);
    const from = fromNumber === null ? null : String(fromNumber);
    const sender = resolveSenderName(from, profileMap);

    if (from !== null) {
      participantCounter.set(from, (participantCounter.get(from) || 0) + 1);
    }

    const plainText = collapseWhitespace(extractText(message.text));
    const attachmentText = summarizeAttachments(message.attachments);
    const forwardedText = summarizeForwarded(message.fwd);
    const replyLabel = message.reply ? `[ответ на #${message.reply}]` : "";

    const lines = [];
    if (replyLabel) {
      lines.push(replyLabel);
    }
    if (plainText) {
      lines.push(plainText);
    }
    if (attachmentText) {
      lines.push(attachmentText);
    }
    if (forwardedText) {
      lines.push(forwardedText);
    }

    let text = lines.join("\n").trim();
    if (!text) {
      text = "[пустое сообщение]";
    }

    normalizedMessages[normalizedIndex] = {
      id: numberOrNull(message.id),
      from,
      sender,
      timestamp: normalizeTimestamp(message.time),
      text,
      searchText: text,
      attachments: [],
    };

    normalizedIndex += 1;

    if (normalizedIndex % 3000 === 0) {
      const progress = 0.35 + (normalizedIndex / totalMessages) * 0.6;
      postMessage({
        type: "progress",
        phase: "normalizing",
        progress: Math.min(progress, 0.96),
        format: "json",
      });
    }
  }

  const participants = Array.from(participantCounter.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id)
    .slice(0, 2);

  const startTimestamp = normalizedMessages[0]?.timestamp ?? null;
  const endTimestamp = normalizedMessages[normalizedMessages.length - 1]?.timestamp ?? null;

  postMessage({
    type: "ready",
    messages: normalizedMessages,
    profiles,
    participants,
    stats: {
      messageCount: normalizedMessages.length,
      from: startTimestamp,
      to: endTimestamp,
    },
  });
}

async function parseHtmlDirectory(entries) {
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("Папка пуста или файлы недоступны");
  }

  postMessage({ type: "progress", phase: "scanning", progress: 0.05, format: "html" });

  const htmlEntries = entries
    .map((entry) => {
      const file = entry?.file;
      if (!(file instanceof File)) {
        return null;
      }

      const relativePath = typeof entry?.relativePath === "string" ? entry.relativePath : file.name;
      if (!/\.html?$/i.test(file.name)) {
        return null;
      }

      return { file, relativePath };
    })
    .filter(Boolean);

  if (!htmlEntries.length) {
    throw new Error("В папке нет HTML файлов");
  }

  const historyEntries = htmlEntries.filter((entry) =>
    /^history_\d+\.html?$/i.test(basename(entry.relativePath)),
  );
  const chosenEntries = historyEntries.length ? historyEntries : htmlEntries;

  chosenEntries.sort((left, right) => {
    const leftIndex = extractHistoryIndex(left.relativePath);
    const rightIndex = extractHistoryIndex(right.relativePath);
    if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return left.relativePath.localeCompare(right.relativePath, "ru");
  });

  const profilesById = new Map();
  const participantCounter = new Map();
  const messages = [];

  let globalOrder = 0;
  const totalFiles = Math.max(1, chosenEntries.length);

  for (let index = 0; index < chosenEntries.length; index += 1) {
    const entry = chosenEntries[index];
    const file = entry.file;
    const relativePath = entry.relativePath;

    const progressBase = 0.08 + (index / totalFiles) * 0.82;
    postMessage({ type: "progress", phase: "reading", progress: progressBase, format: "html" });

    const raw = await file.text();

    postMessage({
      type: "progress",
      phase: "parsing",
      progress: Math.min(0.12 + (index / totalFiles) * 0.82, 0.95),
      format: "html",
    });

    const baseDir = dirname(relativePath);
    const parsedMessages = parseVkDumperHistoryHtml(raw, baseDir);

    for (const msg of parsedMessages) {
      msg.__order = globalOrder;
      globalOrder += 1;

      const from = msg.from;
      if (from !== null) {
        participantCounter.set(from, (participantCounter.get(from) || 0) + 1);
      }

      const profileId = msg.from;
      if (profileId !== null && !profilesById.has(profileId)) {
        profilesById.set(profileId, {
          id: profileId,
          name: msg.sender || `ID ${profileId}`,
          photo: msg.avatar || "",
        });
      } else if (profileId !== null) {
        const existing = profilesById.get(profileId);
        if (existing && !existing.photo && msg.avatar) {
          existing.photo = msg.avatar;
        }
      }

      messages.push(msg);
    }
  }

  postMessage({ type: "progress", phase: "sorting", progress: 0.96, format: "html" });

  messages.sort((left, right) => {
    const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : Infinity;
    const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : Infinity;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return (left.__order || 0) - (right.__order || 0);
  });

  for (let i = 0; i < messages.length; i += 1) {
    messages[i].id = i + 1;
    delete messages[i].__order;
  }

  const participants = Array.from(participantCounter.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => id)
    .slice(0, 2);

  const fromTimestamp = messages.length ? messages[0]?.timestamp ?? null : null;
  const toTimestamp = messages.length ? messages[messages.length - 1]?.timestamp ?? null : null;

  postMessage({
    type: "ready",
    messages,
    profiles: Array.from(profilesById.values()),
    participants,
    stats: {
      messageCount: messages.length,
      from: fromTimestamp,
      to: toTimestamp,
    },
  });
}

function parseVkDumperHistoryHtml(rawSource, baseDir) {
  const cleaned = String(rawSource || "").replace(/^\uFEFF/, "");
  const blocks = splitVkHistoryMessageBlocks(cleaned);
  const messages = [];

  for (const block of blocks) {
    const sender = extractVkSenderInfo(block);
    const senderName = sender.name || "Unknown";
    const senderId = sender.id || `name:${senderName}`;

    const avatarUrl = extractVkAvatarUrl(block);
    const dateText = extractVkDateText(block);
    const timestamp = parseVkDateTime(dateText);

    const gallery = extractGalleryBlock(block);
    const galleryInnerHtml = gallery?.innerHtml || "";
    const attachments = galleryInnerHtml
      ? parseVkGalleryAttachments(galleryInnerHtml, baseDir)
      : [];

    const text = extractVkMessageText(block, gallery?.startIndex ?? -1);
    const hasText = Boolean(text);
    const searchText = buildHtmlSearchText(text, attachments);

    messages.push({
      id: null,
      from: senderId,
      sender: senderName,
      avatar: avatarUrl,
      timestamp,
      text: hasText ? text : attachments.length ? "" : "[пустое сообщение]",
      searchText,
      attachments,
    });
  }

  return messages;
}

function splitVkHistoryMessageBlocks(html) {
  const blocks = [];
  const source = String(html || "");
  const starts = [];
  const pattern = /<div class="im_(?:in|out)">/g;
  let match = pattern.exec(source);

  while (match) {
    starts.push(match.index);
    match = pattern.exec(source);
  }

  if (!starts.length) {
    return blocks;
  }

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : source.length;
    blocks.push(source.slice(start, end));
  }

  return blocks;
}

function extractVkSenderInfo(html) {
  const source = String(html || "");

  const nameMatch = source.match(
    /<div class="im_log_author_chat_name"><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
  );

  const href = nameMatch ? String(nameMatch[1] || "") : "";
  const rawName = nameMatch ? String(nameMatch[2] || "") : "";
  const name = collapseWhitespace(decodeHtmlEntities(stripTags(rawName))) || "";
  const id = extractVkProfileId(href) || "";

  if (href || name) {
    return { href, name, id };
  }

  const thumbMatch = source.match(/<div class="im_log_author_chat_thumb"><a[^>]*href="([^"]+)"/i);
  const thumbHref = thumbMatch ? String(thumbMatch[1] || "") : "";
  return { href: thumbHref, name: "", id: extractVkProfileId(thumbHref) || "" };
}

function extractVkAvatarUrl(html) {
  const source = String(html || "");
  const match = source.match(
    /<div class="im_log_author_chat_thumb">[\s\S]*?<img[^>]*src="([^"]+)"/i,
  );
  return match ? String(match[1] || "") : "";
}

function extractVkDateText(html) {
  const source = String(html || "");
  const match = source.match(/<a class="im_date_link">([\s\S]*?)<\/a>/i);
  return collapseWhitespace(decodeHtmlEntities(stripTags(match ? match[1] : "")));
}

function extractGalleryBlock(html) {
  const source = String(html || "");
  const startIndex = source.indexOf('<div class="gallery attachment">');
  if (startIndex === -1) {
    return null;
  }

  const divBlock = extractDivBlock(source, startIndex);
  if (!divBlock) {
    return null;
  }

  return { startIndex, innerHtml: divBlock.innerHtml };
}

function extractDivBlock(source, startIndex) {
  const startTagEnd = source.indexOf(">", startIndex);
  if (startTagEnd === -1) {
    return null;
  }

  let depth = 1;
  let cursor = startTagEnd + 1;

  while (depth > 0) {
    const nextOpen = source.indexOf("<div", cursor);
    const nextClose = source.indexOf("</div", cursor);

    if (nextClose === -1) {
      return null;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + 4;
      continue;
    }

    depth -= 1;
    const closeTagEnd = source.indexOf(">", nextClose);
    if (closeTagEnd === -1) {
      return null;
    }

    if (depth === 0) {
      return {
        innerHtml: source.slice(startTagEnd + 1, nextClose),
        endIndex: closeTagEnd + 1,
      };
    }

    cursor = closeTagEnd + 1;
  }

  return null;
}

function extractVkMessageText(html, galleryStartIndex) {
  const source = String(html || "");

  const nameStart = source.indexOf('<div class="im_log_author_chat_name">');
  if (nameStart === -1) {
    return "";
  }

  const nameEnd = source.indexOf("</div>", nameStart);
  if (nameEnd === -1) {
    return "";
  }

  const start = nameEnd + "</div>".length;
  const end = galleryStartIndex >= 0 ? galleryStartIndex : source.length;
  if (end <= start) {
    return "";
  }

  const raw = source.slice(start, end);
  return normalizeMultilineText(htmlToText(raw));
}

function parseVkGalleryAttachments(galleryHtml, baseDir) {
  const html = String(galleryHtml || "");
  const attachments = [];
  const seen = new Set();

  const anchorRanges = [];
  const anchorRegex = /<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>/gi;
  let match = anchorRegex.exec(html);

  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    anchorRanges.push([start, end]);

    const hrefRaw = String(match[1] || match[2] || "");
    const href = normalizeMediaRef(hrefRaw, baseDir);
    if (href) {
      const innerHtml = String(match[3] || "");
      const imgMatch = innerHtml.match(/<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/i);
      const title = normalizeMultilineText(htmlToText(innerHtml));

      if (imgMatch) {
        const thumbRaw = String(imgMatch[1] || imgMatch[2] || "");
        const thumb = normalizeMediaRef(thumbRaw, baseDir);
        const inferred = detectMediaTypeFromUrl(hrefRaw);
        const type = inferred === "video" ? "video" : "image";

        const key = `${type}:${href}`;
        if (!seen.has(key)) {
          seen.add(key);
          attachments.push({
            type,
            url: href,
            thumbUrl: thumb || "",
            title: "",
          });
        }
      } else {
        const type = looksLikeDocument(title, hrefRaw) ? "document" : "link";
        const key = `${type}:${href}`;
        if (!seen.has(key)) {
          seen.add(key);
          attachments.push({
            type,
            url: href,
            title: title || href,
          });
        }
      }
    }

    match = anchorRegex.exec(html);
  }

  const audioRegex = /<audio\b[\s\S]*?<\/audio>/gi;
  match = audioRegex.exec(html);

  while (match) {
    const audioBlock = match[0];
    const srcMatch = audioBlock.match(/\bsrc=(?:"([^"]+)"|'([^']+)')/i);
    const srcRaw = srcMatch ? String(srcMatch[1] || srcMatch[2] || "") : "";
    const url = normalizeMediaRef(srcRaw, baseDir);
    if (url) {
      const key = `audio:${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push({ type: "audio", url, title: "" });
      }
    }

    match = audioRegex.exec(html);
  }

  const videoRegex = /<video\b[\s\S]*?<\/video>/gi;
  match = videoRegex.exec(html);

  while (match) {
    const videoBlock = match[0];
    const srcMatch = videoBlock.match(/\bsrc=(?:"([^"]+)"|'([^']+)')/i);
    const srcRaw = srcMatch ? String(srcMatch[1] || srcMatch[2] || "") : "";
    const url = normalizeMediaRef(srcRaw, baseDir);
    if (url) {
      const key = `video:${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push({ type: "video", url, title: "" });
      }
    }

    match = videoRegex.exec(html);
  }

  const imgRegex = /<img\b[^>]*\bsrc=(?:"([^"]+)"|'([^']+)')[^>]*>/gi;
  match = imgRegex.exec(html);

  while (match) {
    const imgIndex = match.index;
    if (isInsideRanges(anchorRanges, imgIndex)) {
      match = imgRegex.exec(html);
      continue;
    }

    const srcRaw = String(match[1] || match[2] || "");
    const url = normalizeMediaRef(srcRaw, baseDir);
    if (url) {
      const key = `image:${url}`;
      if (!seen.has(key)) {
        seen.add(key);
        attachments.push({ type: "image", url, title: "" });
      }
    }

    match = imgRegex.exec(html);
  }

  return attachments;
}

function isInsideRanges(ranges, index) {
  for (const range of ranges) {
    const start = range[0];
    const end = range[1];
    if (index >= start && index < end) {
      return true;
    }
  }
  return false;
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, "");
}

function htmlToText(html) {
  let value = String(html || "");
  value = value.replace(/\r\n?/g, "\n");
  value = value.replace(/<br\s*\/?>/gi, "\n");
  value = value.replace(/<\/p\s*>/gi, "\n");
  value = value.replace(/<p\b[^>]*>/gi, "");
  value = value.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  value = value.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  value = value.replace(/<[^>]+>/g, "");
  value = decodeHtmlEntities(value);
  return value;
}

function decodeHtmlEntities(value) {
  const source = String(value || "");
  return source.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code) => {
    if (!code) {
      return match;
    }

    if (code[0] === "#") {
      const numeric =
        code[1] === "x" || code[1] === "X"
          ? Number.parseInt(code.slice(2), 16)
          : Number.parseInt(code.slice(1), 10);

      if (!Number.isFinite(numeric) || numeric <= 0) {
        return match;
      }

      try {
        return String.fromCodePoint(numeric);
      } catch {
        return match;
      }
    }

    const named = code.toLowerCase();
    if (named === "nbsp") {
      return " ";
    }
    if (named === "amp") {
      return "&";
    }
    if (named === "lt") {
      return "<";
    }
    if (named === "gt") {
      return ">";
    }
    if (named === "quot") {
      return '"';
    }
    if (named === "apos") {
      return "'";
    }

    return match;
  });
}

function buildHtmlSearchText(text, attachments) {
  const parts = [];

  const normalizedText = normalizeMultilineText(text);
  if (normalizedText) {
    parts.push(normalizedText);
  }

  if (Array.isArray(attachments) && attachments.length) {
    const counters = new Map();
    const titles = [];

    for (const item of attachments) {
      const type = typeof item?.type === "string" ? item.type : "link";
      counters.set(type, (counters.get(type) || 0) + 1);

      if (type === "document" && typeof item.title === "string" && item.title.trim()) {
        titles.push(item.title.trim());
      }
    }

    const summary = [];
    for (const [type, count] of counters.entries()) {
      const label = HTML_ATTACHMENT_LABELS[type] || `[${type}]`;
      summary.push(count > 1 ? `${label} x${count}` : label);
    }

    if (summary.length) {
      parts.push(summary.join(" "));
    }

    if (titles.length) {
      parts.push(titles.slice(0, 3).join(" | "));
    }
  }

  return parts.join("\n").trim();
}

function detectMediaTypeFromUrl(url) {
  const normalized = String(url || "").toLowerCase();
  if (/\.(mp4|webm|mkv)(?:$|[?#])/.test(normalized)) {
    return "video";
  }
  if (/\.(mp3|ogg|m4a|wav)(?:$|[?#])/.test(normalized)) {
    return "audio";
  }
  if (/\.(png|jpe?g|gif|webp|bmp)(?:$|[?#])/.test(normalized)) {
    return "image";
  }
  return "link";
}

function looksLikeDocument(title, href) {
  const lowerTitle = String(title || "").toLowerCase();
  const lowerHref = String(href || "").toLowerCase();
  if (lowerHref.includes("vk.com/doc")) {
    return true;
  }
  return /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z)(?:$|[?#])/.test(lowerTitle);
}

function normalizeMediaRef(rawUrl, baseDir) {
  let value = String(rawUrl || "").trim();
  if (!value) {
    return "";
  }

  if (value.startsWith("//")) {
    return `https:${value}`;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return value;
  }

  value = value.replace(/\\/g, "/");
  const withoutHash = value.split("#")[0];
  const [pathPart, query] = withoutHash.split("?");
  const resolved = normalizePath(joinPath(baseDir, pathPart));
  if (!resolved) {
    return "";
  }

  return query ? `${resolved}?${query}` : resolved;
}

function parseVkDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);

  if (
    !Number.isFinite(day) ||
    !Number.isFinite(month) ||
    !Number.isFinite(year) ||
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes)
  ) {
    return null;
  }

  const date = new Date(year, month - 1, day, hours, minutes);
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function extractHistoryIndex(path) {
  const match = basename(path).match(/^history_(\d+)\.html?$/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractVkProfileId(href) {
  const raw = String(href || "").trim();
  if (!raw) {
    return "";
  }

  const matchId = raw.match(/vk\.com\/id(\d+)/i);
  if (matchId) {
    return matchId[1];
  }

  const matchClub = raw.match(/vk\.com\/club(\d+)/i);
  if (matchClub) {
    return `-${matchClub[1]}`;
  }

  const matchPublic = raw.match(/vk\.com\/public(\d+)/i);
  if (matchPublic) {
    return `-${matchPublic[1]}`;
  }

  const matchUsername = raw.match(/vk\.com\/([^/?#]+)/i);
  return matchUsername ? matchUsername[1] : "";
}

function normalizeMultilineText(value) {
  const normalized = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00A0/g, " ")
    .trim();

  if (!normalized) {
    return "";
  }

  return normalized
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

function joinPath(baseDir, relative) {
  const base = String(baseDir || "").replace(/\\/g, "/");
  const rel = String(relative || "").replace(/\\/g, "/");
  if (!base) {
    return rel;
  }
  if (!rel) {
    return base;
  }
  if (rel.startsWith("/")) {
    return rel;
  }
  if (base.endsWith("/")) {
    return `${base}${rel}`;
  }
  return `${base}/${rel}`;
}

function normalizePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  if (!raw) {
    return "";
  }

  const leadingSlash = raw.startsWith("/");
  const segments = raw.split("/").filter(Boolean);
  const stack = [];

  for (const segment of segments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length) {
        stack.pop();
      }
      continue;
    }
    stack.push(segment);
  }

  const joined = stack.join("/");
  return leadingSlash ? `/${joined}` : joined;
}

function basename(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || "";
}

function dirname(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx === -1) {
    return "";
  }
  return normalized.slice(0, idx + 1);
}

function parseDialogPayload(rawSource) {
  const cleaned = String(rawSource || "").replace(/^\uFEFF/, "").trim();

  const candidates = [];

  if (cleaned) {
    candidates.push(cleaned);

    const assignmentTrimmed = cleaned
      .replace(/^(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*/, "")
      .replace(/;\s*$/, "")
      .trim();

    if (assignmentTrimmed !== cleaned) {
      candidates.push(assignmentTrimmed);
    }

    const firstBrace = assignmentTrimmed.indexOf("{");
    const lastBrace = assignmentTrimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      candidates.push(assignmentTrimmed.slice(firstBrace, lastBrace + 1));
    }
  }

  let lastError = null;

  for (const candidate of dedupe(candidates)) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Не удалось разобрать JSON: ${lastError.message}`);
  }

  throw new Error("Не удалось разобрать JSON");
}

function normalizeProfiles(rawProfiles) {
  return rawProfiles
    .map((profile) => {
      const idNumber = numberOrNull(profile?.id);
      if (idNumber === null) {
        return null;
      }

      const id = String(idNumber);
      const firstName = String(profile.firstName || "").trim();
      const lastName = String(profile.lastName || "").trim();
      const name = `${firstName} ${lastName}`.trim() || `ID ${id}`;

      return {
        id,
        name,
        photo: typeof profile.photo === "string" ? profile.photo : "",
      };
    })
    .filter(Boolean);
}

function resolveSenderName(id, profileMap) {
  if (id === null) {
    return "Unknown";
  }

  return profileMap.get(id)?.name || `ID ${id}`;
}

function summarizeAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }

  const counters = new Map();

  for (const attachment of attachments) {
    const type = typeof attachment?.type === "string" ? attachment.type : "file";
    counters.set(type, (counters.get(type) || 0) + 1);
  }

  const chunks = [];

  for (const [type, count] of counters.entries()) {
    const label = ATTACHMENT_LABELS[type] || `[${type}]`;
    chunks.push(count > 1 ? `${label} x${count}` : label);
  }

  return chunks.join(" ").trim();
}

function summarizeForwarded(forwarded) {
  if (!forwarded) {
    return "";
  }

  if (!Array.isArray(forwarded) || forwarded.length === 0) {
    return "[пересланное сообщение]";
  }

  const snippets = [];
  for (const item of forwarded) {
    const text = collapseWhitespace(
      extractText(typeof item === "object" ? item.text : item),
    );
    if (text) {
      snippets.push(trimLength(text, 110));
      if (snippets.length >= 2) {
        break;
      }
    }
  }

  const base = `[пересланные: ${forwarded.length}]`;
  if (!snippets.length) {
    return base;
  }

  return `${base} ${snippets.join(" | ")}`;
}

function extractText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (item && typeof item === "object" && "text" in item) {
          return extractText(item.text);
        }

        return "";
      })
      .filter(Boolean)
      .join(" ");
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string") {
      return value.text;
    }

    return "";
  }

  return "";
}

function normalizeTimestamp(value) {
  const numericValue = numberOrNull(value);
  if (numericValue === null) {
    return null;
  }

  if (numericValue > 1_000_000_000_000) {
    return numericValue;
  }

  if (numericValue > 1_000_000_000) {
    return numericValue * 1000;
  }

  return null;
}

function numberOrNull(value) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function collapseWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimLength(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}...`;
}

function dedupe(list) {
  const seen = new Set();
  const unique = [];

  for (const item of list) {
    if (!item || seen.has(item)) {
      continue;
    }

    seen.add(item);
    unique.push(item);
  }

  return unique;
}
