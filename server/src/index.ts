import { config } from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDecartClient } from "@decartai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env") });

const apiKey = process.env.DECART_API_KEY;
const port = Number(process.env.PORT || 8787);

if (!apiKey || apiKey.includes("your_key_here")) {
  console.error(
    "Missing DECART_API_KEY. Copy server/.env.example to server/.env and set your key."
  );
  process.exit(1);
}

const decart = createDecartClient({ apiKey });

const app = new Hono();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin.startsWith("chrome-extension://")) return origin;
      if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
        return origin;
      }
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

app.get("/health", (c) => c.json({ ok: true }));

app.post("/api/tokens", async (c) => {
  try {
    const token = await decart.tokens.create({
      expiresIn: 600,
      allowedModels: ["lucy-vton-latest"],
    });
    return c.json(token);
  } catch (error) {
    console.error("Token creation failed:", error);
    return c.json(
      {
        error: "Failed to create client token",
        detail: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
});

console.log(`Drape token server listening on http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
