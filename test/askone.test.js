import { test } from "node:test";
import assert from "node:assert/strict";
import { AskOneError, baseOrigin, createClient, fetchAllQuestions, markdownText, roomQaMarkdown } from "../src/askone.js";

const room = { code: "ABC234", name: "Workshop *Q&A*", status: "closed" };
const q = (id, status, votes, extra = {}) => ({
  id, body: `Question ${id}`, status, votes, pinned: false, answer: null,
  created_at: `2026-09-20T10:0${id}:00Z`, display_name: null, ...extra,
});

function fakeFetch(pages) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = pages.shift();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers ?? {} });
  };
  return { calls, fetchImpl };
}

test("sends the token only in the Authorization header and refuses redirects", async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: { rooms: [], next_cursor: null } }]);
  await createClient({ token: "secret", fetchImpl }).listRooms({ limit: 10 });
  assert.equal(calls[0].url.href, "https://askone.org/api/v1/rooms?limit=10");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(!calls[0].url.href.includes("secret"));
});

test("omits unset query parameters", async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: { room, questions: [], next_cursor: null } }]);
  await createClient({ token: "t", fetchImpl }).getRoom("ABC234", { sort: "recent" });
  assert.equal(calls[0].url.search, "?sort=recent");
});

test("rejects a malformed room code before any request", async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  await assert.rejects(createClient({ token: "t", fetchImpl }).getRoom("../x"), AskOneError);
  assert.equal(calls.length, 0);
});

test("requires a well-formed token and an https base URL", () => {
  assert.throws(() => createClient({ token: "" }), /ASKONE_API_TOKEN/);
  assert.throws(() => createClient({ token: "abc\ndef" }), (error) => /line breaks/.test(error.message) && !error.message.includes("abc"));
  assert.throws(() => createClient({ token: "abc def" }), /spaces/);
  assert.throws(() => baseOrigin("http://askone.org"), /https/);
  assert.throws(() => baseOrigin("https://user:secret@askone.org"), (error) => !error.message.includes("secret"));
  assert.throws(() => baseOrigin("not a url secret"), (error) => !error.message.includes("secret"));
  assert.equal(baseOrigin("http://localhost:3000/ignored"), "http://localhost:3000");
});

test("maps API errors, including Retry-After", async () => {
  const { fetchImpl } = fakeFetch([{ status: 429, headers: { "retry-after": "12" },
    body: { error: { code: "rate_limited", message: "Too many requests." } } }]);
  const error = await createClient({ token: "t", fetchImpl }).listRooms().catch((e) => e);
  assert.ok(error instanceof AskOneError);
  assert.equal(error.code, "rate_limited");
  assert.equal(error.retryAfter, "12");
});

test("survives a non-JSON error page", async () => {
  const fetchImpl = async () => new Response("<html>Bad gateway</html>", { status: 502 });
  const error = await createClient({ token: "t", fetchImpl }).listRooms().catch((e) => e);
  assert.equal(error.code, "http_error");
  assert.equal(error.status, 502);
});

test("follows next_cursor and stops at the page cap", async () => {
  const { calls, fetchImpl } = fakeFetch([
    { body: { room, questions: [q(1, "approved", 1)], next_cursor: "c1" } },
    { body: { room, questions: [q(2, "answered", 2)], next_cursor: null } },
  ]);
  const all = await fetchAllQuestions(createClient({ token: "t", fetchImpl }), "ABC234");
  assert.equal(all.questions.length, 2);
  assert.equal(all.truncated, false);
  assert.equal(calls[1].url.searchParams.get("cursor"), "c1");
  assert.equal(calls[1].url.searchParams.get("limit"), "100");

  const endless = fakeFetch([0, 1, 2].map(() => ({ body: { room, questions: [], next_cursor: "more" } })));
  const capped = await fetchAllQuestions(createClient({ token: "t", fetchImpl: endless.fetchImpl }), "ABC234", { maxPages: 3 });
  assert.equal(capped.truncated, true);
  assert.equal(endless.calls.length, 3);
});

