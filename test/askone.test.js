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
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(),
    json: async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); } });
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
