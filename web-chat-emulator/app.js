const ESTIMATED_ROW_HEIGHT = 78;
const OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 160;
const MAX_SEARCH_PREVIEW_ITEMS = 8;

const dom = {
  fileInput: document.querySelector("#fileInput"),
  loadSampleBtn: document.querySelector("#loadSampleBtn"),
  progressBar: document.querySelector("#progressBar"),
  loadStatus: document.querySelector("#loadStatus"),
  chatMeta: document.querySelector("#chatMeta"),
  searchSection: document.querySelector(".search"),
  searchInput: document.querySelector("#searchInput"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  searchStatus: document.querySelector("#searchStatus"),
  prevMatchBtn: document.querySelector("#prevMatchBtn"),
  nextMatchBtn: document.querySelector("#nextMatchBtn"),
  chatViewport: document.querySelector("#chatViewport"),
  chatCanvas: document.querySelector("#chatCanvas"),
  emptyState: document.querySelector("#emptyState"),
};

const state = {
  worker: null,
  loading: false,
  messages: [],
  searchCorpus: [],
  allIndexes: [],
  searchResults: [],
  activeSearchResult: -1,
  searchPreviewResultPositions: [],
  activePreviewIndex: -1,
  searchSuggestionsVisible: false,
  searchQuery: "",
  previousSearchQuery: "",
  rowHeights: [],
  tree: null,
  renderedStart: -1,
  renderedEnd: -1,
  measureQueued: false,
  rightSideId: null,
  searchDebounceId: null,
};

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
});

class FenwickTree {
  constructor(size) {
    this.size = size;
    this.tree = new Float64Array(size + 1);
  }

  update(index, delta) {
    if (!Number.isFinite(delta) || delta === 0 || index < 0 || index >= this.size) {
      return;
    }

    for (let i = index + 1; i <= this.size; i += i & -i) {
      this.tree[i] += delta;
    }
  }

  sum(indexExclusive) {
    const capped = Math.max(0, Math.min(this.size, indexExclusive));
    let result = 0;

    for (let i = capped; i > 0; i -= i & -i) {
      result += this.tree[i];
    }

    return result;
  }

  total() {
    return this.sum(this.size);
  }

  lowerBound(target) {
    if (this.size === 0) {
      return 0;
    }

    if (target <= 0) {
      return 0;
    }

    const totalHeight = this.total();
    if (target >= totalHeight) {
      return this.size - 1;
    }

    let idx = 0;
    let accumulated = 0;
    let bit = 1;

    while (bit <= this.size) {
      bit <<= 1;
    }
    bit >>= 1;

    while (bit > 0) {
      const next = idx + bit;
      if (next <= this.size && accumulated + this.tree[next] <= target) {
        idx = next;
        accumulated += this.tree[next];
      }
      bit >>= 1;
    }

    return Math.min(idx, this.size - 1);
  }
}

attachEvents();
setEmptyState("Загрузите JSON, чтобы увидеть переписку.");

function attachEvents() {
  dom.fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) {
      beginLoad(file);
    }
  });

  dom.loadSampleBtn.addEventListener("click", async () => {
    try {
      const file = await loadSampleFromRepo();
      beginLoad(file);
    } catch (error) {
      setStatus(
        `Не получилось загрузить пример: ${getErrorMessage(error)}`,
        0,
      );
    }
  });

  dom.searchInput.addEventListener("input", () => {
    if (!state.messages.length) {
      return;
    }

    if (state.searchDebounceId) {
      clearTimeout(state.searchDebounceId);
    }

    const query = dom.searchInput.value;
    state.searchDebounceId = setTimeout(() => {
      runSearch(query);
      openSearchSuggestions();
    }, SEARCH_DEBOUNCE_MS);
  });

  dom.searchInput.addEventListener("focus", () => {
    openSearchSuggestions();
  });

  dom.searchInput.addEventListener("click", () => {
    openSearchSuggestions();
  });

  dom.searchInput.addEventListener("keydown", handleSearchInputKeydown);

  dom.searchSuggestions.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  dom.searchSuggestions.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const option = target.closest(".search-suggestion");
    if (!option) {
      return;
    }

    const previewIndex = Number(option.dataset.previewIndex);
    if (Number.isInteger(previewIndex)) {
      selectSearchPreview(previewIndex);
    }
  });

  dom.prevMatchBtn.addEventListener("click", () => moveMatchPointer(-1));
  dom.nextMatchBtn.addEventListener("click", () => moveMatchPointer(1));

  dom.chatViewport.addEventListener("scroll", () => {
    renderVisibleMessages();
  });

  window.addEventListener("resize", () => {
    renderVisibleMessages(true);
  });

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      renderVisibleMessages(true);
    });
    resizeObserver.observe(dom.chatViewport);
  }

  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }

    if (!dom.searchSection?.contains(target)) {
      closeSearchSuggestions();
    }
  });

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  document.addEventListener("drop", (event) => {
    event.preventDefault();
    const [file] = event.dataTransfer?.files || [];
    if (file) {
      beginLoad(file);
    }
  });
}

