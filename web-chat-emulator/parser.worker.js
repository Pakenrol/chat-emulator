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

self.onmessage = async (event) => {
  const payload = event.data;
  if (!payload || payload.type !== "parse-file") {
    return;
  }

  const file = payload.file;
  if (!(file instanceof File)) {
    postMessage({ type: "error", message: "Некорректный файл" });
    return;
  }

  try {
    postMessage({ type: "progress", phase: "reading", progress: 0.05 });
    const rawSource = await file.text();

    postMessage({ type: "progress", phase: "parsing", progress: 0.3 });
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
      const from = numberOrNull(message.from);
      const sender = resolveSenderName(from, profileMap);

      participantCounter.set(from, (participantCounter.get(from) || 0) + 1);

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
      };

      normalizedIndex += 1;

      if (normalizedIndex % 3000 === 0) {
        const progress = 0.35 + (normalizedIndex / totalMessages) * 0.6;
        postMessage({
          type: "progress",
          phase: "normalizing",
          progress: Math.min(progress, 0.96),
        });
      }
    }

    const participants = Array.from(participantCounter.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([id]) => id)
      .filter((id) => id !== null)
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
  } catch (error) {
    postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

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
      const id = numberOrNull(profile?.id);
      if (id === null) {
        return null;
      }

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
