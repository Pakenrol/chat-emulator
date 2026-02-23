const ESTIMATED_ROW_HEIGHT = 78;
const OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 160;
const SEARCH_SUGGESTIONS_OVERSCAN = 8;
const JUMP_FOCUS_TIMEOUT_MS = 1900;
const ATTACHMENTS_RENDER_CHUNK_SIZE = 40;
const ATTACHMENTS_INITIAL_BATCH_SIZE = 60;
const ATTACHMENTS_LOAD_AHEAD_PX = 500;
const ATTACHMENTS_END_TELEPORT_WINDOW = 160;
const ATTACHMENTS_PREPEND_CHUNK_SIZE = 80;

const ATTACHMENT_TYPE_LABELS = {
  image: "Фото",
  video: "Видео",
  audio: "Аудио",
  document: "Документ",
  link: "Ссылка",
};

const ATTACHMENT_TYPE_BADGES = {
  image: "IMG",
  video: "VID",
  audio: "AUD",
  document: "DOC",
  link: "URL",
};

const dom = {
  fileInput: document.querySelector("#fileInput"),
  folderInput: document.querySelector("#folderInput"),
  progressBar: document.querySelector("#progressBar"),
  loadStatus: document.querySelector("#loadStatus"),
  chatMeta: document.querySelector("#chatMeta"),
  searchSection: document.querySelector(".search"),
  searchInput: document.querySelector("#searchInput"),
  searchModeToggle: document.querySelector("#searchModeToggle"),
  searchSuggestions: document.querySelector("#searchSuggestions"),
  searchSuggestionsCanvas: document.querySelector("#searchSuggestionsCanvas"),
  searchStatus: document.querySelector("#searchStatus"),
  prevMatchBtn: document.querySelector("#prevMatchBtn"),
  nextMatchBtn: document.querySelector("#nextMatchBtn"),
  openAttachmentsBtn: document.querySelector("#openAttachmentsBtn"),
  scrollToTopBtn: document.querySelector("#scrollToTopBtn"),
  scrollToBottomBtn: document.querySelector("#scrollToBottomBtn"),
  chatViewport: document.querySelector("#chatViewport"),
  chatCanvas: document.querySelector("#chatCanvas"),
  emptyState: document.querySelector("#emptyState"),
  attachmentsPanel: document.querySelector("#attachmentsPanel"),
  closeAttachmentsBtn: document.querySelector("#closeAttachmentsBtn"),
  attachmentsCount: document.querySelector("#attachmentsCount"),
  attachmentsMediaOnlyToggle: document.querySelector("#attachmentsMediaOnlyToggle"),
  attachmentsScrollTopBtn: document.querySelector("#attachmentsScrollTopBtn"),
  attachmentsScrollBottomBtn: document.querySelector("#attachmentsScrollBottomBtn"),
  attachmentsList: document.querySelector("#attachmentsList"),
  mediaViewer: document.querySelector("#mediaViewer"),
  closeMediaViewerBtn: document.querySelector("#closeMediaViewerBtn"),
  mediaViewerPrevBtn: document.querySelector("#mediaViewerPrevBtn"),
  mediaViewerNextBtn: document.querySelector("#mediaViewerNextBtn"),
  mediaViewerJumpBtn: document.querySelector("#mediaViewerJumpBtn"),
  mediaViewerLabel: document.querySelector("#mediaViewerLabel"),
  mediaViewerOpenOriginal: document.querySelector("#mediaViewerOpenOriginal"),
  mediaViewerStage: document.querySelector("#mediaViewerStage"),
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
  pinToBottom: false,
  programmaticScroll: false,
  searchSuggestionsVisible: false,
  suggestionsRenderedStart: -1,
  suggestionsRenderedEnd: -1,
  suggestionsRenderQueued: false,
  suggestionsForceNextRender: false,
  searchQuery: "",
  previousSearchQuery: "",
  searchFuzzyMode: false,
  previousSearchFuzzyMode: false,
  rowHeights: [],
  tree: null,
  renderedStart: -1,
  renderedEnd: -1,
  measureQueued: false,
  rightSideId: null,
  searchDebounceId: null,
  assetFiles: null,
  assetUrlCache: null,
  attachmentsIndex: [],
  attachmentsViewIndex: [],
  attachmentsById: new Map(),
  attachmentsMediaOnly: true,
  attachmentsRenderToken: 0,
  attachmentsRenderItems: [],
  attachmentsRenderedCount: 0,
  attachmentsRenderQueued: false,
  attachmentsRenderStartIndex: 0,
  attachmentsListStartIndex: 0,
  attachmentsListScrollTop: 0,
  attachmentsListRestoreTarget: 0,
  attachmentsListRestorePending: false,
  attachmentsLastJumpedId: null,
  attachmentsPendingRevealId: null,
  selectedAttachmentId: null,
  attachmentsOpen: false,
  jumpFocusIndex: -1,
  jumpFocusTimeoutId: null,
  mediaViewerOpen: false,
  mediaViewerType: "",
  mediaViewerUrl: "",
  mediaViewerPoster: "",
  mediaViewerTitle: "",
  mediaViewerAttachmentId: null,
  mediaAttachments: [],
  mediaAttachmentPosById: new Map(),
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
setEmptyState("Загрузите JSON или папку с HTML, чтобы увидеть переписку.");

function attachEvents() {
  dom.fileInput.addEventListener("change", (event) => {
    const [file] = event.target.files || [];
    if (file) {
      beginLoad(file);
    }
    event.target.value = "";
  });

  dom.folderInput?.addEventListener("change", (event) => {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      beginLoadDirectory(files);
    }
    event.target.value = "";
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
  dom.searchModeToggle?.addEventListener("click", () => {
    setSearchMode(!state.searchFuzzyMode);
  });

  dom.openAttachmentsBtn?.addEventListener("click", () => {
    openAttachmentsPanel();
  });
  dom.closeAttachmentsBtn?.addEventListener("click", () => {
    closeAttachmentsPanel();
  });

  dom.attachmentsPanel?.addEventListener("click", (event) => {
    if (event.target === dom.attachmentsPanel) {
      closeAttachmentsPanel();
    }
  });

  dom.attachmentsList?.addEventListener("click", handleAttachmentListClick);
  dom.attachmentsList?.addEventListener(
    "scroll",
    () => {
      if (!state.attachmentsListRestorePending) {
        state.attachmentsListScrollTop = dom.attachmentsList?.scrollTop ?? state.attachmentsListScrollTop;
      }
      maybeAppendAttachmentCards();
    },
    { passive: true },
  );
  dom.attachmentsMediaOnlyToggle?.addEventListener("change", handleAttachmentsMediaOnlyToggle);
  dom.attachmentsScrollTopBtn?.addEventListener("click", () => {
    scrollAttachmentsListToTop();
  });
  dom.attachmentsScrollBottomBtn?.addEventListener("click", () => {
    scrollAttachmentsListToBottom();
  });
  dom.chatCanvas.addEventListener("click", handleChatMediaClick);

  dom.mediaViewer?.addEventListener("click", (event) => {
    if (event.target === dom.mediaViewer) {
      closeMediaViewer();
    }
  });
  dom.mediaViewerPrevBtn?.addEventListener("click", () => {
    stepMediaViewer(-1);
  });
  dom.mediaViewerNextBtn?.addEventListener("click", () => {
    stepMediaViewer(1);
  });
  dom.mediaViewerJumpBtn?.addEventListener("click", () => {
    jumpFromMediaViewerToMessage();
  });
  dom.closeMediaViewerBtn?.addEventListener("click", () => {
    closeMediaViewer();
  });

  dom.scrollToTopBtn.addEventListener("click", () => jumpToTop());
  dom.scrollToBottomBtn.addEventListener("click", () => jumpToBottom());

  dom.chatViewport.addEventListener("scroll", () => {
    renderVisibleMessages();
    updateScrollNavButtons();

    if (
      state.pinToBottom &&
      !state.programmaticScroll &&
      !isChatNearBottom()
    ) {
      state.pinToBottom = false;
    }
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

    if (state.mediaViewerOpen && dom.mediaViewer?.contains(target)) {
      return;
    }

    if (state.attachmentsOpen && dom.attachmentsPanel?.contains(target)) {
      return;
    }

    if (!dom.searchSection?.contains(target)) {
      closeSearchSuggestions();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (state.mediaViewerOpen && event.key === "ArrowLeft") {
      event.preventDefault();
      stepMediaViewer(-1);
      return;
    }

    if (state.mediaViewerOpen && event.key === "ArrowRight") {
      event.preventDefault();
      stepMediaViewer(1);
      return;
    }

    if (event.key !== "Escape") {
      return;
    }

    if (state.mediaViewerOpen) {
      event.preventDefault();
      closeMediaViewer();
      return;
    }

    if (state.attachmentsOpen) {
      event.preventDefault();
      closeAttachmentsPanel();
    }
  });

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  document.addEventListener("drop", (event) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) {
      return;
    }

    const htmlFiles = files.filter((file) => /\.html?$/i.test(file.name));
    if (htmlFiles.length > 1) {
      beginLoadDirectory(files);
      return;
    }

    const [file] = files;
    if (file) {
      beginLoad(file);
    }
  });

  updateSearchModeToggleUi();
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

function beginLoadDirectory(files) {
  resetConversationState();
  state.loading = true;
  dom.searchInput.disabled = true;
  dom.searchInput.value = "";
  dom.searchStatus.textContent = "Идёт загрузка папки...";

  const rootLabel = inferDirectoryLabel(files);
  setStatus(`Чтение папки: ${rootLabel}`, 0.05);
  setEmptyState("Идёт обработка HTML‑истории...");

  const { entries, assetFiles } = prepareDirectoryEntries(files);
  state.assetFiles = assetFiles;
  state.assetUrlCache = new Map();

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
      setEmptyState("Не удалось разобрать папку.");
      return;
    }

    if (payload.type === "ready") {
      hydrateConversation(payload);
    }
  };

  worker.postMessage({ type: "parse-html-directory", entries });
}

