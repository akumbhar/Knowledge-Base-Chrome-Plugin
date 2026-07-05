// KnowledgeBase Notes - popup dashboard logic
// Kept in its own file because MV3's default CSP blocks inline <script>.

const DEFAULT_TAGS = ["Interview Prep", "Reading Notes", "Research", "General"];
const NOTES_KEY = "notes";
const SETTINGS_KEY = "settings";
const CUSTOM_TAGS_KEY = "customTags";
const DIGESTS_KEY = "digests";
const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

const state = {
  notes: [],
  customTags: [],
  digests: {},
  activeTag: "All",
  query: "",
  showDigest: true,
};

const els = {
  list: document.getElementById("list"),
  filters: document.getElementById("filters"),
  search: document.getElementById("search"),
  settings: document.getElementById("settings"),
  settingsBtn: document.getElementById("settingsBtn"),
  syncBtn: document.getElementById("syncBtn"),
  restoreBtn: document.getElementById("restoreBtn"),
  summarizeBtn: document.getElementById("summarizeBtn"),
  digest: document.getElementById("digest"),
  provider: document.getElementById("provider"),
  baseUrl: document.getElementById("baseUrl"),
  model: document.getElementById("model"),
  localFields: document.getElementById("localFields"),
  modelFields: document.getElementById("modelFields"),
  claudeFields: document.getElementById("claudeFields"),
  openaiFields: document.getElementById("openaiFields"),
  apiKey: document.getElementById("apiKey"),
  openaiApiKey: document.getElementById("openaiApiKey"),
  baseUrlLabel: document.getElementById("baseUrlLabel"),
  saveKey: document.getElementById("saveKey"),
  clearKey: document.getElementById("clearKey"),
  autoSync: document.getElementById("autoSync"),
  banner: document.getElementById("banner"),
};

init();

async function init() {
  await loadNotes();
  await loadCustomTags();
  await loadDigests();
  await loadSettings();
  buildFilters();
  render();
  renderDigest();
  updateSummarizeState();
  wireEvents();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[NOTES_KEY]) {
      state.notes = changes[NOTES_KEY].newValue || [];
      buildFilters();
      render();
    }
    if (changes[CUSTOM_TAGS_KEY]) {
      state.customTags = changes[CUSTOM_TAGS_KEY].newValue || [];
      buildFilters();
    }
    if (changes[DIGESTS_KEY]) {
      state.digests = changes[DIGESTS_KEY].newValue || {};
      renderDigest();
    }
  });
}

async function loadNotes() {
  const store = await chrome.storage.local.get(NOTES_KEY);
  state.notes = store[NOTES_KEY] || [];
}

async function loadCustomTags() {
  const store = await chrome.storage.local.get(CUSTOM_TAGS_KEY);
  state.customTags = store[CUSTOM_TAGS_KEY] || [];
}

async function loadDigests() {
  const store = await chrome.storage.local.get(DIGESTS_KEY);
  state.digests = store[DIGESTS_KEY] || {};
}

// Default tags + user-created tags + any tag already used by a note (deduped).
function allTags() {
  const set = new Set(DEFAULT_TAGS);
  state.customTags.forEach((t) => set.add(t));
  state.notes.forEach((n) => n.tag && set.add(n.tag));
  return Array.from(set);
}

async function loadSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  const s = store[SETTINGS_KEY] || {};
  const provider = s.provider || "local";
  els.provider.value = provider;
  els.baseUrl.value =
    s.baseUrl ||
    (provider === "ollama" ? DEFAULT_OLLAMA_URL : DEFAULT_BASE_URL);
  els.model.value = s.model || "";
  els.apiKey.value = s.claudeApiKey || "";
  els.openaiApiKey.value = s.openaiApiKey || "";
  els.autoSync.checked = !!s.autoSync;
  toggleProviderFields();
}