test("orders the FAQ: answered, approved by votes, pending last and marked", () => {
  const markdown = roomQaMarkdown({ room, truncated: false, questions: [
    q(1, "pending", 9),
    q(2, "approved", 1),
    q(3, "answered", 0, { answer: "Yes." }),
    q(4, "approved", 5, { answer: "Coming back to this." }),
    q(5, "answered", 3),
  ] });
  const order = [...markdown.matchAll(/^## Question (\d)$/gm)].map((m) => m[1]);
  assert.deepEqual(order, ["5", "3", "4", "2", "1"]);
  assert.match(markdown, /^# Workshop \\\*Q&amp;A\\\* — Q&A$/m);
  assert.match(markdown, /Votes: 9 · Pending moderation/);
  assert.match(markdown, /Answer:\n\nYes\\\./);
  assert.match(markdown, /Host comment:\n\nComing back to this\\\./);
  assert.match(markdown, /Answered in the session; no written answer\./);
});

test("escapes Markdown and HTML in authored text", () => {
  assert.equal(markdownText("<b>#1</b> [x](y)"), "&lt;b&gt;\\#1&lt;/b&gt; \\[x\\]\\(y\\)");
});

test("notes truncation and empty rooms", () => {
  assert.match(roomQaMarkdown({ room, questions: [], truncated: true }), /No questions in this room\.[\s\S]*more than 2000 questions/);
});

test("never echoes a transport error, which can quote the Authorization header", async () => {
  const fetchImpl = async () => { throw new TypeError("Headers.append: \"Bearer secret-token\" is an invalid header value."); };
  const error = await createClient({ token: "secret-token", fetchImpl }).listRooms().catch((e) => e);
  assert.equal(error.code, "network_error");
  assert.ok(!error.message.includes("secret-token"));
});

test("rejects a successful response that is not the AskOne API", async () => {
  const html = async () => new Response("<html>Sign in</html>", { status: 200 });
  assert.equal((await createClient({ token: "t", fetchImpl: html }).listRooms().catch((e) => e)).code, "invalid_response");
  const wrong = async () => new Response(JSON.stringify({ rooms: "nope" }), { status: 200 });
  assert.equal((await createClient({ token: "t", fetchImpl: wrong }).listRooms().catch((e) => e)).code, "invalid_response");
});

test("passes cancellation to fetch and stops paginating", async () => {
  const controller = new AbortController();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.signal);
    controller.abort();
    return new Response(JSON.stringify({ room, questions: [], next_cursor: "more" }), { status: 200 });
  };
  const error = await fetchAllQuestions(createClient({ token: "t", fetchImpl }), "ABC234", { signal: controller.signal }).catch((e) => e);
  assert.equal(error.code, "cancelled");
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof AbortSignal);

  const aborting = async (url, init) => { throw init.signal.reason ?? new Error("aborted"); };
  const stopped = new AbortController(); stopped.abort();
  const cancelled = await createClient({ token: "t", fetchImpl: aborting }).listRooms({}, stopped.signal).catch((e) => e);
  assert.equal(cancelled.code, "cancelled");
});

test("keeps a large FAQ under the reply size budget and says so", () => {
  const many = Array.from({ length: 50 }, (_, i) => q(String(i).padStart(2, "0"), "approved", 50 - i, { body: "x".repeat(200) }));
  const markdown = roomQaMarkdown({ room, questions: many, truncated: false }, 2_000);
  assert.ok(markdown.length <= 2_000, `${markdown.length} characters`);
  assert.match(markdown, /Only \d+ of the 50 questions read fit in one reply/);
});

test("a body cut off by cancellation is reported as cancelled, not as a bad URL", async () => {
  const controller = new AbortController();
  const body = new ReadableStream({ pull() { controller.abort(); throw new DOMException("aborted", "AbortError"); } });
  const fetchImpl = async () => new Response(body, { status: 200 });
  const error = await createClient({ token: "t", fetchImpl }).listRooms({}, controller.signal).catch((e) => e);
  assert.equal(error.code, "cancelled");
});

test("a full-size FAQ including its note stays within the budget", () => {
  const many = Array.from({ length: 2000 }, (_, i) => q(String(i), "approved", 1, { id: `id${i}`, body: "é".repeat(468), answer: "ü".repeat(1000) }));
  const markdown = roomQaMarkdown({ room, questions: many, truncated: true });
  assert.ok(markdown.length <= 900_000, `${markdown.length} characters`);
  assert.match(markdown, /more than 2000 questions[\s\S]*Only \d+ of the 2000 questions read fit in one reply[\s\S]*get_room_questions/);
});

test("bounds and redacts error text from the server", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: "Weird Code!", message: `Bad header Bearer tok-123 ${"x".repeat(5000)}` } }), { status: 400 });
  const error = await createClient({ token: "tok-123", fetchImpl }).listRooms().catch((e) => e);
  assert.equal(error.code, "http_error");
  assert.ok(!error.message.includes("tok-123"));
  assert.ok(error.message.length <= 500);
});

test("refuses an oversized response before parsing it", async () => {
  let sent = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  const body = new ReadableStream({ pull(controller) { if (sent++ < 8) controller.enqueue(chunk); else controller.close(); } });
  const fetchImpl = async () => new Response(body, { status: 200 });
  const error = await createClient({ token: "t", fetchImpl }).listRooms().catch((e) => e);
  assert.equal(error.code, "response_too_large");
  assert.ok(sent <= 7, `read ${sent} chunks`);
});