function handleProgress(payload) {
  const progress = clampNumber(payload.progress, 0, 1);
  const format = String(payload.format || "");
  const parsingLabel = format === "html" ? "Парсинг HTML" : "Парсинг JSON";
  const phaseMap = {
    scanning: "Сканирование",
    reading: "Чтение",
    parsing: parsingLabel,
    normalizing: "Подготовка сообщений",
    sorting: "Сортировка",
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
  state.searchCorpus = state.messages.map((message) => {
    const corpusSource = message?.searchText ?? message?.text ?? "";
    return String(corpusSource).toLowerCase();
  });
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
  state.previousSearchFuzzyMode = state.searchFuzzyMode;
  state.jumpFocusIndex = -1;

  const { items: attachmentItems, byId: attachmentsById } = buildAttachmentsIndex(state.messages);
  const { items: mediaItems, positionById: mediaPositionById } =
    buildMediaAttachmentsIndex(attachmentItems);
  state.attachmentsIndex = attachmentItems;
  state.attachmentsViewIndex = attachmentItems;
  state.attachmentsById = attachmentsById;
  state.mediaAttachments = mediaItems;
  state.mediaAttachmentPosById = mediaPositionById;
  state.attachmentsMediaOnly = true;
  state.attachmentsRenderToken = 0;
  state.attachmentsRenderItems = [];
  state.attachmentsRenderedCount = 0;
  state.attachmentsRenderQueued = false;
  state.attachmentsRenderStartIndex = 0;
  state.attachmentsListStartIndex = 0;
  state.attachmentsListScrollTop = 0;
  state.attachmentsListRestoreTarget = 0;
  state.attachmentsListRestorePending = false;
  state.attachmentsLastJumpedId = null;
  state.attachmentsPendingRevealId = null;
  state.selectedAttachmentId = attachmentItems[0]?.id ?? null;
  state.mediaViewerAttachmentId = null;
  if (dom.attachmentsMediaOnlyToggle) {
    dom.attachmentsMediaOnlyToggle.checked = true;
  }

  if (!state.messages.length) {
    setStatus("Источник загружен, но сообщений не найдено.", 1);
    dom.searchStatus.textContent = "Совпадений: 0";
    dom.chatMeta.textContent = "Нет сообщений в загруженном источнике";
    updateAttachmentsUi();
    setEmptyState("В источнике нет сообщений.");
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
      String(profile.id),
      profile.name,
    ]),
  );

  const participantNames = participants
    .slice(0, 2)
    .map((id) => profileMap.get(String(id)) || `ID ${id}`)
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
  updateSearchModeToggleUi();
  closeSearchSuggestions();
  updateAttachmentsUi();

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

  if (state.jumpFocusTimeoutId) {
    clearTimeout(state.jumpFocusTimeoutId);
    state.jumpFocusTimeoutId = null;
  }

  if (state.assetUrlCache instanceof Map) {
    for (const url of state.assetUrlCache.values()) {
      if (typeof url === "string" && url.startsWith("blob:")) {
        URL.revokeObjectURL(url);
      }
    }
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
  state.previousSearchFuzzyMode = state.searchFuzzyMode;
  state.rowHeights = [];
  state.tree = null;
  state.renderedStart = -1;
  state.renderedEnd = -1;
  state.measureQueued = false;
  state.rightSideId = null;
  state.assetFiles = null;
  state.assetUrlCache = null;
  state.attachmentsIndex = [];
  state.attachmentsViewIndex = [];
  state.attachmentsById = new Map();
  state.attachmentsMediaOnly = true;
  state.attachmentsRenderToken = 0;
  state.attachmentsRenderItems = [];
  state.attachmentsRenderedCount = 0;
  state.attachmentsRenderQueued = false;
  state.attachmentsRenderStartIndex = 0;
  state.attachmentsListStartIndex = 0;
  state.attachmentsListScrollTop = 0;
  state.attachmentsListRestoreTarget = 0;
  state.attachmentsListRestorePending = false;
  state.attachmentsLastJumpedId = null;
  state.attachmentsPendingRevealId = null;
  state.selectedAttachmentId = null;
  state.attachmentsOpen = false;
  state.jumpFocusIndex = -1;
  state.mediaViewerOpen = false;
  state.mediaViewerType = "";
  state.mediaViewerUrl = "";
  state.mediaViewerPoster = "";
  state.mediaViewerTitle = "";
  state.mediaViewerAttachmentId = null;
  state.mediaAttachments = [];
  state.mediaAttachmentPosById = new Map();

  dom.chatCanvas.replaceChildren();
  dom.searchInput.disabled = true;
  dom.searchInput.setAttribute("aria-expanded", "false");
  dom.prevMatchBtn.disabled = true;
  dom.nextMatchBtn.disabled = true;
  dom.searchSuggestions.hidden = true;
  dom.searchSuggestionsCanvas.style.height = "0px";
  dom.searchSuggestionsCanvas.replaceChildren();
  updateSearchModeToggleUi();

  dom.scrollToTopBtn.disabled = true;
  dom.scrollToBottomBtn.disabled = true;
  if (dom.attachmentsMediaOnlyToggle) {
    dom.attachmentsMediaOnlyToggle.checked = true;
    dom.attachmentsMediaOnlyToggle.disabled = true;
  }
  if (dom.attachmentsScrollTopBtn) {
    dom.attachmentsScrollTopBtn.disabled = true;
  }
  if (dom.attachmentsScrollBottomBtn) {
    dom.attachmentsScrollBottomBtn.disabled = true;
  }

  closeAttachmentsPanel({ restoreFocus: false });
  closeMediaViewer({ restoreFocus: false });
  updateAttachmentsUi();
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

    if (index === state.jumpFocusIndex) {
      row.classList.add("jump-focus");
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

    bubble.append(meta);

    const displayText = String(message.text || "");
    if (displayText) {
      const text = document.createElement("div");
      text.className = "message-text";
      appendHighlightedText(text, displayText, state.searchQuery);
      bubble.appendChild(text);
    }

    const attachments = Array.isArray(message.attachments)
      ? message.attachments
      : [];
    if (attachments.length) {
      bubble.appendChild(renderAttachments(attachments));
    }

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

    const shouldPinBottom = state.pinToBottom || isChatNearBottom();
    const scrollTopBefore = dom.chatViewport.scrollTop;
    const anchorIndex = state.tree.lowerBound(scrollTopBefore);
    let deltaBeforeAnchor = 0;
    let changed = false;

    for (const row of dom.chatCanvas.children) {
      const index = Number(row.dataset.index);
      if (!Number.isInteger(index) || index < 0 || index >= state.rowHeights.length) {
        continue;
      }

      const measuredHeight = Math.max(44, Math.ceil(row.getBoundingClientRect().height));
      const previousHeight = state.rowHeights[index] || ESTIMATED_ROW_HEIGHT;
      const delta = measuredHeight - previousHeight;

      if (Math.abs(delta) > 1) {
        state.rowHeights[index] = measuredHeight;
        state.tree.update(index, delta);
        if (!shouldPinBottom && index < anchorIndex) {
          deltaBeforeAnchor += delta;
        }
        changed = true;
      }
    }

    if (changed) {
      if (shouldPinBottom) {
        scrollToBottom(true);
      } else {
        syncChatCanvasHeight();
        if (Math.abs(deltaBeforeAnchor) > 0.5) {
          const maxScrollTop = Math.max(
            0,
            dom.chatViewport.scrollHeight - (dom.chatViewport.clientHeight || 1),
          );
          const targetScrollTop = clampNumber(scrollTopBefore + deltaBeforeAnchor, 0, maxScrollTop);
          setChatScrollTop(targetScrollTop);
        }
      }

      renderVisibleMessages(true);
      updateScrollNavButtons();
    }
  });
}

