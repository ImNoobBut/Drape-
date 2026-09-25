import type {
  ExtensionMessage,
  OverlayInboundMessage,
  OverlayOutboundMessage,
} from "../shared/types";

const ROOT_ID = "drape-root";
const FAB_ID = "drape-fab";
const PANEL_ID = "drape-panel";
const DROP_GLOW_ID = "drape-drop-glow";
const MIN_IMG_SIZE = 80;

let panelOpen = false;
let iframe: HTMLIFrameElement | null = null;
let overlayReady = false;
let pendingGarmentUrl: string | undefined;
/** Survives cross-origin iframe drops where dataTransfer is emptied. */
let activeDragUrl: string | undefined;

function ensureUi() {
  if (document.getElementById(ROOT_ID)) return;

  const root = document.createElement("div");
  root.id = ROOT_ID;

  const fab = document.createElement("button");
  fab.id = FAB_ID;
  fab.type = "button";
  fab.setAttribute("aria-label", "Open drape try-on");
  fab.innerHTML = `<span id="drape-fab-dot"></span><span>Try on</span>`;
  fab.addEventListener("click", () => {
    if (panelOpen) closePanel();
    else openPanel();
  });

  const panel = document.createElement("div");
  panel.id = PANEL_ID;

  const dropGlow = document.createElement("div");
  dropGlow.id = DROP_GLOW_ID;

  root.append(panel, dropGlow);
  document.documentElement.append(root, fab);
}

function getOverlayUrl(): string {
  return chrome.runtime.getURL("src/overlay/index.html");
}

function setIframePointerEvents(enabled: boolean) {
  if (!iframe) return;
  // While dragging, disable iframe hit-testing so the host page receives the
  // drop. Cross-origin chrome-extension iframes cannot read page drag data.
  iframe.style.pointerEvents = enabled ? "auto" : "none";
}

function openPanel(garmentUrl?: string) {
  ensureUi();
  const panel = document.getElementById(PANEL_ID)!;
  const fab = document.getElementById(FAB_ID)!;

  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.src = getOverlayUrl();
    iframe.allow = "camera; microphone";
    iframe.setAttribute("allow", "camera; microphone");
    iframe.title = "drape live try-on";
    panel.appendChild(iframe);
  }

  panel.dataset.open = "true";
  fab.dataset.open = "true";
  fab.querySelector("span:last-child")!.textContent = "Close";
  panelOpen = true;
  pendingGarmentUrl = garmentUrl;
  setIframePointerEvents(true);

  postToOverlay({ source: "drape-host", type: "OPEN", garmentUrl });
}

function closePanel() {
  const panel = document.getElementById(PANEL_ID);
  const fab = document.getElementById(FAB_ID);
  if (!panel || !fab) return;

  postToOverlay({ source: "drape-host", type: "CLOSE" });
  panel.dataset.open = "false";
  fab.dataset.open = "false";
  fab.querySelector("span:last-child")!.textContent = "Try on";
  panelOpen = false;
  pendingGarmentUrl = undefined;
  activeDragUrl = undefined;
  setIframePointerEvents(true);
}

function postToOverlay(message: OverlayInboundMessage) {
  if (!iframe?.contentWindow || !overlayReady) return;
  iframe.contentWindow.postMessage(message, "*");
}

function setGarment(garmentUrl: string) {
  if (!panelOpen) {
    openPanel(garmentUrl);
    return;
  }
  postToOverlay({ source: "drape-host", type: "SET_GARMENT", garmentUrl });
}

function isUsableImage(img: HTMLImageElement): boolean {
  const src = resolveImageUrl(img);
  if (!src) return false;
  if (src.startsWith("data:image/svg")) return false;
  const rect = img.getBoundingClientRect();
  if (rect.width < MIN_IMG_SIZE || rect.height < MIN_IMG_SIZE) return false;
  if (!src.startsWith("http") && !src.startsWith("blob:") && !src.startsWith("data:")) {
    return false;
  }
  return true;
}

function pickFromSrcset(srcset: string): string | null {
  const candidates = srcset
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor] = part.split(/\s+/, 2);
      const widthMatch = descriptor?.match(/^(\d+)w$/);
      const densityMatch = descriptor?.match(/^([\d.]+)x$/);
      const score = widthMatch
        ? Number(widthMatch[1])
        : densityMatch
          ? Number(densityMatch[1]) * 1000
          : 1;
      return { url, score };
    })
    .filter((c) => !!c.url);

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.url || null;
}

