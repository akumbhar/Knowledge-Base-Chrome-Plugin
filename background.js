// Knowledge Base Notes - background service worker (MV3)
// Responsibilities:
//  - Register the "Save to Knowledge Base" context menu.
//  - Ask the content script to show the in-page tag picker for the selection.
//  - Summarize saved text via a configurable LLM provider (local LM Studio by
//    default, Claude optional) and persist to chrome.storage.local.
//  - Build on-demand per-tag markdown digests.
//  - Phase 2: sync to a single Google Sheet with one tab per tag (rows = notes)
//    via chrome.identity + the Google Sheets API.

const MENU_ID = "saveToKB";
const TAGS = ["Interview Prep", "Reading Notes", "Research", "General"];
const NOTES_KEY = "notes";
const SETTINGS_KEY = "settings"; // { provider, baseUrl, model, claudeApiKey, openaiApiKey, autoSync }
const SPREADSHEET_KEY = "spreadsheetId"; // the one Knowledge Base spreadsheet
const SHEET_TABS_KEY = "sheetTabs"; // string[] of tab titles known to exist
const CUSTOM_TAGS_KEY = "customTags"; // string[] of user-created tags
const DIGESTS_KEY = "digests"; // { [tagKey]: { markdown, createdAt, count } }
const SHEET_TITLE = "Knowledge Base";
// Note ID is kept in the last column so deletions can locate the right row.
const SHEET_HEADER = ["Date", "Title", "Summary", "Note", "Source", "Note ID"];
const SHEET_RANGE = "A:F";
const ID_COLUMN = "F";

// Google OAuth via launchWebAuthFlow (lets the user pick any account).
// This must be a "Web application" OAuth client whose authorized redirect URI
// is chrome.identity.getRedirectURL() -> https://<extension-id>.chromiumapp.org/
const WEB_CLIENT_ID = "585055013789-17sg7664d3oe3cum42k7o1476v2ijt49.apps.googleusercontent.com";
const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const GOOGLE_TOKEN_KEY = "googleToken"; // { accessToken, expiresAt }
const CLAUDE_MODEL = "claude-3-5-haiku-latest";
const OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_BASE_URL = "http://localhost:1234"; // LM Studio default
const DEFAULT_OLLAMA_URL = "http://localhost:11434"; // Ollama default

// ---------------------------------------------------------------------------
// Context menu setup
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Save to Knowledge Base",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id == null) return;
  const text = (info.selectionText || "").trim();
  if (!text) return;
  await showTagPicker(tab.id, text);
});

