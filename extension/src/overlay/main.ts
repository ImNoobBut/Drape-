import {
  createDecartClient,
  models,
  noopLogger,
  resolveFpsNumber,
  type ConnectionState,
  type RealTimeClient,
} from "@decartai/sdk";
import { TOKEN_SERVER_URL } from "../shared/types";
import type {
  FetchImageResponse,
  OverlayInboundMessage,
  OverlayOutboundMessage,
} from "../shared/types";
import { prepareGarmentBlob } from "./prepare-garment";

const videoEl = document.getElementById("output") as HTMLVideoElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const garmentPreview = document.getElementById("garment-preview") as HTMLDivElement;
const garmentThumb = document.getElementById("garment-thumb") as HTMLImageElement;
const hintEl = document.getElementById("hint") as HTMLParagraphElement;

const model = models.realtime("lucy-vton-latest");
const targetFps = resolveFpsNumber(model.fps, 30);

let localStream: MediaStream | null = null;
let realtimeClient: RealTimeClient | null = null;
let sessionStarted = false;
let sessionPromise: Promise<void> | null = null;
let applyingGarment = false;
let intentionalDisconnect = false;
/** Latest garment requested while another apply is in flight. */
let queuedGarment: { blob: Blob; previewUrl?: string } | null = null;
let lastGarment: { blob: Blob; previewUrl?: string } | null = null;

function postToHost(message: OverlayOutboundMessage) {
  parent.postMessage(message, "*");
}

function setStatus(text: string, tone: "info" | "ok" | "error" = "info") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  statusEl.hidden = false;
  postToHost({ source: "drape-overlay", type: "STATUS", status: text });
}

function showGarmentThumb(url: string) {
  garmentThumb.src = url;
  garmentPreview.hidden = false;
}

