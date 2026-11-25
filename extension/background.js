const DEFAULT_SERVER = "http://127.0.0.1:3037";
const runningTabs = new Set();

function normalizeServerUrl(raw) {
  const input = typeof raw === "string" ? raw.trim() : "";
  if (!input) return DEFAULT_SERVER;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("Enter a valid server URL (e.g. https://your-server.vercel.app or http://127.0.0.1:3037).");
  }
  const isLocal = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && isLocal) return parsed.origin;
  throw new Error("Remote servers must use https:// (or use http://127.0.0.1:3037 locally).");
}

async function fetchServerStatus(serverUrl) {
  const health = await fetchJsonWithTimeout(`${serverUrl}/health`, {}, 5000);
  if (health.supportsSettingsApi === false) {
    return { supportsSettingsApi: false, ...health };
  }
  try {
    const settings = await fetchJsonWithTimeout(`${serverUrl}/api/settings`, {}, 5000);
    return { supportsSettingsApi: true, ...settings };
  } catch {
    return { supportsSettingsApi: false, ...health };
  }
}

async function getServerUrl() {
  try {
    const stored = await chrome.storage.local.get(["serverUrl"]);
    return normalizeServerUrl(stored?.serverUrl || DEFAULT_SERVER);
  } catch {
    return DEFAULT_SERVER;
  }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const raw = await response.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    if (data?.error) throw new Error(data.error);
    if (response.status === 413) throw new Error("Screenshot is too large for the backend (HTTP 413). Zoom out or resize the window and retry.");
    if (response.status === 504) throw new Error("Backend request timed out (HTTP 504). Press Retry in a moment.");
    const snippet = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
    throw new Error(snippet ? `Backend error (${response.status}): ${snippet}` : `Backend request failed (${response.status}).`);
  }
  if (!data || typeof data !== "object") {
    throw new Error("Backend returned an unreadable response.");
  }
  return data;
}

async function toggleAutoScanPanel() {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active webpage was found.");
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "AUTOSCAN_TOGGLE_VISIBILITY" });
  } catch (error) {
    if (tab?.id) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab.id, { type: "AUTOSCAN_ERROR", error: error?.message || "Could not hide or show the AutoScan panel." });
      } catch (_) { console.warn("Visibility toggle unavailable on this tab:", error); }
    }
  }
}

async function startScan() {
  let tab;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active;
    if (!tab?.id || !tab.windowId) throw new Error("No active webpage was found.");
    if (runningTabs.has(tab.id)) return;
    runningTabs.add(tab.id);

    // Capture as JPEG to keep payload well below Vercel's 4.5 MB serverless limit; never send to Gemini locally.
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 82 });
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    } catch (e) {
      throw new Error("Chrome cannot inject AutoScan on this page. Try a normal website; Chrome internal pages and protected pages are blocked.");
    }
    const serverUrl = await getServerUrl();
    await chrome.tabs.sendMessage(tab.id, { type: "AUTOSCAN_START", screenshot, server: serverUrl });
  } catch (error) {
    if (tab?.id) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab.id, { type: "AUTOSCAN_ERROR", error: error?.message || "Could not capture this tab." });
      } catch (_) { console.warn("AutoScan unavailable on this tab:", error); }
    }
  } finally {
    if (tab?.id) runningTabs.delete(tab.id);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "scan-question") void startScan();
  if (command === "toggle-visibility") void toggleAutoScanPanel();
});
chrome.action.onClicked.addListener(() => void startScan());

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AUTOSCAN_RECAPTURE") {
    (async () => {
      try {
        const tab = sender.tab;
        if (!tab?.id || !tab.windowId) throw new Error("The active tab is unavailable. Press Alt+X again.");
        const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 82 });
        sendResponse({ screenshot });
      } catch (e) { sendResponse({ error: e?.message || "Screenshot capture failed." }); }
    })();
    return true;
  }
  if (message?.type === "AUTOSCAN_PROCESS") {
    (async () => {
      const serverUrl = await getServerUrl();
      try {
        const result = await fetchJsonWithTimeout(`${serverUrl}/api/autoscan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: message.image, domText: message.domText || "", firstOnly: Boolean(message.firstOnly) })
        }, 90000);
        sendResponse({ ok: true, result });
      } catch (e) {
        const msg = e?.name === "TimeoutError" || e?.name === "AbortError"
          ? "Request timed out. Check the local server and retry."
          : (e?.message || `Cannot reach local backend at ${serverUrl}. Start it with node server.js.`);
        sendResponse({ ok: false, error: msg.includes("fetch") ? `Cannot reach the local backend at ${serverUrl}. Start the server in the server folder.` : msg });
      }
    })();
    return true;
  }
  if (message?.type === "AUTOSCAN_GET_SETTINGS") {
    (async () => {
      const serverUrl = await getServerUrl();
      try {
        const status = await fetchServerStatus(serverUrl);
        sendResponse({ ok: true, serverUrl, connected: true, ...status });
      } catch (e) {
        sendResponse({
          ok: true,
          serverUrl,
          connected: false,
          error: e?.message || `Cannot reach ${serverUrl}`
        });
      }
    })();
    return true;
  }
  if (message?.type === "AUTOSCAN_TEST_SERVER") {
    (async () => {
      try {
        const targetUrl = normalizeServerUrl(message.serverUrl);
        const status = await fetchServerStatus(targetUrl);
        sendResponse({ ok: true, serverUrl: targetUrl, ...status });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message?.includes("fetch") ? "Server is unreachable. Check the URL or verify the server is running." : (e?.message || "Connection check failed.") });
      }
    })();
    return true;
  }
  if (message?.type === "AUTOSCAN_SAVE_SETTINGS") {
    (async () => {
      try {
        const targetUrl = normalizeServerUrl(message.serverUrl);
        await chrome.storage.local.set({ serverUrl: targetUrl });

        const payload = {};
        if (typeof message.model === "string" && message.model.trim()) payload.model = message.model.trim();
        if (typeof message.apiKey === "string" && message.apiKey.trim()) payload.apiKey = message.apiKey.trim();

        let serverResponse = null;
        if (Object.keys(payload).length > 0) {
          serverResponse = await fetchJsonWithTimeout(`${targetUrl}/api/settings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          }, 6000);
        } else {
          serverResponse = await fetchServerStatus(targetUrl).catch(() => null);
        }
        sendResponse({
          ok: true,
          serverUrl: targetUrl,
          connected: Boolean(serverResponse),
          ...(serverResponse || {})
        });
      } catch (e) {
        sendResponse({
          ok: false,
          error: e?.message?.includes("fetch") ? "Saved URL locally, but could not reach the server to update model/API key." : (e?.message || "Failed to save settings.")
        });
      }
    })();
    return true;
  }
});
