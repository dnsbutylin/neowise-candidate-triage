import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createApp } from "./server.mjs";

const server = createApp();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(() => new Promise((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
}));

async function post(body, { raw = false } = {}) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("model failures become manual review and drop the draft", async () => {
  const cases = [
    ["[error]", "ошибка модели"],
    ["[bad-json]", "ответ не JSON"],
    ["[bad-topic]", "недопустимая тема"],
    ["[empty-draft]", "пустой черновик"],
  ];

  for (const [marker, label] of cases) {
    const { status, json } = await post({ text: `заявка ${marker}` });
    assert.equal(status, 200, label);
    assert.deepEqual(json, { status: "manual_review", topic: null, draft: null }, label);
  }
});

test("a slow model is cut off at 300ms and sent to manual review", async () => {
  const started = Date.now();
  const { status, json } = await post({ text: "где заказ [timeout]" });
  const elapsed = Date.now() - started;

  assert.equal(status, 200);
  assert.deepEqual(json, { status: "manual_review", topic: null, draft: null });
  assert.ok(elapsed < 900, `ожидание модели не оборвалось за 300 мс, прошло ${elapsed} мс`);
});

test("empty, missing, and broken input is rejected", async () => {
  const invalid = [
    [{ text: "" }, "пустая строка"],
    [{ text: "   " }, "пробелы"],
    [{ text: 12 }, "не строка"],
    [{}, "нет поля text"],
    [null, "тело null"],
  ];

  for (const [body, label] of invalid) {
    const { status, json } = await post(body);
    assert.equal(status, 400, label);
    assert.deepEqual(json, { status: "invalid_input" }, label);
  }

  const broken = await post("{", { raw: true });
  assert.equal(broken.status, 400);
  assert.deepEqual(broken.json, { status: "invalid_input" });
});

test("a usable model reply is returned as a topic and draft", async () => {
  const delivery = await post({ text: "Задерживается доставка заказа" });
  assert.equal(delivery.status, 200);
  assert.equal(delivery.json.status, "ready");
  assert.equal(delivery.json.topic, "delivery");
  assert.equal(typeof delivery.json.draft, "string");
  assert.ok(delivery.json.draft.trim() !== "");

  const pricing = await post({ text: "Какая цена доставки?" });
  assert.equal(pricing.json.topic, "pricing");
});
