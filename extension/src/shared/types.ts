/** Default local token server from the monorepo `server` package. */
export const TOKEN_SERVER_URL = "http://127.0.0.1:8787";

export type ExtensionMessage =
  | { type: "OPEN_TRYON"; garmentUrl?: string }
  | { type: "CLOSE_TRYON" }
  | { type: "SET_GARMENT"; garmentUrl: string }
  | { type: "FETCH_IMAGE"; url: string }
  | { type: "PING" };

export type FetchImageResponse =
  | { ok: true; dataUrl: string; contentType: string }
  | { ok: false; error: string };

export type OverlayInboundMessage =
  | { source: "drape-host"; type: "OPEN"; garmentUrl?: string }
  | { source: "drape-host"; type: "SET_GARMENT"; garmentUrl: string }
  | { source: "drape-host"; type: "CLOSE" };

export type OverlayOutboundMessage =
  | { source: "drape-overlay"; type: "READY" }
  | { source: "drape-overlay"; type: "REQUEST_CLOSE" }
  | { source: "drape-overlay"; type: "STATUS"; status: string }
  | { source: "drape-overlay"; type: "ERROR"; message: string };