async function loadSampleFromRepo() {
  const candidatePaths = ["../214807272.json", "/214807272.json", "./214807272.json"];

  for (const candidate of candidatePaths) {
    try {
      const response = await fetch(candidate);
      if (!response.ok) {
        continue;
      }

      // Cloudflare Pages (and some SPA setups) may return `index.html` with 200 for
      // unknown paths. Detect and skip HTML responses to avoid parsing errors.
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const looksLikeJsonByType = contentType.includes("json");
      if (!looksLikeJsonByType) {
        const peek = await peekResponseText(response.clone(), 160);
        if (peek.trimStart().startsWith("<")) {
          continue;
        }
      }

      const blob = await response.blob();
      return new File([blob], "214807272.json", {
        type: blob.type || (looksLikeJsonByType ? contentType : "application/json"),
      });
    } catch {
      // Try next path.
    }
  }

  throw new Error(
    "Не найден `214807272.json` рядом со страницей. Если вы запускаете локально, запустите сервер из корня репозитория; иначе загрузите свой JSON.",
  );
}

async function peekResponseText(response, maxBytes) {
  try {
    if (!response.body) {
      return "";
    }

    const reader = response.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});

    if (!value) {
      return "";
    }

    const view = value.subarray(0, Math.max(0, Math.min(value.length, maxBytes)));
    return new TextDecoder("utf-8", { fatal: false }).decode(view);
  } catch {
    return "";
  }
}

function beginLoad(file) {
  resetConversationState();
  state.loading = true;
  dom.searchInput.disabled = true;
  dom.searchInput.value = "";
  dom.searchStatus.textContent = "Идёт загрузка файла...";
  setStatus(`Чтение файла: ${file.name}`, 0.05);
  setEmptyState("Идёт обработка файла...");

  if (state.worker) {
    state.worker.terminate();
  }

  const workerUrl = new URL("./parser.worker.js", import.meta.url);
  const worker = new Worker(workerUrl);
  state.worker = worker;

  worker.onmessage = (event) => {
    const payload = event.data;
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (payload.type === "progress") {
      handleProgress(payload);
      return;
    }

    if (payload.type === "error") {
      state.loading = false;
      setStatus(`Ошибка загрузки: ${payload.message || "неизвестная"}`, 0);
      dom.searchStatus.textContent = "Поиск недоступен";
      state.worker?.terminate();
      state.worker = null;
      setEmptyState("Не удалось разобрать файл.");
      return;
    }

    if (payload.type === "ready") {
      hydrateConversation(payload);
    }
  };

  worker.postMessage({ type: "parse-file", file });
}

function handleProgress(payload) {
  const progress = clampNumber(payload.progress, 0, 1);
  const phaseMap = {
    reading: "Чтение файла",
    parsing: "Парсинг JSON",
    normalizing: "Подготовка сообщений",
  };

  const phaseText = phaseMap[payload.phase] || "Обработка";
  const percent = Math.round(progress * 100);
  setStatus(`${phaseText}... ${percent}%`, progress);
}