function toggleProviderFields() {
  const p = els.provider.value;
  if (els.localFields) els.localFields.style.display = p === "local" || p === "ollama" ? "" : "none";
  if (els.modelFields) els.modelFields.style.display = p === "claude" ? "none" : "";
  if (els.claudeFields) els.claudeFields.style.display = p === "claude" ? "" : "none";
  if (els.openaiFields) els.openaiFields.style.display = p === "openai" ? "" : "none";

  if (els.baseUrlLabel) {
    els.baseUrlLabel.textContent =
      p === "ollama" ? "Ollama Base URL" : "LM Studio Base URL";
  }
  if (els.baseUrl) {
    els.baseUrl.placeholder =
      p === "ollama" ? DEFAULT_OLLAMA_URL : DEFAULT_BASE_URL;
  }
  if (els.model) {
    els.model.placeholder =
      p === "openai"
        ? "gpt-4o-mini"
        : p === "ollama"
          ? "llama3.2 (or auto-detect)"
          : "auto-detect from /v1/models";
  }
}

function wireEvents() {
  els.settingsBtn.addEventListener("click", () => {
    els.settings.classList.toggle("open");
  });

  els.search.addEventListener("input", (e) => {
    state.query = e.target.value.toLowerCase().trim();
    render();
  });

  els.provider.addEventListener("change", () => {
    toggleProviderFields();
    saveSettings();
  });
  els.baseUrl.addEventListener("change", saveSettings);
  els.model.addEventListener("change", saveSettings);
  els.saveKey.addEventListener("click", saveSettings);
  els.autoSync.addEventListener("change", saveSettings);
  els.clearKey.addEventListener("click", () => {
    if (els.provider.value === "openai") {
      els.openaiApiKey.value = "";
    } else {
      els.apiKey.value = "";
    }
    saveSettings();
  });

  els.syncBtn.addEventListener("click", syncToGoogleSheets);
  if (els.restoreBtn) els.restoreBtn.addEventListener("click", restoreFromGoogleSheets);
  els.summarizeBtn.addEventListener("click", summarizeActiveTag);

  els.digest.addEventListener("click", (e) => {
    if (e.target.id === "digestClose") {
      state.showDigest = false;
      renderDigest();
    } else if (e.target.id === "digestRegen") {
      summarizeActiveTag();
    } else if (e.target.id === "digestClear") {
      clearActiveDigest();
    }
  });

  els.list.addEventListener("click", (e) => {
    const del = e.target.closest(".del");
    if (del) deleteNote(del.dataset.id);
  });
}

async function saveSettings() {
  const provider = els.provider.value;
  const defaultBase =
    provider === "ollama" ? DEFAULT_OLLAMA_URL : DEFAULT_BASE_URL;
  const settings = {
    provider,
    baseUrl: els.baseUrl.value.trim() || defaultBase,
    model: els.model.value.trim(),
    claudeApiKey: els.apiKey.value.trim(),
    openaiApiKey: els.openaiApiKey.value.trim(),
    autoSync: els.autoSync.checked,
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  showBanner("Settings saved", "ok");
}

async function deleteNote(id) {
  const note = state.notes.find((n) => n.id === id);
  state.notes = state.notes.filter((n) => n.id !== id);
  await chrome.storage.local.set({ [NOTES_KEY]: state.notes });
  render();

  // If this note was synced to Google Sheets, remove its row there too.
  if (note && note.exported && note.spreadsheetId) {
    showBanner("Removing from Google Sheets\u2026", "ok");
    chrome.runtime.sendMessage(
      { type: "DELETE_ROW", note: { spreadsheetId: note.spreadsheetId, tag: note.tag, id: note.id } },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          const err =
            (resp && resp.error) ||
            (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
            "unknown error";
          showBanner("Sheet delete failed: " + err, "err");
        } else if (resp.deleted) {
          showBanner("Removed from Google Sheets", "ok");
        }
      }
    );
  }
}

function updateSummarizeState() {
  const isAll = (state.activeTag || "All") === "All";
  els.summarizeBtn.disabled = isAll;
  els.summarizeBtn.title = isAll
    ? "Select a tag to summarize"
    : "AI summary of the selected tag";
}