// Ask the content script to render the tag picker. If the content script is
// not present yet (page loaded before the extension), inject it and retry.
async function showTagPicker(tabId, text) {
  const message = { type: "SHOW_TAG_PICKER", text, tags: await getAllTags() };
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await chrome.tabs.sendMessage(tabId, message);
    } catch (injectErr) {
      console.warn("KnowledgeBase: could not show tag picker", injectErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "SAVE_NOTE") {
    handleSaveNote(msg.payload, sender)
      .then((note) => sendResponse({ ok: true, note }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg.type === "SYNC_GDOCS") {
    syncAllNotes()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg.type === "RESTORE_GDOCS") {
    restoreFromSheets()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg.type === "SUMMARIZE_TAG") {
    summarizeTag(msg.tag)
      .then((digest) => sendResponse({ ok: true, digest }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }

  if (msg.type === "DELETE_ROW") {
    deleteNoteRow(msg.note)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // async
  }
});

// ---------------------------------------------------------------------------
// Save flow
// ---------------------------------------------------------------------------
async function handleSaveNote(payload, sender) {
  const { text, tag } = payload;
  const pageUrl = payload.pageUrl || (sender.tab && sender.tab.url) || "";
  const pageTitle = payload.pageTitle || (sender.tab && sender.tab.title) || "";

  const settings = await getSettings();
  const ai = await processNote(text);

  const cleanTag = (tag || "").trim() || "General";

  const note = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    aiTitle: ai.title,
    aiSummary: ai.summary,
    tag: cleanTag,
    url: pageUrl,
    title: pageTitle,
    createdAt: new Date().toISOString(),
    exported: false,
  };

  await rememberCustomTag(cleanTag);

  const notes = await getNotes();
  notes.unshift(note);
  await chrome.storage.local.set({ [NOTES_KEY]: notes });

  // Optional auto-sync to Google Docs (non-interactive so it fails silently
  // if the user has not authorized yet).
  if (settings.autoSync) {
    try {
      await syncNote(note.id, false);
    } catch (e) {
      console.warn("KnowledgeBase: auto-sync skipped", e);
    }
  }

  return note;
}

// ---------------------------------------------------------------------------
// LLM provider layer. Supports LM Studio, Ollama (OpenAI-compatible local APIs),
// OpenAI, and Claude. callLLM returns the assistant text or throws so callers can fall back.
// ---------------------------------------------------------------------------
async function callLLM(system, user, maxTokens) {
  const settings = await getSettings();
  if (settings.provider === "claude") return callClaude(settings, system, user, maxTokens);
  if (settings.provider === "openai") return callOpenAI(settings, system, user, maxTokens);
  if (settings.provider === "ollama") {
    return callOpenAICompatible(settings, system, user, maxTokens, {
      defaultBaseUrl: DEFAULT_OLLAMA_URL,
      providerLabel: "Ollama",
      missingModelHint: "No Ollama model found. Is Ollama running? Pull a model with `ollama pull <name>`.",
    });
  }
  return callOpenAICompatible(settings, system, user, maxTokens, {
    defaultBaseUrl: DEFAULT_BASE_URL,
    providerLabel: "LM Studio",
    missingModelHint: "No local model found. Is LM Studio running with a model loaded and its server started?",
  });
}

async function callOpenAICompatible(settings, system, user, maxTokens, opts) {
  const baseUrl = (settings.baseUrl || opts.defaultBaseUrl).replace(/\/+$/, "");
  const model = settings.model || (await detectLocalModel(baseUrl));
  if (!model) throw new Error(opts.missingModelHint);
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3, stream: false }),
  });
  if (!res.ok) throw new Error(`${opts.providerLabel} error ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!txt) throw new Error(`Empty response from ${opts.providerLabel}`);
  return txt;
}

async function callOpenAI(settings, system, user, maxTokens) {
  if (!settings.openaiApiKey) throw new Error("No OpenAI API key set");
  const model = settings.model || OPENAI_MODEL;
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.openaiApiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  const txt = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!txt) throw new Error("Empty response from OpenAI");
  return txt;
}

async function detectLocalModel(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    if (!res.ok) return "";
    const data = await res.json();
    return (data && data.data && data.data[0] && data.data[0].id) || "";
  } catch (_) {
    return "";
  }
}

async function callClaude(settings, system, user, maxTokens) {
  if (!settings.claudeApiKey) throw new Error("No Claude API key set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.claudeApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude error ${res.status}: ${await safeText(res)}`);
  const data = await res.json();
  const txt = data.content && data.content[0] && data.content[0].text;
  if (!txt) throw new Error("Empty response from Claude");
  return txt;
}

// ---------------------------------------------------------------------------
// Per-note summarization -> { title, summary(markdown) }. Falls back to a plain
// snippet if the provider is unavailable (e.g. LM Studio not running).
// ---------------------------------------------------------------------------
async function processNote(text) {
  const system = "You organize saved research snippets into a personal knowledge base.";
  const user =
    "Summarize the text between the <text> tags. Respond in EXACTLY this format and nothing else:\n" +
    "TITLE: <a concise title, at most 8 words>\n" +
    "---\n" +
    "<2 to 4 short markdown bullet points capturing the key points>\n\n" +
    `<text>\n${text}\n</text>`;
  try {
    const raw = await callLLM(system, user, 500);
    return parseTitleAndSummary(raw, text);
  } catch (err) {
    console.warn("Knowledge Base: note summarization failed", err);
    return fallbackAi(text);
  }
}