function updateSearchModeToggleUi() {
  if (!(dom.searchModeToggle instanceof HTMLButtonElement)) {
    return;
  }

  dom.searchModeToggle.textContent = state.searchFuzzyMode ? "Fuzzy: вкл" : "Fuzzy: выкл";
  dom.searchModeToggle.setAttribute("aria-pressed", state.searchFuzzyMode ? "true" : "false");
  dom.searchModeToggle.disabled = !state.messages.length || dom.searchInput.disabled;
}

function setSearchMode(nextFuzzyMode) {
  const enabled = Boolean(nextFuzzyMode);
  if (state.searchFuzzyMode === enabled) {
    return;
  }

  state.searchFuzzyMode = enabled;
  state.previousSearchQuery = "";
  state.previousSearchFuzzyMode = enabled;
  updateSearchModeToggleUi();

  if (!state.messages.length) {
    return;
  }

  if (state.searchDebounceId) {
    clearTimeout(state.searchDebounceId);
    state.searchDebounceId = null;
  }

  runSearch(dom.searchInput.value);
  openSearchSuggestions();
}

function scoreFuzzySubsequence(source, query) {
  if (!query) {
    return Number.NEGATIVE_INFINITY;
  }

  if (query.length <= 1) {
    return source.includes(query) ? 1 : Number.NEGATIVE_INFINITY;
  }

  let queryPos = 0;
  let score = 0;
  let streak = 0;
  let firstMatch = -1;
  let lastMatch = -1;

  for (let index = 0; index < source.length && queryPos < query.length; index += 1) {
    const char = source.charAt(index);
    if (char === query.charAt(queryPos)) {
      if (firstMatch < 0) {
        firstMatch = index;
      }
      lastMatch = index;
      queryPos += 1;
      streak += 1;
      score += 10 + Math.min(streak, 6) * 2;
      if (index === 0 || /[^a-z0-9а-яё]/i.test(source.charAt(index - 1))) {
        score += 4;
      }
    } else {
      streak = 0;
    }
  }

  if (queryPos !== query.length) {
    return Number.NEGATIVE_INFINITY;
  }

  const span = Math.max(1, lastMatch - firstMatch + 1);
  score += Math.max(0, 50 - span);
  score -= Math.floor(Math.max(0, firstMatch) / 40);
  return score;
}

function runSearch(rawQuery) {
  state.searchQuery = String(rawQuery || "").trim().toLowerCase();

  if (!state.searchQuery) {
    state.searchResults = [];
    state.activeSearchResult = -1;
    state.previewCursor = -1;
    state.previousSearchQuery = "";
    state.previousSearchFuzzyMode = state.searchFuzzyMode;
    closeSearchSuggestions();
    updateSearchUi();
    renderVisibleMessages(true);
    return;
  }

  const useFuzzy = state.searchFuzzyMode;
  const canReusePreviousPool =
    state.previousSearchQuery &&
    state.searchQuery.startsWith(state.previousSearchQuery) &&
    state.previousSearchFuzzyMode === useFuzzy;
  const pool = canReusePreviousPool ? state.searchResults : state.allIndexes;

  let nextResults = [];
  if (useFuzzy) {
    const ranked = [];
    for (const index of pool) {
      const score = scoreFuzzySubsequence(state.searchCorpus[index], state.searchQuery);
      if (Number.isFinite(score)) {
        ranked.push({ index, score });
      }
    }
    ranked.sort((left, right) => right.score - left.score || left.index - right.index);
    nextResults = ranked.map((entry) => entry.index);
  } else {
    const exactMatches = [];
    for (const index of pool) {
      if (state.searchCorpus[index].includes(state.searchQuery)) {
        exactMatches.push(index);
      }
    }
    nextResults = exactMatches;
  }

  state.searchResults = nextResults;
  state.activeSearchResult = nextResults.length ? 0 : -1;
  state.previewCursor = state.activeSearchResult;
  state.previousSearchQuery = state.searchQuery;
  state.previousSearchFuzzyMode = useFuzzy;

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

  state.pinToBottom = false;
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

    const previewSource = String(message.searchText ?? message.text ?? "");
    const previewText = buildSearchPreview(
      previewSource,
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

  state.pinToBottom = false;
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
  updateSearchModeToggleUi();

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

  state.pinToBottom = false;
  const viewportHeight = dom.chatViewport.clientHeight;
  const top = state.tree.sum(index);
  const messageHeight = state.rowHeights[index] || ESTIMATED_ROW_HEIGHT;
  const offset = (viewportHeight - messageHeight) * 0.5;

  setChatScrollTop(Math.max(0, top - offset));
}

function setChatScrollTop(value) {
  state.programmaticScroll = true;
  dom.chatViewport.scrollTop = value;
  requestAnimationFrame(() => {
    state.programmaticScroll = false;
  });
}

function isChatNearBottom(epsilon = 2) {
  const viewportHeight = dom.chatViewport.clientHeight || 1;
  const maxScrollTop = Math.max(0, dom.chatViewport.scrollHeight - viewportHeight);
  return dom.chatViewport.scrollTop >= maxScrollTop - epsilon;
}

function scrollToBottom(syncCanvas = false) {
  if (!state.tree) {
    return;
  }

  if (syncCanvas) {
    syncChatCanvasHeight();
    // Force layout so scrollHeight reflects updated canvas height.
    void dom.chatViewport.scrollHeight;
  }

  const maxScroll = Math.max(0, dom.chatViewport.scrollHeight - dom.chatViewport.clientHeight);
  setChatScrollTop(maxScroll);
}

function jumpToTop() {
  if (!state.tree) {
    return;
  }

  state.pinToBottom = false;
  setChatScrollTop(0);
  renderVisibleMessages(true);
  updateScrollNavButtons();
}

function jumpToBottom() {
  if (!state.tree) {
    return;
  }

  state.pinToBottom = true;
  scrollToBottom(true);
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

function buildAttachmentsIndex(messages) {
  const items = [];
  const byId = new Map();
  let nextId = 1;

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.length) {
      continue;
    }

    for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex += 1) {
      const attachment = attachments[attachmentIndex] || {};
      const type = normalizeAttachmentType(attachment.type);
      const title = String(attachment.title || "").trim();
      const url = String(attachment.url || "").trim();
      const thumbUrl = String(attachment.thumbUrl || "").trim();

      if (!url && !thumbUrl) {
        continue;
      }

      if (isStickerLikeAttachment(type, url, thumbUrl, title)) {
        continue;
      }

      const item = {
        id: nextId,
        type,
        title,
        url,
        thumbUrl,
        messageIndex,
        messageId: message?.id ?? null,
        messagePreview: truncateText(
          String(message?.text || message?.searchText || "").replace(/\s+/g, " ").trim(),
          136,
        ),
        sender: message?.sender || `ID ${message?.from ?? "?"}`,
        timestamp: message?.timestamp ?? null,
      };

      if (attachment && typeof attachment === "object") {
        try {
          attachment.__attachmentId = nextId;
        } catch {
          // Ignore immutable objects; viewer navigation will fallback to URL matching.
        }
      }

      items.push(item);
      byId.set(nextId, item);
      nextId += 1;
    }
  }

  return { items, byId };
}