function hydrateConversation(payload) {
  state.loading = false;
  state.worker?.terminate();
  state.worker = null;

  state.messages = Array.isArray(payload.messages) ? payload.messages : [];
  state.searchCorpus = state.messages.map((message) =>
    String(message.text || "").toLowerCase(),
  );
  state.allIndexes = Array.from({ length: state.messages.length }, (_, index) => index);
  state.searchResults = [];
  state.activeSearchResult = -1;
  state.searchPreviewResultPositions = [];
  state.activePreviewIndex = -1;
  state.searchSuggestionsVisible = false;
  state.searchQuery = "";
  state.previousSearchQuery = "";

  if (!state.messages.length) {
    setStatus("Файл загружен, но сообщений не найдено.", 1);
    dom.searchStatus.textContent = "Совпадений: 0";
    dom.chatMeta.textContent = "Нет сообщений в загруженном файле";
    setEmptyState("В файле нет сообщений.");
    return;
  }

  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  state.rightSideId =
    participants[0] ?? state.messages[state.messages.length - 1]?.from ?? state.messages[0]?.from;

  state.rowHeights = new Array(state.messages.length).fill(ESTIMATED_ROW_HEIGHT);
  state.tree = new FenwickTree(state.messages.length);
  for (let index = 0; index < state.rowHeights.length; index += 1) {
    state.tree.update(index, state.rowHeights[index]);
  }

  state.renderedStart = -1;
  state.renderedEnd = -1;

  const profileMap = new Map(
    (Array.isArray(payload.profiles) ? payload.profiles : []).map((profile) => [
      Number(profile.id),
      profile.name,
    ]),
  );

  const participantNames = participants
    .slice(0, 2)
    .map((id) => profileMap.get(Number(id)) || `ID ${id}`)
    .join(" / ");

  const fromTime = state.messages[0]?.timestamp;
  const toTime = state.messages[state.messages.length - 1]?.timestamp;
  const fromLabel = Number.isFinite(fromTime) ? dateFormatter.format(fromTime) : "?";
  const toLabel = Number.isFinite(toTime) ? dateFormatter.format(toTime) : "?";

  dom.chatMeta.textContent = `${state.messages.length.toLocaleString("ru-RU")} сообщений | ${fromLabel} - ${toLabel}${participantNames ? ` | ${participantNames}` : ""}`;

  dom.searchInput.disabled = false;
  dom.searchStatus.textContent = "Введите текст для поиска";
  dom.prevMatchBtn.disabled = true;
  dom.nextMatchBtn.disabled = true;
  closeSearchSuggestions();

  setStatus("Диалог успешно загружен.", 1);
  clearEmptyState();

  scrollToBottom();
  renderVisibleMessages(true);
}

function resetConversationState() {
  if (state.searchDebounceId) {
    clearTimeout(state.searchDebounceId);
    state.searchDebounceId = null;
  }

  state.messages = [];
  state.searchCorpus = [];
  state.allIndexes = [];
  state.searchResults = [];
  state.activeSearchResult = -1;
  state.searchPreviewResultPositions = [];
  state.activePreviewIndex = -1;
  state.searchSuggestionsVisible = false;
  state.searchQuery = "";
  state.previousSearchQuery = "";
  state.rowHeights = [];
  state.tree = null;
  state.renderedStart = -1;
  state.renderedEnd = -1;
  state.measureQueued = false;
  state.rightSideId = null;

  dom.chatCanvas.replaceChildren();
  dom.searchInput.disabled = true;
  dom.searchInput.setAttribute("aria-expanded", "false");
  dom.prevMatchBtn.disabled = true;
  dom.nextMatchBtn.disabled = true;
  dom.searchSuggestions.hidden = true;
  dom.searchSuggestions.replaceChildren();
}

function renderVisibleMessages(force = false) {
  if (!state.tree || !state.messages.length) {
    return;
  }

  const viewportHeight = dom.chatViewport.clientHeight || 1;
  const scrollTop = dom.chatViewport.scrollTop;
  const totalHeight = Math.max(state.tree.total(), viewportHeight);

  dom.chatCanvas.style.height = `${Math.ceil(totalHeight)}px`;

  const start = Math.max(0, state.tree.lowerBound(scrollTop) - OVERSCAN);
  const end = Math.min(
    state.messages.length - 1,
    state.tree.lowerBound(scrollTop + viewportHeight) + OVERSCAN,
  );

  if (!force && start === state.renderedStart && end === state.renderedEnd) {
    return;
  }

  state.renderedStart = start;
  state.renderedEnd = end;

  const fragment = document.createDocumentFragment();
  const activeMessageIndex =
    state.activeSearchResult >= 0 ? state.searchResults[state.activeSearchResult] : -1;

  for (let index = start; index <= end; index += 1) {
    const message = state.messages[index];
    const row = document.createElement("article");
    row.className = `message-row ${
      message.from === state.rightSideId ? "outgoing" : "incoming"
    }`;

    if (isIndexInSearchResults(index)) {
      row.classList.add("match");
    }

    if (index === activeMessageIndex) {
      row.classList.add("active-match");
    }

    row.dataset.index = String(index);
    row.style.top = `${state.tree.sum(index)}px`;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const senderNode = document.createElement("span");
    senderNode.textContent = message.sender || `ID ${message.from}`;

    const timeNode = document.createElement("span");
    timeNode.textContent = Number.isFinite(message.timestamp)
      ? dateFormatter.format(message.timestamp)
      : "без времени";

    meta.append(senderNode, timeNode);

    const text = document.createElement("div");
    text.className = "message-text";
    appendHighlightedText(text, String(message.text || ""), state.searchQuery);

    bubble.append(meta, text);
    row.appendChild(bubble);
    fragment.appendChild(row);
  }

  dom.chatCanvas.replaceChildren(fragment);
  scheduleMeasurement();
}

