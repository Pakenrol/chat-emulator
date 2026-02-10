const ESTIMATED_ROW_HEIGHT = 78;
const OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 160;
const SEARCH_SUGGESTIONS_OVERSCAN = 8;

const dom = {
  fileInput: document.querySelector("#fileInput"),
  loadSampleBtn: document.querySelector("#loadSampleBtn"),
  progressBar: document.querySelector("#progressBar"),
  loadStatus: document.querySelector("#loadStatus"),
  chatMeta: document.querySelector("#chatMeta"),
  searchSection: document.querySelector(".search"),
  searchInput: document.querySelector("#searchInput"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  searchSuggestionsCanvas: document.querySelector("#searchSuggestionsCanvas"),
  searchStatus: document.querySelector("#searchStatus"),
  prevMatchBtn: document.querySelector("#prevMatchBtn"),
  nextMatchBtn: document.querySelector("#nextMatchBtn"),
  scrollToTopBtn: document.querySelector("#scrollToTopBtn"),
  scrollToBottomBtn: document.querySelector("#scrollToBottomBtn"),
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
  previewCursor: -1,
  highlightQuery: "",
  highlightMatcher: null,
  searchSuggestionsVisible: false,
  suggestionsRenderedStart: -1,
  suggestionsRenderedEnd: -1,
  suggestionsRenderQueued: false,
  suggestionsForceNextRender: false,
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
    const target = event.target;
    if (target instanceof Element && target.closest(".search-suggestion")) {
      event.preventDefault();
    }
  });

  dom.searchSuggestions.addEventListener(
    "scroll",
    () => {
      scheduleSearchSuggestionsRender();
    },
    { passive: true },
  );

  dom.searchSuggestions.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const option = target.closest(".search-suggestion");
    if (!option) {
      return;
    }

    const resultPosition = Number(option.dataset.resultPosition);
    if (Number.isInteger(resultPosition)) {
      selectSearchResultPosition(resultPosition);
    }
  });

  dom.prevMatchBtn.addEventListener("click", () => moveMatchPointer(-1));
  dom.nextMatchBtn.addEventListener("click", () => moveMatchPointer(1));

  dom.scrollToTopBtn.addEventListener("click", () => jumpToTop());
  dom.scrollToBottomBtn.addEventListener("click", () => jumpToBottom());

  dom.chatViewport.addEventListener("scroll", () => {
    renderVisibleMessages();
    updateScrollNavButtons();
  });

  window.addEventListener("resize", () => {
    renderVisibleMessages(true);
    updateScrollNavButtons();
    if (state.searchSuggestionsVisible) {
      state.suggestionsRenderedStart = -1;
      state.suggestionsRenderedEnd = -1;
      scheduleSearchSuggestionsRender(true);
    }
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
  state.previewCursor = -1;
  state.highlightQuery = "";
  state.highlightMatcher = null;
  state.searchSuggestionsVisible = false;
  state.suggestionsRenderedStart = -1;
  state.suggestionsRenderedEnd = -1;
  state.suggestionsRenderQueued = false;
  state.suggestionsForceNextRender = false;
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

  // Open at the beginning by default; navigation buttons allow jumping to the end.
  dom.chatViewport.scrollTop = 0;
  renderVisibleMessages(true);
  updateScrollNavButtons();
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
  state.previewCursor = -1;
  state.highlightQuery = "";
  state.highlightMatcher = null;
  state.searchSuggestionsVisible = false;
  state.suggestionsRenderedStart = -1;
  state.suggestionsRenderedEnd = -1;
  state.suggestionsRenderQueued = false;
  state.suggestionsForceNextRender = false;
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
  dom.searchSuggestionsCanvas.style.height = "0px";
  dom.searchSuggestionsCanvas.replaceChildren();

  dom.scrollToTopBtn.disabled = true;
  dom.scrollToBottomBtn.disabled = true;
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

function syncChatCanvasHeight() {
  if (!state.tree) {
    return;
  }

  const viewportHeight = dom.chatViewport.clientHeight || 1;
  const totalHeight = Math.max(state.tree.total(), viewportHeight);
  dom.chatCanvas.style.height = `${Math.ceil(totalHeight)}px`;
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
    state.previewCursor = -1;
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
  state.previewCursor = state.activeSearchResult;
  state.previousSearchQuery = state.searchQuery;

  if (!nextResults.length) {
    closeSearchSuggestions();
  } else if (state.searchSuggestionsVisible) {
    ensurePreviewCursorVisible();
    scheduleSearchSuggestionsRender(true);
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
  state.previewCursor = state.activeSearchResult;

  updateSearchUi();

  const messageIndex = state.searchResults[state.activeSearchResult];
  scrollToMessageIndex(messageIndex);
  renderVisibleMessages(true);

  if (state.searchSuggestionsVisible) {
    ensurePreviewCursorVisible();
    scheduleSearchSuggestionsRender(true);
  }
}

function handleSearchInputKeydown(event) {
  if (event.key === "Escape") {
    closeSearchSuggestions();
    return;
  }

  const isNavigationKey =
    event.key === "ArrowDown" ||
    event.key === "ArrowUp" ||
    event.key === "PageDown" ||
    event.key === "PageUp";

  if (isNavigationKey && !state.searchSuggestionsVisible) {
    openSearchSuggestions();
  }

  if (!state.searchSuggestionsVisible || !state.searchResults.length) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    movePreviewCursor(1);
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    movePreviewCursor(-1);
    return;
  }

  if (event.key === "PageDown") {
    event.preventDefault();
    movePreviewCursor(getSuggestionsPageJump());
    return;
  }

  if (event.key === "PageUp") {
    event.preventDefault();
    movePreviewCursor(-getSuggestionsPageJump());
    return;
  }

  if (event.key === "Enter") {
    if (state.previewCursor < 0) {
      return;
    }

    event.preventDefault();
    selectSearchResultPosition(state.previewCursor);
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
  state.suggestionsRenderedStart = -1;
  state.suggestionsRenderedEnd = -1;
  state.suggestionsForceNextRender = true;

  if (!Number.isInteger(state.previewCursor) || state.previewCursor < 0) {
    state.previewCursor = state.activeSearchResult >= 0 ? state.activeSearchResult : 0;
  }

  if (state.previewCursor >= state.searchResults.length) {
    state.previewCursor = state.searchResults.length - 1;
  }

  dom.searchSuggestions.hidden = false;
  dom.searchInput.setAttribute("aria-expanded", "true");

  // First render expands the list, so centering math uses real dimensions.
  renderSearchSuggestions(true);
  ensurePreviewCursorVisible(true);
  scheduleSearchSuggestionsRender(true);
}

function closeSearchSuggestions() {
  state.searchSuggestionsVisible = false;
  state.suggestionsRenderedStart = -1;
  state.suggestionsRenderedEnd = -1;
  state.suggestionsForceNextRender = false;
  dom.searchSuggestions.hidden = true;
  dom.searchSuggestionsCanvas.style.height = "0px";
  dom.searchSuggestionsCanvas.replaceChildren();
  dom.searchInput.setAttribute("aria-expanded", "false");
}

function scheduleSearchSuggestionsRender(force = false) {
  if (!state.searchSuggestionsVisible) {
    return;
  }

  if (force) {
    state.suggestionsForceNextRender = true;
  }

  if (state.suggestionsRenderQueued) {
    return;
  }

  state.suggestionsRenderQueued = true;

  requestAnimationFrame(() => {
    state.suggestionsRenderQueued = false;
    const shouldForce = state.suggestionsForceNextRender;
    state.suggestionsForceNextRender = false;
    renderSearchSuggestions(shouldForce);
  });
}

function renderSearchSuggestions(force = false) {
  if (!state.searchSuggestionsVisible) {
    return;
  }

  if (!state.searchQuery || !state.searchResults.length) {
    closeSearchSuggestions();
    return;
  }

  const rowHeight = getSearchSuggestionRowHeight();
  const viewportHeight = dom.searchSuggestions.clientHeight || 1;
  const scrollTop = dom.searchSuggestions.scrollTop;
  const paddingTop = getSearchSuggestionsPaddingTop();
  const effectiveScrollTop = Math.max(0, scrollTop - paddingTop);
  const totalHeight = Math.max(state.searchResults.length * rowHeight, viewportHeight);

  dom.searchSuggestionsCanvas.style.height = `${Math.ceil(totalHeight)}px`;

  const start = Math.max(
    0,
    Math.floor(effectiveScrollTop / rowHeight) - SEARCH_SUGGESTIONS_OVERSCAN,
  );
  const end = Math.min(
    state.searchResults.length - 1,
    Math.floor((effectiveScrollTop + viewportHeight) / rowHeight) + SEARCH_SUGGESTIONS_OVERSCAN,
  );

  if (!force && start === state.suggestionsRenderedStart && end === state.suggestionsRenderedEnd) {
    return;
  }

  state.suggestionsRenderedStart = start;
  state.suggestionsRenderedEnd = end;

  const fragment = document.createDocumentFragment();

  for (let resultPosition = start; resultPosition <= end; resultPosition += 1) {
    const messageIndex = state.searchResults[resultPosition];
    const message = state.messages[messageIndex];

    if (!message) {
      continue;
    }

    const option = document.createElement("button");
    option.type = "button";
    option.role = "option";
    option.className = "search-suggestion";
    option.dataset.resultPosition = String(resultPosition);
    option.style.top = `${Math.round(resultPosition * rowHeight)}px`;

    const isActive = resultPosition === state.previewCursor;
    option.setAttribute("aria-selected", String(isActive));

    if (isActive) {
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

  dom.searchSuggestionsCanvas.replaceChildren(fragment);
}

function movePreviewCursor(direction) {
  const length = state.searchResults.length;
  if (!length) {
    return;
  }

  if (!Number.isInteger(state.previewCursor) || state.previewCursor < 0) {
    state.previewCursor = 0;
  }

  state.previewCursor = Math.max(0, Math.min(length - 1, state.previewCursor + direction));
  ensurePreviewCursorVisible();
  scheduleSearchSuggestionsRender(true);
}

function getSuggestionsPageJump() {
  const rowHeight = getSearchSuggestionRowHeight();
  const viewportHeight = dom.searchSuggestions.clientHeight || rowHeight;
  return Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
}

function ensurePreviewCursorVisible(center = false) {
  if (!state.searchSuggestionsVisible) {
    return;
  }

  const length = state.searchResults.length;
  if (state.previewCursor < 0 || state.previewCursor >= length) {
    return;
  }

  const rowHeight = getSearchSuggestionRowHeight();
  const viewportHeight = dom.searchSuggestions.clientHeight || 1;
  const maxScrollTop = Math.max(
    0,
    dom.searchSuggestions.scrollHeight - viewportHeight,
  );
  const paddingTop = getSearchSuggestionsPaddingTop();
  const itemTop = paddingTop + state.previewCursor * rowHeight;

  if (center) {
    dom.searchSuggestions.scrollTop = clampNumber(
      itemTop - (viewportHeight - rowHeight) * 0.35,
      0,
      maxScrollTop,
    );
    return;
  }

  const scrollTop = dom.searchSuggestions.scrollTop;
  const itemBottom = itemTop + rowHeight;
  const viewportBottom = scrollTop + viewportHeight;

  if (itemTop < scrollTop) {
    dom.searchSuggestions.scrollTop = clampNumber(itemTop, 0, maxScrollTop);
    return;
  }

  if (itemBottom > viewportBottom) {
    dom.searchSuggestions.scrollTop = clampNumber(itemBottom - viewportHeight, 0, maxScrollTop);
  }
}

function selectSearchResultPosition(resultPosition) {
  if (
    resultPosition < 0 ||
    resultPosition >= state.searchResults.length
  ) {
    return;
  }

  const messageIndex = state.searchResults[resultPosition];
  if (!Number.isInteger(messageIndex)) {
    return;
  }

  state.activeSearchResult = resultPosition;
  state.previewCursor = resultPosition;
  updateSearchUi();
  scrollToMessageIndex(messageIndex);
  renderVisibleMessages(true);

  closeSearchSuggestions();
  dom.searchInput.focus({ preventScroll: true });
}

function getSearchSuggestionRowHeight() {
  const rawValue = getComputedStyle(document.documentElement)
    .getPropertyValue("--search-suggestion-row-height")
    .trim();
  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed) || parsed <= 10) {
    return 70;
  }

  return parsed;
}

function getSearchSuggestionsPaddingTop() {
  const rawValue = getComputedStyle(dom.searchSuggestions).paddingTop;
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : 0;
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

function jumpToTop() {
  if (!state.tree) {
    return;
  }

  dom.chatViewport.scrollTop = 0;
  renderVisibleMessages(true);
  updateScrollNavButtons();
}

function jumpToBottom() {
  if (!state.tree) {
    return;
  }

  syncChatCanvasHeight();
  scrollToBottom();
  renderVisibleMessages(true);
  updateScrollNavButtons();
}

function updateScrollNavButtons() {
  if (!dom.scrollToTopBtn || !dom.scrollToBottomBtn) {
    return;
  }

  if (!state.messages.length || !state.tree) {
    dom.scrollToTopBtn.disabled = true;
    dom.scrollToBottomBtn.disabled = true;
    return;
  }

  const scrollTop = dom.chatViewport.scrollTop;
  const viewportHeight = dom.chatViewport.clientHeight || 1;
  const maxScrollTop = Math.max(0, dom.chatViewport.scrollHeight - viewportHeight);
  const epsilon = 2;

  dom.scrollToTopBtn.disabled = scrollTop <= epsilon;
  dom.scrollToBottomBtn.disabled = scrollTop >= maxScrollTop - epsilon;
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

function getHighlightMatcher(query) {
  if (!query) {
    state.highlightQuery = "";
    state.highlightMatcher = null;
    return null;
  }

  if (state.highlightMatcher && state.highlightQuery === query) {
    return state.highlightMatcher;
  }

  state.highlightQuery = query;
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  state.highlightMatcher = new RegExp(escapedQuery, "ig");
  return state.highlightMatcher;
}

function appendHighlightedText(target, source, query) {
  if (!query) {
    target.textContent = source;
    return;
  }

  const matcher = getHighlightMatcher(query);
  if (!matcher) {
    target.textContent = source;
    return;
  }

  target.textContent = "";
  matcher.lastIndex = 0;
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