// Parse the "TITLE: ...\n---\n<markdown>" response format.
function parseTitleAndSummary(raw, text) {
  const titleMatch = raw.match(/TITLE:\s*(.+)/i);
  let title = titleMatch ? titleMatch[1].trim() : "";

  let summary;
  const delim = raw.indexOf("---");
  if (delim !== -1) {
    summary = raw.slice(delim + 3).trim();
  } else if (titleMatch) {
    summary = raw.slice(raw.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
  } else {
    summary = raw.trim();
  }

  title = title.replace(/^["'#*\s]+|["'\s]+$/g, "");
  if (!title) title = fallbackAi(text).title;
  return { title: title.slice(0, 120), summary: summary.slice(0, 1200) };
}

function fallbackAi(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  return {
    title: clean.split(" ").slice(0, 8).join(" ") || "Untitled note",
    summary: clean.slice(0, 160),
  };
}

// ---------------------------------------------------------------------------
// Aggregate per-tag digest. On-demand; caches the result per tag.
// ---------------------------------------------------------------------------
async function summarizeTag(tag) {
  const notes = await getNotes();
  const scoped = tag && tag !== "All" ? notes.filter((n) => n.tag === tag) : notes;
  if (scoped.length === 0) {
    return { markdown: "", createdAt: new Date().toISOString(), count: 0, empty: true };
  }

  const list = scoped
    .map((n, i) => {
      const snippet = (n.text || "").replace(/\s+/g, " ").trim().slice(0, 800);
      return `### Note ${i + 1}: ${n.aiTitle || "Untitled"}\nSource: ${n.url || "n/a"}\n${snippet}`;
    })
    .join("\n\n");

  const label = tag && tag !== "All" ? `the "${tag}" tag` : "all tags";
  const system = "You are a knowledge synthesizer. You produce clear, readable markdown digests.";
  const user =
    `Below are ${scoped.length} saved notes from ${label}. Write a well-organized markdown digest that ` +
    "groups related ideas under `##` headings, uses bullet points for key takeaways, and stays concise. " +
    "Synthesize the ideas rather than repeating the notes verbatim.\n\n" +
    list;

  const raw = await callLLM(system, user, 1500);
  const digest = { markdown: raw.trim(), createdAt: new Date().toISOString(), count: scoped.length };
  await saveDigest(tag || "All", digest);
  return digest;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (_) {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Google Sheets sync (Phase 2). One "Knowledge Base" spreadsheet, one tab per
// tag, one row per note. Notes are appended on demand.
// ---------------------------------------------------------------------------
// One-way reconcile: make the spreadsheet match local notes exactly.
// The extension is the source of truth - append missing rows and remove any
// sheet rows (including old id-less ones) that no longer map to a local note.
async function syncAllNotes() {
  const notes = await getNotes();
  const token = await getGoogleToken(true); // interactive: prompt once
  const spreadsheetId = await findOrCreateSpreadsheet(token);

  const notesByTag = {};
  for (const n of notes) (notesByTag[n.tag] = notesByTag[n.tag] || []).push(n);
  const tags = Object.keys(notesByTag);

  // Ensure a tab (with header) exists for every tag that has notes.
  let meta = await getSheetsMeta(spreadsheetId, token);
  const existingTitles = meta.map((s) => s.title);
  for (const tag of tags) {
    if (!existingTitles.includes(tag)) {
      await addSheetTab(spreadsheetId, tag, token);
      await appendRow(spreadsheetId, tag, SHEET_HEADER, token);
    }
  }
  meta = await getSheetsMeta(spreadsheetId, token); // refetch to include new tabs

  let appended = 0;
  let removed = 0;
  const errors = [];

  for (const sheet of meta) {
    try {
      const validIds = new Set((notesByTag[sheet.title] || []).map((n) => n.id));
      const rows = await readTab(spreadsheetId, sheet.title, token);

      // Data rows (skip header). A row is an orphan if its ID column doesn't
      // match a current local note for this tag.
      const present = new Set();
      const orphanIndices = [];
      for (let i = 1; i < rows.length; i++) {
        const id = rows[i] && rows[i][5];
        if (id && validIds.has(id)) present.add(id);
        else orphanIndices.push(i);
      }

      if (orphanIndices.length) {
        await deleteRows(spreadsheetId, sheet.sheetId, orphanIndices, token);
        removed += orphanIndices.length;
      }

      const missing = (notesByTag[sheet.title] || []).filter((n) => !present.has(n.id));
      for (const n of missing) {
        await appendNoteRow(spreadsheetId, n, token);
        appended += 1;
      }
    } catch (e) {
      errors.push(`${sheet.title}: ${e}`);
    }
  }

  // Every local note now has a row: mark them all exported.
  let changed = false;
  for (const n of notes) {
    if (!n.exported || n.spreadsheetId !== spreadsheetId) {
      n.exported = true;
      n.spreadsheetId = spreadsheetId;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [NOTES_KEY]: notes });
  await chrome.storage.local.set({ [SHEET_TABS_KEY]: meta.map((s) => s.title) });

  return { appended, removed, total: notes.length, errors, spreadsheetId };
}

// Pull notes from the linked spreadsheet and merge into local storage.
// Imports rows whose Note ID is not already present locally; skips duplicates.
async function restoreFromSheets() {
  const token = await getGoogleToken(true);
  const store = await chrome.storage.local.get(SPREADSHEET_KEY);
  const spreadsheetId = store[SPREADSHEET_KEY];
  if (!spreadsheetId) {
    throw new Error("No spreadsheet linked — sync at least once before restoring");
  }

  const notes = await getNotes();
  const existingIds = new Set(notes.map((n) => n.id));
  const meta = await getSheetsMeta(spreadsheetId, token);

  let imported = 0;
  let skipped = 0;
  let legacySkipped = 0;

  for (const sheet of meta) {
    try {
      const rows = await readTab(spreadsheetId, sheet.title, token);
      if (!rows.length || !isSheetHeader(rows[0])) continue;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || !row.length) continue;
        const id = row[5] && String(row[5]).trim();
        if (!id) {
          legacySkipped += 1;
          continue;
        }
        if (existingIds.has(id)) {
          skipped += 1;
          continue;
        }
        const note = parseSheetRow(row, sheet.title, spreadsheetId);
        if (!note) continue;
        notes.unshift(note);
        existingIds.add(id);
        imported += 1;
        await rememberCustomTag(note.tag);
      }
    } catch (_) {
      // Skip tabs that can't be read or don't match our format.
    }
  }

  if (imported > 0) {
    await chrome.storage.local.set({ [NOTES_KEY]: notes });
  }

  return { imported, skipped, legacySkipped, total: notes.length };
}

function isSheetHeader(row) {
  if (!row || row.length < 6) return false;
  return row[0] === SHEET_HEADER[0] && row[5] === SHEET_HEADER[5];
}

function parseSheetRow(row, tag, spreadsheetId) {
  const id = String(row[5] || "").trim();
  if (!id) return null;
  return {
    id,
    text: row[3] || "",
    aiTitle: row[1] || "Untitled",
    aiSummary: row[2] || "",
    tag: tag || "General",
    url: row[4] || "",
    title: "",
    createdAt: parseSheetDate(row[0]),
    exported: true,
    spreadsheetId,
  };
}

function parseSheetDate(dateStr) {
  const parsed = Date.parse(String(dateStr || ""));
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return new Date().toISOString();
}

async function syncNote(noteId, interactive) {
  const token = await getGoogleToken(interactive);
  const spreadsheetId = await findOrCreateSpreadsheet(token);
  return syncNoteWithToken(noteId, token, spreadsheetId);
}

async function syncNoteWithToken(noteId, token, spreadsheetId) {
  const notes = await getNotes();
  const note = notes.find((n) => n.id === noteId);
  if (!note) throw new Error("Note not found");
  if (note.exported) return note;

  await ensureSheetForTag(spreadsheetId, note.tag, token);
  await appendNoteRow(spreadsheetId, note, token);

  note.exported = true;
  note.spreadsheetId = spreadsheetId;
  await chrome.storage.local.set({ [NOTES_KEY]: notes });
  return note;
}

// Obtain a Google access token via launchWebAuthFlow. Tokens are cached (with
// expiry) in storage; interactive=false reuses a cached token or fails.
async function getGoogleToken(interactive) {
  const store = await chrome.storage.local.get(GOOGLE_TOKEN_KEY);
  const cached = store[GOOGLE_TOKEN_KEY];
  if (cached && cached.accessToken && cached.expiresAt > Date.now() + 60000) {
    return cached.accessToken;
  }
  if (!interactive) {
    throw new Error("Not signed in to Google - open the popup and click Sync");
  }
  return launchGoogleAuth();
}

function launchGoogleAuth() {
  return new Promise((resolve, reject) => {
    const redirectUri = chrome.identity.getRedirectURL();
    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      `?client_id=${encodeURIComponent(WEB_CLIENT_ID)}` +
      "&response_type=token" +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&scope=${encodeURIComponent(GOOGLE_SCOPES.join(" "))}` +
      "&prompt=consent";

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "Google sign-in cancelled"));
        return;
      }
      const params = parseAuthFragment(redirectUrl);
      if (params.error) {
        reject(new Error(params.error));
        return;
      }
      if (!params.access_token) {
        reject(new Error("No access token returned"));
        return;
      }
      const expiresIn = parseInt(params.expires_in || "3600", 10);
      await chrome.storage.local.set({
        [GOOGLE_TOKEN_KEY]: {
          accessToken: params.access_token,
          expiresAt: Date.now() + expiresIn * 1000,
        },
      });
      resolve(params.access_token);
    });
  });
}

function parseAuthFragment(redirectUrl) {
  const out = {};
  const frag = redirectUrl.split("#")[1] || redirectUrl.split("?")[1] || "";
  for (const kv of frag.split("&")) {
    const [k, v] = kv.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return out;
}

// Sheets API fetch that attaches the bearer token and, on 401, clears the
// cached token so the next sync re-authorizes.
async function sheetsFetch(url, options, token) {
  const res = await fetch(url, {
    ...options,
    headers: { ...(options && options.headers), authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    await chrome.storage.local.remove(GOOGLE_TOKEN_KEY);
    throw new Error("Google session expired - click Sync again to re-authorize");
  }
  return res;
}

// Return the stored spreadsheet id, or create the Knowledge Base spreadsheet.
async function findOrCreateSpreadsheet(token) {
  const store = await chrome.storage.local.get(SPREADSHEET_KEY);
  if (store[SPREADSHEET_KEY]) return store[SPREADSHEET_KEY];

  const res = await sheetsFetch(
    "https://sheets.googleapis.com/v4/spreadsheets",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ properties: { title: SHEET_TITLE } }),
    },
    token
  );
  if (!res.ok) throw new Error(`Sheet create failed: ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  await chrome.storage.local.set({ [SPREADSHEET_KEY]: data.spreadsheetId, [SHEET_TABS_KEY]: [] });
  return data.spreadsheetId;
}

// Return [{ title, sheetId }] for every tab in the spreadsheet.
async function getSheetsMeta(spreadsheetId, token) {
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
    {},
    token
  );
  if (!res.ok) throw new Error(`Sheet read failed: ${res.status} ${await safeText(res)}`);
  const meta = await res.json();
  return (meta.sheets || []).map((s) => ({ title: s.properties.title, sheetId: s.properties.sheetId }));
}

// Create a tab and return its numeric sheetId.
async function addSheetTab(spreadsheetId, tag, token) {
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tag } } }] }),
    },
    token
  );
  if (!res.ok) throw new Error(`Add tab failed: ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  return data.replies[0].addSheet.properties.sheetId;
}

// Read all rows (including header) from a tab.
async function readTab(spreadsheetId, title, token) {
  const range = `'${String(title).replace(/'/g, "''")}'!${SHEET_RANGE}`;
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(`Read tab failed: ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  return data.values || [];
}

// Delete multiple rows by 0-based index (deletes bottom-up to keep indices valid).
async function deleteRows(spreadsheetId, sheetId, indices, token) {
  const requests = [...indices]
    .sort((a, b) => b - a)
    .map((i) => ({
      deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 } },
    }));
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests }),
    },
    token
  );
  if (!res.ok) throw new Error(`Delete rows failed: ${res.status} ${await safeText(res)}`);
}

// Ensure a tab (sheet) named after the tag exists, with a header row.
async function ensureSheetForTag(spreadsheetId, tag, token) {
  const store = await chrome.storage.local.get(SHEET_TABS_KEY);
  const known = store[SHEET_TABS_KEY] || [];
  if (known.includes(tag)) return;

  // Fetch the current tab titles to avoid duplicate-name errors.
  const metaRes = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(title))`,
    {},
    token
  );
  if (!metaRes.ok) throw new Error(`Sheet read failed: ${metaRes.status} ${await safeText(metaRes)}`);
  const meta = await metaRes.json();
  const titles = (meta.sheets || []).map((s) => s.properties && s.properties.title);

  if (!titles.includes(tag)) {
    const addRes = await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tag } } }] }),
      },
      token
    );
    if (!addRes.ok) throw new Error(`Add tab failed: ${addRes.status} ${await safeText(addRes)}`);
    await appendRow(spreadsheetId, tag, SHEET_HEADER, token);
    titles.push(tag);
  }

  await chrome.storage.local.set({ [SHEET_TABS_KEY]: titles });
}

