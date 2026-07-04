# Knowledge Base Notes

A Chrome extension for building a personal knowledge base from the web. Select text on any page, save it with a tag, get an AI-generated title and summary, browse everything in a dashboard, generate per-tag digests, and optionally sync notes to Google Sheets.

## Features

- **Save from any page** — Right-click selected text and choose **Save to Knowledge Base**
- **Tag picker** — Assign notes to built-in tags (Interview Prep, Reading Notes, Research, General) or create custom tags
- **AI summaries** — Each saved note gets an AI-generated title and bullet-point summary
- **Per-tag digests** — Generate a markdown digest that synthesizes all notes under a tag
- **Dashboard** — Search, filter by tag, view notes, delete notes, and manage summaries
- **Google Sheets sync** — One spreadsheet with one tab per tag; extension is the source of truth
- **Local-first** — Notes are stored in `chrome.storage.local` on your machine

## Requirements

- **Google Chrome** (or another Chromium-based browser with extension support)
- **AI provider** (pick one):
  - **Local (default):** [LM Studio](https://lmstudio.ai/) running with a model loaded and the local server started (default URL: `http://localhost:1234`)
  - **Claude:** An [Anthropic API key](https://console.anthropic.com/)
- **Google Sheets sync (optional):** A Google Cloud OAuth client configured for the extension (see [Google Sheets setup](#google-sheets-setup-optional))

## Installation

### 1. Clone the repository

```bash
git clone git@github.com:akumbhar/Knowledge-Base-Chrome-Plugin.git
cd Knowledge-Base-Chrome-Plugin
```

Or download and extract the ZIP from GitHub.

### 2. Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the project folder (the directory that contains `manifest.json`)

The **Knowledge Base Notes** extension should appear in your toolbar.

### 3. Pin the extension (recommended)

Click the puzzle-piece icon in the Chrome toolbar, then pin **Knowledge Base Notes** so the popup is easy to open.

### 4. Configure AI (first-time setup)

1. Click the extension icon, or right-click the icon and choose **Options** to open the full dashboard
2. Click the gear icon to open **Settings**
3. Choose your AI provider:
   - **Local (LM Studio):** Start LM Studio, load a model, and start the local server. The default base URL is `http://localhost:1234`. Optionally set a specific model name; otherwise the extension auto-detects from `/v1/models`.
   - **Claude (Anthropic):** Switch the provider to Claude and paste your API key (`sk-ant-...`), then click **Save**

### 5. Reload after code changes

If you pull updates or edit the code locally, go to `chrome://extensions` and click the reload icon on the extension card.

## Usage

### Save a note

1. Select text on any webpage
2. Right-click and choose **Save to Knowledge Base**
3. Pick a tag (or type a new one) in the in-page picker
4. Press **Enter** or click **Save**

The extension sends the text to your configured AI provider for a title and summary, then stores the note locally.

### Browse notes

- **Popup:** Click the extension icon for a compact view with search and tag filters
- **Dashboard:** Open **Options** from the extension menu for the full dashboard (search, summarize, sync, settings)

### Generate a tag summary

1. Open the dashboard
2. Select a tag (not **All**)
3. Click **Summarize**

The AI produces a markdown digest of all notes under that tag. You can **Regenerate**, **Clear** (delete the saved summary), or **Close** (hide it without deleting).

### Sync to Google Sheets

1. Open the dashboard and click the sync icon (↻) in the header
2. Sign in with Google when prompted
3. The extension creates a spreadsheet named **Knowledge Base** (if needed) with one tab per tag

Each row contains: Date, Title, Summary, Note, Source, and a hidden Note ID.

Enable **Auto-sync new notes to Google Sheets** in Settings to sync notes automatically when you save them.

**Note:** The extension is the source of truth. Manual edits or deletions in Google Sheets may be overwritten on the next sync.

## Google Sheets setup (optional)

Google Sheets sync uses OAuth via `chrome.identity.launchWebAuthFlow`. To use your own OAuth client instead of the bundled one:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Google Sheets API**
3. Create an OAuth **Web application** client
4. Add an authorized redirect URI:
   - Load the extension once in Chrome
   - Open the extension's background service worker console, or run in the dashboard console:
     ```js
     chrome.identity.getRedirectURL()
     ```
   - Add the returned URL (format: `https://<extension-id>.chromiumapp.org/`) as an authorized redirect URI
5. Replace `WEB_CLIENT_ID` in `background.js` with your client ID
6. Reload the extension

## Project structure

```
├── manifest.json      # Extension manifest (MV3)
├── background.js      # Service worker: save flow, AI, Google Sheets sync
├── content.js         # In-page tag picker (Shadow DOM)
├── popup.html         # Compact popup UI
├── dashboard.html     # Full dashboard UI
├── popup.js           # Shared dashboard/popup logic
└── icons/             # Extension icons
```

## Privacy

- Notes are stored locally in your browser via `chrome.storage.local`
- AI requests go to your chosen provider (local LM Studio server or Anthropic's API)
- Google Sheets sync sends note data to Google's API only when you sync or have auto-sync enabled

## License

MIT