function resolveImageUrl(img: HTMLImageElement): string | null {
  const attrs = [
    img.getAttribute("data-src"),
    img.getAttribute("data-original"),
    img.getAttribute("data-lazy-src"),
    img.getAttribute("data-zoom-image"),
    img.currentSrc,
    img.src,
  ];

  const srcset =
    img.getAttribute("data-srcset") ||
    img.getAttribute("srcset") ||
    (img.parentElement instanceof HTMLPictureElement
      ? img.parentElement.querySelector("source")?.getAttribute("srcset")
      : null);
  if (srcset) {
    const fromSet = pickFromSrcset(srcset);
    if (fromSet) attrs.unshift(fromSet);
  }

  for (const raw of attrs) {
    if (!raw || raw.startsWith("data:image/svg")) continue;
    try {
      const href = new URL(raw, location.href).href;
      if (
        href.startsWith("http") ||
        href.startsWith("blob:") ||
        href.startsWith("data:image")
      ) {
        return href;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function extractUrlFromDataTransfer(dt: DataTransfer | null): string | undefined {
  if (!dt) return undefined;

  const uriList = dt.getData("text/uri-list")?.trim();
  if (uriList) {
    const first = uriList
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (first && /^(https?:|data:image|blob:)/i.test(first)) return first;
  }

  const plain = dt.getData("text/plain")?.trim();
  if (plain && /^(https?:|data:image|blob:)/i.test(plain.split("\n")[0]!)) {
    return plain.split("\n")[0]!;
  }

  const html = dt.getData("text/html");
  if (html) {
    const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match?.[1]) {
      try {
        return new URL(match[1], location.href).href;
      } catch {
        // ignore
      }
    }
  }

  return undefined;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function isOverPanel(event: DragEvent): boolean {
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.dataset.open !== "true") return false;
  const rect = panel.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function setupDragDrop() {
  document.addEventListener(
    "dragstart",
    (event) => {
      const target = event.target;
      let img: HTMLImageElement | null = null;
      if (target instanceof HTMLImageElement) {
        img = target;
      } else if (target instanceof Element) {
        img = target.closest("img");
      }
      if (!img || !img.classList.contains("drape-drag-target")) return;

      const url = resolveImageUrl(img);
      if (!url || !event.dataTransfer) return;

      activeDragUrl = url;
      img.classList.add("drape-dragging");
      event.dataTransfer.setData("text/uri-list", url);
      event.dataTransfer.setData("text/plain", url);
      event.dataTransfer.setData(
        "text/html",
        `<img src="${url.replace(/"/g, "&quot;")}" />`
      );
      event.dataTransfer.effectAllowed = "copy";

      if (panelOpen) {
        setIframePointerEvents(false);
        const glow = document.getElementById(DROP_GLOW_ID);
        if (glow) glow.dataset.active = "true";
      }
    },
    true
  );

  document.addEventListener(
    "dragend",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement) {
        target.classList.remove("drape-dragging");
      }
      document
        .querySelectorAll("img.drape-dragging")
        .forEach((el) => el.classList.remove("drape-dragging"));
      const glow = document.getElementById(DROP_GLOW_ID);
      if (glow) glow.dataset.active = "false";
      setIframePointerEvents(true);
      // Keep activeDragUrl briefly so a late drop can still read it; clear next tick.
      window.setTimeout(() => {
        activeDragUrl = undefined;
      }, 0);
    },
    true
  );

  document.addEventListener(
    "dragover",
    (event) => {
      if (!panelOpen) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      const glow = document.getElementById(DROP_GLOW_ID);
      if (glow) glow.dataset.active = isOverPanel(event) ? "true" : "false";
    },
    true
  );

  document.addEventListener(
    "drop",
    (event) => {
      if (!panelOpen) return;

      const overPanel = isOverPanel(event);
      // Accept page-wide drops while panel is open so users can drop near the panel.
      if (!overPanel && !activeDragUrl && !event.dataTransfer?.files?.length) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const glow = document.getElementById(DROP_GLOW_ID);
      if (glow) glow.dataset.active = "false";
      setIframePointerEvents(true);

      const file = event.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) {
        void fileToDataUrl(file)
          .then((dataUrl) => setGarment(dataUrl))
          .catch(() => {
            /* ignore read errors */
          });
        activeDragUrl = undefined;
        return;
      }

      const url =
        extractUrlFromDataTransfer(event.dataTransfer) || activeDragUrl;
      activeDragUrl = undefined;
      if (url) setGarment(url);
    },
    true
  );

  // Double-click a product image to try it on quickly.
  document.addEventListener(
    "dblclick",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLImageElement)) return;
      if (!target.classList.contains("drape-drag-target")) return;
      const url = resolveImageUrl(target);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      setGarment(url);
    },
    true
  );
}

function markDraggableImages() {
  document.querySelectorAll("img").forEach((node) => {
    const img = node as HTMLImageElement;
    if (!isUsableImage(img)) {
      img.classList.remove("drape-drag-target");
      return;
    }
    img.classList.add("drape-drag-target");
    img.setAttribute("draggable", "true");
  });
}

function setupMessaging() {
  chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
    if (message.type === "OPEN_TRYON") {
      openPanel(message.garmentUrl);
    } else if (message.type === "CLOSE_TRYON") {
      closePanel();
    } else if (message.type === "SET_GARMENT") {
      setGarment(message.garmentUrl);
    }
  });

  window.addEventListener("message", (event) => {
    const data = event.data as OverlayOutboundMessage | undefined;
    if (!data || data.source !== "drape-overlay") return;

    if (data.type === "READY") {
      overlayReady = true;
      if (panelOpen) {
        postToOverlay({
          source: "drape-host",
          type: "OPEN",
          garmentUrl: pendingGarmentUrl,
        });
      }
      return;
    }

    if (data.type === "REQUEST_CLOSE") {
      closePanel();
    }
  });
}

ensureUi();
setupDragDrop();
setupMessaging();
markDraggableImages();

const observer = new MutationObserver(() => markDraggableImages());
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "data-src", "data-srcset"],
});
