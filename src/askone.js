// AskOne host API client (https://askone.org/api/v1) and the Q&A Markdown that
// get_room_qa returns. Reads need rooms:read; the host actions need rooms:write,
// which only tokens created after the write API shipped carry.

export const DEFAULT_URL = "https://askone.org";
const ROOM_CODE = /^[A-Za-z0-9]{6}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Visible ASCII only: anything else could make fetch echo the header value in an error.
const TOKEN = /^[!-~]{1,512}$/;
const PAGE_LIMIT = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_QA_PAGES = 20;
// Below the server's 1,000,000-character reply cap, which keeps far under the SDK's 10 MB limit.
export const MAX_QA_CHARS = 900_000;
// Room for the closing note, so truncating never pushes a reply over the budget.
const NOTE_RESERVE = 300;

export class AskOneError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function roomCode(code) {
  if (typeof code !== "string" || !ROOM_CODE.test(code)) {
    throw new AskOneError(400, "invalid_request", "A room code is six letters or digits, for example ABC234.");
  }
  return code;
}

/** Survey and question ids go into the URL path, so only a UUID may. */
export function childId(id, label) {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new AskOneError(400, "invalid_request", `${label} is a UUID from a read tool.`);
  }
  return id;
}

export function baseOrigin(value = DEFAULT_URL) {
  let url;
  // The value is never echoed: it could carry credentials (https://user:secret@host).
  try { url = new URL(value); } catch { throw new Error("ASKONE_URL is not a valid URL."); }
  if (url.username || url.password) throw new Error("ASKONE_URL must not contain a user name or password.");
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("ASKONE_URL must use https (http is allowed only for localhost).");
  }
  return url.origin;
}

export function createClient({ token, baseUrl = DEFAULT_URL, userAgent = "askone-mcp", fetchImpl = globalThis.fetch }) {
  if (!token) {
    throw new Error("ASKONE_API_TOKEN is not set. An organization admin creates one in AskOne: organization switcher → Manage → API tokens.");
  }
  if (!TOKEN.test(token)) {
    throw new Error("ASKONE_API_TOKEN contains spaces, line breaks or other characters a token never has. Copy it again from AskOne.");
  }
  const origin = baseOrigin(baseUrl);

  async function request(method, path, { params = {}, payload } = {}, shape, signal) {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": userAgent };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      // redirect: "error" keeps the token from following a redirect to another host.
      // Writes are never retried here: a lost reply is retried by the caller with a request_id.
      response = await fetchImpl(url, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "error",
        signal: withTimeout(signal),
      });
    } catch (error) {
      throw transportError(error, signal, origin);
    }
    let raw;
    try {
      raw = await readBounded(response);
    } catch (error) {
      if (error instanceof AskOneError) throw error;
      throw transportError(error, signal, origin);
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* malformed JSON is judged below */ }
    if (!response.ok) {
      // The server's own wording is passed on, but bounded and never with the token in it.
      const error = body?.error ?? {};
      const code = typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "http_error";
      const message = typeof error.message === "string"
        ? error.message.split(token).join("[redacted]").slice(0, 500)
        : `AskOne returned HTTP ${response.status}.`;
      throw new AskOneError(response.status, code, message, response.headers.get("retry-after") ?? undefined);
    }
    if (!body || typeof body !== "object" || !shape(body)) {
      throw new AskOneError(502, "invalid_response", `${origin} did not answer like the AskOne API. Check ASKONE_URL.`);
    }
    return body;
  }

  const get = (path, params, shape, signal) => request("GET", path, { params }, shape, signal);
  const post = (path, payload, shape, signal) => request("POST", path, { payload }, shape, signal);
  const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const isRoom = (value) => isObject(value) && typeof value.code === "string";
  const hasId = (value) => isObject(value) && typeof value.id === "string";
  const roomPage = (body) => isRoom(body.room) && Array.isArray(body.questions);
  const hasRoom = (body) => isRoom(body.room);
  const hasSurvey = (body) => isRoom(body.room) && hasId(body.survey);
  const hasQuestion = (body) => isRoom(body.room) && hasId(body.question);
  const room = (code) => `/api/v1/rooms/${roomCode(code)}`;
  return {
    listRooms: async ({ limit, cursor } = {}, signal) =>
      get("/api/v1/rooms", { limit, cursor }, (body) => Array.isArray(body.rooms), signal),
    getRoom: async (code, { limit, cursor, sort } = {}, signal) =>
      get(`/api/v1/rooms/${roomCode(code)}`, { limit, cursor, sort }, roomPage, signal),
    getSurveys: async (code, signal) =>
      get(`/api/v1/rooms/${roomCode(code)}/surveys`, {}, (body) => Array.isArray(body.surveys), signal),

    // Host actions (rooms:write). Each body carries only documented fields; undefined ones are dropped.
    createRoom: async ({ name, description, moderation, open, request_id } = {}, signal) =>
      post("/api/v1/rooms", { name, description, moderation, open, request_id }, hasRoom, signal),
    openRoom: async (code, signal) => post(`${room(code)}/open`, {}, hasRoom, signal),
    closeRoom: async (code, signal) => post(`${room(code)}/close`, {}, hasRoom, signal),
    createSurvey: async (code, { question, type, options, allow_multiple, correct_option, scale, low_label, high_label,
      show_results, launch, request_id } = {}, signal) =>
      post(`${room(code)}/surveys`, { question, type, options, allow_multiple, correct_option, scale, low_label, high_label,
        show_results, launch, request_id }, hasSurvey, signal),
    closeSurvey: async (code, surveyId, { show_results } = {}, signal) =>
      post(`${room(code)}/surveys/${childId(surveyId, "survey_id")}/close`, { show_results }, hasSurvey, signal),
    moderateQuestion: async (code, questionId, action, signal) =>
      post(`${room(code)}/questions/${childId(questionId, "question_id")}/moderate`, { action }, hasQuestion, signal),
    answerQuestion: async (code, questionId, { answer } = {}, signal) =>
      post(`${room(code)}/questions/${childId(questionId, "question_id")}/answer`, { answer }, hasQuestion, signal),
  };
}