async function appendNoteRow(spreadsheetId, note, token) {
  const date = new Date(note.createdAt).toLocaleString();
  const row = [date, note.aiTitle || "", note.aiSummary || "", note.text || "", note.url || "", note.id];
  await appendRow(spreadsheetId, note.tag, row, token);
}

async function appendRow(spreadsheetId, tag, values, token) {
  const range = `'${String(tag).replace(/'/g, "''")}'!${SHEET_RANGE}`;
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: [values] }),
    },
    token
  );
  if (!res.ok) throw new Error(`Append row failed: ${res.status} ${await safeText(res)}`);
}

// Delete the sheet row for a note (matched by its id in the ID column).
async function deleteNoteRow(note) {
  if (!note || !note.spreadsheetId || !note.id || !note.tag) {
    return { skipped: true };
  }
  const token = await getGoogleToken(true);
  const sheetId = await getSheetIdForTag(note.spreadsheetId, note.tag, token);
  if (sheetId == null) return { skipped: true }; // tab no longer exists

  const rowIndex = await findRowIndexById(note.spreadsheetId, note.tag, note.id, token);
  if (rowIndex == null) return { skipped: true }; // row not found (e.g. never synced)

  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${note.spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            deleteDimension: {
              range: { sheetId, dimension: "ROWS", startIndex: rowIndex, endIndex: rowIndex + 1 },
            },
          },
        ],
      }),
    },
    token
  );
  if (!res.ok) throw new Error(`Delete row failed: ${res.status} ${await safeText(res)}`);
  return { deleted: true };
}

