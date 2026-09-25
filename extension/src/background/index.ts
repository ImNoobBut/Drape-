import type { ExtensionMessage, FetchImageResponse } from "../shared/types";

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    if (message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "FETCH_IMAGE") {
      void fetchImageAsDataUrl(message.url).then(sendResponse);
      return true;
    }

    return false;
  }
);

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "OPEN_TRYON" } satisfies ExtensionMessage);
  } catch {
    // Content script may not be injected on restricted pages (chrome://, etc.)
  }
});

async function fetchImageAsDataUrl(url: string): Promise<FetchImageResponse> {
  try {
    const response = await fetch(url, { credentials: "omit", redirect: "follow" });
    if (!response.ok) {
      return { ok: false, error: `Failed to fetch image (${response.status})` };
    }

    const blob = await response.blob();
    let contentType = blob.type || response.headers.get("content-type") || "";
    contentType = contentType.split(";")[0]!.trim().toLowerCase();

    // Some CDNs serve images as octet-stream; sniff magic bytes.
    if (!contentType.startsWith("image/")) {
      const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
      contentType = sniffImageType(header) || "";
    }

    if (!contentType.startsWith("image/")) {
      // Last resort: trust common image URL extensions.
      if (/\.(jpe?g|png|webp|gif|avif|bmp)(\?|#|$)/i.test(url)) {
        contentType = guessTypeFromUrl(url);
      } else {
        return { ok: false, error: "URL did not return an image" };
      }
    }

    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    return {
      ok: true,
      dataUrl: `data:${contentType};base64,${base64}`,
      contentType,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to fetch image",
    };
  }
}

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function guessTypeFromUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.includes(".png")) return "image/png";
  if (lower.includes(".webp")) return "image/webp";
  if (lower.includes(".gif")) return "image/gif";
  if (lower.includes(".avif")) return "image/avif";
  if (lower.includes(".bmp")) return "image/bmp";
  return "image/jpeg";
}