function summarizeActiveTag() {
  const key = state.activeTag || "All";
  if (key === "All") return; // summarization disabled for the All tab
  state.showDigest = true;
  els.digest.className = "digest show";
  els.digest.innerHTML = `<div class="digest-loading">Summarizing ${escapeHtml(key)}\u2026</div>`;
  showBanner(`Summarizing ${key}\u2026`, "ok");

  chrome.runtime.sendMessage({ type: "SUMMARIZE_TAG", tag: state.activeTag }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      const err =
        (resp && resp.error) ||
        (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        "unknown error";
      showBanner("Summarize failed: " + err, "err");
      els.digest.innerHTML = `<div class="digest-loading">Could not summarize.<br>${escapeHtml(err)}</div>`;
      return;
    }
    if (resp.digest && resp.digest.empty) {
      showBanner("No notes to summarize here", "ok");
      state.showDigest = false;
      renderDigest();
      return;
    }
    state.digests[key] = resp.digest;
    renderDigest();
    showBanner("Summary ready", "ok");
  });
}

function renderDigest() {
  const key = state.activeTag || "All";
  const d = state.digests[key];
  if (key === "All" || !state.showDigest || !d || !d.markdown) {
    els.digest.className = "digest";
    els.digest.innerHTML = "";
    return;
  }
  const when = new Date(d.createdAt).toLocaleString();
  els.digest.className = "digest show";
  els.digest.innerHTML = `
    <div class="digest-head">
      <div class="digest-title">Summary &middot; ${escapeHtml(key)}
        <span class="digest-meta">${d.count} note(s) &middot; ${escapeHtml(when)}</span>
      </div>
      <div class="digest-actions">
        <button class="digest-btn" id="digestRegen">Regenerate</button>
        <button class="digest-btn" id="digestClear" title="Delete this saved summary">Clear</button>
        <button class="digest-btn" id="digestClose" title="Hide (keeps the saved summary)">Close</button>
      </div>
    </div>
    <div class="md digest-body">${renderMarkdown(d.markdown)}</div>`;
}

// Permanently remove the saved AI summary for the active tag from storage.
async function clearActiveDigest() {
  const key = state.activeTag || "All";
  if (!state.digests[key]) return;
  delete state.digests[key];
  await chrome.storage.local.set({ [DIGESTS_KEY]: state.digests });
  state.showDigest = false;
  renderDigest();
  showBanner("Summary cleared", "ok");
}

function syncToGoogleSheets() {
  showBanner("Syncing to Google Sheets\u2026", "ok");
  chrome.runtime.sendMessage({ type: "SYNC_GDOCS" }, (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      const err = (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || "unknown error";
      showBanner("Sync failed: " + err, "err");
      return;
    }
    const hadErrors = resp.errors && resp.errors.length;
    if (resp.total === 0) {
      showBanner("No notes to sync", "ok");
    } else if (!resp.appended && !resp.removed) {
      showBanner("Already in sync", hadErrors ? "err" : "ok");
    } else {
      showBanner(`Synced: ${resp.appended} added, ${resp.removed} removed`, hadErrors ? "err" : "ok");
    }
  });
}

function restoreFromGoogleSheets() {
  showBanner("Restoring from Google Sheets\u2026", "ok");
  chrome.runtime.sendMessage({ type: "RESTORE_GDOCS" }, async (resp) => {
    if (chrome.runtime.lastError || !resp || !resp.ok) {
      const err =
        (resp && resp.error) ||
        (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
        "unknown error";
      showBanner("Restore failed: " + err, "err");
      return;
    }
    if (resp.imported === 0) {
      if (resp.skipped > 0) {
        showBanner(`Nothing to restore — ${resp.skipped} already local`, "ok");
      } else {
        showBanner("Nothing to restore — already up to date", "ok");
      }
      return;
    }
    let msg = `Restored ${resp.imported} note(s)`;
    if (resp.skipped > 0) msg += ` (${resp.skipped} already local)`;
    showBanner(msg, "ok");
    await loadNotes();
    buildFilters();
    render();
  });
}

function buildFilters() {
  const all = ["All", ...allTags()];
  els.filters.innerHTML = "";
  all.forEach((tag) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (tag === state.activeTag ? " active" : "");
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      state.activeTag = tag;
      state.showDigest = true;
      buildFilters();
      render();
      renderDigest();
      updateSummarizeState();
    });
    els.filters.appendChild(chip);
  });
}