async function getSheetIdForTag(spreadsheetId, tag, token) {
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
    {},
    token
  );
  if (!res.ok) throw new Error(`Sheet read failed: ${res.status} ${await safeText(res)}`);
  const meta = await res.json();
  const match = (meta.sheets || []).find((s) => s.properties && s.properties.title === tag);
  return match ? match.properties.sheetId : null;
}

// Find the 0-based row index (row 1 = index 0) whose ID column equals id.
async function findRowIndexById(spreadsheetId, tag, id, token) {
  const range = `'${String(tag).replace(/'/g, "''")}'!${ID_COLUMN}:${ID_COLUMN}`;
  const res = await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    {},
    token
  );
  if (!res.ok) throw new Error(`ID lookup failed: ${res.status} ${await safeText(res)}`);
  const data = await res.json();
  const values = data.values || [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] && values[i][0] === id) return i;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
async function getNotes() {
  const store = await chrome.storage.local.get(NOTES_KEY);
  return store[NOTES_KEY] || [];
}

async function getSettings() {
  const store = await chrome.storage.local.get(SETTINGS_KEY);
  const s = store[SETTINGS_KEY] || {};
  const provider = s.provider || "local";
  const defaultBase =
    provider === "ollama" ? DEFAULT_OLLAMA_URL : DEFAULT_BASE_URL;
  return {
    provider,
    baseUrl: s.baseUrl || defaultBase,
    model: s.model || "",
    claudeApiKey: s.claudeApiKey || "",
    openaiApiKey: s.openaiApiKey || "",
    autoSync: !!s.autoSync,
  };
}

async function getDigests() {
  const store = await chrome.storage.local.get(DIGESTS_KEY);
  return store[DIGESTS_KEY] || {};
}

async function saveDigest(tagKey, digest) {
  const digests = await getDigests();
  digests[tagKey] = digest;
  await chrome.storage.local.set({ [DIGESTS_KEY]: digests });
}

async function getCustomTags() {
  const store = await chrome.storage.local.get(CUSTOM_TAGS_KEY);
  return store[CUSTOM_TAGS_KEY] || [];
}

// Default tags first, then user-created ones (de-duplicated).
async function getAllTags() {
  const custom = await getCustomTags();
  return [...TAGS, ...custom.filter((t) => !TAGS.includes(t))];
}

async function rememberCustomTag(tag) {
  if (!tag || TAGS.includes(tag)) return;
  const custom = await getCustomTags();
  if (!custom.includes(tag)) {
    custom.push(tag);
    await chrome.storage.local.set({ [CUSTOM_TAGS_KEY]: custom });
  }
}