const roomBody = { room, join_url: "https://askone.org/r/ABC234", projector_url: "https://askone.org/r/ABC234/projector", host_url: "https://askone.org/rooms/ABC234" };
const SURVEY = "6f1c2a52-7d3e-4f1b-9a7e-0c5b8f2d4e11";
const QUESTION = "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";

test("host actions POST only the documented fields as JSON, with the token in the header", async () => {
  const { calls, fetchImpl } = fakeFetch([
    { body: roomBody }, { body: roomBody }, { body: roomBody },
    { body: { ...roomBody, survey: { id: SURVEY } } }, { body: { ...roomBody, survey: { id: SURVEY } } },
    { body: { ...roomBody, question: { id: QUESTION, status: "approved" } } },
    { body: { ...roomBody, question: { id: QUESTION, status: "answered" } } },
  ]);
  const client = createClient({ token: "secret", fetchImpl });
  await client.createRoom({ name: "Workshop", moderation: "ai", extra: "dropped" });
  await client.openRoom("ABC234");
  await client.closeRoom("ABC234");
  await client.createSurvey("ABC234", { question: "Next?", type: "poll", options: ["A", "B"], bogus: 1 });
  await client.closeSurvey("ABC234", SURVEY, { show_results: false });
  await client.moderateQuestion("ABC234", QUESTION, "approve");
  await client.answerQuestion("ABC234", QUESTION, {});
  assert.deepEqual(calls.map((c) => `${c.init.method} ${c.url.pathname}`), [
    "POST /api/v1/rooms",
    "POST /api/v1/rooms/ABC234/open",
    "POST /api/v1/rooms/ABC234/close",
    "POST /api/v1/rooms/ABC234/surveys",
    `POST /api/v1/rooms/ABC234/surveys/${SURVEY}/close`,
    `POST /api/v1/rooms/ABC234/questions/${QUESTION}/moderate`,
    `POST /api/v1/rooms/ABC234/questions/${QUESTION}/answer`,
  ]);
  const bodies = calls.map((c) => JSON.parse(c.init.body));
  assert.deepEqual(bodies[0], { name: "Workshop", moderation: "ai" });
  assert.deepEqual(bodies[1], {});
  assert.deepEqual(bodies[3], { question: "Next?", type: "poll", options: ["A", "B"] });
  assert.deepEqual(bodies[4], { show_results: false });
  assert.deepEqual(bodies[5], { action: "approve" });
  assert.deepEqual(bodies[6], {});
  for (const c of calls) {
    assert.equal(c.init.headers["Content-Type"], "application/json");
    assert.equal(c.init.headers.Authorization, "Bearer secret");
    assert.equal(c.init.redirect, "error");
    assert.ok(!c.url.href.includes("secret"));
    assert.equal(c.url.search, "");
  }
});

test("reads stay GET with no body", async () => {
  const { calls, fetchImpl } = fakeFetch([{ body: { rooms: [], next_cursor: null } }]);
  await createClient({ token: "t", fetchImpl }).listRooms();
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers["Content-Type"], undefined);
});

test("survey and question ids must be UUIDs before anything is sent", async () => {
  const { calls, fetchImpl } = fakeFetch([]);
  const client = createClient({ token: "t", fetchImpl });
  for (const call of [() => client.closeSurvey("ABC234", "../../rooms"), () => client.moderateQuestion("ABC234", "1 OR 1", "hide"),
    () => client.answerQuestion("ABC234", undefined, {})]) {
    const error = await call().catch((e) => e);
    assert.equal(error.code, "invalid_request");
  }
  assert.equal(calls.length, 0);
});

test("a write refused for a read-only token surfaces the server's own instruction", async () => {
  const { fetchImpl } = fakeFetch([{ status: 403, body: { error: { code: "insufficient_scope", message: "This token is read-only. Create a new token to change rooms." } } }]);
  const error = await createClient({ token: "ak_0123456789abcdef.secret", fetchImpl }).closeRoom("ABC234").catch((e) => e);
  assert.equal(error.code, "insufficient_scope");
  assert.match(error.message, /Create a new token/);
});

test("a write reply without the expected object is not reported as success", async () => {
  const { fetchImpl } = fakeFetch([{ body: { room } }]);
  const error = await createClient({ token: "t", fetchImpl }).moderateQuestion("ABC234", QUESTION, "hide").catch((e) => e);
  assert.equal(error.code, "invalid_response");
});

test("a write receipt must carry the room and the object it names", async () => {
  for (const reply of [{ room: [] }, { room: {} }, { room, survey: [] }]) {
    const { fetchImpl } = fakeFetch([{ body: reply }]);
    const call = "survey" in reply
      ? createClient({ token: "t", fetchImpl }).closeSurvey("ABC234", SURVEY, {})
      : createClient({ token: "t", fetchImpl }).closeRoom("ABC234");
    assert.equal((await call.catch((e) => e)).code, "invalid_response", JSON.stringify(reply));
  }
});