function scheduleMeasurement() {
  if (state.measureQueued || !state.tree) {
    return;
  }

  state.measureQueued = true;

  requestAnimationFrame(() => {
    state.measureQueued = false;

    if (!state.tree) {
      return;
    }

    let changed = false;

    for (const row of dom.chatCanvas.children) {
      const index = Number(row.dataset.index);
      const measuredHeight = Math.max(44, Math.ceil(row.getBoundingClientRect().height));
      const previousHeight = state.rowHeights[index];

      if (Math.abs(measuredHeight - previousHeight) > 1) {
        state.rowHeights[index] = measuredHeight;
        state.tree.update(index, measuredHeight - previousHeight);
        changed = true;
      }
    }

    if (changed) {
      renderVisibleMessages(true);
    }
  });
}

function runSearch(rawQuery) {
  state.searchQuery = String(rawQuery || "").trim().toLowerCase();

  if (!state.searchQuery) {
    state.searchResults = [];
    state.activeSearchResult = -1;
    state.searchPreviewResultPositions = [];
    state.activePreviewIndex = -1;
    state.previousSearchQuery = "";
    closeSearchSuggestions();
    updateSearchUi();
    renderVisibleMessages(true);
    return;
  }

  const canReusePreviousPool =
    state.previousSearchQuery && state.searchQuery.startsWith(state.previousSearchQuery);
  const pool = canReusePreviousPool ? state.searchResults : state.allIndexes;

  const nextResults = [];
  for (const index of pool) {
    if (state.searchCorpus[index].includes(state.searchQuery)) {
      nextResults.push(index);
    }
  }

  state.searchResults = nextResults;
  state.activeSearchResult = nextResults.length ? 0 : -1;
  state.activePreviewIndex = nextResults.length ? 0 : -1;
  state.previousSearchQuery = state.searchQuery;

  if (!nextResults.length) {
    closeSearchSuggestions();
  } else if (state.searchSuggestionsVisible) {
    renderSearchSuggestions();
  }

  updateSearchUi();
  renderVisibleMessages(true);

  if (nextResults.length) {
    scrollToMessageIndex(nextResults[0]);
  }
}

function moveMatchPointer(direction) {
  const length = state.searchResults.length;
  if (!length) {
    return;
  }

  state.activeSearchResult =
    (state.activeSearchResult + direction + length) % length;

  updateSearchUi();

  const messageIndex = state.searchResults[state.activeSearchResult];
  scrollToMessageIndex(messageIndex);
  renderVisibleMessages(true);

  syncActivePreviewWithSearchResult();
  renderSearchSuggestions();
}