// A page of the API is a few hundred KB at most; refuse anything far larger before parsing it.
async function readBounded(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AskOneError(502, "response_too_large", "AskOne returned more data than one request should (over 5 MB).");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Never pass a transport error's message through: it can quote request headers.
function transportError(error, signal, origin) {
  if (signal?.aborted) return new AskOneError(499, "cancelled", "The request was cancelled.");
  if (error?.name === "TimeoutError") return new AskOneError(504, "timeout", "AskOne did not answer within 30 seconds.");
  return new AskOneError(502, "network_error", `Could not reach ${origin}.`);
}

function withTimeout(signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Every visible question in a room, up to MAX_QA_PAGES pages of 100. */
export async function fetchAllQuestions(client, code, { maxPages = MAX_QA_PAGES, signal } = {}) {
  const questions = [];
  let room;
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw new AskOneError(499, "cancelled", "The request was cancelled.");
    const result = await client.getRoom(code, { limit: PAGE_LIMIT, sort: "top", cursor }, signal);
    room = result.room;
    questions.push(...result.questions);
    cursor = result.next_cursor;
    if (!cursor) return { room, questions, truncated: false };
  }
  return { room, questions, truncated: true };
}

/** Plain authored text stays text when pasted into a Markdown renderer. */
export function markdownText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/([\\`*_{}\[\]()#+.!|~-])/g, (match) => `\\${match}`).replace(/\r\n?/g, "\n");
}

/** FAQ order: answered first, then approved by votes, pending last and marked. */
export function roomQaMarkdown({ room, questions, truncated }, maxChars = MAX_QA_CHARS) {
  const rank = { answered: 0, approved: 1, pending: 2 };
  const ordered = [...questions].sort((a, b) => rank[a.status] - rank[b.status] || b.votes - a.votes
    || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const lines = [`# ${markdownText(room.name)} — Q&A`, "", `Room: ${room.code}`, ""];
  let size = lines.join("\n").length;
  let included = 0;
  for (const question of ordered) {
    let answer;
    if (question.answer) {
      const label = question.status === "answered" ? "Answer" : "Host comment";
      answer = `${label}:\n\n${markdownText(question.answer).replaceAll("\n", "\n\n")}`;
    } else {
      answer = question.status === "answered" ? "Answered in the session; no written answer." : "No written answer.";
    }
    const block = [`## ${markdownText(question.body).replaceAll("\n", " ")}`, "",
      `Votes: ${question.votes}${question.status === "pending" ? " · Pending moderation" : ""}`, "", answer, ""];
    const blockSize = block.join("\n").length + 1;
    if (size + blockSize > maxChars - NOTE_RESERVE) break;
    lines.push(...block);
    size += blockSize;
    included++;
  }
  if (!ordered.length) lines.push("No questions in this room.", "");
  if (truncated) {
    lines.push(`This room has more than ${MAX_QA_PAGES * PAGE_LIMIT} questions; only the first ${ordered.length} by AskOne's top order were read.`, "");
  }
  if (included < ordered.length) {
    lines.push(`Only ${included} of the ${ordered.length} questions read fit in one reply.`, "");
  }
  if (truncated || included < ordered.length) {
    lines.push("Use get_room_questions to page through the rest.", "");
  }
  return lines.join("\n");
}