function buildMediaAttachmentsIndex(items) {
  const mediaItems = [];
  const positionById = new Map();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isPrimaryMediaAttachment(item?.type)) {
      continue;
    }

    positionById.set(item.id, mediaItems.length);
    mediaItems.push(item);
  }

  return {
    items: mediaItems,
    positionById,
  };
}

function normalizeAttachmentType(type) {
  const normalized = String(type || "").trim().toLowerCase();

  if (
    normalized === "image" ||
    normalized === "video" ||
    normalized === "audio" ||
    normalized === "document" ||
    normalized === "link"
  ) {
    return normalized;
  }

  return "link";
}

function getAttachmentTypeLabel(type) {
  return ATTACHMENT_TYPE_LABELS[normalizeAttachmentType(type)] || "Файл";
}

function formatTimestamp(value) {
  return Number.isFinite(value) ? dateFormatter.format(value) : "без времени";
}

function isStickerLikeAttachment(type, url, thumbUrl, title) {
  if (normalizeAttachmentType(type) !== "image") {
    return false;
  }

  const source = `${String(url || "")}\n${String(thumbUrl || "")}\n${String(title || "")}`.toLowerCase();
  if (!source) {
    return false;
  }

  return /\bsticker(s)?\b/.test(source) || /\/sticker(?:s|pack)?(?:\/|$|\?|#)/.test(source);
}

function isPrimaryMediaAttachment(type) {
  const normalized = normalizeAttachmentType(type);
  return normalized === "image" || normalized === "video";
}

function handleAttachmentsMediaOnlyToggle() {
  state.attachmentsMediaOnly = Boolean(dom.attachmentsMediaOnlyToggle?.checked);
  updateAttachmentsUi();
}

function rebuildAttachmentsViewIndex() {
  if (!state.attachmentsMediaOnly) {
    state.attachmentsViewIndex = state.attachmentsIndex;
    return;
  }

  const filtered = [];
  for (const item of state.attachmentsIndex) {
    if (isPrimaryMediaAttachment(item.type)) {
      filtered.push(item);
    }
  }
  state.attachmentsViewIndex = filtered;
}

function getVisibleAttachments() {
  return Array.isArray(state.attachmentsViewIndex) ? state.attachmentsViewIndex : [];
}

function getVisibleAttachmentIndexById(attachmentId) {
  const parsedId = Number(attachmentId);
  if (!Number.isInteger(parsedId)) {
    return -1;
  }

  const visibleItems = getVisibleAttachments();
  for (let index = 0; index < visibleItems.length; index += 1) {
    if (visibleItems[index]?.id === parsedId) {
      return index;
    }
  }

  return -1;
}

function tryApplyLastJumpedAttachmentAnchor() {
  const anchorId = Number(state.attachmentsLastJumpedId);
  if (!Number.isInteger(anchorId)) {
    state.attachmentsPendingRevealId = null;
    return false;
  }

  const visibleIndex = getVisibleAttachmentIndexById(anchorId);
  if (visibleIndex < 0) {
    state.attachmentsPendingRevealId = null;
    return false;
  }

  state.selectedAttachmentId = anchorId;
  const anchorWindowOffset = Math.floor(ATTACHMENTS_END_TELEPORT_WINDOW / 2);
  state.attachmentsListStartIndex = Math.max(0, visibleIndex - anchorWindowOffset);
  state.attachmentsListScrollTop = 0;
  state.attachmentsListRestoreTarget = 0;
  state.attachmentsListRestorePending = false;
  state.attachmentsPendingRevealId = anchorId;
  return true;
}

function ensureSelectedAttachmentVisible() {
  const visibleItems = getVisibleAttachments();
  if (!visibleItems.length) {
    state.selectedAttachmentId = null;
    return;
  }

  const selectedId = Number(state.selectedAttachmentId);
  if (Number.isInteger(selectedId)) {
    for (const item of visibleItems) {
      if (item.id === selectedId) {
        return;
      }
    }
  }

  state.selectedAttachmentId = visibleItems[0]?.id ?? null;
}

function updateAttachmentsUi() {
  const totalCount = state.attachmentsIndex.length;
  rebuildAttachmentsViewIndex();
  const visibleCount = getVisibleAttachments().length;

  if (dom.attachmentsMediaOnlyToggle) {
    dom.attachmentsMediaOnlyToggle.checked = state.attachmentsMediaOnly;
    dom.attachmentsMediaOnlyToggle.disabled = totalCount === 0;
  }
  if (dom.attachmentsScrollTopBtn) {
    dom.attachmentsScrollTopBtn.disabled = totalCount === 0;
  }
  if (dom.attachmentsScrollBottomBtn) {
    dom.attachmentsScrollBottomBtn.disabled = totalCount === 0;
  }

  if (dom.openAttachmentsBtn) {
    dom.openAttachmentsBtn.disabled = totalCount === 0;
    if (totalCount > 0 && state.attachmentsMediaOnly) {
      dom.openAttachmentsBtn.textContent =
        `Вложения (${visibleCount.toLocaleString("ru-RU")}/${totalCount.toLocaleString("ru-RU")})`;
    } else {
      dom.openAttachmentsBtn.textContent =
        totalCount > 0 ? `Вложения (${totalCount.toLocaleString("ru-RU")})` : "Вложения";
    }
  }

  if (dom.attachmentsCount) {
    if (totalCount === 0) {
      dom.attachmentsCount.textContent = "0 вложений";
    } else if (state.attachmentsMediaOnly) {
      dom.attachmentsCount.textContent =
        `${visibleCount.toLocaleString("ru-RU")} из ${totalCount.toLocaleString("ru-RU")} вложений`;
    } else {
      dom.attachmentsCount.textContent = `${totalCount.toLocaleString("ru-RU")} вложений`;
    }
  }

  if (!totalCount) {
    state.attachmentsRenderStartIndex = 0;
    state.attachmentsListStartIndex = 0;
    state.attachmentsListScrollTop = 0;
    state.attachmentsListRestoreTarget = 0;
    state.attachmentsListRestorePending = false;
    state.attachmentsPendingRevealId = null;
    state.selectedAttachmentId = null;
    renderAttachmentList();

    if (state.attachmentsOpen) {
      closeAttachmentsPanel({ restoreFocus: false });
    }

    return;
  }

  ensureSelectedAttachmentVisible();

  if (state.attachmentsOpen) {
    renderAttachmentsPanel();
  }
}

function openAttachmentsPanel() {
  if (!state.attachmentsIndex.length || !dom.attachmentsPanel) {
    return;
  }

  state.attachmentsOpen = true;
  closeSearchSuggestions();
  dom.attachmentsPanel.hidden = false;
  dom.attachmentsPanel.setAttribute("aria-hidden", "false");
  document.body.classList.add("attachments-open");

  ensureSelectedAttachmentVisible();

  renderAttachmentsPanel({ preserveScroll: false, preferLastJumpAnchor: true });
}

function closeAttachmentsPanel({ restoreFocus = true } = {}) {
  if (!dom.attachmentsPanel) {
    return;
  }

  if (state.attachmentsOpen && dom.attachmentsList) {
    state.attachmentsListScrollTop = dom.attachmentsList.scrollTop;
    state.attachmentsListStartIndex = state.attachmentsRenderStartIndex;
  }

  state.attachmentsRenderToken += 1;
  state.attachmentsRenderItems = [];
  state.attachmentsRenderedCount = 0;
  state.attachmentsRenderQueued = false;
  state.attachmentsRenderStartIndex = 0;
  state.attachmentsListRestoreTarget = 0;
  state.attachmentsListRestorePending = false;
  state.attachmentsOpen = false;
  dom.attachmentsPanel.hidden = true;
  dom.attachmentsPanel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("attachments-open");

  if (restoreFocus) {
    dom.openAttachmentsBtn?.focus({ preventScroll: true });
  }
}

function renderAttachmentsPanel({ preserveScroll = true, preferLastJumpAnchor = false } = {}) {
  ensureSelectedAttachmentVisible();
  let restoreScroll = state.attachmentsOpen;
  let startIndex = null;

  if (preferLastJumpAnchor && tryApplyLastJumpedAttachmentAnchor()) {
    restoreScroll = false;
    startIndex = state.attachmentsListStartIndex;
  }

  if (preserveScroll && dom.attachmentsList && !state.attachmentsListRestorePending) {
    state.attachmentsListScrollTop = dom.attachmentsList.scrollTop;
    state.attachmentsListStartIndex = state.attachmentsRenderStartIndex;
  }
  renderAttachmentList({ restoreScroll, startIndex });
}

function renderAttachmentList({ restoreScroll = false, startIndex = null } = {}) {
  if (!dom.attachmentsList) {
    return;
  }

  const items = getVisibleAttachments();
  const total = items.length;
  let normalizedStart = Number.isInteger(Number(startIndex)) ? Number(startIndex) : 0;
  if (!Number.isInteger(Number(startIndex)) && restoreScroll) {
    normalizedStart = Number(state.attachmentsListStartIndex) || 0;
  }
  normalizedStart = Math.max(0, Math.min(normalizedStart, Math.max(0, total - 1)));

  state.attachmentsRenderToken += 1;
  state.attachmentsRenderItems = items;
  state.attachmentsRenderStartIndex = normalizedStart;
  state.attachmentsRenderedCount = normalizedStart;
  state.attachmentsRenderQueued = false;
  state.attachmentsListStartIndex = normalizedStart;
  state.attachmentsListRestorePending = Boolean(restoreScroll && state.attachmentsOpen);
  state.attachmentsListRestoreTarget = state.attachmentsListRestorePending
    ? Math.max(0, Number(state.attachmentsListScrollTop) || 0)
    : 0;
  dom.attachmentsList.replaceChildren();
  dom.attachmentsList.scrollTop = 0;

  if (!items.length) {
    state.attachmentsRenderStartIndex = 0;
    state.attachmentsListStartIndex = 0;
    state.attachmentsListRestoreTarget = 0;
    state.attachmentsListRestorePending = false;
    state.attachmentsPendingRevealId = null;
    const empty = document.createElement("p");
    empty.className = "attachments-list-empty";
    empty.textContent =
      state.attachmentsIndex.length && state.attachmentsMediaOnly
        ? "По фильтру «Исключить лишнее» нет фото и видео."
        : "Во вложениях этого диалога ничего не найдено.";
    dom.attachmentsList.appendChild(empty);
    return;
  }

  appendAttachmentCardsBatch({ initial: true });
}

function maybeAppendAttachmentCards() {
  if (!dom.attachmentsList || state.attachmentsRenderQueued) {
    return;
  }

  if (
    state.attachmentsRenderStartIndex > 0 &&
    dom.attachmentsList.scrollTop <= ATTACHMENTS_LOAD_AHEAD_PX
  ) {
    prependAttachmentCardsBatch();
    return;
  }

  const remaining =
    dom.attachmentsList.scrollHeight -
    dom.attachmentsList.clientHeight -
    dom.attachmentsList.scrollTop;

  if (remaining <= ATTACHMENTS_LOAD_AHEAD_PX) {
    appendAttachmentCardsBatch();
  }
}

function prependAttachmentCardsBatch() {
  if (!dom.attachmentsList) {
    return;
  }

  const token = state.attachmentsRenderToken;
  const items = state.attachmentsRenderItems;
  const total = Array.isArray(items) ? items.length : 0;
  const currentStart = Math.max(0, Number(state.attachmentsRenderStartIndex) || 0);
  if (!total || currentStart <= 0) {
    return;
  }

  const nextStart = Math.max(0, currentStart - ATTACHMENTS_PREPEND_CHUNK_SIZE);
  const previousHeight = dom.attachmentsList.scrollHeight;
  const previousTop = dom.attachmentsList.scrollTop;

  const fragment = document.createDocumentFragment();
  let appendedSelected = false;
  const selectedId = Number(state.selectedAttachmentId);

  for (let index = nextStart; index < currentStart; index += 1) {
    const item = items[index];
    fragment.appendChild(createAttachmentListCard(item));
    if (Number.isInteger(selectedId) && item.id === selectedId) {
      appendedSelected = true;
    }
  }

  dom.attachmentsList.insertBefore(fragment, dom.attachmentsList.firstChild);
  state.attachmentsRenderStartIndex = nextStart;
  state.attachmentsListStartIndex = nextStart;

  const heightDelta = dom.attachmentsList.scrollHeight - previousHeight;
  dom.attachmentsList.scrollTop = previousTop + Math.max(0, heightDelta);
  state.attachmentsListScrollTop = dom.attachmentsList.scrollTop;

  if (appendedSelected) {
    syncAttachmentSelectionUi();
  }

  if (token !== state.attachmentsRenderToken) {
    return;
  }

  revealPendingAttachmentIfNeeded();
}

function scrollAttachmentsListToTop() {
  if (!dom.attachmentsList || !state.attachmentsOpen) {
    return;
  }

  state.attachmentsPendingRevealId = null;
  state.attachmentsListStartIndex = 0;
  state.attachmentsListScrollTop = 0;
  renderAttachmentList({ restoreScroll: false, startIndex: 0 });
  dom.attachmentsList.scrollTop = 0;
  state.attachmentsListScrollTop = 0;
}

function scrollAttachmentsListToBottom() {
  if (!dom.attachmentsList || !state.attachmentsOpen) {
    return;
  }

  const items = getVisibleAttachments();
  const total = items.length;
  if (!total) {
    return;
  }

  const startIndex = Math.max(0, total - ATTACHMENTS_END_TELEPORT_WINDOW);
  state.attachmentsPendingRevealId = null;
  state.selectedAttachmentId = items[total - 1]?.id ?? state.selectedAttachmentId;
  state.attachmentsListStartIndex = startIndex;
  state.attachmentsListScrollTop = 0;
  renderAttachmentList({ restoreScroll: false, startIndex });

  requestAnimationFrame(() => {
    if (!dom.attachmentsList || !state.attachmentsOpen) {
      return;
    }
    dom.attachmentsList.scrollTop = dom.attachmentsList.scrollHeight;
    state.attachmentsListScrollTop = dom.attachmentsList.scrollTop;
  });
}

function revealPendingAttachmentIfNeeded() {
  if (!dom.attachmentsList) {
    return;
  }

  const targetId = Number(state.attachmentsPendingRevealId);
  if (!Number.isInteger(targetId)) {
    return;
  }

  const targetCard = dom.attachmentsList.querySelector(
    `.attachments-item[data-attachment-id="${targetId}"]`,
  );
  if (!(targetCard instanceof HTMLElement)) {
    return;
  }

  targetCard.scrollIntoView({ block: "center", inline: "nearest" });
  state.attachmentsListScrollTop = dom.attachmentsList.scrollTop;
  state.attachmentsPendingRevealId = null;
}

function appendAttachmentCardsBatch({ initial = false } = {}) {
  if (!dom.attachmentsList) {
    return;
  }

  const token = state.attachmentsRenderToken;
  const items = state.attachmentsRenderItems;
  const total = Array.isArray(items) ? items.length : 0;
  const startIndex = Math.max(0, Number(state.attachmentsRenderStartIndex) || 0);
  const cursor = Math.max(startIndex, state.attachmentsRenderedCount);
  if (!total || cursor >= total) {
    return;
  }

  const batchSize =
    initial && startIndex > 0 ? ATTACHMENTS_END_TELEPORT_WINDOW : initial ? ATTACHMENTS_INITIAL_BATCH_SIZE : ATTACHMENTS_RENDER_CHUNK_SIZE;
  const limit = Math.min(total, cursor + batchSize);
  const selectedId = Number(state.selectedAttachmentId);

  const fragment = document.createDocumentFragment();
  let appendedSelected = false;

  for (let index = cursor; index < limit; index += 1) {
    const item = items[index];
    fragment.appendChild(createAttachmentListCard(item));
    if (Number.isInteger(selectedId) && item.id === selectedId) {
      appendedSelected = true;
    }
  }

  dom.attachmentsList.appendChild(fragment);
  state.attachmentsRenderedCount = limit;

  if (appendedSelected || limit >= total) {
    syncAttachmentSelectionUi();
  }

  revealPendingAttachmentIfNeeded();

  if (restoreAttachmentListScrollIfNeeded(token)) {
    return;
  }

  if (
    limit < total &&
    dom.attachmentsList.scrollHeight <= dom.attachmentsList.clientHeight + ATTACHMENTS_LOAD_AHEAD_PX
  ) {
    state.attachmentsRenderQueued = true;
    requestAnimationFrame(() => {
      state.attachmentsRenderQueued = false;
      if (token !== state.attachmentsRenderToken) {
        return;
      }
      appendAttachmentCardsBatch();
    });
  }
}

function restoreAttachmentListScrollIfNeeded(token) {
  if (!dom.attachmentsList || !state.attachmentsListRestorePending) {
    return false;
  }

  if (token !== state.attachmentsRenderToken) {
    return true;
  }

  const targetScrollTop = Math.max(0, Number(state.attachmentsListRestoreTarget) || 0);
  const maxScrollTop = Math.max(0, dom.attachmentsList.scrollHeight - dom.attachmentsList.clientHeight);
  const total = Array.isArray(state.attachmentsRenderItems) ? state.attachmentsRenderItems.length : 0;
  const renderedAll = state.attachmentsRenderedCount >= total;

  if (targetScrollTop <= 0 || maxScrollTop >= targetScrollTop || renderedAll) {
    dom.attachmentsList.scrollTop = Math.min(targetScrollTop, maxScrollTop);
    state.attachmentsListScrollTop = dom.attachmentsList.scrollTop;
    state.attachmentsListRestoreTarget = 0;
    state.attachmentsListRestorePending = false;
    maybeAppendAttachmentCards();
    return false;
  }

  if (state.attachmentsRenderQueued) {
    return true;
  }

  state.attachmentsRenderQueued = true;
  requestAnimationFrame(() => {
    state.attachmentsRenderQueued = false;
    if (token !== state.attachmentsRenderToken) {
      return;
    }
    appendAttachmentCardsBatch();
  });

  return true;
}

function createAttachmentListCard(item) {
  const card = document.createElement("article");
  card.className = "attachments-item";
  card.dataset.attachmentId = String(item.id);

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "attachments-item-open";
  openButton.dataset.action = "preview";
  openButton.dataset.attachmentId = String(item.id);

  const thumb = createAttachmentListThumb(item);
  const main = document.createElement("span");
  main.className = "attachments-item-main";

  const typeBadge = document.createElement("span");
  typeBadge.className = "attachments-item-type";
  typeBadge.textContent = getAttachmentTypeLabel(item.type);

  const title = document.createElement("span");
  title.className = "attachments-item-title";
  title.textContent = item.title || getAttachmentTypeLabel(item.type);

  main.append(typeBadge, title);
  openButton.append(thumb, main);

  const meta = document.createElement("p");
  meta.className = "attachments-item-meta";
  meta.textContent = `${item.sender} · ${formatTimestamp(item.timestamp)}`;

  const actions = document.createElement("div");
  actions.className = "attachments-item-actions";

  if (isPrimaryMediaAttachment(item.type)) {
    const openMediaButton = document.createElement("button");
    openMediaButton.type = "button";
    openMediaButton.className = "attachments-item-action";
    openMediaButton.textContent = "Открыть";
    openMediaButton.dataset.action = "open-media";
    openMediaButton.dataset.attachmentId = String(item.id);
    actions.appendChild(openMediaButton);
  }

  const jumpButton = document.createElement("button");
  jumpButton.type = "button";
  jumpButton.className = "attachments-item-action";
  jumpButton.textContent = "К сообщению";
  jumpButton.dataset.action = "jump";
  jumpButton.dataset.attachmentId = String(item.id);
  actions.appendChild(jumpButton);

  card.append(openButton, meta, actions);
  return card;
}

function syncAttachmentSelectionUi() {
  if (!dom.attachmentsList) {
    return;
  }

  const activeNode = dom.attachmentsList.querySelector(".attachments-item.active");
  if (activeNode instanceof HTMLElement) {
    activeNode.classList.remove("active");
    const button = activeNode.querySelector(".attachments-item-open");
    if (button instanceof HTMLButtonElement) {
      button.setAttribute("aria-pressed", "false");
    }
  }

  const selectedId = Number(state.selectedAttachmentId);
  if (!Number.isInteger(selectedId)) {
    return;
  }

  const nextActive = dom.attachmentsList.querySelector(
    `.attachments-item[data-attachment-id="${selectedId}"]`,
  );
  if (!(nextActive instanceof HTMLElement)) {
    return;
  }

  nextActive.classList.add("active");
  const openButton = nextActive.querySelector(".attachments-item-open");
  if (openButton instanceof HTMLButtonElement) {
    openButton.setAttribute("aria-pressed", "true");
  }
}

function createAttachmentListThumb(item) {
  const slot = document.createElement("span");
  slot.className = "attachments-item-thumb";

  if (item.type === "image" || item.type === "video") {
    const previewUrl = resolveMediaUrl(item.thumbUrl || item.url);
    if (!previewUrl) {
      const badge = document.createElement("span");
      badge.className = "attachments-item-thumb-badge";
      badge.textContent = ATTACHMENT_TYPE_BADGES[item.type] || "FILE";
      slot.appendChild(badge);
    } else {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = item.title || getAttachmentTypeLabel(item.type);
      img.src = previewUrl;
      slot.appendChild(img);
    }
  } else {
    const badge = document.createElement("span");
    badge.className = "attachments-item-thumb-badge";
    badge.textContent = ATTACHMENT_TYPE_BADGES[item.type] || "FILE";
    slot.appendChild(badge);
  }

  if (item.type === "video") {
    const videoBadge = document.createElement("span");
    videoBadge.className = "attachments-item-thumb-video";
    videoBadge.textContent = "VIDEO";
    slot.appendChild(videoBadge);
  }

  return slot;
}

function openAttachmentInViewer(attachmentId) {
  const item = findAttachmentItemById(attachmentId);
  if (!item || !isPrimaryMediaAttachment(item.type)) {
    return;
  }

  const mediaUrl = resolveMediaUrl(item.url || item.thumbUrl);
  if (!mediaUrl) {
    return;
  }

  const posterUrl = resolveMediaUrl(item.thumbUrl || "");
  openMediaViewer({
    type: item.type,
    url: mediaUrl,
    poster: posterUrl,
    title: item.title || getAttachmentTypeLabel(item.type),
    attachmentId: item.id,
  });
}

function detectPreviewType(type, url) {
  const normalizedType = normalizeAttachmentType(type);
  if (normalizedType === "image" || normalizedType === "video" || normalizedType === "audio") {
    return normalizedType;
  }

  const normalizedUrl = String(url || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/.test(normalizedUrl)) {
    return "image";
  }
  if (/\.(mp4|webm|m4v|mov|mkv)(?:$|[?#])/.test(normalizedUrl)) {
    return "video";
  }
  if (/\.(mp3|wav|ogg|m4a|aac|flac)(?:$|[?#])/.test(normalizedUrl)) {
    return "audio";
  }
  if (/\.pdf(?:$|[?#])/.test(normalizedUrl)) {
    return "pdf";
  }

  return normalizedType;
}

function findAttachmentItemById(id) {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || !(state.attachmentsById instanceof Map)) {
    return null;
  }

  return state.attachmentsById.get(parsed) || null;
}

function setSelectedAttachment(id) {
  const item = findAttachmentItemById(id);
  if (!item) {
    return false;
  }

  const visibleItems = getVisibleAttachments();
  if (visibleItems.length) {
    let isVisible = false;
    for (const visibleItem of visibleItems) {
      if (visibleItem.id === item.id) {
        isVisible = true;
        break;
      }
    }

    if (!isVisible) {
      return false;
    }
  }

  state.selectedAttachmentId = item.id;
  syncAttachmentSelectionUi();
  return true;
}

function handleAttachmentListClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const actionTarget = target.closest("[data-action][data-attachment-id]");
  if (!(actionTarget instanceof Element)) {
    return;
  }

  const attachmentId = Number(actionTarget.dataset.attachmentId);
  if (!Number.isInteger(attachmentId)) {
    return;
  }

  const action = String(actionTarget.dataset.action || "");
  if (action === "preview" || action === "open-media") {
    setSelectedAttachment(attachmentId);
    openAttachmentInViewer(attachmentId);
    return;
  }

  if (action === "jump") {
    jumpToAttachmentMessage(attachmentId);
  }
}

function jumpToAttachmentMessage(attachmentId) {
  const item = findAttachmentItemById(attachmentId);
  if (!item) {
    return;
  }

  state.attachmentsLastJumpedId = item.id;
  setSelectedAttachment(item.id);
  closeAttachmentsPanel({ restoreFocus: false });

  state.pinToBottom = false;
  state.jumpFocusIndex = item.messageIndex;

  if (state.jumpFocusTimeoutId) {
    clearTimeout(state.jumpFocusTimeoutId);
  }

  scrollToMessageIndex(item.messageIndex);
  renderVisibleMessages(true);
  updateScrollNavButtons();

  state.jumpFocusTimeoutId = setTimeout(() => {
    state.jumpFocusTimeoutId = null;
    state.jumpFocusIndex = -1;
    renderVisibleMessages(true);
  }, JUMP_FOCUS_TIMEOUT_MS);
}

function findMediaAttachmentByResolvedUrl(type, resolvedUrl) {
  if (!resolvedUrl || !Array.isArray(state.mediaAttachments) || !state.mediaAttachments.length) {
    return null;
  }

  const targetType = detectPreviewType(type, resolvedUrl);
  if (!isPrimaryMediaAttachment(targetType)) {
    return null;
  }

  for (const item of state.mediaAttachments) {
    const itemType = detectPreviewType(item.type, item.url || item.thumbUrl);
    if (itemType !== targetType) {
      continue;
    }

    const primaryUrl = resolveMediaUrl(item.url);
    if (primaryUrl && primaryUrl === resolvedUrl) {
      return item;
    }

    const fallbackUrl = resolveMediaUrl(item.thumbUrl || "");
    if (fallbackUrl && fallbackUrl === resolvedUrl) {
      return item;
    }
  }

  return null;
}

function updateMediaViewerNavButtons() {
  const prevBtn = dom.mediaViewerPrevBtn;
  const nextBtn = dom.mediaViewerNextBtn;
  if (!prevBtn || !nextBtn) {
    return;
  }

  const currentId = Number(state.mediaViewerAttachmentId);
  const positionMap = state.mediaAttachmentPosById;
  const mediaItems = Array.isArray(state.mediaAttachments) ? state.mediaAttachments : [];

  if (!Number.isInteger(currentId) || !(positionMap instanceof Map) || !mediaItems.length) {
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const position = positionMap.get(currentId);
  if (!Number.isInteger(position)) {
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  prevBtn.disabled = position <= 0;
  nextBtn.disabled = position >= mediaItems.length - 1;
}

function stepMediaViewer(direction) {
  if (!state.mediaViewerOpen) {
    return;
  }

  const directionSign = direction < 0 ? -1 : 1;
  const currentId = Number(state.mediaViewerAttachmentId);
  if (!Number.isInteger(currentId) || !(state.mediaAttachmentPosById instanceof Map)) {
    return;
  }

  const currentPosition = state.mediaAttachmentPosById.get(currentId);
  if (!Number.isInteger(currentPosition)) {
    return;
  }

  const nextPosition = currentPosition + directionSign;
  if (nextPosition < 0 || nextPosition >= state.mediaAttachments.length) {
    return;
  }

  const item = state.mediaAttachments[nextPosition];
  if (!item) {
    return;
  }

  openMediaViewer({
    type: item.type,
    url: item.url || item.thumbUrl,
    poster: item.thumbUrl || "",
    title: item.title || getAttachmentTypeLabel(item.type),
    attachmentId: item.id,
  });
}

function jumpFromMediaViewerToMessage() {
  const attachmentId = Number(state.mediaViewerAttachmentId);
  if (!Number.isInteger(attachmentId)) {
    return;
  }

  closeMediaViewer({ restoreFocus: false });
  jumpToAttachmentMessage(attachmentId);
}

function handleChatMediaClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const mediaTarget = target.closest("[data-media-open='true']");
  if (!(mediaTarget instanceof Element)) {
    return;
  }

  const mediaUrl = String(
    mediaTarget.getAttribute("data-media-url") || mediaTarget.getAttribute("href") || "",
  ).trim();
  if (!mediaUrl) {
    return;
  }
  const attachmentIdRaw = Number(mediaTarget.getAttribute("data-media-attachment-id"));
  const attachmentId = Number.isInteger(attachmentIdRaw) ? attachmentIdRaw : null;

  event.preventDefault();

  openMediaViewer({
    type: String(mediaTarget.getAttribute("data-media-type") || ""),
    url: mediaUrl,
    poster: String(mediaTarget.getAttribute("data-media-poster") || ""),
    title: String(mediaTarget.getAttribute("data-media-title") || "").trim(),
    attachmentId,
  });
}

function openMediaViewer({ type = "", url = "", poster = "", title = "", attachmentId = null } = {}) {
  if (!dom.mediaViewer || !dom.mediaViewerStage) {
    return;
  }

  const resolvedUrl = resolveMediaUrl(url);
  if (!resolvedUrl) {
    return;
  }

  const resolvedPoster = poster ? resolveMediaUrl(poster) : "";
  const resolvedType = detectPreviewType(type, resolvedUrl);
  let resolvedAttachmentId = Number(attachmentId);
  if (!Number.isInteger(resolvedAttachmentId)) {
    const matchedItem = findMediaAttachmentByResolvedUrl(resolvedType, resolvedUrl);
    resolvedAttachmentId = matchedItem?.id ?? null;
  }
  if (!Number.isInteger(resolvedAttachmentId)) {
    resolvedAttachmentId = null;
  }

  state.mediaViewerOpen = true;
  state.mediaViewerType = resolvedType;
  state.mediaViewerUrl = resolvedUrl;
  state.mediaViewerPoster = resolvedPoster;
  state.mediaViewerTitle = title || getAttachmentTypeLabel(resolvedType || type);
  state.mediaViewerAttachmentId = resolvedAttachmentId;

  dom.mediaViewer.hidden = false;
  dom.mediaViewer.setAttribute("aria-hidden", "false");
  document.body.classList.add("media-viewer-open");
  renderMediaViewerContent();
}

function closeMediaViewer({ restoreFocus = false } = {}) {
  if (!dom.mediaViewer || !dom.mediaViewerStage) {
    return;
  }

  state.mediaViewerOpen = false;
  state.mediaViewerType = "";
  state.mediaViewerUrl = "";
  state.mediaViewerPoster = "";
  state.mediaViewerTitle = "";
  state.mediaViewerAttachmentId = null;

  dom.mediaViewer.hidden = true;
  dom.mediaViewer.setAttribute("aria-hidden", "true");
  dom.mediaViewerStage.replaceChildren();
  document.body.classList.remove("media-viewer-open");

  if (restoreFocus) {
    dom.chatViewport.focus({ preventScroll: true });
  }
}

function renderMediaViewerContent() {
  if (!dom.mediaViewerStage || !dom.mediaViewerLabel || !dom.mediaViewerOpenOriginal) {
    return;
  }

  dom.mediaViewerStage.replaceChildren();

  const titleParts = [state.mediaViewerTitle || "Вложение"];
  if (state.mediaViewerType) {
    titleParts.push(getAttachmentTypeLabel(state.mediaViewerType));
  }
  dom.mediaViewerLabel.textContent = titleParts.join(" · ");

  if (state.mediaViewerUrl) {
    dom.mediaViewerOpenOriginal.href = state.mediaViewerUrl;
    dom.mediaViewerOpenOriginal.hidden = false;
  } else {
    dom.mediaViewerOpenOriginal.hidden = true;
    dom.mediaViewerOpenOriginal.removeAttribute("href");
  }

  if (dom.mediaViewerJumpBtn) {
    const linkedAttachmentId = Number(state.mediaViewerAttachmentId);
    const hasLinkedMessage = Number.isInteger(linkedAttachmentId);
    dom.mediaViewerJumpBtn.disabled = !hasLinkedMessage;
  }
  updateMediaViewerNavButtons();

  const type = state.mediaViewerType;
  const src = state.mediaViewerUrl;

  if (type === "image") {
    const image = document.createElement("img");
    image.src = src;
    image.alt = state.mediaViewerTitle || "Изображение";
    dom.mediaViewerStage.appendChild(image);
    return;
  }

  if (type === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = src;
    if (state.mediaViewerPoster) {
      video.poster = state.mediaViewerPoster;
    }
    dom.mediaViewerStage.appendChild(video);
    return;
  }

  const empty = document.createElement("p");
  empty.className = "media-viewer-empty";
  empty.textContent = "Для этого типа вложения встроенный просмотр недоступен.";
  dom.mediaViewerStage.appendChild(empty);
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

function inferDirectoryLabel(files) {
  const first = files.find((file) => typeof file?.webkitRelativePath === "string");
  const path = first?.webkitRelativePath || "";
  const firstSegment = path.split("/")[0];
  return firstSegment || "папка";
}

function prepareDirectoryEntries(files) {
  const firstPath = files.find((file) => typeof file?.webkitRelativePath === "string")
    ?.webkitRelativePath;
  const rootPrefix =
    typeof firstPath === "string" && firstPath.includes("/")
      ? `${firstPath.split("/")[0]}/`
      : "";

  const entries = [];
  const assetFiles = new Map();

  for (const file of files) {
    let relativePath = file.webkitRelativePath || file.name;
    if (rootPrefix && relativePath.startsWith(rootPrefix)) {
      relativePath = relativePath.slice(rootPrefix.length);
    }
    relativePath = normalizeRelPath(relativePath);

    entries.push({ file, relativePath });

    if (!/\.html?$/i.test(file.name)) {
      assetFiles.set(relativePath, file);
    }
  }

  return { entries, assetFiles };
}

function normalizeRelPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

function parseDimensionValue(raw) {
  const value = Number.parseInt(String(raw || "").trim(), 10);
  if (!Number.isFinite(value) || value < 16 || value > 16384) {
    return 0;
  }

  return value;
}

function parseDimensionToken(raw) {
  const match = String(raw || "").trim().match(/^(\d{2,5})[xX](\d{2,5})$/);
  if (!match) {
    return null;
  }

  const width = parseDimensionValue(match[1]);
  const height = parseDimensionValue(match[2]);
  if (!width || !height) {
    return null;
  }

  return { width, height };
}

function extractMediaDimensions(rawUrl) {
  const source = String(rawUrl || "").replace(/&amp;/g, "&").trim();
  if (!source) {
    return null;
  }

  try {
    const parsed = new URL(source, "https://chat-emulator.local");
    const sizeKeys = ["size", "dimensions", "dim", "resolution", "res"];

    for (const key of sizeKeys) {
      const dimensions = parseDimensionToken(parsed.searchParams.get(key));
      if (dimensions) {
        return dimensions;
      }
    }

    const width = parseDimensionValue(
      parsed.searchParams.get("w") || parsed.searchParams.get("width"),
    );
    const height = parseDimensionValue(
      parsed.searchParams.get("h") || parsed.searchParams.get("height"),
    );
    if (width && height) {
      return { width, height };
    }
  } catch {
    // Ignore malformed URLs and keep regex fallback below.
  }

  const inlineTokenMatch = source.match(
    /(?:^|[?&#/])(?:size|dimensions|dim|resolution|res)=([0-9]{2,5})x([0-9]{2,5})(?:$|[&#])/i,
  );
  if (!inlineTokenMatch) {
    return null;
  }

  const width = parseDimensionValue(inlineTokenMatch[1]);
  const height = parseDimensionValue(inlineTokenMatch[2]);
  if (!width || !height) {
    return null;
  }

  return { width, height };
}

function pickMediaDimensions(...candidates) {
  for (const candidate of candidates) {
    const dimensions = extractMediaDimensions(candidate);
    if (dimensions) {
      return dimensions;
    }
  }

  return null;
}

function applyMediaDimensions(node, ...candidates) {
  if (!(node instanceof HTMLElement)) {
    return null;
  }

  const dimensions = pickMediaDimensions(...candidates);
  if (!dimensions) {
    return null;
  }

  node.style.aspectRatio = `${dimensions.width} / ${dimensions.height}`;

  if (node instanceof HTMLImageElement) {
    node.width = dimensions.width;
    node.height = dimensions.height;
  }

  return dimensions;
}

function isProbablyAbsoluteUrl(value) {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function resolveMediaUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) {
    return "";
  }

  if (isProbablyAbsoluteUrl(url)) {
    return url;
  }

  const key = normalizeRelPath(url.split("#")[0].split("?")[0]);
  const file = state.assetFiles instanceof Map ? state.assetFiles.get(key) : null;
  if (!file) {
    return url;
  }

  if (!(state.assetUrlCache instanceof Map)) {
    state.assetUrlCache = new Map();
  }

  const cached = state.assetUrlCache.get(key);
  if (typeof cached === "string") {
    return cached;
  }

  const objectUrl = URL.createObjectURL(file);
  state.assetUrlCache.set(key, objectUrl);
  return objectUrl;
}

function renderAttachments(attachments) {
  const wrap = document.createElement("div");
  wrap.className = "message-attachments";

  for (const attachment of attachments) {
    const type = String(attachment?.type || "");
    const title = String(attachment?.title || "").trim();
    const attachmentIdRaw = Number(attachment?.__attachmentId);
    const attachmentId = Number.isInteger(attachmentIdRaw) ? attachmentIdRaw : null;

    if (type === "image") {
      const full = resolveMediaUrl(attachment.url);
      const thumb = resolveMediaUrl(attachment.thumbUrl || attachment.url);
      if (!full && !thumb) {
        continue;
      }

      const link = document.createElement("a");
      link.className = "attachment-link";
      link.href = full || thumb;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.dataset.mediaOpen = "true";
      link.dataset.mediaType = "image";
      link.dataset.mediaUrl = full || thumb;
      link.dataset.mediaPoster = "";
      link.dataset.mediaTitle = title || "Изображение";
      if (attachmentId !== null) {
        link.dataset.mediaAttachmentId = String(attachmentId);
      }

      const img = document.createElement("img");
      img.className = "attachment-image";
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = title || "Изображение";
      applyMediaDimensions(img, attachment.thumbUrl, attachment.url);
      img.src = thumb || full;
      img.addEventListener("load", () => scheduleMeasurement(), { once: true });

      link.appendChild(img);
      wrap.appendChild(link);
      continue;
    }

    if (type === "video") {
      const src = resolveMediaUrl(attachment.url);
      if (!src) {
        continue;
      }
      const poster = resolveMediaUrl(attachment.thumbUrl || "");

      const video = document.createElement("video");
      video.className = "attachment-video";
      video.controls = true;
      video.preload = "metadata";
      if (!applyMediaDimensions(video, attachment.url, attachment.thumbUrl)) {
        video.style.aspectRatio = "16 / 9";
      }
      video.src = src;
      if (poster) {
        video.poster = poster;
      }
      video.addEventListener("loadedmetadata", () => scheduleMeasurement(), { once: true });
      wrap.appendChild(video);

      const actions = document.createElement("div");
      actions.className = "attachment-media-actions";

      const openInlineButton = document.createElement("button");
      openInlineButton.type = "button";
      openInlineButton.className = "attachment-inline-open";
      openInlineButton.textContent = "Открыть в окне";
      openInlineButton.dataset.mediaOpen = "true";
      openInlineButton.dataset.mediaType = "video";
      openInlineButton.dataset.mediaUrl = src;
      openInlineButton.dataset.mediaPoster = poster || "";
      openInlineButton.dataset.mediaTitle = title || "Видео";
      if (attachmentId !== null) {
        openInlineButton.dataset.mediaAttachmentId = String(attachmentId);
      }
      actions.appendChild(openInlineButton);
      wrap.appendChild(actions);
      continue;
    }

    if (type === "audio") {
      const src = resolveMediaUrl(attachment.url);
      if (!src) {
        continue;
      }
      const audio = document.createElement("audio");
      audio.className = "attachment-audio";
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = src;
      audio.addEventListener("loadedmetadata", () => scheduleMeasurement(), { once: true });
      wrap.appendChild(audio);
      continue;
    }

    if (type === "link" || type === "document") {
      const href = resolveMediaUrl(attachment.url);
      if (!href) {
        continue;
      }
      const link = document.createElement("a");
      link.className = "attachment-file";
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = title || attachment.url || "Файл";
      wrap.appendChild(link);
      continue;
    }
  }

  return wrap;
}
