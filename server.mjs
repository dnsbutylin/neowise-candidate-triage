import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const MODEL_TIMEOUT_MS = 300;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleTriage(request, response) {
  let text;
  try {
    const payload = JSON.parse(await readBody(request));
    text = payload?.text;
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  if (typeof text !== "string" || text.trim() === "") {
    return json(response, 400, { status: "invalid_input" });
  }

  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, MODEL_TIMEOUT_MS);
  });
  const pending = classify(text, { signal: controller.signal }).then(
    (value) => ({ ok: true, value }),
    () => ({ ok: false }),
  );

  try {
    const outcome = await Promise.race([pending, timeout]);
    if (!outcome.ok) return manualReview(response);
    const parsed = JSON.parse(outcome.value);
    const topic = parsed?.topic;
    const draft = parsed?.draft;
    if (!ALLOWED_TOPICS.has(topic) || typeof draft !== "string" || draft.trim() === "") {
      return manualReview(response);
    }
    return json(response, 200, { status: "ready", topic, draft });
  } catch {
    return manualReview(response);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createApp() {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch {
      if (!response.headersSent) {
        json(response, 500, { status: "server_error" });
      }
    }
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
