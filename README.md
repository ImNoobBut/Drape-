# Drape

Live virtual try-on on any shopping site, powered by [Decart Lucy V-TON](https://platform.decart.ai).

Drag a garment from a product page onto yourself and see it rendered on your camera in realtime.

## What it does

1. Injects a **Try on** button on every http(s) page
2. Opens a camera overlay (extension-owned iframe)
3. Drag a product image onto the panel (or double-click / upload)
4. Streams your camera to Lucy V-TON and shows the dressed result live

## Prerequisites

- Node.js 18+
- Google Chrome (desktop)
- A Decart API key from [platform.decart.ai](https://platform.decart.ai)

## Setup

```bash
# From repo root
npm install

# Configure the token server (never commit the real key)
cp server/.env.example server/.env
# Edit server/.env and set DECART_API_KEY=...
```

If you previously shared an API key in chat, **rotate it** on the Decart dashboard and put the new key in `server/.env`.

## Run

Terminal 1 — token server (keeps your permanent API key server-side):

```bash
npm run server
```

Terminal 2 — build / watch the extension:

```bash
npm run dev
# or a one-shot production build:
npm run build
```

Load in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select `extension/dist`
4. Open any fashion product page
5. Click **Try on**, allow camera, drag a garment image onto the panel

## Architecture

| Piece | Role |
| --- | --- |
| `extension/` | Manifest V3 app (content script, background, overlay) |
| `server/` | `POST /api/tokens` mints short-lived Decart client tokens |
| `@decartai/sdk` | WebRTC realtime connect to `lucy-vton-latest` |

The permanent `DECART_API_KEY` never ships inside the extension package.

## Tips

- Prefer clear product photos (garment-focused, plain background)
- Double-click a large product image to try it immediately
- Use **Upload garment** in the panel if drag/drop is awkward on a site
- Token server must be running at `http://127.0.0.1:8787` while you use the extension locally

## Scripts

| Command | Description |
| --- | --- |
| `npm run server` | Start token API with watch |
| `npm run start` | Start token API once |
| `npm run dev` | Vite/CRX extension dev build |
| `npm run build` | Production extension build → `extension/dist` |