function render() {
  const filtered = state.notes.filter((n) => {
    if (state.activeTag !== "All" && n.tag !== state.activeTag) return false;
    if (!state.query) return true;
    const hay = `${n.aiTitle} ${n.aiSummary} ${n.text} ${n.title} ${n.tag}`.toLowerCase();
    return hay.includes(state.query);
  });

  if (filtered.length === 0) {
    els.list.innerHTML = `
      <div class="empty">
        <div class="big">\u{1F4DA}</div>
        <p>${state.notes.length === 0
          ? "No notes yet.<br>Select text on any page, right-click, and choose <b>Save to Knowledge Base</b>."
          : "No notes match this filter."}</p>
      </div>`;
    return;
  }

  els.list.innerHTML = filtered.map(renderNote).join("");
}

function renderNote(n) {
  const date = new Date(n.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const src = n.url
    ? `<a class="src" href="${escapeAttr(n.url)}" target="_blank" rel="noopener" title="${escapeAttr(n.title || n.url)}">${escapeHtml(n.title || n.url)}</a>`
    : `<span class="src" style="color:#94a3b8">${date}</span>`;
  return `
    <div class="note">
      <div class="note-head">
        <div class="note-title">${escapeHtml(n.aiTitle || "Untitled")}</div>
        <div class="note-head-meta">
          ${n.exported ? '<span class="synced" title="Synced to Google Sheets">\u2713 synced</span>' : ""}
          <span class="badge">${escapeHtml(n.tag)}</span>
        </div>
      </div>
      ${n.aiSummary ? `<div class="note-summary md">${renderMarkdown(n.aiSummary)}</div>` : ""}
      <div class="note-text">${escapeHtml(n.text)}</div>
      <div class="note-foot">
        ${src}
        <button class="del" data-id="${escapeAttr(n.id)}" title="Delete">\u{1F5D1}</button>
      </div>
    </div>`;
}

let bannerTimer = null;
function showBanner(msg, kind) {
  els.banner.textContent = msg;
  els.banner.className = `banner show ${kind}`;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => {
    els.banner.className = "banner";
  }, 3200);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// Minimal, safe markdown -> HTML. Input is HTML-escaped first, then a small
// subset is converted, so untrusted note text can never inject markup.
function renderMarkdown(md) {
  if (!md) return "";
  const lines = escapeHtml(md).split(/\r?\n/);
  let html = "";
  let listType = null; // "ul" | "ol"
  let inCode = false;
  let codeBuf = [];
  let para = [];

  const flushPara = () => {
    if (para.length) {
      html += `<p>${inlineMarkdown(para.join(" "))}</p>`;
      para = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
        codeBuf = [];
        inCode = false;
      } else {
        flushPara();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length + 2, 6); // downshift so h1 -> h3
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
      continue;
    }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        html += "<ul>";
        listType = "ul";
      }
      html += `<li>${inlineMarkdown(ul[1])}</li>`;
      continue;
    }

    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        html += "<ol>";
        listType = "ol";
      }
      html += `<li>${inlineMarkdown(ol[1])}</li>`;
      continue;
    }

    closeList();
    para.push(line.trim());
  }

  if (inCode) html += `<pre><code>${codeBuf.join("\n")}</code></pre>`;
  flushPara();
  closeList();
  return html;
}

function inlineMarkdown(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>'
    );
}
