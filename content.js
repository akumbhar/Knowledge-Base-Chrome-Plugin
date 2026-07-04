// KnowledgeBase Notes - content script
// Renders an in-page tag picker (in a Shadow DOM so page styles cannot bleed in)
// when the background script asks for it after "Save to KnowledgeBase" is clicked.

(function () {
  if (window.__kbNotesLoaded) return;
  window.__kbNotesLoaded = true;

  const TAGS = ["Interview Prep", "Reading Notes", "Research", "General"];
  let host = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "SHOW_TAG_PICKER") {
      showPicker(msg.text || "", msg.tags || TAGS);
    }
  });

  function removePicker() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    document.removeEventListener("keydown", onKeyDown, true);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      removePicker();
    }
  }

  function showPicker(text, tags) {
    removePicker();

    host = document.createElement("div");
    host.style.all = "initial";
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
      .overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        display: flex; align-items: center; justify-content: center;
        background: rgba(15, 23, 42, 0.35);
      }
      .card {
        width: 360px; max-width: calc(100vw - 32px);
        background: #ffffff; color: #0f172a; border-radius: 14px;
        box-shadow: 0 20px 50px rgba(2, 6, 23, 0.35);
        padding: 18px; animation: pop .12s ease-out;
      }
      @keyframes pop { from { transform: scale(.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
      .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
      .title { font-size: 15px; font-weight: 700; }
      .close { cursor: pointer; border: none; background: transparent; font-size: 18px; color: #64748b; line-height: 1; padding: 2px 6px; border-radius: 6px; }
      .close:hover { background: #f1f5f9; }
      .preview {
        font-size: 12px; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0;
        border-radius: 8px; padding: 8px 10px; max-height: 84px; overflow: auto; margin-bottom: 14px;
        white-space: pre-wrap;
      }
      .label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #94a3b8; margin-bottom: 8px; }
      .tags { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
      .tag {
        cursor: pointer; border: 1px solid #e2e8f0; background: #fff; color: #0f172a;
        border-radius: 9px; padding: 9px 10px; font-size: 13px; font-weight: 600; text-align: left;
        transition: all .1s ease;
      }
      .tag:hover { border-color: #6366f1; }
      .tag.active { background: #6366f1; border-color: #6366f1; color: #fff; }
      .newtag { display: flex; gap: 8px; margin-bottom: 16px; }
      .newtag-input {
        flex: 1; border: 1px solid #e2e8f0; border-radius: 9px; padding: 9px 10px;
        font-size: 13px; outline: none; color: #0f172a; background: #fff;
      }
      .newtag-input:focus { border-color: #6366f1; }
      .newtag-add {
        cursor: pointer; border: 1px solid #e2e8f0; background: #f1f5f9; color: #334155;
        border-radius: 9px; padding: 0 14px; font-size: 13px; font-weight: 600;
      }
      .newtag-add:hover { background: #e2e8f0; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; }
      .btn { cursor: pointer; border-radius: 9px; padding: 9px 16px; font-size: 13px; font-weight: 600; border: 1px solid transparent; }
      .btn.secondary { background: #f1f5f9; color: #334155; }
      .btn.secondary:hover { background: #e2e8f0; }
      .btn.primary { background: #6366f1; color: #fff; }
      .btn.primary:disabled { opacity: .5; cursor: not-allowed; }
      .btn.primary:not(:disabled):hover { background: #4f46e5; }
      .status { font-size: 12px; color: #16a34a; margin-right: auto; align-self: center; }
      .status.error { color: #dc2626; }
    `;

    const overlay = document.createElement("div");
    overlay.className = "overlay";

    const card = document.createElement("div");
    card.className = "card";

    const preview = text.length > 280 ? text.slice(0, 280) + "\u2026" : text;
    let selectedTag = null;

    card.innerHTML = `
      <div class="head">
        <div class="title">Save to Knowledge Base</div>
        <button class="close" title="Close">\u00d7</button>
      </div>
      <div class="preview"></div>
      <div class="label">Pick a tag</div>
      <div class="tags"></div>
      <div class="newtag">
        <input class="newtag-input" type="text" placeholder="Add your own tag\u2026" maxlength="40" />
        <button class="newtag-add" type="button">Add</button>
      </div>
      <div class="actions">
        <span class="status"></span>
        <button class="btn secondary cancel">Cancel</button>
        <button class="btn primary save" disabled>Save</button>
      </div>
    `;

    card.querySelector(".preview").textContent = preview;

    const tagsWrap = card.querySelector(".tags");
    const saveBtn = card.querySelector(".save");
    const statusEl = card.querySelector(".status");
    const newTagInput = card.querySelector(".newtag-input");
    const newTagAdd = card.querySelector(".newtag-add");

    function selectChip(chip, tagValue) {
      selectedTag = tagValue;
      tagsWrap.querySelectorAll(".tag").forEach((el) => el.classList.remove("active"));
      chip.classList.add("active");
      saveBtn.disabled = false;
    }

    function addChip(tagValue, select) {
      const b = document.createElement("button");
      b.className = "tag";
      b.textContent = tagValue;
      b.addEventListener("click", () => selectChip(b, tagValue));
      tagsWrap.appendChild(b);
      if (select) selectChip(b, tagValue);
      return b;
    }

    tags.forEach((t) => addChip(t, false));

    function addCustomTag() {
      const value = newTagInput.value.trim();
      if (!value) return;
      // If a chip with the same name (case-insensitive) exists, just select it.
      const existing = Array.from(tagsWrap.querySelectorAll(".tag")).find(
        (el) => el.textContent.toLowerCase() === value.toLowerCase()
      );
      if (existing) {
        selectChip(existing, existing.textContent);
      } else {
        addChip(value, true);
      }
      newTagInput.value = "";
    }

    newTagAdd.addEventListener("click", addCustomTag);
    newTagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addCustomTag();
      }
    });

    card.querySelector(".close").addEventListener("click", removePicker);
    card.querySelector(".cancel").addEventListener("click", removePicker);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) removePicker();
    });

    saveBtn.addEventListener("click", () => {
      if (!selectedTag) return;
      saveBtn.disabled = true;
      statusEl.className = "status";
      statusEl.textContent = "Saving\u2026";
      chrome.runtime.sendMessage(
        {
          type: "SAVE_NOTE",
          payload: {
            text,
            tag: selectedTag,
            pageUrl: location.href,
            pageTitle: document.title,
          },
        },
        (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            statusEl.className = "status error";
            statusEl.textContent = "Save failed";
            saveBtn.disabled = false;
            return;
          }
          statusEl.textContent = "Saved!";
          setTimeout(removePicker, 650);
        }
      );
    });

    shadow.appendChild(style);
    shadow.appendChild(overlay);
    overlay.appendChild(card);
    document.documentElement.appendChild(host);
    document.addEventListener("keydown", onKeyDown, true);
  }
})();