async function fetchToken(): Promise<string> {
  const res = await fetch(`${TOKEN_SERVER_URL}/api/tokens`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token server error (${res.status}): ${body}`);
  }
  const data = (await res.json()) as { apiKey?: string; error?: string };
  if (!data.apiKey) {
    throw new Error(data.error || "Token server did not return apiKey");
  }
  return data.apiKey;
}

async function fetchImageViaBackground(url: string): Promise<Blob> {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    const res = await fetch(url);
    return res.blob();
  }

  const response = (await chrome.runtime.sendMessage({
    type: "FETCH_IMAGE",
    url,
  })) as FetchImageResponse;

  if (!response?.ok) {
    throw new Error(response?.error || "Could not fetch garment image");
  }

  const res = await fetch(response.dataUrl);
  return res.blob();
}

function softInvalidateSession() {
  // Keep camera tracks alive; only drop the Decart/LiveKit client.
  try {
    intentionalDisconnect = true;
    realtimeClient?.disconnect();
  } catch {
    // ignore
  } finally {
    intentionalDisconnect = false;
  }
  realtimeClient = null;
  sessionStarted = false;
  sessionPromise = null;
}

function attachSessionListeners(client: RealTimeClient) {
  client.on("connectionChange", (state: ConnectionState) => {
    if (intentionalDisconnect) return;

    if (state === "reconnecting") {
      setStatus("Connection interrupted — reconnecting…");
      return;
    }
    if (state === "connected" || state === "generating") {
      if (lastGarment) {
        setStatus("Live try-on active — drop another image to swap", "ok");
      } else {
        setStatus("Camera ready — drag a garment onto yourself", "ok");
      }
      return;
    }
    if (state === "disconnected") {
      // SDK may still auto-reconnect; if isConnected stays false, next apply rebuilds.
      if (!client.isConnected()) {
        realtimeClient = null;
        sessionStarted = false;
        setStatus("Disconnected from try-on. Drop an image to reconnect.", "error");
      }
    }
  });

  client.on("sessionEnded", (event) => {
    softInvalidateSession();
    const reason = event?.reason || "unknown";
    const friendly =
      reason === "insufficient_credits"
        ? "Decart credits exhausted. Top up on platform.decart.ai and try again."
        : reason === "moderation_violation"
          ? "Session ended by Decart moderation. Try a different garment image."
          : `Try-on session ended (${reason}). Drop an image to start again.`;
    setStatus(friendly, "error");
    postToHost({ source: "drape-overlay", type: "ERROR", message: friendly });
  });

  client.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, "error");
    postToHost({ source: "drape-overlay", type: "ERROR", message });
  });
}

async function ensureSession() {
  if (realtimeClient?.isConnected()) {
    sessionStarted = true;
    return;
  }

  // Stale client that is no longer connected.
  if (realtimeClient && !realtimeClient.isConnected()) {
    softInvalidateSession();
  }

  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    try {
      if (!localStream || localStream.getVideoTracks().every((t) => t.readyState === "ended")) {
        setStatus("Requesting camera…");
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: "user",
            frameRate: { ideal: targetFps, max: targetFps },
            width: { ideal: model.width },
            height: { ideal: model.height },
          },
        });
      }

      videoEl.srcObject = localStream;
      await videoEl.play().catch(() => undefined);

      setStatus("Connecting to Lucy V-TON…");
      const apiKey = await fetchToken();
      // Decart logs expected LiveKit/signaling drops as console.warn, which
      // Chrome surfaces on chrome://extensions. Silence SDK noise; we surface
      // real failures via connectionChange / sessionEnded / status UI.
      const client = createDecartClient({
        apiKey,
        logger: noopLogger,
        telemetry: false,
      });

      realtimeClient = await client.realtime.connect(localStream, {
        model,
        mirror: "auto",
        onRemoteStream: (remoteStream) => {
          videoEl.srcObject = remoteStream;
          void videoEl.play().catch(() => undefined);
        },
        onConnectionChange: (state) => {
          if (state === "reconnecting") {
            setStatus("Connection interrupted — reconnecting…");
          }
        },
      });

      attachSessionListeners(realtimeClient);
      sessionStarted = true;
      setStatus("Camera ready — drag a garment onto yourself", "ok");
      hintEl.textContent = "Drag a clothing image from the page, or upload one";
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to start try-on session";
      const denied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      setStatus(
        denied
          ? "Camera permission denied. Allow camera access for this extension and reopen."
          : message,
        "error"
      );
      postToHost({ source: "drape-overlay", type: "ERROR", message });
      softInvalidateSession();
      throw error;
    } finally {
      sessionPromise = null;
    }
  })();

  return sessionPromise;
}

async function applyGarment(blob: Blob, previewUrl?: string) {
  if (applyingGarment) {
    queuedGarment = { blob, previewUrl };
    setStatus("Queued next garment…");
    return;
  }
  applyingGarment = true;

  try {
    await ensureSession();
    if (!realtimeClient?.isConnected()) {
      softInvalidateSession();
      await ensureSession();
    }
    if (!realtimeClient) throw new Error("Try-on session is not connected");

    if (previewUrl) showGarmentThumb(previewUrl);
    else showGarmentThumb(URL.createObjectURL(blob));

    setStatus("Preparing garment…");
    const prepared = await prepareGarmentBlob(blob);
    lastGarment = { blob: prepared, previewUrl };

    setStatus("Applying garment…");
    await realtimeClient.set({
      prompt:
        "Substitute the current clothing with this garment from the reference image",
      image: prepared,
      enhance: true,
    });

    // If set() itself triggered a disconnect, rebuild once and retry.
    if (!realtimeClient.isConnected()) {
      setStatus("Reconnecting after drop…");
      softInvalidateSession();
      await ensureSession();
      if (!realtimeClient) throw new Error("Could not reconnect try-on session");
      await realtimeClient.set({
        prompt:
          "Substitute the current clothing with this garment from the reference image",
        image: prepared,
        enhance: true,
      });
    }

    setStatus("Live try-on active — drop another image to swap", "ok");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to apply garment";
    setStatus(message, "error");
    postToHost({ source: "drape-overlay", type: "ERROR", message });
  } finally {
    applyingGarment = false;
    const next = queuedGarment;
    queuedGarment = null;
    if (next) {
      void applyGarment(next.blob, next.previewUrl);
    }
  }
}

async function applyGarmentFromUrl(url: string) {
  setStatus("Loading garment image…");
  const blob = await fetchImageViaBackground(url);
  await applyGarment(
    blob,
    url.startsWith("http") || url.startsWith("data:") ? url : undefined
  );
}

async function teardown() {
  intentionalDisconnect = true;
  try {
    realtimeClient?.disconnect();
  } catch {
    // ignore
  } finally {
    intentionalDisconnect = false;
  }
  realtimeClient = null;
  sessionStarted = false;
  sessionPromise = null;
  queuedGarment = null;
  lastGarment = null;

  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;

  if (videoEl.srcObject) {
    videoEl.srcObject = null;
  }
}

async function handleHostMessage(data: OverlayInboundMessage) {
  if (data.type === "OPEN") {
    try {
      await ensureSession();
      if (data.garmentUrl) {
        await applyGarmentFromUrl(data.garmentUrl);
      }
    } catch {
      // status already set
    }
    return;
  }

  if (data.type === "SET_GARMENT") {
    try {
      await applyGarmentFromUrl(data.garmentUrl);
    } catch {
      // status already set
    }
    return;
  }

  if (data.type === "CLOSE") {
    await teardown();
  }
}

closeBtn.addEventListener("click", () => {
  void teardown().then(() => {
    postToHost({ source: "drape-overlay", type: "REQUEST_CLOSE" });
  });
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  void applyGarment(file, URL.createObjectURL(file));
  fileInput.value = "";
});

window.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("drag-over");
});

window.addEventListener("dragleave", () => {
  document.body.classList.remove("drag-over");
});

window.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("drag-over");

  const file = event.dataTransfer?.files?.[0];
  if (file && file.type.startsWith("image/")) {
    void applyGarment(file, URL.createObjectURL(file));
    return;
  }

  const url =
    event.dataTransfer?.getData("text/uri-list") ||
    event.dataTransfer?.getData("text/plain");
  if (url && /^https?:|^data:image|^blob:/.test(url)) {
    void applyGarmentFromUrl(url.trim().split("\n")[0]!);
  }
});

window.addEventListener("message", (event) => {
  const data = event.data as OverlayInboundMessage | undefined;
  if (!data || data.source !== "drape-host") return;
  void handleHostMessage(data);
});

window.addEventListener("beforeunload", () => {
  void teardown();
});

postToHost({ source: "drape-overlay", type: "READY" });
setStatus("Ready — open try-on to start");
