import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "Drape: Live Virtual Try-On",
  description:
    "Try on clothes from any online store with live camera virtual try-on powered by Decart Lucy V-TON.",
  version: "1.0.1",
  icons: {
    "16": "public/icons/icon16.png",
    "48": "public/icons/icon48.png",
    "128": "public/icons/icon128.png",
  },
  action: {
    default_title: "Drape Try-On",
    default_icon: {
      "16": "public/icons/icon16.png",
      "48": "public/icons/icon48.png",
    },
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["src/content/index.ts"],
      css: ["src/content/styles.css"],
      run_at: "document_idle",
    },
  ],
  permissions: ["storage", "activeTab"],
  host_permissions: [
    "http://*/*",
    "https://*/*",
    "http://127.0.0.1:8787/*",
    "http://localhost:8787/*",
  ],
  web_accessible_resources: [
    {
      resources: ["src/overlay/index.html", "assets/*"],
      matches: ["http://*/*", "https://*/*"],
    },
  ],
});