function handleSearchInputKeydown(event) {
  if (event.key === "Escape") {
    closeSearchSuggestions();
    return;
  }

  if (!state.searchSuggestionsVisible || !state.searchPreviewResultPositions.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveSearchPreviewPointer(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveSearchPreviewPointer(-1);
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    const nextPreviewIndex =
      state.activePreviewIndex >= 0 ? state.activePreviewIndex : 0;
    selectSearchPreview(nextPreviewIndex);
  }
}

function openSearchSuggestions() {
  if (
    dom.searchInput.disabled ||
    !state.searchQuery ||
    !state.searchResults.length
  ) {
    closeSearchSuggestions();
    return;
  }

  state.searchSuggestionsVisible = true;
  syncActivePreviewWithSearchResult();
  if (state.activePreviewIndex < 0) {
    state.activePreviewIndex = 0;
  }

  dom.searchSuggestions.hidden = false;
  dom.searchInput.setAttribute("aria-expanded", "true");
  renderSearchSuggestions();
}

function closeSearchSuggestions() {
  state.searchSuggestionsVisible = false;
  state.searchPreviewResultPositions = [];
  state.activePreviewIndex = -1;
  dom.searchSuggestions.hidden = true;
  dom.searchSuggestions.replaceChildren();
  dom.searchInput.setAttribute("aria-expanded", "false");
}

function renderSearchSuggestions() {
  if (!state.searchSuggestionsVisible) {
    return;
  }

  if (!state.searchQuery || !state.searchResults.length) {
    closeSearchSuggestions();
    return;
  }

  const previewCount = Math.min(
    MAX_SEARCH_PREVIEW_ITEMS,
    state.searchResults.length,
  );
  state.searchPreviewResultPositions = Array.from(
    { length: previewCount },
    (_, position) => position,
  );

  if (state.activePreviewIndex >= previewCount) {
    state.activePreviewIndex = previewCount - 1;
  }
  if (state.activePreviewIndex < 0) {
    state.activePreviewIndex = 0;
  }

  const fragment = document.createDocumentFragment();

  for (let previewIndex = 0; previewIndex < previewCount; previewIndex += 1) {
    const resultPosition = state.searchPreviewResultPositions[previewIndex];
    const messageIndex = state.searchResults[resultPosition];
    const message = state.messages[messageIndex];

    if (!message) {
      continue;
    }

    const option = document.createElement("button");
    option.type = "button";
    option.role = "option";
    option.className = "search-suggestion";
    option.dataset.previewIndex = String(previewIndex);
    option.setAttribute(
      "aria-selected",
      String(previewIndex === state.activePreviewIndex),
    );

    if (previewIndex === state.activePreviewIndex) {
      option.classList.add("active");
    }

    const meta = document.createElement("div");
    meta.className = "search-suggestion-meta";

    const senderNode = document.createElement("span");
    senderNode.textContent = message.sender || `ID ${message.from}`;

    const timeNode = document.createElement("span");
    const timeLabel = Number.isFinite(message.timestamp)
      ? dateFormatter.format(message.timestamp)
      : "без времени";
    timeNode.textContent = `${timeLabel} · ${resultPosition + 1}/${state.searchResults.length}`;

    const textNode = document.createElement("div");
    textNode.className = "search-suggestion-text";

    const previewText = buildSearchPreview(
      String(message.text || ""),
      state.searchQuery,
    );
    appendHighlightedText(textNode, previewText, state.searchQuery);

    meta.append(senderNode, timeNode);
    option.append(meta, textNode);
    fragment.appendChild(option);
  }

  dom.searchSuggestions.replaceChildren(fragment);
  const activeOption = dom.searchSuggestions.querySelector(".search-suggestion.active");
  activeOption?.scrollIntoView({ block: "nearest" });
}

function moveSearchPreviewPointer(direction) {
  const length = state.searchPreviewResultPositions.length;
  if (!length) {
    return;
  }

  if (state.activePreviewIndex < 0) {
    state.activePreviewIndex = direction > 0 ? 0 : length - 1;
  } else {
    state.activePreviewIndex =
      (state.activePreviewIndex + direction + length) % length;
  }

  renderSearchSuggestions();
}

function selectSearchPreview(previewIndex) {
  if (
    previewIndex < 0 ||
    previewIndex >= state.searchPreviewResultPositions.length
  ) {
    return;
  }

  const resultPosition = state.searchPreviewResultPositions[previewIndex];
  if (!Number.isInteger(resultPosition)) {
    return;
  }

  const messageIndex = state.searchResults[resultPosition];
  if (!Number.isInteger(messageIndex)) {
    return;
  }

  state.activeSearchResult = resultPosition;
  syncActivePreviewWithSearchResult();
  updateSearchUi();
  scrollToMessageIndex(messageIndex);
  renderVisibleMessages(true);

  closeSearchSuggestions();
  dom.searchInput.focus({ preventScroll: true });
}

function syncActivePreviewWithSearchResult() {
  const previewCount = Math.min(
    MAX_SEARCH_PREVIEW_ITEMS,
    state.searchResults.length,
  );

  if (!previewCount) {
    state.activePreviewIndex = -1;
    return;
  }

  if (
    state.activeSearchResult < 0 ||
    state.activeSearchResult >= previewCount
  ) {
    state.activePreviewIndex = -1;
    return;
  }

  state.activePreviewIndex = state.activeSearchResult;
}

function buildSearchPreview(source, query) {
  const compactSource = source.replace(/\s+/g, " ").trim();
  if (!compactSource) {
    return "Сообщение без текста";
  }

  if (!query) {
    return truncateText(compactSource, 94);
  }

  const matchIndex = compactSource.toLowerCase().indexOf(query);
  if (matchIndex < 0) {
    return truncateText(compactSource, 94);
  }

  const contextRadius = 36;
  const start = Math.max(0, matchIndex - contextRadius);
  const end = Math.min(
    compactSource.length,
    matchIndex + query.length + contextRadius,
  );

  let snippet = compactSource.slice(start, end);
  if (start > 0) {
    snippet = `…${snippet}`;
  }
  if (end < compactSource.length) {
    snippet = `${snippet}…`;
  }

  return snippet;
}

function truncateText(source, maxLength) {
  if (source.length <= maxLength) {
    return source;
  }

  return `${source.slice(0, Math.max(0, maxLength - 1))}…`;
}

function updateSearchUi() {
  if (!state.messages.length) {
    closeSearchSuggestions();
    dom.searchStatus.textContent = "Поиск недоступен";
    dom.prevMatchBtn.disabled = true;
    dom.nextMatchBtn.disabled = true;
    return;
  }

  if (!state.searchQuery) {
    closeSearchSuggestions();
    dom.searchStatus.textContent = "Введите текст для поиска";
    dom.prevMatchBtn.disabled = true;
    dom.nextMatchBtn.disabled = true;
    return;
  }

  if (!state.searchResults.length) {
    closeSearchSuggestions();
    dom.searchStatus.textContent = "Совпадений не найдено";
    dom.prevMatchBtn.disabled = true;
    dom.nextMatchBtn.disabled = true;
    return;
  }

  dom.searchStatus.textContent = `${state.activeSearchResult + 1} из ${state.searchResults.length}`;
  dom.prevMatchBtn.disabled = false;
  dom.nextMatchBtn.disabled = false;
  renderSearchSuggestions();
}

function scrollToMessageIndex(index) {
  if (!state.tree || index < 0 || index >= state.messages.length) {
    return;
  }

  const viewportHeight = dom.chatViewport.clientHeight;
  const top = state.tree.sum(index);
  const messageHeight = state.rowHeights[index] || ESTIMATED_ROW_HEIGHT;
  const offset = (viewportHeight - messageHeight) * 0.5;

  dom.chatViewport.scrollTop = Math.max(0, top - offset);
}

function scrollToBottom() {
  if (!state.tree) {
    return;
  }

  const maxScroll = Math.max(0, state.tree.total() - dom.chatViewport.clientHeight);
  dom.chatViewport.scrollTop = maxScroll;
}

function isIndexInSearchResults(index) {
  const results = state.searchResults;
  let left = 0;
  let right = results.length - 1;

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const value = results[middle];

    if (value === index) {
      return true;
    }

    if (value < index) {
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }

  return false;
}

function appendHighlightedText(target, source, query) {
  if (!query) {
    target.textContent = source;
    return;
  }

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escapedQuery, "ig");
  let cursor = 0;
  let match = matcher.exec(source);

  while (match) {
    if (match.index > cursor) {
      target.append(source.slice(cursor, match.index));
    }

    const mark = document.createElement("mark");
    mark.textContent = match[0];
    target.appendChild(mark);

    cursor = match.index + match[0].length;

    if (match[0].length === 0) {
      matcher.lastIndex += 1;
    }

    match = matcher.exec(source);
  }

  if (cursor < source.length) {
    target.append(source.slice(cursor));
  }
}

function setStatus(text, progress) {
  dom.loadStatus.textContent = text;
  const width = `${Math.round(clampNumber(progress, 0, 1) * 100)}%`;
  dom.progressBar.style.width = width;
}

function setEmptyState(text) {
  dom.emptyState.textContent = text;
  dom.emptyState.style.display = "grid";
}

function clearEmptyState() {
  dom.emptyState.style.display = "none";
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(max, value));
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return String(error);
}
