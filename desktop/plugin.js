// src/plugin.mjs
import * as sdk from "@hermes/plugin-sdk";
import { createElement as h2 } from "react";

// src/ui.mjs
import { createElement as h, forwardRef, useEffect, useRef, useState } from "react";

// src/answers.mjs
function emptyAnswers() {
  return { selectedByQuestion: {}, notesByQuestion: {}, dismissedByQuestion: {}, generalComments: "" };
}
function toggleDismissed(answers, questionId) {
  const dismissed = { ...answers.dismissedByQuestion || {} };
  if (dismissed[questionId]) delete dismissed[questionId];
  else dismissed[questionId] = true;
  return { ...answers, dismissedByQuestion: dismissed };
}
function toggleSelection(answers, questionId, optionId) {
  const selected = { ...answers.selectedByQuestion };
  if (selected[questionId] === optionId) delete selected[questionId];
  else selected[questionId] = optionId;
  return { ...answers, selectedByQuestion: selected };
}
function updateAnswer(answers, field, questionId, value) {
  return { ...answers, [field]: { ...answers[field], [questionId]: value } };
}
function setGeneralComments(answers, value) {
  return { ...answers, generalComments: value };
}
function decisionLabels(document) {
  const decisions = document?.decisions || [];
  const refs = decisions.map((item) => String(item?.ref || "").trim());
  const useRefs = refs.length > 0 && refs.every(Boolean) && new Set(refs).size === refs.length;
  return Object.fromEntries(decisions.map((item, index) => [item.id, `Q${useRefs ? refs[index] : index + 1}`]));
}
function serializeAnswers(document, answers, earlier = [], earlierAnswers = null) {
  const lines = [];
  const labels = decisionLabels(document);
  for (const question of document?.decisions || []) {
    const selected = answers?.selectedByQuestion?.[question.id];
    const option = question.options.find((item) => item.id === selected);
    const note = String(answers?.notesByQuestion?.[question.id] || "").trim();
    if (!option && !note) continue;
    lines.push(`${labels[question.id]}. ${question.question}`);
    if (option) lines.push(`- ${option.label}`);
    if (note) lines.push(`Notes: ${note}`);
    lines.push("");
  }
  earlier.forEach((question, index) => {
    const option = question.options.find((item) => item.id === earlierAnswers?.selectedByQuestion?.[question.fold]);
    const note = String(earlierAnswers?.notesByQuestion?.[question.fold] || "").trim();
    if (!option && !note) return;
    lines.push(`E${index + 1}. ${question.question} (earlier question)`);
    if (option) lines.push(`- ${option.label}`);
    if (note) lines.push(`Notes: ${note}`);
    lines.push("");
  });
  const comments = String(answers?.generalComments || "").trim();
  if (comments) {
    lines.push("General comments", comments);
  }
  return lines.join("\n").replace(/\n+$/, "");
}

// src/backend-client.mjs
var asObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
var atom = (value) => value && typeof value.get === "function" ? value.get() : value;
function ownerScope(host2) {
  const state = host2?.state || {};
  const owner = atom(state.focusedSessionOwner);
  if (owner?.connectionId && owner?.profile) return { connectionId: String(owner.connectionId).trim(), profile: String(owner.profile).trim() };
  if (!String(atom(state.focusedStoredSessionId) || "").trim()) return { connectionId: "", profile: "" };
  return activeOwnerScope(host2);
}
function activeOwnerScope(host2) {
  const state = host2?.state || {};
  return { connectionId: String(atom(state.connectionId) || "").trim(), profile: String(atom(state.profile) || "").trim() };
}
function isActiveOwner(host2, scope) {
  const focused = ownerScope(host2);
  const active = activeOwnerScope(host2);
  return Boolean(focused.connectionId && focused.profile && active.connectionId && active.profile && focused.connectionId === scope?.connectionId && focused.profile === scope?.profile && active.connectionId === scope?.connectionId && active.profile === scope?.profile);
}
function apiError(response, fallback) {
  const error = asObject(response?.error);
  const message = typeof error?.message === "string" ? error.message : fallback;
  const result = new Error(message);
  result.code = typeof error?.code === "string" ? error.code : "provider_error";
  result.retryable = error?.retryable === true;
  return result;
}
function validAssignment(value) {
  return asObject(value) && ["auto", "pinned", "unknown"].includes(value.state) && (value.provider === null || typeof value.provider === "string") && (value.model === null || typeof value.model === "string") && typeof value.hasCustomEndpoint === "boolean" && (value.observedAt === null || typeof value.observedAt === "string") && (value.reason === null || ["read_failed", "invalid_assignment"].includes(value.reason));
}
function capabilityError(code, message) {
  return Object.assign(new Error(message), { code });
}
function validateCapabilityScope(result, profile) {
  const readinessCodes = ["backend_unbound", "task_unavailable", "llm_unavailable", "assignment_unreadable"];
  if (result.profile === null && result.backendInstanceId === null && readinessCodes.includes(result.reason)) {
    const code = result.reason;
    const messages = {
      backend_unbound: "TL;DR model backend is not bound to this profile yet. Check again, or open Models \u2192 Auxiliary \u2192 TL;DR.",
      task_unavailable: "TL;DR is not registered on this profile. Check the plugin status, then try again.",
      llm_unavailable: "TL;DR model access is unavailable on this profile. Open Models \u2192 Auxiliary \u2192 TL;DR to configure it.",
      assignment_unreadable: "Could not check the TL;DR setting on this profile. Check again, or open Models \u2192 Auxiliary \u2192 TL;DR."
    };
    throw capabilityError(code, messages[code]);
  }
  if (result.profile !== profile || typeof result.backendInstanceId !== "string" || !result.backendInstanceId) {
    throw capabilityError("scope_mismatch", "TL;DR model backend is bound to a different profile.");
  }
  if (result.ready !== true) {
    const code = ["task_unavailable", "llm_unavailable", "assignment_unreadable"].includes(result.reason) ? result.reason : "backend_not_ready";
    const messages = {
      task_unavailable: "TL;DR is not registered on this profile. Check the plugin status, then try again.",
      llm_unavailable: "TL;DR model access is unavailable on this profile. Open Models \u2192 Auxiliary \u2192 TL;DR to configure it.",
      assignment_unreadable: "Could not check the TL;DR setting on this profile. Check again, or open Models \u2192 Auxiliary \u2192 TL;DR.",
      backend_not_ready: "TL;DR model backend is not ready on this profile. Check again, or open Models \u2192 Auxiliary \u2192 TL;DR."
    };
    throw capabilityError(code, messages[code]);
  }
}
function createBackendClient({ ctx, host: host2, rest = ctx?.rest } = {}) {
  let capability = null;
  let boundScope = null;
  const request = async (path, options) => {
    if (typeof rest !== "function") throw Object.assign(new Error("TL;DR model setup is unavailable on this host."), { code: "setup_required" });
    const result = await rest(path, options);
    if (!asObject(result)) throw Object.assign(new Error("TL;DR model backend returned an invalid response."), { code: "incompatible_version" });
    if (result.error) throw apiError(result, "TL;DR model request failed.");
    return result;
  };
  return {
    get capability() {
      return capability;
    },
    async capabilities({ expectedProfile = "" } = {}) {
      const scope = ownerScope(host2);
      if (!scope.connectionId || !scope.profile || !isActiveOwner(host2, scope)) throw Object.assign(new Error("TL;DR model setup requires this chat connection/profile to be active."), { code: "scope_mismatch" });
      const result = await request("/capabilities", { method: "GET", timeoutMs: 15e3 });
      if (result.apiVersion !== 3 || result.pluginId !== "tldr" || result.task !== "tldr_summary" || !validAssignment(result.assignment)) throw Object.assign(new Error("This Hermes host cannot run the TL;DR model setup."), { code: "incompatible_version" });
      const profile = expectedProfile || scope.profile;
      validateCapabilityScope(result, profile);
      capability = result;
      boundScope = { ...scope, targetProfile: profile };
      return result;
    },
    async generate({ requestId, expectedBackendInstanceId, expectedProfile, input }) {
      const scope = ownerScope(host2);
      if (!boundScope || !isActiveOwner(host2, boundScope) || scope.connectionId !== boundScope.connectionId || scope.profile !== boundScope.profile) throw Object.assign(new Error("TL;DR model setup requires this chat connection/profile to be active."), { code: "scope_mismatch" });
      const result = await request("/generate", { method: "POST", timeoutMs: 12e4, body: { apiVersion: 3, requestId, expectedBackendInstanceId, expectedProfile, input } });
      if (result.apiVersion !== 3 || result.backendInstanceId !== expectedBackendInstanceId || result.profile !== expectedProfile) throw Object.assign(new Error("TL;DR backend scope changed; no result was saved."), { code: "scope_mismatch" });
      if (typeof result.text !== "string" || !asObject(result.actual) || !["host-reported", "host-reported-unavailable"].includes(result.attribution)) throw Object.assign(new Error("TL;DR backend returned an invalid generation receipt."), { code: "provider_error" });
      return result;
    },
    async history({ expectedBackendInstanceId, expectedProfile, sessionId }) {
      const result = await request("/history", { method: "POST", timeoutMs: 2e4, body: { apiVersion: 3, expectedBackendInstanceId, expectedProfile, sessionId } });
      if (result.apiVersion !== 3 || result.backendInstanceId !== expectedBackendInstanceId || result.profile !== expectedProfile || result.sessionId !== sessionId || !Array.isArray(result.messages)) throw Object.assign(new Error("TL;DR could not read this saved chat."), { code: "provider_error" });
      return { count: result.messages.length, messages: result.messages };
    }
  };
}

// src/source.mjs
var EXCLUDED_KINDS = /* @__PURE__ */ new Set([
  "hidden",
  "system",
  "notification",
  "failure",
  "error",
  "tool_start",
  "tool_complete",
  "tool_generating",
  "process_complete",
  "process_start",
  "internal",
  "reasoning",
  "commentary",
  "model_switch",
  "personality_switch",
  "internal_notification",
  "async_delegation_complete",
  "auto_continue"
]);
var NON_BOUNDARY_USER_KINDS = /* @__PURE__ */ new Set(["model_switch", "personality_switch", "hidden", "steer"]);
var NON_CONTEXT_USER_KINDS = /* @__PURE__ */ new Set(["model_switch", "personality_switch", "hidden", "internal_notification", "process_complete", "async_delegation_complete", "auto_continue"]);
var MAX_SOURCE_TEXT = 32e3;
var OMITTED_MARKER = "[\u2026 middle of a long reply omitted \u2026]";
var SOURCE_HEAD = 7e3;
var SOURCE_TAIL = 23500;
var MAX_CONTEXT_ITEMS = 6;
var MAX_CONTEXT_TEXT = 9e3;
var MAX_CONTEXT_ITEM = 2500;
function atomValue(value) {
  return value && typeof value.get === "function" ? value.get() : value;
}
var kindOf = (message) => String(message?.display_kind || "").toLowerCase();
var hasText = (message) => typeof message?.text === "string" && Boolean(message.text.trim());
function readHostState(host2) {
  const state = host2?.state || {};
  const storedSessionId = String(atomValue(state.focusedStoredSessionId) || "").trim();
  let owner = atomValue(state.focusedSessionOwner) || null;
  let ownerFallback = false;
  if (!(owner?.connectionId && owner?.profile) && storedSessionId) {
    const connectionId = String(atomValue(state.connectionId) || "").trim();
    const profile = String(atomValue(state.profile) || "").trim();
    if (connectionId && profile) {
      owner = { connectionId, profile };
      ownerFallback = true;
    }
  }
  return {
    runtimeId: String(atomValue(state.focusedSessionId) || "").trim(),
    storedSessionId,
    owner,
    ownerFallback,
    busy: Boolean(atomValue(state.busy)),
    awaitingResponse: Boolean(atomValue(state.awaitingResponse))
  };
}
function eligibleAssistant(message) {
  if (!message || message.role !== "assistant" || !hasText(message)) return false;
  if (EXCLUDED_KINDS.has(kindOf(message))) return false;
  if (message.hidden === true || message.is_hidden === true || message.failed === true || message.interrupted === true) return false;
  return true;
}
function isTurnBoundary(message) {
  return message?.role === "user" && !NON_BOUNDARY_USER_KINDS.has(kindOf(message));
}
function latestTurn(history) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) if (eligibleAssistant(messages[index])) {
    lastAssistant = index;
    break;
  }
  if (lastAssistant < 0) return { messages, start: messages.length, segments: [] };
  let start = 0;
  for (let index = lastAssistant; index >= 0; index -= 1) if (isTurnBoundary(messages[index])) {
    start = index + 1;
    break;
  }
  const segments = messages.slice(start, lastAssistant + 1).filter(eligibleAssistant);
  return { messages, start, segments };
}
function trimSource(text) {
  if (text.length <= MAX_SOURCE_TEXT) return { text, trimmed: false };
  return { text: `${text.slice(0, SOURCE_HEAD)}

${OMITTED_MARKER}

${text.slice(-SOURCE_TAIL)}`, trimmed: true };
}
function selectLatestAssistant(history) {
  const { segments } = latestTurn(history);
  if (!segments.length) return { status: "empty" };
  const rowId = Number(segments.at(-1).row_id);
  if (!Number.isSafeInteger(rowId) || rowId <= 0) return { status: "not_persisted" };
  const joined = segments.map((segment) => segment.text.trim()).join("\n\n");
  const { text, trimmed } = trimSource(joined);
  return { status: "ready", source: { rowId, text }, sourceTrimmed: trimmed, segmentCount: segments.length };
}
function buildModelInput(history, source) {
  const { messages, start } = latestTurn(history);
  const preceding = messages.slice(0, start).filter((message) => (message?.role === "user" || message?.role === "assistant") && hasText(message)).filter((message) => message.role === "user" ? !NON_CONTEXT_USER_KINDS.has(kindOf(message)) : eligibleAssistant(message));
  let contextTruncated = preceding.length > MAX_CONTEXT_ITEMS;
  const selected = [];
  let size = 0;
  for (const message of preceding.slice(-MAX_CONTEXT_ITEMS).reverse()) {
    let text = message.text.trim();
    if (text.length > MAX_CONTEXT_ITEM) {
      text = `[\u2026] ${text.slice(-MAX_CONTEXT_ITEM)}`;
      contextTruncated = true;
    }
    if (size + text.length > MAX_CONTEXT_TEXT) {
      contextTruncated = true;
      break;
    }
    selected.push({ role: message.role, text });
    size += text.length;
  }
  const context = selected.reverse();
  return { schemaVersion: 1, source, context, contextTruncated: contextTruncated || source.text.includes(OMITTED_MARKER) };
}
async function sha256Text(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function scopeKey({ connectionId, profile, targetProfile, storedSessionId, rowId, sourceTextSha256 }) {
  return JSON.stringify(["tldr", 1, connectionId, profile, targetProfile, storedSessionId, rowId, sourceTextSha256]);
}
function sameScope(a, b) {
  return Boolean(a && b && a.runtimeId === b.runtimeId && a.storedSessionId === b.storedSessionId && a.owner?.connectionId === b.owner?.connectionId && a.owner?.profile === b.owner?.profile);
}
var MAX_TOOLS = 40;
var MAX_TOOL_NAME = 64;
var MAX_TOOL_CONTEXT = 120;
var TRANSCRIPT_BUDGET = 3e4;
var FIRST_REQUEST_MAX = 3e3;
var SESSION_OMITTED_MARKER = "[\u2026 earlier turns omitted \u2026]";
var rowIdOf = (message) => {
  const value = Number(message?.row_id);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};
function maxRowId(history) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  return messages.reduce((max, message) => Math.max(max, rowIdOf(message)), 0);
}
var isUserWords = (message) => message?.role === "user" && hasText(message) && !NON_CONTEXT_USER_KINDS.has(kindOf(message));
function toolLog(messages) {
  const tools = [];
  for (const message of messages) {
    if (message?.role !== "tool") continue;
    const name = String(message.name || "tool").slice(0, MAX_TOOL_NAME) || "tool";
    const context = String(message.context || "").replace(/\s+/g, " ").trim().slice(0, MAX_TOOL_CONTEXT);
    tools.push({ name, context });
  }
  return tools.slice(-MAX_TOOLS).map((item, i) => ({ i, ...item }));
}
function transcriptTurns(messages) {
  const turns = [];
  for (const message of messages) {
    let role = null;
    if (eligibleAssistant(message)) role = "ASSISTANT";
    else if (isUserWords(message)) role = "USER";
    if (!role) continue;
    const text = message.text.trim();
    const last = turns.at(-1);
    if (last && last.role === role && role === "ASSISTANT") {
      last.text += `

${text}`;
      last.rowId = rowIdOf(message) || last.rowId;
    } else turns.push({ role, text, rowId: rowIdOf(message) });
  }
  return turns;
}
var renderTurn = (turn) => `[${turn.role}] ${turn.text}`;
function budgetTurns(turns, budget) {
  const kept = [];
  let size = 0;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    let text = renderTurn(turns[index]);
    if (!kept.length && text.length > budget) text = `${text.slice(0, 4e3)}

${OMITTED_MARKER}

${text.slice(-(budget - 4100))}`;
    if (size + text.length + 2 > budget && kept.length) break;
    kept.unshift({ turn: turns[index], text });
    size += text.length + 2;
  }
  return kept;
}
function lastReplySelection(history) {
  const selected = selectLatestAssistant(history);
  if (selected.status !== "ready") return selected;
  const { messages, start } = latestTurn(history);
  const lastAssistantIndex = messages.findLastIndex(eligibleAssistant);
  const input = buildModelInput(history, selected.source);
  return {
    status: "ready",
    mode: "last",
    source: selected.source,
    context: input.context,
    contextTruncated: input.contextTruncated,
    tools: toolLog(messages.slice(start, lastAssistantIndex + 1)),
    coverage: { kind: "last", parts: selected.segmentCount, trimmed: selected.sourceTrimmed },
    userTexts: input.context.filter((item) => item.role === "user").map((item) => item.text)
  };
}
function selectForMode(history, mode = "last", { lastSeenRowId = 0 } = {}) {
  if (mode === "last") return lastReplySelection(history);
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const latest = selectLatestAssistant(history);
  if (latest.status !== "ready") return latest;
  if (mode === "since") {
    if (!lastSeenRowId) return { ...lastReplySelection(history), fallback: "first_check" };
    const startIndex2 = messages.findIndex((message) => rowIdOf(message) > lastSeenRowId);
    const window2 = startIndex2 < 0 ? [] : messages.slice(startIndex2);
    const turns2 = transcriptTurns(window2);
    if (!turns2.some((turn) => turn.role === "ASSISTANT")) return { status: "nothing_new" };
    const assistantTurns = turns2.filter((turn) => turn.role === "ASSISTANT").length;
    if (assistantTurns === 1 && turns2.at(-1).role === "ASSISTANT" && turns2.length <= 2) return { ...lastReplySelection(history), fallback: "single_reply" };
    const kept2 = budgetTurns(turns2, TRANSCRIPT_BUDGET);
    const omitted = turns2.length - kept2.length;
    const text = [omitted ? SESSION_OMITTED_MARKER : null, ...kept2.map((item) => item.text)].filter(Boolean).join("\n\n");
    const before = transcriptTurns(messages.slice(0, startIndex2 < 0 ? messages.length : startIndex2)).slice(-2).map((turn) => ({ role: turn.role === "USER" ? "user" : "assistant", text: turn.text.slice(-2e3) }));
    return {
      status: "ready",
      mode,
      source: { rowId: latest.source.rowId, text },
      context: before,
      contextTruncated: omitted > 0,
      tools: toolLog(window2),
      coverage: { kind: "since", turns: kept2.length, total: turns2.length, replies: assistantTurns, fromRowId: lastSeenRowId },
      userTexts: kept2.filter((item) => item.turn.role === "USER").map((item) => item.turn.text)
    };
  }
  const turns = transcriptTurns(messages);
  const first = turns.find((turn) => turn.role === "USER");
  const firstText = first ? renderTurn({ ...first, text: first.text.length > FIRST_REQUEST_MAX ? `${first.text.slice(0, FIRST_REQUEST_MAX)} [\u2026]` : first.text }) : "";
  const kept = budgetTurns(turns, TRANSCRIPT_BUDGET - firstText.length - SESSION_OMITTED_MARKER.length - 8);
  const includesFirst = first && kept.some((item) => item.turn === first);
  const parts = includesFirst || !first ? kept.map((item) => item.text) : [firstText, SESSION_OMITTED_MARKER, ...kept.map((item) => item.text)];
  const startTurn = kept[0]?.turn;
  const startIndex = startTurn ? messages.findIndex((message) => rowIdOf(message) && rowIdOf(message) >= (startTurn.rowId || 0)) : 0;
  return {
    status: "ready",
    mode,
    source: { rowId: latest.source.rowId, text: parts.join("\n\n") },
    context: [],
    contextTruncated: !includesFirst && Boolean(first),
    tools: toolLog(messages.slice(Math.max(0, startIndex))),
    coverage: { kind: "session", turns: kept.length + (includesFirst || !first ? 0 : 1), total: turns.length, firstIncluded: Boolean(first) },
    userTexts: [first?.text, ...kept.filter((item) => item.turn.role === "USER").map((item) => item.turn.text)].filter(Boolean)
  };
}
function coverageLabel(coverage, fallback) {
  if (!coverage) return "Summary of the latest reply";
  if (fallback === "first_check") return "First TL;DR in this chat \xB7 showing the last reply";
  if (fallback === "single_reply") return "Since you last checked \xB7 1 new reply";
  if (coverage.kind === "last") return `Covers the last reply${coverage.parts > 1 ? ` (${coverage.parts} parts)` : ""}${coverage.trimmed ? " \xB7 long reply, middle trimmed" : ""}`;
  if (coverage.kind === "since") return `Since you last checked \xB7 ${coverage.replies} ${coverage.replies === 1 ? "reply" : "replies"}${coverage.turns < coverage.total ? ` \xB7 latest ${coverage.turns} of ${coverage.total} turns` : ""}`;
  if (coverage.kind === "session") return coverage.turns >= coverage.total ? `Whole session \xB7 all ${coverage.total} turns` : `Whole session \xB7 your first request + latest ${Math.max(0, coverage.turns - 1)} of ${coverage.total} turns (older middle not read)`;
  return "";
}

// src/schema.mjs
var MAX_TEXT = 2e3;
var MAX_CHANGES = 12;
var MAX_RISKS = 8;
var MAX_DECISIONS = 10;
var MAX_OPTIONS = 5;
var MAX_LOCKED = 8;
var isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
var clean = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return "";
  const result = value.replace(/\s+/g, " ").trim();
  return result.length > MAX_TEXT ? `${result.slice(0, MAX_TEXT - 1)}\u2026` : result;
};
var textOf = (value) => isObject(value) ? clean(value.text ?? value.label ?? value.title ?? value.summary ?? value.description) : clean(value);
var list = (value) => Array.isArray(value) ? value : value === void 0 || value === null || value === "" ? [] : [value];
var slug = (value, fallback) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || fallback;
var STATUS = {
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
  verified: "completed",
  shipped: "completed",
  fixed: "completed",
  proposed: "proposed",
  proposal: "proposed",
  planned: "proposed",
  pending: "proposed",
  next: "proposed",
  todo: "proposed",
  recommended: "proposed",
  suggested: "proposed",
  "in progress": "proposed",
  in_progress: "proposed",
  uncertain: "uncertain",
  unverified: "uncertain",
  partial: "uncertain",
  failed: "uncertain",
  blocked: "uncertain",
  unknown: "uncertain"
};
var normalizeStatus = (value) => STATUS[clean(value).toLowerCase()] || "uncertain";
var fold = (value) => String(value || "").normalize("NFKC").replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2013\u2014\u2212]/g, "-").replace(/\u2026/g, "...").replace(/\s+/g, " ").trim().toLowerCase();
function grounded(evidence, sources) {
  const needle = fold(evidence).replace(/^["']|["']$/g, "").replace(/^\.\.\.|\.\.\.$/g, "").trim();
  if (needle.length < 3) return "";
  return sources.some((source) => fold(source).includes(needle)) ? clean(evidence) : "";
}
function extractJson(raw) {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("The model returned an empty response.");
  if (raw.length > 262144) throw new Error("The model response was too large.");
  let text = raw.trim().replace(/^\uFEFF/, "");
  const fenced = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fenced && fenced[1].includes("{")) text = fenced[1].trim();
  try {
    return JSON.parse(text);
  } catch {
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
    }
  }
  throw new Error("The model did not return a readable summary. Try Regenerate.");
}
function normalizeDecision(item, index, sources, usedIds) {
  if (!isObject(item)) return null;
  const rawQuestion = clean(item.question ?? item.title ?? item.prompt);
  const leading = rawQuestion.match(/^(?:q(?:uestion)?\s*)?(\d{1,3})[.):]\s+/i);
  let question = rawQuestion.replace(/^(?:q(?:uestion)?\s*)?\d{1,3}[.):]\s+/i, "").replace(/\*\*|__|`/g, "").trim();
  const mark = question.indexOf("?");
  if (mark > 0 && mark < question.length - 1) question = question.slice(0, mark + 1);
  if (!question) return null;
  const optionIds = /* @__PURE__ */ new Set();
  const options = [];
  for (const [optionIndex, option] of list(item.options ?? item.choices).entries()) {
    const label = textOf(option);
    if (!label || options.some((existing) => existing.label.toLowerCase() === label.toLowerCase())) continue;
    let id2 = isObject(option) ? clean(option.id) : "";
    if (!id2 || optionIds.has(id2)) id2 = slug(label, `o${optionIndex + 1}`);
    while (optionIds.has(id2)) id2 = `${id2}-${optionIndex + 1}`;
    optionIds.add(id2);
    options.push({ id: id2, label });
    if (options.length >= MAX_OPTIONS) break;
  }
  if (options.length < 2) return null;
  let recommendation = null;
  const rec = item.recommendation ?? item.recommended;
  if (isObject(rec) || typeof rec === "string") {
    const wanted = isObject(rec) ? clean(rec.optionId ?? rec.option ?? rec.id ?? rec.label) : clean(rec);
    const match = options.find((option) => option.id === wanted) || options.find((option) => option.label.toLowerCase() === wanted.toLowerCase());
    if (match) recommendation = { optionId: match.id, reason: isObject(rec) ? clean(rec.reason ?? rec.why) : "" };
  }
  let id = clean(item.id) || `d${index + 1}`;
  while (usedIds.has(id)) id = `${id}-${index + 1}`;
  usedIds.add(id);
  const ref = clean(item.ref ?? item.number ?? leading?.[1]).replace(/^(q|question)\s*/i, "").replace(/[.):]+$/, "").slice(0, 6);
  return { id, ref: ref || null, question, options, recommendation, context: clean(item.context), eli5: clean(item.eli5), evidence: grounded(item.evidence ?? item.quote, sources) };
}
var STATES = { done: "done", complete: "done", completed: "done", finished: "done", blocked: "blocked", stuck: "blocked", running: "running", in_progress: "running", "in progress": "running", working: "running", waiting: "waiting", waiting_on_you: "waiting", "waiting on you": "waiting", needs_input: "waiting", answer: "answer", answered: "answer", info: "answer" };
function normalizeStatusBlock(value) {
  if (!isObject(value)) {
    const state2 = STATES[clean(value).toLowerCase()];
    return state2 ? { state: state2, verified: "", background: "", next: "", needs: "" } : null;
  }
  const state = STATES[clean(value.state ?? value.status).toLowerCase()];
  if (!state) return null;
  return { state, verified: clean(value.verified), background: clean(value.background ?? value.running), next: clean(value.next ?? value.nextAction), needs: clean(value.needs ?? value.needsFromYou) };
}
var toolIndex = (value, tools) => {
  const index = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isSafeInteger(index) && index >= 0 && index < tools.length ? index : null;
};
function parseModelDocument(raw, evidenceTexts = [], { tools = null, userTexts = [] } = {}) {
  const value = extractJson(raw);
  if (!isObject(value)) throw new Error("The model did not return a readable summary. Try Regenerate.");
  const sources = evidenceTexts.filter((item) => typeof item === "string");
  const brief = isObject(value.brief) ? value.brief : value;
  const changes = [];
  for (const item of list(brief.changes)) {
    const text = textOf(item);
    if (!text) continue;
    const change = { text, status: isObject(item) ? normalizeStatus(item.status) : "uncertain" };
    if (Array.isArray(tools)) {
      const index = isObject(item) ? toolIndex(item.tool ?? item.toolIndex, tools) : null;
      change.evidence = index === null ? "stated" : "shown";
      if (index !== null) change.tool = { name: tools[index].name, context: tools[index].context };
    }
    changes.push(change);
    if (changes.length >= MAX_CHANGES) break;
  }
  const risks = list(brief.risks).map(textOf).filter(Boolean).slice(0, MAX_RISKS);
  const usedIds = /* @__PURE__ */ new Set();
  const decisions = list(value.decisions).map((item, index) => normalizeDecision(item, index, sources, usedIds)).filter(Boolean).slice(0, MAX_DECISIONS);
  const lockedDecisions = list(value.lockedDecisions).filter(isObject).map((item) => ({
    title: clean(item.title),
    resolution: clean(item.resolution ?? item.decision),
    rationale: clean(item.rationale ?? item.reason),
    evidence: grounded(item.evidence, sources)
  })).filter((item) => item.title && item.resolution).slice(0, MAX_LOCKED);
  const questions = decisions.map((item) => item.question);
  const folded = new Set(questions.map(fold));
  const extras = list(brief.needsInput).map(textOf).filter((item) => item && !folded.has(fold(item)));
  const needsInput = [...questions, ...extras].slice(0, MAX_DECISIONS + 4);
  let bottomLine = clean(brief.bottomLine ?? brief.bottom_line ?? brief.summary ?? value.bottomLine ?? value.summary ?? value.tldr);
  if (!bottomLine && changes.length) bottomLine = changes[0].text;
  if (!bottomLine) throw new Error("The model returned a summary without a bottom line. Try Regenerate.");
  const status = normalizeStatusBlock(brief.status ?? value.status);
  const conflicts = list(value.conflicts ?? brief.conflicts).filter(isObject).map((item) => ({ quote: grounded(item.quote, userTexts.filter((text) => typeof text === "string")), text: clean(item.text ?? item.reason) })).filter((item) => item.quote && item.text).slice(0, 3);
  return { schemaVersion: 2, brief: { status, bottomLine, changes, needsInput, risks }, conflicts, decisions, lockedDecisions };
}

// src/prompt.mjs
var PROMPT_VERSION = "tldr-v2";
var PROMPT_VERSION_V2 = "tldr-v6";

// src/options.mjs
var SETTINGS_KEY = "settings-v6";
var MODES = ["last", "since", "session"];
var LENGTHS = ["S", "M", "L"];
var DEFAULT_PREFERENCES = 'Plain words; skip file paths unless I need them to act.';
var MAX_PREFERENCES = 500;
var AUTO_THRESHOLDS = [800, 1500, 3e3];
var AUTO_CAPS = [10, 30, 60];
var DEFAULT_SETTINGS = Object.freeze({
  defaultMode: "last",
  defaultLength: "M",
  statusFirst: true,
  evidence: true,
  conflicts: true,
  decisionScope: "design",
  recommend: "permanent",
  preferences: DEFAULT_PREFERENCES,
  answers: "insert",
  remindSkipped: false,
  auto: false,
  autoThreshold: 1500,
  autoDailyCap: 30
});
var pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
var bool = (value, fallback) => typeof value === "boolean" ? value : fallback;
function normalizeSettings(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const d = DEFAULT_SETTINGS;
  return {
    defaultMode: pick(raw.defaultMode, MODES, d.defaultMode),
    defaultLength: pick(raw.defaultLength, LENGTHS, d.defaultLength),
    statusFirst: bool(raw.statusFirst, d.statusFirst),
    evidence: bool(raw.evidence, d.evidence),
    conflicts: bool(raw.conflicts, d.conflicts),
    decisionScope: pick(raw.decisionScope, ["design", "all"], d.decisionScope),
    recommend: pick(raw.recommend, ["permanent", "balanced", "quick"], d.recommend),
    preferences: typeof raw.preferences === "string" ? raw.preferences.slice(0, MAX_PREFERENCES) : d.preferences,
    answers: pick(raw.answers, ["insert", "copy"], d.answers),
    remindSkipped: bool(raw.remindSkipped, d.remindSkipped),
    auto: bool(raw.auto, d.auto),
    autoThreshold: pick(raw.autoThreshold, AUTO_THRESHOLDS, d.autoThreshold),
    autoDailyCap: pick(raw.autoDailyCap, AUTO_CAPS, d.autoDailyCap)
  };
}
function loadSettings(storage) {
  try {
    return normalizeSettings(storage?.get(SETTINGS_KEY, {}));
  } catch {
    return normalizeSettings({});
  }
}
function saveSettings(storage, value) {
  const next = normalizeSettings(value);
  try {
    storage?.set(SETTINGS_KEY, next);
  } catch {
  }
  return next;
}
function modelOptions(settings, length) {
  return {
    length: pick(length, LENGTHS, settings.defaultLength),
    statusFirst: settings.statusFirst,
    evidence: settings.evidence,
    conflicts: settings.conflicts,
    decisionScope: settings.decisionScope,
    recommend: settings.recommend,
    preferences: settings.preferences.trim().slice(0, MAX_PREFERENCES)
  };
}
function settingsHash(settings) {
  const { statusFirst, evidence, conflicts, decisionScope, recommend } = settings;
  return JSON.stringify([statusFirst, evidence, conflicts, decisionScope, recommend, settings.preferences.trim()]);
}
var AUTO_LEDGER_KEY = "auto-ledger-v1";
var today = (now2 = /* @__PURE__ */ new Date()) => now2.toISOString().slice(0, 10);
function autoUsage(storage, now2) {
  try {
    const value = storage?.get(AUTO_LEDGER_KEY, {});
    return value?.day === today(now2) && Number.isSafeInteger(value.count) ? value.count : 0;
  } catch {
    return 0;
  }
}
function recordAuto(storage, now2) {
  const count = autoUsage(storage, now2) + 1;
  try {
    storage?.set(AUTO_LEDGER_KEY, { day: today(now2), count });
  } catch {
  }
  return count;
}

// src/history.mjs
var fold2 = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
var STATE_LABEL = { done: "Done", blocked: "Blocked", running: "Running", waiting: "Waiting on you", answer: "Answer" };
function diffDocuments(previous, next) {
  if (!previous || !next) return [];
  const lines = [];
  const before = previous.brief?.status?.state;
  const after = next.brief?.status?.state;
  if (before && after && before !== after) lines.push({ kind: "status", text: `Status: ${STATE_LABEL[before]} \u2192 ${STATE_LABEL[after]}` });
  const questions = (doc) => new Map((doc.decisions || []).map((item) => [fold2(item.question), item.question]));
  const oldQ = questions(previous);
  const newQ = questions(next);
  for (const [key, text] of oldQ) if (!newQ.has(key)) lines.push({ kind: "resolved", text: `Resolved: \u201C${text}\u201D` });
  for (const [key, text] of newQ) if (!oldQ.has(key)) lines.push({ kind: "added", text: `New decision: \u201C${text}\u201D` });
  const risks = (doc) => new Map((doc.brief?.risks || []).map((item) => [fold2(item), item]));
  const oldR = risks(previous);
  const newR = risks(next);
  for (const [key, text] of oldR) if (!newR.has(key)) lines.push({ kind: "cleared", text: `Risk cleared: ${text}` });
  for (const [key, text] of newR) if (!oldR.has(key)) lines.push({ kind: "risk", text: `New risk: ${text}` });
  return lines.slice(0, 8);
}
var MODE_LABEL = { last: "Last reply", since: "Since I checked", session: "Whole session" };
var LENGTH_LABEL = { S: "Glance", M: "Standard", L: "Detailed" };
function chatHistory(records, storedSessionId, sameOwner) {
  const entries = [];
  for (const [key, revisions] of Object.entries(records || {})) {
    let parts;
    try {
      parts = JSON.parse(key);
    } catch {
      continue;
    }
    if (!Array.isArray(parts) || parts[5] !== storedSessionId || sameOwner && !sameOwner(parts)) continue;
    for (const revision of revisions || []) {
      if (!revision?.document) continue;
      entries.push({ key, revisionId: revision.revisionId, createdAt: revision.createdAt || "", mode: revision.view?.mode || "last", length: revision.view?.length || "M", document: revision.document, hasAnswers: Boolean(Object.keys(revision.answers?.selectedByQuestion || {}).length || Object.values(revision.answers?.notesByQuestion || {}).some((value) => String(value).trim()) || String(revision.answers?.generalComments || "").trim()) });
    }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries.map((entry, index) => ({ ...entry, label: `${MODE_LABEL[entry.mode] || "Last reply"} \xB7 ${LENGTH_LABEL[entry.length] || "Standard"}`, changes: diffDocuments(entries[index + 1]?.document, entry.document) }));
}

// src/reminders.mjs
var REMINDER_KEY = "skipped-questions-v1";
var MAX_OPEN = 20;
var MAX_DISMISSED = 200;
var MAX_CHATS = 100;
var foldQuestion = (value) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function readAll(storage) {
  try {
    const value = storage?.get(REMINDER_KEY, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function writeAll(storage, all) {
  const keys = Object.keys(all);
  if (keys.length > MAX_CHATS) {
    keys.sort((a, b) => String(all[a]?.touchedAt || "").localeCompare(String(all[b]?.touchedAt || "")));
    for (const key of keys.slice(0, keys.length - MAX_CHATS)) delete all[key];
  }
  try {
    storage?.set(REMINDER_KEY, all);
  } catch {
  }
}
function chatEntry(all, chatKey) {
  const entry = all[chatKey];
  return { open: Array.isArray(entry?.open) ? entry.open : [], dismissed: Array.isArray(entry?.dismissed) ? entry.dismissed : [] };
}
function loadReminders(storage, chatKey) {
  if (!chatKey) return { open: [], dismissed: [] };
  return chatEntry(readAll(storage), chatKey);
}
function earlierQuestions(storage, chatKey, document) {
  const onScreen = new Set((document?.decisions || []).map((item) => foldQuestion(item.question)));
  return loadReminders(storage, chatKey).open.filter((item) => !onScreen.has(item.fold));
}
var answered = (answers, id) => Boolean(answers?.selectedByQuestion?.[id] || String(answers?.notesByQuestion?.[id] || "").trim());
function commitAnswers(storage, chatKey, { document, answers, earlier = [], earlierAnswers = null, now: now2 = (/* @__PURE__ */ new Date()).toISOString() }) {
  if (!chatKey) return [];
  const all = readAll(storage);
  const entry = chatEntry(all, chatKey);
  const dismissed = new Set(entry.dismissed);
  let open = entry.open.filter((item) => !dismissed.has(item.fold));
  const remove = (fold3) => {
    open = open.filter((item) => item.fold !== fold3);
  };
  for (const item of earlier) {
    if (answered(earlierAnswers, item.fold)) remove(item.fold);
    if (earlierAnswers?.dismissedByQuestion?.[item.fold]) {
      remove(item.fold);
      dismissed.add(item.fold);
    }
  }
  for (const decision of document?.decisions || []) {
    const fold3 = foldQuestion(decision.question);
    if (!fold3) continue;
    if (answers?.dismissedByQuestion?.[decision.id]) {
      remove(fold3);
      dismissed.add(fold3);
      continue;
    }
    if (answered(answers, decision.id)) {
      remove(fold3);
      continue;
    }
    if (dismissed.has(fold3) || open.some((item) => item.fold === fold3)) continue;
    open.push({ fold: fold3, question: decision.question, options: decision.options.map((option) => ({ id: option.id, label: option.label })), recommendation: decision.recommendation ? { optionId: decision.recommendation.optionId, reason: decision.recommendation.reason || "" } : null, context: decision.context || "", eli5: decision.eli5 || "", addedAt: now2 });
  }
  open = open.slice(-MAX_OPEN);
  all[chatKey] = { open, dismissed: [...dismissed].slice(-MAX_DISMISSED), touchedAt: now2 };
  writeAll(storage, all);
  return open;
}
function dismissReminder(storage, chatKey, fold3, now2 = (/* @__PURE__ */ new Date()).toISOString()) {
  if (!chatKey || !fold3) return [];
  const all = readAll(storage);
  const entry = chatEntry(all, chatKey);
  const open = entry.open.filter((item) => item.fold !== fold3);
  all[chatKey] = { open, dismissed: [.../* @__PURE__ */ new Set([...entry.dismissed, fold3])].slice(-MAX_DISMISSED), touchedAt: now2 };
  writeAll(storage, all);
  return open;
}
function clearReminders(storage, chatKey) {
  if (!chatKey) return;
  const all = readAll(storage);
  delete all[chatKey];
  writeAll(storage, all);
}
function carryAnswers(previousDocument, previousAnswers, nextDocument) {
  const result = { selectedByQuestion: {}, notesByQuestion: {}, dismissedByQuestion: {}, generalComments: String(previousAnswers?.generalComments || "") };
  if (!previousDocument || !previousAnswers) return result;
  const byFold = new Map((previousDocument.decisions || []).map((item) => [foldQuestion(item.question), item]));
  for (const decision of nextDocument?.decisions || []) {
    const old = byFold.get(foldQuestion(decision.question));
    if (!old) continue;
    const oldOption = old.options.find((option) => option.id === previousAnswers.selectedByQuestion?.[old.id]);
    const match = oldOption && decision.options.find((option) => foldQuestion(option.label) === foldQuestion(oldOption.label));
    if (match) result.selectedByQuestion[decision.id] = match.id;
    const note = previousAnswers.notesByQuestion?.[old.id];
    if (String(note || "").trim()) result.notesByQuestion[decision.id] = note;
    if (previousAnswers.dismissedByQuestion?.[old.id]) result.dismissedByQuestion[decision.id] = true;
  }
  return result;
}

// src/controller.mjs
var STORAGE_KEY = "revisions-v1";
var SELECTION_KEY = "selected-revisions-v1";
var SETUP_KEY = "model-setup-ui-v1";
var LAST_SEEN_KEY = "last-seen-v1";
var AUTO_DEBOUNCE_MS = 2500;
var ROUTE_TTL_MS = 15e3;
var WATCH_DEBOUNCE_MS = 1200;
var MAX_REVISIONS_PER_SOURCE = 5;
var MAX_SOURCES_STORED = 60;
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var revisionId = () => globalThis.crypto?.randomUUID?.() || `rev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
function assertRoute(route) {
  if (!route || !String(route.connectionId || "").trim() || !String(route.profile || "").trim() || !String(route.targetProfile || "").trim() || !route.mode) throw new Error("This chat\u2019s Hermes connection isn\u2019t ready yet. Try again in a moment.");
}
function matchingRoute(routes, owner) {
  const matches = (routes || []).filter((route) => route?.connectionId === owner?.connectionId && route?.profile === owner?.profile);
  if (matches.length !== 1) throw new Error(matches.length ? "This chat matches more than one Hermes connection; try again." : "This chat\u2019s Hermes connection isn\u2019t ready yet. Try again in a moment.");
  assertRoute(matches[0]);
  return matches[0];
}
function sameRoute(a, b) {
  return Boolean(a && b && a.connectionId === b.connectionId && a.profile === b.profile && a.targetProfile === b.targetProfile && a.mode === b.mode);
}
function setupRoute(scope) {
  if (!scope || !String(scope.connectionId || "").trim() || !String(scope.ownerProfile || scope.profile || "").trim() || !String(scope.targetProfile || "").trim()) return null;
  return { connectionId: scope.connectionId, profile: scope.ownerProfile || scope.profile, targetProfile: scope.targetProfile };
}
function sameSetupRoute(a, b) {
  return Boolean(a && b && a.connectionId === b.connectionId && a.profile === b.profile && a.targetProfile === b.targetProfile);
}
function hasAnswerContent(answers) {
  return Boolean(Object.keys(answers?.selectedByQuestion || {}).length || Object.values(answers?.notesByQuestion || {}).some((value) => String(value).trim()) || String(answers?.generalComments || "").trim());
}
function authRejected(error) {
  const code = error?.code ?? error?.status ?? error?.data?.code ?? error?.data?.status;
  const reason = error?.reason ?? error?.data?.reason;
  return code === 401 || code === 403 || code === "401" || code === "403" || code === "unauthorized" || code === "forbidden" || reason === "invalid_or_expired_session" || reason === "unauthorized" || reason === "forbidden";
}
var ownerKey = (state) => JSON.stringify([state?.owner?.connectionId || "", state?.owner?.profile || ""]);
var controllerScopeKey = (state) => JSON.stringify([state?.runtimeId || "", state?.storedSessionId || "", state?.owner?.connectionId || "", state?.owner?.profile || ""]);
var hasFocusedOwner = (state) => Boolean(state?.owner?.connectionId && state?.owner?.profile);
var errorText = (error, fallback) => error instanceof Error && error.message ? error.message : fallback;
function createController({ host: host2, storage, backendClient = null, onChange = () => void 0, routeReader = null }) {
  if (!host2?.state || typeof host2.profileRoutes !== "function" || typeof host2.requestProfile !== "function" || typeof host2.retainProfile !== "function") throw new Error("This Hermes Desktop version is too old for TL;DR.");
  let disposed = false;
  let running = false;
  let abandonEpoch = 0;
  let refreshEpoch = 0;
  let capabilityEpoch = 0;
  let active = false;
  let forceSetup = false;
  let blockedScopeKey = null;
  let routeCache = null;
  let watchTimer = null;
  let autoTimer = null;
  let prevBusy = Boolean(readHostState(host2).busy || readHostState(host2).awaitingResponse);
  let lastAutoRowKey = null;
  let seenSnapshot = null;
  let observedMaxRow = null;
  const initialSettings = loadSettings(storage);
  let current = { view: { mode: initialSettings.defaultMode, length: initialSettings.defaultLength }, settings: initialSettings, olderSettings: false, coverage: null, coverageText: "", autoReady: false, inputVersions: null, status: "idle", answer: null, answers: emptyAnswers(), revisions: [], revisionId: null, contextTruncated: false, stale: false, message: "", cooldownUntil: 0, route: null, assignment: null, modelStatus: "unknown", setupVisible: false, setupMessage: "", generation: null, sourceSnapshot: null, scopeKey: null, source: null };
  const listeners = /* @__PURE__ */ new Set();
  const dirtyAnswers = /* @__PURE__ */ new Map();
  const volatileRevisions = /* @__PURE__ */ new Map();
  const volatileSelections = /* @__PURE__ */ new Map();
  const emit = () => {
    if (disposed) return;
    onChange(current);
    listeners.forEach((listener) => listener(current));
  };
  const set = (patch) => {
    current = { ...current, ...patch };
    emit();
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const readRoutes = async () => {
    const key = ownerKey(readHostState(host2));
    if (routeCache && routeCache.key === key && Date.now() - routeCache.at < ROUTE_TTL_MS) return routeCache.promise;
    const promise = Promise.resolve().then(() => routeReader ? routeReader() : host2.profileRoutes());
    const entry = { key, at: Date.now(), promise };
    routeCache = entry;
    promise.catch(() => {
      if (routeCache === entry) routeCache = null;
    });
    return promise;
  };
  const resolveRoute = async (state) => matchingRoute(await readRoutes(), state.owner);
  const loadRevisions = () => {
    try {
      const records = storage.get(STORAGE_KEY, {});
      const persisted = records && typeof records === "object" && !Array.isArray(records) ? Object.fromEntries(Object.entries(records).filter(([, value]) => Array.isArray(value))) : {};
      for (const [key, value] of volatileRevisions) persisted[key] = value;
      return persisted;
    } catch {
      return Object.fromEntries(volatileRevisions);
    }
  };
  const loadSelections = () => {
    try {
      const value = storage.get(SELECTION_KEY, {});
      const selections = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
      for (const [key, id] of volatileSelections) selections[key] = id;
      return selections;
    } catch {
      return Object.fromEntries(volatileSelections);
    }
  };
  const saveSelection = (key, id) => {
    try {
      const selections = loadSelections();
      selections[key] = id;
      storage.set(SELECTION_KEY, selections);
      volatileSelections.delete(key);
    } catch {
      volatileSelections.set(key, id);
    }
  };
  const prune = (records) => {
    for (const key of Object.keys(records)) {
      const revisions = records[key];
      if (revisions.length > MAX_REVISIONS_PER_SOURCE) records[key] = revisions.filter((item, index) => index >= revisions.length - MAX_REVISIONS_PER_SOURCE || hasAnswerContent(item.answers));
    }
    const keys = Object.keys(records);
    if (keys.length > MAX_SOURCES_STORED) {
      const newest = (key) => records[key].at(-1)?.createdAt || "";
      keys.sort((a, b) => newest(a).localeCompare(newest(b)));
      for (const key of keys.slice(0, keys.length - MAX_SOURCES_STORED)) if (!records[key].some((item) => hasAnswerContent(item.answers))) delete records[key];
    }
    return records;
  };
  const saveRevisions = (records) => {
    try {
      storage.set(STORAGE_KEY, prune(records));
      for (const key of Object.keys(records)) volatileRevisions.delete(key);
      return true;
    } catch {
      for (const [key, value] of Object.entries(records)) volatileRevisions.set(key, value);
      return false;
    }
  };
  const answerScope = (key, id) => `${key}\0${id}`;
  const setupScopeKey = (route) => JSON.stringify(["tldr", 1, route?.connectionId || "", route?.profile || "", route?.targetProfile || ""]);
  const loadSetup = (route) => {
    try {
      const all = storage.get(SETUP_KEY, {});
      const value = all && typeof all === "object" && !Array.isArray(all) ? all[setupScopeKey(route)] : null;
      return { dismissed: value?.dismissed === true, pendingReturn: value?.pendingReturn === true };
    } catch {
      return { dismissed: false, pendingReturn: false };
    }
  };
  const saveSetup = (route, next) => {
    try {
      const all = storage.get(SETUP_KEY, {});
      const values = all && typeof all === "object" && !Array.isArray(all) ? { ...all } : {};
      values[setupScopeKey(route)] = { dismissed: next.dismissed === true, pendingReturn: next.pendingReturn === true };
      storage.set(SETUP_KEY, values);
    } catch {
    }
  };
  const revisionSummaries = (revisions) => revisions.map((item) => ({ revisionId: item.revisionId, createdAt: item.createdAt, rowId: item.source?.rowId, hasAnswers: hasAnswerContent(item.answers) }));
  const keyFor = async (route, state, source, view = current.view) => {
    const sha = await sha256Text(source.text);
    if (view.mode === "last" && view.length === "M") return scopeKey({ connectionId: route.connectionId, profile: route.profile, targetProfile: route.targetProfile, storedSessionId: state.storedSessionId, rowId: source.rowId, sourceTextSha256: sha });
    return JSON.stringify(["tldr", 2, route.connectionId, route.profile, route.targetProfile, state.storedSessionId, view.mode, view.length, source.rowId, sha]);
  };
  const seenKey = (route, state) => JSON.stringify([route.connectionId, route.profile, route.targetProfile, state.storedSessionId]);
  const loadSeen = (key) => {
    try {
      const all = storage.get(LAST_SEEN_KEY, {});
      const value = Number(all?.[key]);
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
      return 0;
    }
  };
  const saveSeen = (key, rowId) => {
    try {
      const all = storage.get(LAST_SEEN_KEY, {});
      const next = all && typeof all === "object" && !Array.isArray(all) ? { ...all } : {};
      next[key] = Math.max(Number(next[key]) || 0, rowId);
      const keys = Object.keys(next);
      if (keys.length > 200) for (const old of keys.slice(0, keys.length - 200)) delete next[old];
      storage.set(LAST_SEEN_KEY, next);
    } catch {
    }
  };
  const readHistory = async (route, state) => {
    if (state.runtimeId) return host2.requestProfile(route, "session.history", { session_id: state.runtimeId, profile: route.targetProfile }, 15e3, { spawnPriority: "foreground" });
    if (!backendClient?.history) throw new Error("This chat isn\u2019t open live in Desktop. Click into it or send a message here, then try again.");
    const cached = backendClient.capability;
    const capability = cached?.profile === route.targetProfile && cached?.ready === true ? cached : await backendClient.capabilities({ expectedProfile: route.targetProfile });
    if (capability?.storedHistory !== true) throw new Error("This chat isn\u2019t open live in Desktop, and the TL;DR server part on Hermes is too old to read saved chats. Click into the chat or send a message here, then try again.");
    return backendClient.history({ expectedBackendInstanceId: capability.backendInstanceId, expectedProfile: route.targetProfile, sessionId: state.storedSessionId });
  };
  const readSource = async (route, state, view = current.view) => {
    const history = await readHistory(route, state);
    const key = seenKey(route, state);
    if (!seenSnapshot || seenSnapshot.key !== key) seenSnapshot = { key, rowId: loadSeen(key) };
    const top = maxRowId(history);
    if (top) observedMaxRow = { key, rowId: Math.max(observedMaxRow?.key === key ? observedMaxRow.rowId : 0, top) };
    return { history, selected: selectForMode(history, view.mode, { lastSeenRowId: seenSnapshot.rowId }), view: { ...view } };
  };
  const settingsSignature = () => settingsHash(current.settings);
  const setupScope = () => current.route && { connectionId: current.route.connectionId, ownerProfile: current.route.profile, targetProfile: current.route.targetProfile };
  const setActive = (next) => {
    const nextActive = next === true;
    if (active === nextActive || disposed) return;
    active = nextActive;
    if (active) {
      seenSnapshot = null;
      observedMaxRow = null;
      if (current.autoReady) set({ autoReady: false });
    }
    if (!active) {
      refreshEpoch += 1;
      capabilityEpoch += 1;
      clearTimeout(watchTimer);
      watchTimer = null;
      if (observedMaxRow?.rowId) saveSeen(observedMaxRow.key, observedMaxRow.rowId);
      seenSnapshot = null;
      observedMaxRow = null;
    }
  };
  const validateSetupScope = async (expected) => {
    const state = readHostState(host2);
    routeCache = null;
    const route = await resolveRoute(state);
    const observed = { connectionId: route.connectionId, ownerProfile: route.profile, targetProfile: route.targetProfile };
    if (expected && (expected.connectionId !== observed.connectionId || expected.ownerProfile !== observed.ownerProfile || expected.targetProfile !== observed.targetProfile)) throw Object.assign(new Error("The chat\u2019s connection or profile changed; reopen TL;DR before changing its model."), { code: "scope_mismatch" });
    if (!sameScope(state, readHostState(host2))) throw Object.assign(new Error("The chat changed while Settings was opening; reopen TL;DR and try again."), { code: "scope_mismatch" });
    return { ...observed, backendInstanceId: backendClient?.capability?.backendInstanceId || null };
  };
  const loadModels = async ({ passive = false } = {}) => {
    const state = readHostState(host2);
    if (passive && blockedScopeKey === controllerScopeKey(state)) return current;
    const requestEpoch = ++capabilityEpoch;
    if (!hasFocusedOwner(state)) return current;
    try {
      const route = await resolveRoute(state);
      if (!backendClient) throw Object.assign(new Error("The TL;DR backend isn\u2019t installed on this Hermes host."), { code: "setup_required" });
      const capability = await backendClient.capabilities({ expectedProfile: route.targetProfile });
      if (disposed || requestEpoch !== capabilityEpoch || !sameScope(state, readHostState(host2))) return current;
      const ui = loadSetup(route);
      const assignment = capability.assignment;
      let setupMessage = "";
      if (ui.pendingReturn) {
        saveSetup(route, { ...ui, pendingReturn: false, dismissed: true });
        setupMessage = assignment.state === "pinned" ? `TL;DR now uses ${assignment.provider || "the provider default"}${assignment.model ? `/${assignment.model}` : ""}.` : assignment.state === "auto" ? "TL;DR is still set to Automatic." : "";
      }
      set({ route, assignment, inputVersions: Array.isArray(capability.inputVersions) ? capability.inputVersions : [1], modelStatus: capability.ready === true ? "ready" : "setup", setupVisible: forceSetup, setupMessage });
    } catch (error) {
      if (authRejected(error)) blockedScopeKey = controllerScopeKey(state);
      if (requestEpoch === capabilityEpoch) set({ modelStatus: "unavailable", assignment: { state: "unknown", provider: null, model: null, hasCustomEndpoint: false, observedAt: null, reason: "read_failed" }, setupVisible: forceSetup, setupMessage: forceSetup ? errorText(error, "Couldn\u2019t check the TL;DR model setting.") : "" });
    }
    return current;
  };
  const markAutomatic = () => {
    if (!current.route) return false;
    forceSetup = false;
    saveSetup(current.route, { dismissed: true, pendingReturn: false });
    set({ setupVisible: false, setupMessage: "" });
    return true;
  };
  const deferSetup = () => {
    forceSetup = false;
    set({ setupVisible: false });
    return true;
  };
  const markPendingReturn = (scope) => {
    forceSetup = false;
    const route = scope ? setupRoute(scope) : current.route;
    if (!route) return false;
    saveSetup(route, { ...loadSetup(route), pendingReturn: true });
    set({ setupVisible: false });
    return true;
  };
  const clearPendingReturn = (scope) => {
    const route = scope ? setupRoute(scope) : current.route;
    if (!route) return false;
    saveSetup(route, { ...loadSetup(route), pendingReturn: false });
    if (!scope || sameSetupRoute(current.route, route)) {
      forceSetup = true;
      set({ setupVisible: true, setupMessage: "" });
    }
    return true;
  };
  const showSetup = () => {
    forceSetup = true;
    set({ setupVisible: true });
    return true;
  };
  const statusMessage = (status) => {
    if (status === "empty") return "There\u2019s no finished assistant reply in this chat yet.";
    if (status === "not_persisted") return "The latest reply is still being saved. Try again in a moment.";
    if (status === "nothing_new") return "Nothing new since you last checked. Switch to Last reply or Whole session.";
    return "The latest reply isn\u2019t available yet. Try again in a moment.";
  };
  const showRevisionFor = (key, patch = {}) => {
    const records = loadRevisions();
    const revisions = records[key] || [];
    const selectedId = loadSelections()[key];
    const revision = revisions.find((item) => item.revisionId === selectedId) || revisions.at(-1);
    const dirty = revision ? dirtyAnswers.get(answerScope(key, revision.revisionId)) : null;
    const olderSettings = Boolean(revision && revision.settingsHash !== settingsSignature());
    set({ scopeKey: key, answer: revision?.document || null, answers: dirty || revision?.answers || emptyAnswers(), revisionId: revision?.revisionId || null, contextTruncated: Boolean(revision?.contextTruncated), revisions: revisionSummaries(revisions), generation: revision?.generation || null, olderSettings, ...revision?.coverage ? { coverage: revision.coverage, coverageText: coverageLabel(revision.coverage, revision.fallback) } : {}, ...patch });
  };
  const refresh = async ({ preserve = false } = {}) => {
    if (disposed) return current;
    const request = ++refreshEpoch;
    const state = readHostState(host2);
    if (preserve && blockedScopeKey === controllerScopeKey(state)) return current;
    if (!state.storedSessionId || !hasFocusedOwner(state)) {
      set({ status: "unsupported", message: state.storedSessionId ? "TL;DR can\u2019t tell which Hermes connection this chat belongs to. Reconnect or reopen the chat, then try again." : "Open a saved Hermes chat to use TL;DR." });
      return current;
    }
    if (state.busy || state.awaitingResponse) {
      if (!current.answer) set({ status: "waiting", message: "Waiting for the reply to finish\u2026" });
      return current;
    }
    try {
      const route = await resolveRoute(state);
      const result = await readSource(route, state);
      if (disposed || request !== refreshEpoch || !sameScope(state, readHostState(host2))) return current;
      blockedScopeKey = null;
      if (result.selected.status !== "ready") {
        set({ status: result.selected.status, answer: preserve ? current.answer : null, stale: Boolean(preserve && current.answer), sourceSnapshot: null, message: statusMessage(result.selected.status) });
        return current;
      }
      const key = await keyFor(route, state, result.selected.source, result.view);
      if (disposed || request !== refreshEpoch) return current;
      const snapshot = { route, state, history: result.history, selected: result.selected, view: result.view };
      set({ coverage: result.selected.coverage, coverageText: coverageLabel(result.selected.coverage, result.selected.fallback) });
      if (preserve && current.answer && current.scopeKey && current.scopeKey !== key && !(loadRevisions()[key] || []).length) {
        set({ status: "ready", stale: true, route, source: result.selected.source, sourceSnapshot: snapshot, message: "There\u2019s a newer reply. Regenerate to summarize it." });
        return current;
      }
      showRevisionFor(key, { status: "ready", source: result.selected.source, sourceSnapshot: snapshot, route, stale: false, message: "" });
    } catch (error) {
      if (authRejected(error)) blockedScopeKey = controllerScopeKey(state);
      if (!disposed && request === refreshEpoch) set({ status: "error", message: authRejected(error) ? "Hermes isn\u2019t signed in on this connection right now. TL;DR will try again when you reopen it." : errorText(error, "Couldn\u2019t read this chat.") });
    }
    return current;
  };
  const generate = async ({ sourceSnapshot = current.sourceSnapshot, auto = false } = {}) => {
    if (disposed) return { status: "disposed" };
    if (running) return { status: "busy", message: "A TL;DR is already being written." };
    if (Date.now() < current.cooldownUntil) return { status: "cooldown", message: `Please wait ${Math.ceil((current.cooldownUntil - Date.now()) / 1e3)} seconds before retrying.` };
    const state = readHostState(host2);
    if (!state.storedSessionId || !hasFocusedOwner(state)) return { status: "unsupported", message: "Open a saved Hermes chat to use TL;DR." };
    if (state.busy || state.awaitingResponse) return { status: "stale", message: "Wait for the reply to finish, then try again." };
    blockedScopeKey = null;
    running = true;
    const myAbandon = abandonEpoch;
    const abandoned = () => disposed || myAbandon !== abandonEpoch;
    const allowed = () => auto || active;
    const view = auto ? { mode: "last", length: current.settings.defaultLength } : { ...current.view };
    set({ status: "loading", message: "Reading the latest reply\u2026" });
    let release = () => void 0;
    try {
      const route = await resolveRoute(state);
      if (abandoned() || !allowed()) return { status: "discarded" };
      release = await host2.retainProfile(route, { spawnPriority: "foreground" });
      const reusable = sourceSnapshot?.selected?.status === "ready" && sameScope(state, sourceSnapshot.state) && sameRoute(route, sourceSnapshot.route) && sourceSnapshot.view?.mode === view.mode;
      const before = reusable ? sourceSnapshot : await readSource(route, state, view);
      if (abandoned() || !allowed()) return { status: "discarded" };
      if (before.selected.status !== "ready") throw new Error(statusMessage(before.selected.status));
      const key = await keyFor(route, state, before.selected.source, view);
      const selected = before.selected;
      const input = { context: selected.context || buildModelInput(before.history, selected.source).context, contextTruncated: Boolean(selected.contextTruncated) };
      if (!backendClient) throw Object.assign(new Error("The TL;DR backend isn\u2019t installed on this Hermes host."), { code: "setup_required" });
      const cached = backendClient.capability;
      const capability = cached?.profile === route.targetProfile && cached?.ready === true ? cached : await backendClient.capabilities({ expectedProfile: route.targetProfile });
      if (capability?.ready !== true || capability?.assignment?.state === "unknown") throw Object.assign(new Error(capability?.reason || "TL;DR\u2019s model isn\u2019t available on this profile."), { code: "setup_required" });
      const v2 = Array.isArray(capability.inputVersions) && capability.inputVersions.includes(2);
      if (!v2 && (view.mode !== "last" || view.length !== "M")) throw Object.assign(new Error("Modes and lengths need the updated TL;DR server part on Hermes. Last reply at Standard length still works."), { code: "setup_required" });
      if (abandoned() || !allowed()) return { status: "discarded" };
      set({ status: "loading", source: before.selected.source, scopeKey: key, route, message: "Writing the summary\u2026" });
      const requestId = globalThis.crypto?.randomUUID?.() || `tldr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const settings = current.settings;
      const tools = v2 && settings.evidence ? selected.tools || [] : [];
      const payload = v2 ? { schemaVersion: 2, mode: view.mode, source: selected.source, context: input.context, contextTruncated: input.contextTruncated, options: modelOptions(settings, view.length), tools } : { schemaVersion: 1, context: input.context, contextTruncated: input.contextTruncated, source: selected.source };
      const result = await backendClient.generate({ requestId, expectedBackendInstanceId: capability.backendInstanceId, expectedProfile: route.targetProfile, input: payload });
      const generation = { lane: "plugin-auxiliary", task: "tldr_summary", assignmentAtStart: result.assignmentAtStart || capability.assignment, actual: result.actual || { provider: null, model: null }, attribution: result.attribution || "host-reported-unavailable", usage: result.usage || null, requestId };
      const generated = parseModelDocument(result.text, [selected.source.text, ...input.context.map((item) => item.text)], { tools: v2 && settings.evidence ? tools : null, userTexts: selected.userTexts || [] });
      const previous = (loadRevisions()[key] || []).at(-1);
      const carried = previous ? carryAnswers(previous.document, previous.answers, generated) : emptyAnswers();
      const revision = { revisionId: revisionId(), createdAt: now(), promptVersion: v2 ? PROMPT_VERSION_V2 : PROMPT_VERSION, contextTruncated: input.contextTruncated, source: selected.source, document: generated, answers: carried, generation, view, settingsHash: v2 ? settingsHash(settings) : null, coverage: selected.coverage || null, fallback: selected.fallback || null, auto };
      const records = loadRevisions();
      records[key] = [...records[key] || [], revision];
      const persisted = saveRevisions(records);
      saveSelection(key, revision.revisionId);
      if (abandoned()) return { status: "discarded" };
      if (auto && !active) {
        set({ status: "idle", message: "", autoReady: sameScope(state, readHostState(host2)) });
        return { status: "ready", document: generated, auto: true };
      }
      if (!sameScope(state, readHostState(host2))) {
        set({ status: "idle", message: "" });
        return { status: "saved_elsewhere" };
      }
      if (view.mode !== current.view.mode || view.length !== current.view.length) {
        set({ status: current.answer ? "ready" : "idle", message: "" });
        return { status: "saved_elsewhere" };
      }
      showRevisionFor(key, { status: "ready", source: selected.source, route, stale: false, message: persisted ? "" : "Saved summaries are unavailable; this one is kept until you close Hermes." });
      return { status: "ready", document: generated };
    } catch (error) {
      if (authRejected(error)) blockedScopeKey = controllerScopeKey(state);
      if (abandoned()) return { status: "discarded" };
      if (auto && !active) {
        set({ status: "idle", message: "" });
        return { status: "error", message: errorText(error, "Automatic TL;DR failed.") };
      }
      const message = authRejected(error) ? "Hermes isn\u2019t signed in on this connection right now. Try again after it reconnects." : errorText(error, "TL;DR couldn\u2019t write a summary.");
      const timedOut = /timed out|timeout|deadline/i.test(message);
      set({ status: "error", cooldownUntil: timedOut ? Date.now() + 1e4 : current.cooldownUntil, message: timedOut ? "The model took too long. Try again in a few seconds." : message });
      return { status: "error", message };
    } finally {
      try {
        release?.();
      } catch {
      }
      running = false;
      emit();
    }
  };
  const updateAnswers = (answers) => {
    current = { ...current, answers };
    emit();
    if (!current.scopeKey || !current.revisionId) return;
    const records = loadRevisions();
    const revisions = records[current.scopeKey] || [];
    const index = revisions.findIndex((item) => item.revisionId === current.revisionId);
    if (index >= 0) {
      revisions[index] = { ...revisions[index], answers };
      if (saveRevisions(records)) dirtyAnswers.delete(answerScope(current.scopeKey, current.revisionId));
      else dirtyAnswers.set(answerScope(current.scopeKey, current.revisionId), answers);
    }
  };
  const selectRevision = (id) => {
    if (!current.scopeKey) return false;
    const revisions = loadRevisions()[current.scopeKey] || [];
    const revision = revisions.find((item) => item.revisionId === id);
    if (!revision) return false;
    const dirty = dirtyAnswers.get(answerScope(current.scopeKey, id));
    saveSelection(current.scopeKey, id);
    set({ status: "ready", answer: revision.document, answers: dirty || revision.answers || emptyAnswers(), revisionId: id, revisions: revisionSummaries(revisions), stale: false, generation: revision.generation || null });
    return true;
  };
  const resetAnswers = (confirmed) => {
    if (!confirmed || !current.scopeKey || !current.revisionId) return false;
    const records = loadRevisions();
    const revisions = records[current.scopeKey] || [];
    const index = revisions.findIndex((item) => item.revisionId === current.revisionId);
    if (index < 0) return false;
    const answers = emptyAnswers();
    revisions[index] = { ...revisions[index], answers };
    if (saveRevisions(records)) dirtyAnswers.delete(answerScope(current.scopeKey, current.revisionId));
    else dirtyAnswers.set(answerScope(current.scopeKey, current.revisionId), answers);
    set({ answers });
    return true;
  };
  const abandon = () => {
    if (!running) return false;
    abandonEpoch += 1;
    set({ status: current.answer ? "ready" : "idle", message: "Stopped waiting. If the model still finishes, the summary will be here next time you open TL;DR." });
    return true;
  };
  const revalidate = () => refresh({ preserve: true });
  const setView = (next) => {
    const view = { mode: ["last", "since", "session"].includes(next?.mode) ? next.mode : current.view.mode, length: ["S", "M", "L"].includes(next?.length) ? next.length : current.view.length };
    if (view.mode === current.view.mode && view.length === current.view.length) return false;
    set({ view, answer: null, revisionId: null, scopeKey: null, sourceSnapshot: null, olderSettings: false, message: "" });
    return true;
  };
  const setSettings = (patch) => {
    const settings = saveSettings(storage, { ...current.settings, ...patch });
    current = { ...current, settings };
    if (current.scopeKey) showRevisionFor(current.scopeKey);
    else emit();
    return settings;
  };
  const ownerMatches = (parts) => {
    const route = current.route;
    return Boolean(route && parts[2] === route.connectionId && parts[3] === route.profile && parts[4] === route.targetProfile);
  };
  const listHistory = () => {
    const state = readHostState(host2);
    if (!state.storedSessionId || !current.route) return [];
    return chatHistory(loadRevisions(), state.storedSessionId, ownerMatches);
  };
  const clearChatHistory = (confirmed) => {
    const state = readHostState(host2);
    if (!confirmed || !state.storedSessionId || !current.route) return 0;
    const records = loadRevisions();
    let removed = 0;
    for (const key of Object.keys(records)) {
      let parts;
      try {
        parts = JSON.parse(key);
      } catch {
        continue;
      }
      if (Array.isArray(parts) && parts[5] === state.storedSessionId && ownerMatches(parts)) {
        delete records[key];
        volatileRevisions.delete(key);
        removed += 1;
      }
    }
    try {
      storage.set(STORAGE_KEY, records);
    } catch {
    }
    clearReminders(storage, reminderChatKey());
    set({ answer: null, revisionId: null, revisions: [], scopeKey: null, olderSettings: false });
    return removed;
  };
  const reminderChatKey = () => {
    const state = readHostState(host2);
    return current.route && state.storedSessionId ? seenKey(current.route, state) : null;
  };
  const earlierQuestions2 = () => current.settings.remindSkipped && current.answer ? earlierQuestions(storage, reminderChatKey(), current.answer) : [];
  const commitAnswers2 = ({ earlier = [], earlierAnswers = null } = {}) => {
    if (!current.settings.remindSkipped || !current.answer) return [];
    return commitAnswers(storage, reminderChatKey(), { document: current.answer, answers: current.answers, earlier, earlierAnswers });
  };
  const dismissEarlier = (fold3) => {
    const open = dismissReminder(storage, reminderChatKey(), fold3);
    emit();
    return open;
  };
  const openHistoryEntry = (key, id) => {
    const revisions = loadRevisions()[key] || [];
    const revision = revisions.find((item) => item.revisionId === id);
    if (!revision) return false;
    saveSelection(key, id);
    const view = revision.view || { mode: "last", length: "M" };
    current = { ...current, view: { mode: view.mode, length: view.length } };
    showRevisionFor(key, { status: "ready", stale: false, message: "" });
    return true;
  };
  const runAuto = async () => {
    autoTimer = null;
    const settings = current.settings;
    if (disposed || !settings.auto || active || running) return;
    const state = readHostState(host2);
    if (state.busy || state.awaitingResponse || !state.runtimeId || !state.storedSessionId || !hasFocusedOwner(state)) return;
    if (autoUsage(storage) >= settings.autoDailyCap) return;
    try {
      const route = await resolveRoute(state);
      if (disposed || active || !sameScope(state, readHostState(host2))) return;
      const view = { mode: "last", length: settings.defaultLength };
      const snapshot = await readSource(route, state, view);
      seenSnapshot = null;
      observedMaxRow = null;
      const selected = snapshot.selected;
      if (selected.status !== "ready" || selected.source.text.length < settings.autoThreshold) return;
      const key = await keyFor(route, state, selected.source, view);
      if (key === lastAutoRowKey || (loadRevisions()[key] || []).length) return;
      lastAutoRowKey = key;
      recordAuto(storage);
      await generate({ sourceSnapshot: { route, state, history: snapshot.history, selected, view }, auto: true });
    } catch {
    }
  };
  const watchUnsubs = [];
  for (const atom3 of [host2.state.focusedSessionId, host2.state.focusedStoredSessionId, host2.state.focusedSessionOwner, host2.state.busy, host2.state.awaitingResponse]) if (typeof atom3?.subscribe === "function") watchUnsubs.push(atom3.subscribe(() => {
    const observedNow = readHostState(host2);
    const busyNow = Boolean(observedNow.busy || observedNow.awaitingResponse);
    const finished = prevBusy && !busyNow;
    prevBusy = busyNow;
    if (busyNow) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (finished && !active && current.settings.auto && !disposed) {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(() => {
        void runAuto();
      }, AUTO_DEBOUNCE_MS);
    }
    if (disposed || !active || running) return;
    routeCache = null;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      const observed = readHostState(host2);
      if (disposed || !active || running || observed.busy || observed.awaitingResponse) return;
      void refresh({ preserve: true });
    }, WATCH_DEBOUNCE_MS);
  }));
  const dispose = () => {
    disposed = true;
    active = false;
    abandonEpoch += 1;
    refreshEpoch += 1;
    clearTimeout(watchTimer);
    clearTimeout(autoTimer);
    watchUnsubs.splice(0).forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch {
      }
    });
    listeners.clear();
  };
  return { get state() {
    return current;
  }, get running() {
    return running;
  }, subscribe, setActive, refresh, revalidate, loadModels, setupScope, validateSetupScope, markAutomatic, deferSetup, markPendingReturn, clearPendingReturn, showSetup, generate, updateAnswers, selectRevision, resetAnswers, abandon, dispose, setView, setSettings, listHistory, openHistoryEntry, clearChatHistory, earlierQuestions: earlierQuestions2, commitAnswers: commitAnswers2, dismissEarlier, runAuto, storageKey: STORAGE_KEY, hasAnswerContent };
}

// src/export.mjs
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function escapeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function createDecisionsHtml(document, answers) {
  const json = escapeJson({ document, answers });
  const serializer = `(() => { const decisionLabels = ${decisionLabels.toString()}; return ${serializeAnswers.toString()} })()`;
  const answerBytes = escapeHtml(serializeAnswers(document, answers));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TL;DR Decisions</title><style>body{font:15px system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#101318;color:#edf2f7}article{border:1px solid #344054;border-radius:12px;padding:18px;margin:14px 0}button{padding:9px 12px;border:1px solid #64748b;border-radius:8px;background:#1e293b;color:inherit}#copy{white-space:pre-wrap;background:#0b0f14;padding:14px;border-radius:8px}</style></head><body><main><p>Detached local export \xB7 source attribution stays in Hermes</p><h1>Decisions</h1><section id="content"></section><button id="copy" type="button">Copy selected answers</button><pre id="bytes" aria-label="Exact answer bytes">${answerBytes || "Choose an option or add a note"}</pre></main><script>const payload=${json};const serializeAnswers=${serializer};const bytes=serializeAnswers(payload.document,payload.answers);document.querySelector('#bytes').textContent=bytes||'Choose an option or add a note';document.querySelector('#copy').addEventListener('click',async()=>{try{if(!bytes)throw new Error('No answers selected');await navigator.clipboard.writeText(bytes);document.querySelector('#copy').textContent='Copied'}catch{document.querySelector('#copy').textContent='Select the exact bytes above manually'}});document.querySelector('#content').textContent=payload.document.decisions.map(d=>d.question).join(' \xB7 ')||'No decisions needed';<\/script></body></html>`;
}

// src/settings.mjs
function atom2(value) {
  return value && typeof value.get === "function" ? value.get() : value;
}
function nativeModelsPath() {
  return "/settings?tab=config:model&aux=tldr_summary";
}
function ownerScope2(host2) {
  const focused = atom2(host2?.state?.focusedSessionOwner);
  return { connectionId: String(focused?.connectionId || "").trim(), ownerProfile: String(focused?.profile || "").trim() };
}
function activeScope(host2) {
  return { connectionId: String(atom2(host2?.state?.connectionId) || "").trim(), ownerProfile: String(atom2(host2?.state?.profile) || "").trim() };
}
function routeScope(route) {
  return { connectionId: String(route?.connectionId || "").trim(), ownerProfile: String(route?.profile || "").trim(), targetProfile: String(route?.targetProfile || "").trim() };
}
function sameScope2(a, b) {
  return Boolean(a && b && a.connectionId === b.connectionId && a.ownerProfile === b.ownerProfile && a.targetProfile === b.targetProfile);
}
function mismatch(expected, actual) {
  return expected && (!sameScope2(expected, actual) || expected.backendInstanceId && actual.backendInstanceId && expected.backendInstanceId !== actual.backendInstanceId);
}
function timeoutError(label, timeoutMs) {
  return Object.assign(new Error(`${label} timed out after ${timeoutMs}ms. Check the active connection/profile and open Models \u2192 Auxiliary \u2192 TL;DR manually.`), { code: "navigation_timeout" });
}
function staleCompletionError() {
  return Object.assign(new Error("The TL;DR Settings request became stale; reopen TL;DR and try again."), { code: "stale_completion", staleCompletion: true });
}
async function checkInvocation(validateCurrent, scope, phase, timeoutMs) {
  if (typeof validateCurrent !== "function") return;
  const current = await bounded(() => validateCurrent(scope, phase), `Validating TL;DR Settings ${phase}`, timeoutMs);
  if (current === false) throw staleCompletionError();
}
async function revalidateNavigation({ host: host2, scope, validateCurrent, timeoutMs }) {
  await checkInvocation(validateCurrent, scope, "after navigation", timeoutMs);
  const focused = ownerScope2(host2);
  const active = activeScope(host2);
  if (focused.connectionId !== scope.connectionId || focused.ownerProfile !== scope.ownerProfile || active.connectionId !== scope.connectionId || active.ownerProfile !== scope.ownerProfile) throw staleCompletionError();
  const routes = await bounded(() => host2.profileRoutes(), "Refreshing Hermes model routes after navigation", timeoutMs);
  await checkInvocation(validateCurrent, scope, "after route refresh", timeoutMs);
  const matches = (routes || []).filter((route) => route?.connectionId === scope.connectionId && route?.profile === scope.ownerProfile);
  if (matches.length !== 1 || !matches[0]?.targetProfile || !sameScope2(scope, routeScope(matches[0]))) throw staleCompletionError();
  const latestFocused = ownerScope2(host2);
  const latestActive = activeScope(host2);
  if (latestFocused.connectionId !== scope.connectionId || latestFocused.ownerProfile !== scope.ownerProfile || latestActive.connectionId !== scope.connectionId || latestActive.ownerProfile !== scope.ownerProfile) throw staleCompletionError();
}
async function bounded(operation, label, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function openNativeModels({ host: host2, runAction = null, expectedScope = null, validateScope = null, validateCurrent = null, beforeNavigate = null, onNavigateFailure = null, timeoutMs = 8e3 }) {
  const focused = atom2(host2?.state?.focusedSessionOwner);
  const active = { connectionId: String(atom2(host2?.state?.connectionId) || "").trim(), profile: String(atom2(host2?.state?.profile) || "").trim() };
  const owner = { connectionId: String(focused?.connectionId || "").trim(), profile: String(focused?.profile || "").trim() };
  if (!owner.connectionId || !owner.profile || owner.connectionId !== active.connectionId || owner.profile !== active.profile) throw Object.assign(new Error("Activate the intended connection/profile in Hermes, then reopen TL;DR to change its model."), { code: "scope_mismatch" });
  if (typeof host2?.profileRoutes !== "function") throw Object.assign(new Error("TL;DR model setup is unavailable on this host."), { code: "setup_required" });
  const routes = await bounded(() => host2.profileRoutes(), "Reading Hermes model routes", timeoutMs);
  await checkInvocation(validateCurrent, expectedScope, "after initial route read", timeoutMs);
  const matches = (routes || []).filter((route) => route?.connectionId === owner.connectionId && route?.profile === owner.profile);
  if (matches.length !== 1 || !matches[0]?.targetProfile) throw Object.assign(new Error("The intended Hermes connection/profile has no unique route; try again after it settles."), { code: "scope_mismatch" });
  const initial = routeScope(matches[0]);
  if (mismatch(expectedScope, initial)) throw Object.assign(new Error("The focused connection/profile changed; reopen TL;DR before changing its model."), { code: "scope_mismatch" });
  const handshake = typeof validateScope === "function" ? await bounded(() => validateScope(initial), "Checking the TL;DR model route", timeoutMs) : null;
  await checkInvocation(validateCurrent, initial, "after route check", timeoutMs);
  const finalFocused = ownerScope2(host2);
  const finalActive = activeScope(host2);
  if (!sameScope2(finalFocused, finalActive)) throw Object.assign(new Error("Activate the intended connection/profile in Hermes, then reopen TL;DR to change its model."), { code: "scope_mismatch" });
  const finalRoutes = await bounded(() => host2.profileRoutes(), "Refreshing Hermes model routes", timeoutMs);
  await checkInvocation(validateCurrent, initial, "after final route read", timeoutMs);
  const finalMatches = (finalRoutes || []).filter((route) => route?.connectionId === finalFocused.connectionId && route?.profile === finalFocused.ownerProfile);
  if (finalMatches.length !== 1 || !finalMatches[0]?.targetProfile) throw Object.assign(new Error("The intended Hermes connection/profile has no unique route; try again after it settles."), { code: "scope_mismatch" });
  const final = routeScope(finalMatches[0]);
  if (!sameScope2(initial, final) || mismatch(expectedScope, final) || handshake && mismatch(handshake, final)) throw Object.assign(new Error("The TL;DR target changed while Settings was being prepared; reopen TL;DR and try again."), { code: "scope_mismatch" });
  const navigationScope = { ...final, backendInstanceId: handshake?.backendInstanceId || expectedScope?.backendInstanceId || null };
  if (typeof beforeNavigate === "function") await bounded(() => beforeNavigate(navigationScope), "Preparing Hermes Settings", timeoutMs);
  await checkInvocation(validateCurrent, navigationScope, "before navigation", timeoutMs);
  try {
    if (typeof host2.navigate === "function") {
      await bounded(() => host2.navigate(nativeModelsPath()), "Opening Hermes Settings", timeoutMs);
      await revalidateNavigation({ host: host2, scope: navigationScope, validateCurrent, timeoutMs });
      return { method: "navigate", path: nativeModelsPath(), targetProfile: final.targetProfile, connectionId: final.connectionId, backendInstanceId: navigationScope.backendInstanceId };
    }
    if (typeof runAction === "function") {
      const result = await bounded(() => runAction("nav.settings"), "Opening Hermes Settings", timeoutMs);
      if (result?.ok === false) throw Object.assign(new Error("Hermes Settings could not be opened on this host."), { code: "setup_required" });
      await revalidateNavigation({ host: host2, scope: navigationScope, validateCurrent, timeoutMs });
      return { method: "action", path: "/settings", targetProfile: final.targetProfile, connectionId: final.connectionId, backendInstanceId: navigationScope.backendInstanceId };
    }
    throw Object.assign(new Error("Hermes Settings navigation is unavailable on this host."), { code: "setup_required" });
  } catch (error) {
    if (!error?.staleCompletion) try {
      await onNavigateFailure?.(navigationScope);
    } catch {
    }
    throw error;
  }
}

// src/ui.mjs
var baseCss = `
.tldr-root{--tldr-accent:var(--ui-accent,currentColor);color:var(--ui-text-primary,inherit);font:inherit}.tldr-trigger{border:1px solid var(--ui-stroke-secondary,var(--border,currentColor));background:var(--ui-bg-elevated,transparent);color:inherit;border-radius:7px;padding:4px 9px;cursor:pointer}.tldr-trigger:hover{border-color:var(--tldr-accent)}.tldr-backdrop{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;box-sizing:border-box;border:0;color:inherit;font:inherit;display:grid;place-items:center;background:transparent;padding:clamp(10px,3vw,36px)}.tldr-backdrop::backdrop{background:rgb(0 0 0 / .54)}.tldr-dialog{box-sizing:border-box;min-width:0;min-height:0;width:min(840px,100%);max-height:min(760px,100%);overflow:auto;background:var(--ui-bg-editor,Canvas);border:1px solid var(--ui-stroke-secondary,var(--border,currentColor));border-radius:16px;box-shadow:0 22px 80px #0008;padding:clamp(16px,3vw,28px)}.tldr-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.tldr-head h2{margin:0;font-size:1.25rem}.tldr-muted{color:var(--ui-text-secondary,var(--muted-foreground,currentColor));font-size:.85rem}.tldr-actions,.tldr-tabs{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.tldr-tabs{border-bottom:1px solid var(--ui-stroke-secondary,var(--border,currentColor));margin:18px 0 16px}.tldr-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:inherit;padding:9px 12px;cursor:pointer}.tldr-tab[aria-selected=true]{border-bottom-color:var(--tldr-accent);color:var(--tldr-accent)}.tldr-section{border:1px solid var(--ui-stroke-secondary,var(--border,currentColor));border-radius:10px;padding:14px;margin:12px 0}.tldr-section h3{margin:0 0 9px;font-size:1rem}.tldr-list{padding-left:1.25rem;margin:0}.tldr-list li{margin:.45rem 0}.tldr-choice{display:flex;flex-wrap:wrap;gap:7px}.tldr-choice button{border:1px solid var(--ui-stroke-secondary,var(--border,currentColor));background:transparent;color:inherit;border-radius:999px;padding:7px 10px;cursor:pointer}.tldr-choice button[aria-pressed=true]{background:color-mix(in srgb,var(--tldr-accent) 22%,transparent);border-color:var(--tldr-accent)}.tldr-note,.tldr-comments,.tldr-fallback{width:100%;box-sizing:border-box;min-height:68px;margin-top:9px;background:var(--ui-bg-elevated,Canvas);color:inherit;border:1px solid var(--ui-stroke-secondary,var(--border,currentColor));border-radius:8px;padding:9px;resize:vertical}.tldr-fallback{min-height:100px}.tldr-primary{background:var(--tldr-accent);color:var(--ui-text-primary,currentColor);border:0;border-radius:8px;padding:8px 12px;font-weight:650;cursor:pointer}.tldr-secondary{background:transparent;color:inherit;border:1px solid var(--ui-stroke-secondary,var(--border,currentColor));border-radius:8px;padding:8px 12px;cursor:pointer}.tldr-primary:disabled,.tldr-secondary:disabled{opacity:.5;cursor:not-allowed}.tldr-banner{padding:10px 12px;border-radius:8px;background:color-mix(in srgb,var(--tldr-accent) 13%,transparent);margin:12px 0}.tldr-danger{color:var(--ui-text-secondary,currentColor)}.tldr-locked{opacity:.82}.tldr-spacer{flex:1}@media(max-width:520px){.tldr-dialog{border-radius:12px;padding:15px}.tldr-head{display:block}.tldr-head .tldr-actions{margin-top:12px}.tldr-actions>*{flex:1}.tldr-trigger{padding:3px 7px}}.tldr-root{--tldr-accent:var(--ui-accent,var(--ui-accent,currentColor));color:var(--ui-text-primary,var(--foreground,inherit));font:inherit}.tldr-modelbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px}.tldr-model-pill{border:1px solid var(--ui-stroke-secondary,var(--border,#c8ccd6));border-radius:999px;padding:5px 9px;background:var(--ui-bg-elevated,transparent);font-size:.82rem}.tldr-picker{margin:10px 0;padding:12px;border:1px solid var(--ui-stroke-secondary,var(--border,#c8ccd6));border-radius:12px}.tldr-model-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:7px;margin:9px 0}.tldr-model-option{border:1px solid var(--ui-stroke-secondary,var(--border,#c8ccd6));background:var(--ui-bg-elevated,transparent);color:inherit;border-radius:9px;padding:8px 10px;cursor:pointer;text-align:left;font:inherit}.tldr-model-option[aria-pressed=true]{border-color:var(--tldr-accent);background:color-mix(in srgb,var(--tldr-accent) 14%,transparent)}.tldr-model-option:disabled{opacity:.48;cursor:not-allowed}.tldr-model-option small{display:block;color:var(--ui-text-secondary,var(--muted-foreground,#697386));margin-top:3px}.tldr-model-option em{font-style:normal;color:var(--tldr-accent);font-size:.75rem}.tldr-hero{border:0!important}.tldr-hero h3{font-size:1.5rem;letter-spacing:-.02em}.tldr-footer{position:sticky;bottom:-28px;padding:16px 0 0;background:var(--ui-bg-editor,Canvas)}@media(max-width:520px){.tldr-model-list{grid-template-columns:1fr}}
.tldr-root{--tldr-accent:#f4d929;--tldr-on-accent:#17170f;--tldr-charcoal:#1b1b17;--tldr-charcoal-deep:#10110e;--tldr-ivory:#f2ecd9;--tldr-ivory-muted:#aaa592;--tldr-surface:var(--ui-bg-editor,Canvas);--tldr-subtle:color-mix(in srgb,var(--tldr-surface) 92%,var(--tldr-charcoal));--tldr-rule:color-mix(in srgb,var(--ui-stroke-secondary,var(--border,currentColor)) 74%,#a9a38f)}.tldr-trigger{display:inline-flex;align-items:center;gap:7px;border:1px solid #bba50b;background:var(--tldr-accent);color:var(--tldr-on-accent);border-radius:5px;padding:5px 10px;font-size:.78rem;font-weight:760;letter-spacing:.035em;line-height:1;box-shadow:0 1px 0 #fff3 inset,0 1px 3px #0003}.tldr-trigger::before{content:"";width:14px;height:10px;display:inline-block;background:linear-gradient(var(--tldr-on-accent) 0 1px,transparent 1px 4px,var(--tldr-on-accent) 4px 5px,transparent 5px 8px,var(--tldr-on-accent) 8px 9px);opacity:.9}.tldr-trigger:hover{background:#ffe85c;border-color:#8f7b00;color:var(--tldr-on-accent);transform:translateY(-1px)}.tldr-trigger:active{transform:translateY(0)}.tldr-trigger:focus-visible{outline:2px solid var(--tldr-accent);outline-offset:3px}.tldr-dialog{background:var(--tldr-surface);border-color:var(--tldr-rule);border-radius:12px;box-shadow:0 24px 80px #0009;padding:clamp(18px,3vw,32px);color:var(--ui-text-primary,inherit)}.tldr-head{position:relative;isolation:isolate;min-height:100px;display:flex;align-items:flex-start;padding:13px 20px 12px;margin:calc(clamp(18px,3vw,32px) * -1) calc(clamp(18px,3vw,32px) * -1) 20px;background:var(--tldr-charcoal-deep);border-bottom:1px solid #5c583f;overflow:hidden}.tldr-head::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,var(--tldr-charcoal-deep) 0%,color-mix(in srgb,var(--tldr-charcoal-deep) 86%,transparent) 35%,transparent 76%);opacity:.96;z-index:-2}.tldr-head::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(0deg,transparent 0 8px,#f4d92910 8px 9px);mix-blend-mode:screen;pointer-events:none;z-index:-1}.tldr-head>div:first-child{min-width:0;max-width:72%}.tldr-head h2{margin:0;color:var(--tldr-accent);font-family:Impact,'Arial Narrow','Segoe UI',sans-serif;font-size:clamp(2rem,4.5vw,2.5rem);font-weight:800;letter-spacing:-.045em;line-height:.94;text-transform:uppercase}.tldr-head .tldr-muted{margin:.55rem 0 0;color:var(--tldr-ivory);font-size:.72rem;line-height:1.35;letter-spacing:.04em}.tldr-head .tldr-actions{position:relative;z-index:1;margin-left:auto}.tldr-head .tldr-actions button{border-color:#f2ecd955;background:#11130fdd;color:var(--tldr-ivory)}.tldr-head .tldr-actions button:hover{border-color:var(--tldr-accent);color:var(--tldr-accent)}.tldr-section{border:0;border-top:1px solid var(--tldr-rule);border-radius:0;padding:18px 0;margin:0}.tldr-section:first-child{border-top:0}.tldr-section h3{font-size:1rem;letter-spacing:.015em}.tldr-muted{font-size:.84rem}.tldr-actions{gap:8px}.tldr-actions button{border-radius:5px}.tldr-primary{background:var(--tldr-accent);color:var(--tldr-on-accent);border-color:#bba50b;font-weight:760}.tldr-primary:hover{background:#ffe85c;color:var(--tldr-on-accent)}.tldr-modelbar{border-top:1px solid var(--tldr-rule);border-bottom:1px solid var(--tldr-rule);padding:10px 0}.tldr-model-pill{background:var(--tldr-subtle);border-color:var(--tldr-rule);font-size:.78rem;letter-spacing:.02em}.tldr-choice button[aria-pressed=true]{background:var(--tldr-accent);border-color:#bba50b;color:var(--tldr-on-accent);font-weight:700}.tldr-banner{border-left:3px solid var(--tldr-accent);background:color-mix(in srgb,var(--tldr-accent) 11%,var(--tldr-surface));border-radius:3px}.tldr-danger{border-left-color:#d66b5d}.tldr-success{border-left-color:#6fa56b}.tldr-footer{border-top:1px solid var(--tldr-rule)}.tldr-tertiary{letter-spacing:.08em;text-transform:uppercase;font-size:.68rem}@media(prefers-color-scheme:dark){.tldr-dialog{--tldr-surface:var(--ui-bg-editor,#1b1b17);--tldr-subtle:color-mix(in srgb,var(--tldr-surface) 88%,#f2ecd9);--tldr-rule:color-mix(in srgb,var(--ui-stroke-secondary,#3c3b31) 76%,#aaa592);color:var(--tldr-ivory)}.tldr-dialog .tldr-muted{color:color-mix(in srgb,var(--tldr-ivory) 72%,transparent)}.tldr-dialog .tldr-section h3{color:var(--tldr-ivory)}}@media(prefers-reduced-motion:reduce){.tldr-trigger{transition:none;transform:none}.tldr-trigger:hover{transform:none}}@media(max-width:520px){.tldr-head{min-height:96px;padding:16px;margin-top:-16px;margin-left:-16px;margin-right:-16px}.tldr-head>div:first-child{max-width:78%}.tldr-head h2{font-size:2.15rem}.tldr-head .tldr-muted{font-size:.66rem}.tldr-section{padding:15px 0}}
`;
var extraCss = `.tldr-status{display:inline-block;min-width:5.6em;margin-right:.5em;padding:1px 6px;border-radius:4px;font-size:.72rem;font-weight:650;text-align:center;border:1px solid var(--ui-stroke-secondary,currentColor)}.tldr-status-completed{color:var(--ui-success,#4caf50);border-color:currentColor}.tldr-status-proposed{color:var(--ui-accent,#4f8cff);border-color:currentColor}.tldr-status-uncertain{color:var(--ui-warning,#d9a400);border-color:currentColor}.tldr-bottomline{font-size:1.05rem;line-height:1.45;margin:0}.tldr-footer-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-top:18px;padding-top:12px;border-top:1px solid var(--ui-stroke-secondary,currentColor)}.tldr-footer-row .tldr-modelbar{display:flex;gap:8px;align-items:center;border:0;padding:0;margin:0;background:transparent}.tldr-head{min-height:0}.tldr-actions button{white-space:nowrap}`;
var css = baseCss + extraCss;
var Button = forwardRef(({ children, className = "tldr-secondary", ...props }, ref) => h("button", { ref, type: "button", className, ...props }, children));
var v6Css = `.tldr6-viewrow{flex-basis:100%;display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px}.tldr6-act{position:relative;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 9px;border:1px solid #f2ecd933;border-radius:8px;background:#11130fcc;color:var(--tldr-ivory);font:inherit;font-size:.8rem;cursor:pointer}.tldr6-act:hover,.tldr6-act[aria-pressed=true]{border-color:var(--tldr-accent);color:var(--tldr-accent)}.tldr6-act:disabled{opacity:.4;cursor:not-allowed}.tldr-head{overflow:visible}@media(max-width:700px){.tldr6-act-text{display:none}.tldr6-act{padding:0 8px}}.tldr-dialog{width:min(760px,100%)}.tldr-head{min-height:0;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 16px;position:sticky;top:calc(clamp(18px,3vw,32px) * -1);z-index:3}.tldr-head h2{font-size:1.7rem;margin-right:6px}.tldr6-seg{display:inline-flex;border:1px solid #f2ecd933;border-radius:8px;padding:2px;background:#11130fcc}.tldr6-seg button{border:0;background:transparent;color:var(--tldr-ivory-muted);padding:5px 9px;border-radius:6px;font:inherit;font-size:.8rem;cursor:pointer;white-space:nowrap}.tldr6-seg button[aria-checked=true]{background:#2a2a22;color:var(--tldr-ivory);box-shadow:inset 0 0 0 1px #f2ecd944}.tldr6-seg button:disabled{opacity:.4;cursor:not-allowed}.tldr6-seg.tldr6-len button{font-weight:700;padding:5px 8px}.tldr6-icon{width:32px;height:32px;display:grid;place-items:center;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--tldr-ivory-muted);cursor:pointer;padding:0}.tldr6-icon:hover,.tldr6-icon[aria-pressed=true]{border-color:#f2ecd944;color:var(--tldr-accent);background:#11130fcc}.tldr6-icon:disabled{opacity:.4;cursor:not-allowed}.tldr6-sub{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:space-between;font-size:.78rem;color:color-mix(in srgb,var(--tldr-ivory) 62%,transparent);margin:-8px 0 12px}.tldr6-link{background:none;border:0;padding:0;color:inherit;text-decoration:underline;cursor:pointer;font:inherit}.tldr6-status{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--tldr-rule);border-radius:12px;padding:14px;background:var(--tldr-subtle)}.tldr6-badge{flex:none;font-size:.7rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px;border:1px solid currentColor}.tldr6-done{color:#7fd39a}.tldr6-blocked{color:#ff8e80}.tldr6-running{color:#82bfff}.tldr6-waiting{color:var(--tldr-accent)}.tldr6-answer{color:var(--tldr-ivory-muted)}.tldr6-bottom{font-size:1.05rem;font-weight:650;line-height:1.4;margin:0}.tldr6-facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:10px 0 0;font-size:.88rem}.tldr6-facts dt{color:color-mix(in srgb,var(--tldr-ivory) 55%,transparent)}.tldr6-facts dd{margin:0}.tldr6-h{font-size:.7rem;letter-spacing:.09em;text-transform:uppercase;color:color-mix(in srgb,var(--tldr-ivory) 55%,transparent);margin:20px 0 6px}.tldr6-item{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--tldr-rule)}.tldr6-item:last-child{border-bottom:0}.tldr6-item>span:nth-child(2){flex:1}.tldr6-ev{flex:none;font-size:.72rem;cursor:help;white-space:nowrap;margin-top:2px}.tldr6-shown{color:#7fd39a}.tldr6-stated{color:#e7b45c}.tldr6-conflict{border:1px solid #6b4b78;background:color-mix(in srgb,#6b4b78 18%,transparent);border-radius:9px;padding:9px 11px;margin:6px 0}.tldr6-conflict q{color:#c9b3ff}.tldr6-card{border:1px solid var(--tldr-rule);border-radius:12px;padding:13px;margin:0 0 10px;background:var(--tldr-subtle)}.tldr6-card h3{margin:0 0 9px;font-size:.98rem}.tldr6-q{display:inline-block;min-width:2.2em;margin-right:8px;padding:1px 6px;border-radius:5px;background:var(--tldr-accent);color:var(--tldr-on-accent);font-size:.75rem;font-weight:800;text-align:center;vertical-align:1px}.tldr6-skiprow{margin-top:6px}.tldr6-skip{border:1px dashed var(--tldr-rule);background:transparent;color:color-mix(in srgb,var(--tldr-ivory) 70%,transparent);border-radius:999px;padding:3px 10px;font:inherit;font-size:.76rem;cursor:pointer}.tldr6-skip[aria-pressed=true]{border-style:solid;color:var(--tldr-ivory)}.tldr6-earlierlist{border-left:3px solid var(--tldr-accent);padding-left:10px;margin-bottom:12px}.tldr6-rec{font-size:.64rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase;margin-left:7px;color:var(--tldr-accent)}.tldr-choice button[aria-pressed=true] .tldr6-q{display:inline-block;min-width:2.2em;margin-right:8px;padding:1px 6px;border-radius:5px;background:var(--tldr-accent);color:var(--tldr-on-accent);font-size:.75rem;font-weight:800;text-align:center;vertical-align:1px}.tldr6-rec{color:inherit}.tldr6-card details,.tldr6-locked details{border-top:1px solid var(--tldr-rule);margin-top:8px;padding-top:6px}.tldr6-card summary,.tldr6-locked summary{cursor:pointer;font-size:.84rem;color:color-mix(in srgb,var(--tldr-ivory) 70%,transparent)}.tldr6-card details p{margin:6px 0 2px;font-size:.88rem}.tldr6-locked{border:1px solid var(--tldr-rule);border-radius:12px;padding:6px 13px 10px}.tldr6-locked p{margin:7px 0;font-size:.88rem}.tldr6-foot{position:sticky;bottom:calc(clamp(18px,3vw,32px) * -1);margin:16px calc(clamp(18px,3vw,32px) * -1) calc(clamp(18px,3vw,32px) * -1);padding:12px clamp(18px,3vw,32px);background:var(--tldr-surface);border-top:1px solid var(--tldr-rule);display:flex;flex-wrap:wrap;gap:8px;align-items:center;z-index:2}.tldr6-count{font-size:.8rem;color:color-mix(in srgb,var(--tldr-ivory) 60%,transparent)}.tldr6-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#e04f3f;margin-left:2px;box-shadow:0 0 0 2px #17170f}.tldr6-panel h3{font-size:.95rem;margin:0 0 10px}.tldr6-sec{border-bottom:1px solid var(--tldr-rule);padding:14px 0}.tldr6-sec:last-child{border-bottom:0}.tldr6-row{display:flex;align-items:center;gap:12px;padding:6px 0;flex-wrap:wrap}.tldr6-row>.tldr6-lbl{flex:1;min-width:200px}.tldr6-lbl small{display:block;font-size:.78rem;color:color-mix(in srgb,var(--tldr-ivory) 58%,transparent);margin-top:2px}.tldr6-panel .tldr6-seg{background:transparent;border-color:var(--tldr-rule)}.tldr6-panel .tldr6-seg button[aria-checked=true]{background:var(--tldr-accent);color:var(--tldr-on-accent)}.tldr6-switch{width:40px;height:23px;border-radius:999px;border:0;background:#4a4a40;position:relative;cursor:pointer;flex:none;padding:0}.tldr6-switch::after{content:"";position:absolute;top:3px;left:3px;width:17px;height:17px;border-radius:50%;background:#e9e4d2;transition:left .15s}.tldr6-switch[aria-checked=true]{background:var(--tldr-accent)}.tldr6-switch[aria-checked=true]::after{left:20px;background:var(--tldr-on-accent)}.tldr6-panel select{background:var(--tldr-surface);color:inherit;border:1px solid var(--tldr-rule);border-radius:8px;padding:6px 8px;font:inherit;font-size:.86rem}.tldr6-dim{opacity:.45;pointer-events:none}.tldr6-hist{display:block;width:100%;text-align:left;border:1px solid var(--tldr-rule);border-radius:10px;padding:10px 12px;margin:8px 0;background:var(--tldr-subtle);color:inherit;font:inherit;cursor:pointer}.tldr6-hist[aria-current=true]{border-color:var(--tldr-accent)}.tldr6-hist small{display:block;font-size:.76rem;color:color-mix(in srgb,var(--tldr-ivory) 58%,transparent)}.tldr6-hist ul{margin:6px 0 0;padding-left:1.1rem;font-size:.84rem}.tldr-dialog .tldr-note,.tldr-dialog .tldr-comments,.tldr-dialog .tldr-fallback{background:color-mix(in srgb,var(--tldr-surface) 80%,#000);color:var(--tldr-ivory);border:1px solid var(--tldr-rule)}.tldr-dialog .tldr-note::placeholder,.tldr-dialog .tldr-comments::placeholder{color:color-mix(in srgb,var(--tldr-ivory) 45%,transparent)}.tldr6-panelname{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--tldr-ivory-muted)}@media(max-width:560px){.tldr-head h2{font-size:1.3rem}.tldr6-seg button{padding:5px 6px;font-size:.74rem}.tldr6-status{flex-direction:column;gap:8px}.tldr6-facts{grid-template-columns:1fr;gap:0}.tldr6-facts dd{margin-bottom:6px}}`;
var fullCss = css + v6Css;
var MODE_OPTIONS = [["last", "Last reply", "Summarize only the latest reply"], ["since", "Since I checked", "Everything since you last opened TL;DR in this chat"], ["session", "Whole session", "Where the whole chat stands now"]];
var LENGTH_OPTIONS = [["S", "S", "Short: a glance"], ["M", "M", "Medium: standard"], ["L", "L", "Long: detailed"]];
var STATE_TEXT = { done: "Done", blocked: "Blocked", running: "Running", waiting: "Waiting on you", answer: "Answer" };
var STATUS_LABEL = { completed: "Done", proposed: "Proposed", uncertain: "Unverified" };
var icon = (paths) => h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths);
var ICONS = {
  regen: () => icon([h("path", { key: 1, d: "M21 12a9 9 0 1 1-2.64-6.36L21 8" }), h("path", { key: 2, d: "M21 3v5h-5" })]),
  history: () => icon([h("path", { key: 1, d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }), h("path", { key: 2, d: "M3 3v5h5" }), h("path", { key: 3, d: "M12 7v5l4 2" })]),
  gear: () => icon([h("circle", { key: 1, cx: 12, cy: 12, r: 3 }), h("path", { key: 2, d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" })]),
  close: () => icon([h("path", { key: 1, d: "M18 6 6 18" }), h("path", { key: 2, d: "m6 6 12 12" })])
};
function HeadButton({ iconName, text, tip, ...props }, ref) {
  return h("button", { ref, type: "button", className: "tldr6-act", "aria-label": props["aria-label"] || text, ...props }, ICONS[iconName](), text ? h("span", { className: "tldr6-act-text" }, text) : null);
}
var HeadAction = forwardRef(HeadButton);
function Segmented({ label, options, value, onChange, disabled = false, className = "", isDisabled = () => false }) {
  return h("div", { className: `tldr6-seg ${className}`, role: "radiogroup", "aria-label": label }, options.map(([id, text, title]) => h("button", { key: id, type: "button", role: "radio", "aria-checked": value === id, "aria-label": title && text.length <= 2 ? title : text, "aria-description": title || void 0, disabled: disabled || isDisabled(id), onClick: () => {
    if (value !== id) onChange(id);
  } }, text)));
}
function Switch({ label, checked, onChange }) {
  return h("button", { type: "button", role: "switch", className: "tldr6-switch", "aria-checked": Boolean(checked), "aria-label": label, onClick: () => onChange(!checked) });
}
function StatusCard({ brief, showFacts }) {
  const status = brief.status;
  const facts = status && showFacts ? [["Verified", status.verified], ["In background", status.background], ["Next", status.next], ["Needs from you", status.needs]].filter(([, value]) => value) : [];
  return h(
    "section",
    { className: "tldr6-status", "aria-label": "Bottom line" },
    status ? h("span", { className: `tldr6-badge tldr6-${status.state}` }, STATE_TEXT[status.state]) : null,
    h(
      "div",
      null,
      h("p", { className: "tldr6-bottom tldr-bottomline" }, brief.bottomLine),
      facts.length ? h("dl", { className: "tldr6-facts" }, facts.flatMap(([key, value]) => [h("dt", { key: `${key}-t` }, key), h("dd", { key: `${key}-d` }, value)])) : null
    )
  );
}
function evidenceTitle(change) {
  if (change.evidence === "shown") return `Backed by a tool step: ${change.tool?.name || "tool"}${change.tool?.context ? ` \u2014 ${change.tool.context}` : ""}. This shows the step ran, not its result.`;
  return "No tool step in the summarized work backs this. Treat it as a claim.";
}
function BriefBody({ document, settings }) {
  const brief = document.brief;
  const conflicts = settings.conflicts ? document.conflicts || [] : [];
  return h(
    "div",
    null,
    h(StatusCard, { brief, showFacts: true }),
    brief.changes?.length ? h("div", null, h("div", { className: "tldr6-h" }, "What changed"), brief.changes.map((item, i) => h(
      "div",
      { key: i, className: "tldr6-item" },
      h("span", { className: `tldr-status tldr-status-${item.status}` }, STATUS_LABEL[item.status] || "Unverified"),
      h("span", null, item.text),
      item.evidence && settings.evidence ? h("span", { className: `tldr6-ev tldr6-${item.evidence}`, title: evidenceTitle(item), "aria-label": `${item.evidence === "shown" ? "Shown" : "Stated only"}: ${evidenceTitle(item)}` }, item.evidence === "shown" ? "\u25CF Shown" : "\u25CB Stated only") : null
    ))) : null,
    brief.risks?.length || conflicts.length ? h(
      "div",
      null,
      h("div", { className: "tldr6-h" }, "Risks"),
      conflicts.map((item, i) => h("div", { key: `c${i}`, className: "tldr6-conflict" }, h("strong", null, "Possible conflict"), " with your instruction ", h("q", null, item.quote), h("br"), item.text)),
      brief.risks.map((item, i) => h("div", { key: i, className: "tldr6-item" }, h("span", { "aria-hidden": true }, "\u26A0"), h("span", null, item)))
    ) : null
  );
}
function DecisionCard({ decision, label, answers, onChange, remind = false, onDismissNow = null }) {
  const selected = answers.selectedByQuestion[decision.id];
  const dismissed = Boolean(answers.dismissedByQuestion?.[decision.id]);
  const note = answers.notesByQuestion[decision.id] || "";
  const recId = decision.recommendation?.optionId;
  return h(
    "section",
    { className: "tldr6-card" },
    h("h3", null, h("span", { className: "tldr6-q" }, label), decision.question),
    h("div", { className: "tldr-choice", role: "group", "aria-label": `Options for ${decision.question}` }, decision.options.map((option) => h(Button, { key: option.id, "aria-pressed": selected === option.id, onClick: () => onChange(toggleSelection(answers, decision.id, option.id)) }, option.label, option.id === recId ? h("span", { className: "tldr6-rec" }, "Recommended") : null))),
    h("textarea", { className: "tldr-note", value: note, placeholder: "Notes (optional)", onChange: (event) => onChange(updateAnswer(answers, "notesByQuestion", decision.id, event.target.value)), "aria-label": `Notes for ${decision.question}` }),
    onDismissNow ? h("div", { className: "tldr6-skiprow" }, h("button", { type: "button", className: "tldr6-link tldr6-count", onClick: onDismissNow, "aria-label": `Dismiss: ${decision.question}` }, "Dismiss \u2014 stop reminding me")) : remind ? h("div", { className: "tldr6-skiprow" }, h("button", { type: "button", className: "tldr6-skip", "aria-pressed": dismissed, onClick: () => onChange(toggleDismissed(answers, decision.id)), "aria-label": `Don't remind me about: ${decision.question}` }, dismissed ? "\u2713 Won\u2019t remind me" : "Don\u2019t remind me")) : null,
    decision.recommendation?.reason ? h("details", null, h("summary", null, "Why recommended"), h("p", null, decision.recommendation.reason)) : null,
    decision.context ? h("details", null, h("summary", null, "Context"), h("p", null, decision.context)) : null,
    decision.eli5 ? h("details", null, h("summary", null, "ELI5"), h("p", null, decision.eli5)) : null,
    decision.evidence ? h("p", { className: "tldr-muted" }, `From the source: \u201C${decision.evidence}\u201D`) : null
  );
}
function DecisionsBody({ document, answers, onChange, remind }) {
  return h(
    "div",
    null,
    h("div", { className: "tldr6-h" }, document.decisions.length ? `Decisions \xB7 ${document.decisions.length}` : "Decisions"),
    document.decisions.length ? ((labels) => document.decisions.map((decision) => h(DecisionCard, { key: decision.id, decision, label: labels[decision.id], answers, onChange, remind })))(decisionLabels(document)) : h("div", { className: "tldr-banner" }, "No decisions needed."),
    document.lockedDecisions.length ? h("div", { className: "tldr6-locked tldr-locked" }, h("details", { style: { border: 0, margin: 0 } }, h("summary", null, `Locked decisions \xB7 ${document.lockedDecisions.length} (chosen for you)`), document.lockedDecisions.map((item) => h("p", { key: item.title }, h("strong", null, item.title), ": ", item.resolution, item.rationale ? ` \u2014 ${item.rationale}` : "")))) : null,
    h("div", { className: "tldr6-h" }, "General comments"),
    h("textarea", { className: "tldr-comments", value: answers.generalComments || "", placeholder: "Anything else", onChange: (event) => onChange(setGeneralComments(answers, event.target.value)), "aria-label": "General comments" })
  );
}
function SettingsPanel({ settings, onChange, insertSupported, assignment, onModel, autoUsed }) {
  const set = (key) => (value) => onChange({ [key]: value });
  return h(
    "div",
    { className: "tldr6-panel", role: "region", "aria-label": "TL;DR settings" },
    h(
      "section",
      { className: "tldr6-sec" },
      h("h3", null, "Summary"),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Open with", h("small", null, "You can still switch in the header")), h(Segmented, { label: "Open with", options: MODE_OPTIONS, value: settings.defaultMode, onChange: set("defaultMode") })),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Default length"), h(Segmented, { label: "Default length", className: "tldr6-len", options: LENGTH_OPTIONS, value: settings.defaultLength, onChange: set("defaultLength") })),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Status first", h("small", null, "Done / Blocked / Running / Waiting on you, then Verified \xB7 In background \xB7 Next \xB7 Needs from you")), h(Switch, { label: "Status first", checked: settings.statusFirst, onChange: set("statusFirst") })),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Evidence labels", h("small", null, "Marks each change Shown (a tool step backs it) or Stated only. TL;DR can\u2019t see tool results, so it never says \u201Cverified true\u201D.")), h(Switch, { label: "Evidence labels", checked: settings.evidence, onChange: set("evidence") })),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Conflict warnings", h("small", null, "Whole session only: flags where the current state seems to go against your earlier instructions")), h(Switch, { label: "Conflict warnings", checked: settings.conflicts, onChange: set("conflicts") }))
    ),
    h(
      "section",
      { className: "tldr6-sec" },
      h("h3", null, "Decisions"),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Ask me about", h("small", null, "Everything else becomes a locked decision")), h(Segmented, { label: "Ask me about", options: [["design", "Design & behavior"], ["all", "Everything"]], value: settings.decisionScope, onChange: set("decisionScope") })),
      h("div", { className: "tldr6-row" }, h("label", { className: "tldr6-lbl", htmlFor: "tldr6-recommend" }, "Recommend"), h("select", { id: "tldr6-recommend", value: settings.recommend, onChange: (event) => onChange({ recommend: event.target.value }) }, h("option", { value: "permanent" }, "The permanent, correct fix"), h("option", { value: "balanced" }, "Balanced"), h("option", { value: "quick" }, "The quickest unblock"))),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Remind me about skipped questions", h("small", null, "This chat only. When you insert or copy answers, questions you left untouched show up at the top of TL;DR next time, until you answer them or choose \u201CDon\u2019t remind me\u201D.")), h(Switch, { label: "Remind me about skipped questions", checked: settings.remindSkipped, onChange: set("remindSkipped") }))
    ),
    h(
      "section",
      { className: "tldr6-sec" },
      h("h3", null, "My preferences"),
      h("textarea", { className: "tldr-comments", value: settings.preferences, maxLength: 500, rows: 4, "aria-label": "My preferences", onChange: (event) => onChange({ preferences: event.target.value }) }),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl tldr6-count" }, "Added to every TL;DR. Shapes tone and recommendations; can\u2019t override the accuracy rules."), h("span", { className: "tldr6-count" }, `${settings.preferences.length} / 500`))
    ),
    h(
      "section",
      { className: "tldr6-sec" },
      h("h3", null, "Answers"),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Main button", h("small", null, insertSupported ? "\u2713 This Desktop can add text to the message box. TL;DR never sends for you." : "This Desktop version can\u2019t add text to the message box, so answers are copied.")), h(Segmented, { label: "Main button", options: [["insert", "Insert into chat"], ["copy", "Copy"]], value: insertSupported ? settings.answers : "copy", onChange: set("answers"), isDisabled: (id) => id === "insert" && !insertSupported }))
    ),
    h(
      "section",
      { className: "tldr6-sec" },
      h("h3", null, "Automatic TL;DR"),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, "Summarize long replies automatically", h("small", null, "One model call when the chat you\u2019re viewing finishes a long reply. Shows a dot on the TL;DR button; never pops open, never polls.")), h(Switch, { label: "Summarize long replies automatically", checked: settings.auto, onChange: set("auto") })),
      h(
        "div",
        { className: settings.auto ? "" : "tldr6-dim", "aria-disabled": !settings.auto },
        h("div", { className: "tldr6-row" }, h("label", { className: "tldr6-lbl", htmlFor: "tldr6-threshold" }, "Only replies longer than"), h("select", { id: "tldr6-threshold", value: settings.autoThreshold, disabled: !settings.auto, onChange: (event) => onChange({ autoThreshold: Number(event.target.value) }) }, [800, 1500, 3e3].map((value) => h("option", { key: value, value }, `${value.toLocaleString()} characters`)))),
        h("div", { className: "tldr6-row" }, h("label", { className: "tldr6-lbl", htmlFor: "tldr6-cap" }, "Daily limit", h("small", null, `${autoUsed} used today`)), h("select", { id: "tldr6-cap", value: settings.autoDailyCap, disabled: !settings.auto, onChange: (event) => onChange({ autoDailyCap: Number(event.target.value) }) }, [10, 30, 60].map((value) => h("option", { key: value, value }, String(value)))))
      )
    ),
    h(
      "section",
      { className: "tldr6-sec" },
      h("h3", null, "Model"),
      h("div", { className: "tldr6-row" }, h("div", { className: "tldr6-lbl" }, `TL;DR model: ${assignmentLabel(assignment)}`, h("small", null, "Your main chat model is unaffected")), h(Button, { onClick: onModel }, "Change in Models\u2026"))
    )
  );
}
function HistoryPanel({ entries, currentId, onOpen, onClear }) {
  return h(
    "div",
    { className: "tldr6-panel", role: "region", "aria-label": "TL;DR history" },
    h("p", { className: "tldr6-count" }, "Saved on this computer \xB7 newest first \xB7 comparing costs no model call"),
    entries.length ? entries.map((entry) => h(
      "button",
      { key: entry.revisionId, type: "button", className: "tldr6-hist", "aria-current": entry.revisionId === currentId, onClick: () => onOpen(entry) },
      h("small", null, `${new Date(entry.createdAt).toLocaleString()} \xB7 ${entry.label}${entry.hasAnswers ? " \xB7 answered" : ""}`),
      h("strong", null, `${entry.document.brief?.status ? `${STATE_TEXT[entry.document.brief.status.state]}: ` : ""}${entry.document.brief?.bottomLine || ""}`),
      entry.changes.length ? h("ul", null, entry.changes.map((change, i) => h("li", { key: i }, change.text))) : null
    )) : h("div", { className: "tldr-banner" }, "No saved TL;DRs for this chat yet."),
    entries.length ? h("div", { className: "tldr6-row" }, h("span", { className: "tldr6-lbl tldr6-count" }, "Keeps the last 5 per reply and 60 replies overall. Answered ones are always kept."), h(Button, { onClick: onClear }, "Clear this chat\u2019s history")) : null
  );
}
function assignmentLabel(assignment) {
  if (!assignment || assignment.state === "unknown") return "not checked";
  if (assignment.state === "auto") return "Automatic";
  if (assignment.hasCustomEndpoint && !assignment.provider && !assignment.model) return "Custom route";
  if (assignment.provider && assignment.model) return `${assignment.provider}/${assignment.model}`;
  if (assignment.provider) return `${assignment.provider} \xB7 provider default`;
  if (assignment.model) return assignment.model;
  return "Automatic";
}
function SetupCard({ status, onChoose, onAutomatic, onLater, onCheck }) {
  const targetProfile = status.route?.targetProfile || "this profile";
  return h(
    "section",
    { className: "tldr-setup", "aria-labelledby": "tldr-setup-title" },
    h("h3", { id: "tldr-setup-title" }, "TL;DR model"),
    h("p", null, `Currently: ${assignmentLabel(status.assignment)}. Choose a model in Hermes Settings \u2192 Models \u2192 Auxiliary \u2192 TL;DR. This only affects TL;DR on ${targetProfile}, not your chat model.`),
    status.setupMessage ? h("p", { className: "tldr-banner" }, status.setupMessage) : null,
    h("div", { className: "tldr-actions" }, h(Button, { className: "tldr-primary", onClick: onChoose }, "Open Models"), h(Button, { onClick: onAutomatic }, "Use Automatic"), h(Button, { onClick: onCheck }, "Check again"), h(Button, { onClick: onLater }, "Done"))
  );
}
function attributionLabel(generation) {
  const actual = generation?.actual;
  return actual?.provider || actual?.model ? `${actual?.provider || "provider default"}${actual?.model ? `/${actual.model}` : ""}` : null;
}
function TldrEntry({ ctx, host: host2, storage, sdk: sdk2 }) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [status, setStatus] = useState({ status: "idle", answers: emptyAnswers(), settings: null, view: { mode: "last", length: "M" } });
  const [copyState, setCopyState] = useState(null);
  const [instance, setInstance] = useState(null);
  const [opening, setOpening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [settingsState, setSettingsState] = useState(null);
  const [earlierAnswers, setEarlierAnswers] = useState(emptyAnswers);
  const [showEarlier, setShowEarlier] = useState(false);
  const openingRef = useRef(false);
  const settingsBusyRef = useRef(false);
  const openEpoch = useRef(0);
  const settingsEpoch = useRef(0);
  const triggerRef = useRef(null);
  const closeRef = useRef(null);
  const dialogRef = useRef(null);
  const overlayRef = useRef(null);
  const insertSupported = typeof host2?.composer?.insertText === "function";
  useEffect(() => {
    if (!open) return void 0;
    const overlay = overlayRef.current;
    if (overlay && !overlay.open) overlay.showModal();
    return () => {
      if (overlay?.open) overlay.close();
    };
  }, [open]);
  useEffect(() => {
    const next = createController({ host: host2, storage, backendClient: createBackendClient({ ctx, host: host2 }), onChange: setStatus });
    setInstance(next);
    setStatus(next.state);
    return () => next.dispose();
  }, [host2, storage, ctx]);
  const working = opening || status.status === "loading";
  useEffect(() => {
    if (!working || !open) return void 0;
    const start = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1e3)), 1e3);
    return () => clearInterval(timer);
  }, [working, open]);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!instance) return void 0;
    const sync = () => instance.setActive(open && globalThis.document?.visibilityState !== "hidden");
    sync();
    globalThis.document?.addEventListener("visibilitychange", sync);
    return () => globalThis.document?.removeEventListener("visibilitychange", sync);
  }, [instance, open]);
  const close = () => {
    openEpoch.current += 1;
    settingsEpoch.current += 1;
    settingsBusyRef.current = false;
    instance?.setActive(false);
    setOpen(false);
    setPanel(null);
    setTimeout(() => triggerRef.current?.focus(), 0);
  };
  useEffect(() => {
    if (!open) return void 0;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (panel) setPanel(null);
        else close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!dialog.contains(globalThis.document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && globalThis.document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && globalThis.document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, instance, panel]);
  const result = status.answer;
  const settings = status.settings || {};
  const earlier = open && result && instance ? instance.earlierQuestions() : [];
  const touchedEarlier = earlier.filter((item) => earlierAnswers.selectedByQuestion[item.fold] || String(earlierAnswers.notesByQuestion[item.fold] || "").trim());
  const answerText = result ? serializeAnswers(result, status.answers, earlier, earlierAnswers) : "";
  const answerCount = result ? (result.decisions || []).filter((item) => status.answers.selectedByQuestion[item.id] || String(status.answers.notesByQuestion[item.id] || "").trim()).length + touchedEarlier.length + (String(status.answers.generalComments || "").trim() ? 1 : 0) : 0;
  const v2Ready = !Array.isArray(status.inputVersions) || status.inputVersions.includes(2);
  const load = async ({ withModels = false } = {}) => {
    if (!instance || openingRef.current || instance.running) return;
    const epoch = ++openEpoch.current;
    openingRef.current = true;
    setOpening(true);
    setCopyState(null);
    try {
      const [snapshot] = await Promise.all([instance.refresh(), withModels ? instance.loadModels() : Promise.resolve()]);
      if (epoch !== openEpoch.current) return;
      if (snapshot.status === "ready" && !snapshot.answer) await instance.generate({ sourceSnapshot: snapshot.sourceSnapshot });
    } finally {
      openingRef.current = false;
      setOpening(false);
    }
  };
  const openEntry = async () => {
    setOpen(true);
    setPanel(null);
    if (!instance || openingRef.current || instance.running) return;
    const current = instance.state;
    instance.setActive(true);
    setSettingsState(null);
    instance.setView(current.autoReady ? { mode: "last", length: current.settings.defaultLength } : { mode: current.settings.defaultMode, length: current.settings.defaultLength });
    await load({ withModels: true });
  };
  const switchView = async (next) => {
    setPanel(null);
    if (!instance || instance.running || openingRef.current) return;
    if (instance.setView(next)) await load();
  };
  const choose = async () => {
    if (settingsBusyRef.current) return;
    if (!instance?.setupScope || !instance?.validateSetupScope) {
      setSettingsState({ kind: "error", message: "TL;DR model setup is unavailable on this host." });
      return;
    }
    settingsBusyRef.current = true;
    setSettingsState({ kind: "opening", message: "Opening Models\u2026" });
    const expectedScope = instance.setupScope();
    const dialogEpoch = openEpoch.current;
    const actionEpoch = ++settingsEpoch.current;
    const isCurrent = () => openEpoch.current === dialogEpoch && settingsEpoch.current === actionEpoch;
    try {
      await openNativeModels({ host: host2, runAction: sdk2?.runAction, expectedScope, validateScope: (scope) => instance.validateSetupScope(scope), validateCurrent: () => isCurrent(), beforeNavigate: (navigationScope) => {
        if (!isCurrent()) return false;
        instance.markPendingReturn(navigationScope);
      }, onNavigateFailure: (navigationScope) => {
        if (isCurrent()) instance.clearPendingReturn(navigationScope);
      } });
      if (!isCurrent()) return;
      setSettingsState(null);
      close();
    } catch (error) {
      if (!isCurrent()) return;
      setOpen(true);
      setSettingsState({ kind: "error", message: error instanceof Error ? error.message : "Hermes Settings could not be opened." });
    } finally {
      if (isCurrent()) settingsBusyRef.current = false;
    }
  };
  const commit = () => {
    instance?.commitAnswers({ earlier, earlierAnswers });
    setEarlierAnswers(emptyAnswers());
    setShowEarlier(false);
  };
  const useAutomatic = async () => {
    instance?.markAutomatic();
    if (!status.answer) await instance?.generate();
  };
  const change = async () => {
    setPanel(null);
    instance?.showSetup?.();
    await instance?.loadModels();
  };
  const copy = async ({ fallback = false } = {}) => {
    if (!answerText) {
      setCopyState({ kind: "empty", message: "Choose an option or add a note first." });
      return;
    }
    try {
      const ok = await ctx.os?.writeClipboard?.(answerText);
      if (ok === true) commit();
      setCopyState(ok === true ? { kind: "success", message: fallback ? "Couldn\u2019t reach the message box, so your answers were copied instead." : "Copied your answers." } : { kind: "failure", message: "Clipboard access was unavailable." });
    } catch {
      setCopyState({ kind: "failure", message: "Clipboard access was unavailable." });
    }
  };
  const insert = async () => {
    if (!answerText) {
      setCopyState({ kind: "empty", message: "Choose an option or add a note first." });
      return;
    }
    let ok = false;
    try {
      ok = await host2.composer.insertText(readStoredSession(host2), answerText, { mode: "block" }) === true;
    } catch {
      ok = false;
    }
    if (!ok) {
      await copy({ fallback: true });
      return;
    }
    commit();
    setCopyState(null);
    close();
    host2.notify?.({ kind: "success", message: "TL;DR answers added to your message. Review, then press Enter to send." });
  };
  const exportHtml = () => {
    if (!result) return;
    const blob = new Blob([createDecisionsHtml(result, status.answers)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const anchor = globalThis.document.createElement("a");
    anchor.href = url;
    anchor.download = "tldr-decisions.html";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const setAnswers = (answers) => {
    setCopyState(null);
    instance?.updateAnswers(answers);
  };
  const openManual = (event) => {
    event.currentTarget.previousElementSibling?.focus();
    event.currentTarget.previousElementSibling?.select();
  };
  const togglePanel = (name) => {
    if (panel === name) {
      setPanel(null);
      return;
    }
    if (name === "history") setHistoryEntries(instance?.listHistory() || []);
    setPanel(name);
  };
  const openHistory = (entry) => {
    if (instance?.openHistoryEntry(entry.key, entry.revisionId)) {
      setPanel(null);
      setCopyState(null);
    }
  };
  const clearHistory = () => {
    if (globalThis.confirm?.("Delete saved TL;DRs and answers for this chat on this computer?")) {
      instance?.clearChatHistory(true);
      setHistoryEntries([]);
    }
  };
  const useInsert = insertSupported && settings.answers !== "copy";
  const attribution = attributionLabel(status.generation);
  const modelLabel = attribution || assignmentLabel(status.assignment);
  const showSummary = !panel;
  const hasDecisions = Boolean(result?.decisions?.length);
  return h(
    "div",
    { className: "tldr-root" },
    h("style", null, fullCss),
    h(Button, { ref: triggerRef, className: "tldr-trigger", disabled: !instance, onClick: openEntry, "aria-label": status.autoReady ? "Open TL;DR (new summary ready)" : "Open TL;DR" }, working ? "TL;DR \xB7 Working\u2026" : "TL;DR", status.autoReady && !open ? h("span", { className: "tldr6-dot", "aria-hidden": true }) : null),
    open ? h("dialog", { ref: overlayRef, className: "tldr-backdrop", role: "presentation", onCancel: (event) => {
      event.preventDefault();
      if (panel) setPanel(null);
      else close();
    } }, h(
      "section",
      { ref: dialogRef, className: "tldr-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "tldr-title", tabIndex: -1 },
      h(
        "header",
        { className: "tldr-head" },
        h("h2", { id: "tldr-title" }, "TL;DR"),
        panel ? h("span", { className: "tldr6-panelname" }, panel === "settings" ? "Settings" : "History") : null,
        h("span", { className: "tldr-spacer" }),
        h(HeadAction, { iconName: "regen", text: "Redo", tip: "Write a fresh summary (one model call)", "aria-label": "Regenerate", disabled: working || !status.source, onClick: () => {
          setPanel(null);
          void instance?.generate();
        } }),
        h(HeadAction, { iconName: "history", text: "History", tip: "Earlier summaries of this chat", "aria-label": "History", "aria-pressed": panel === "history", onClick: () => togglePanel("history") }),
        h(HeadAction, { iconName: "gear", text: "Settings", tip: "TL;DR settings", "aria-label": "TL;DR settings", "aria-pressed": panel === "settings", onClick: () => togglePanel("settings") }),
        h(HeadAction, { ref: closeRef, iconName: "close", tip: "Close (Esc)", "aria-label": "Close TL;DR", onClick: close }),
        panel ? null : h(
          "div",
          { className: "tldr6-viewrow" },
          panel ? null : h(Segmented, { label: "What to summarize", options: MODE_OPTIONS, value: status.view?.mode, disabled: working, onChange: (mode) => switchView({ mode }), isDisabled: (id) => id !== "last" && !v2Ready }),
          h("span", { className: "tldr-spacer" }),
          panel ? null : h(Segmented, { label: "Length", className: "tldr6-len", options: LENGTH_OPTIONS, value: status.view?.length, disabled: working, onChange: (length) => switchView({ length }), isDisabled: (id) => id !== "M" && !v2Ready })
        )
      ),
      h("div", { className: "tldr6-sub" }, h("span", null, status.coverageText || "Summary of the latest reply"), h("span", null, `Model: ${modelLabel} \xB7 `, h("button", { type: "button", className: "tldr6-link", onClick: change, "aria-label": "Change TL;DR model" }, "Change"))),
      panel === "settings" ? h(SettingsPanel, { settings, onChange: (patch) => instance?.setSettings(patch), insertSupported, assignment: status.assignment, onModel: choose, autoUsed: autoUsage(storage) }) : null,
      panel === "history" ? h(HistoryPanel, { entries: historyEntries, currentId: status.revisionId, onOpen: openHistory, onClear: clearHistory }) : null,
      showSummary ? h(
        "div",
        null,
        working ? h("div", { className: "tldr-banner", role: "status", "aria-live": "polite", "aria-atomic": true }, `${status.message || "Reading the chat\u2026"} ${elapsed}s`) : null,
        !working && status.message ? h("div", { className: status.status === "error" ? "tldr-banner tldr-danger" : "tldr-banner", role: status.status === "error" ? "alert" : "status" }, status.message) : null,
        settingsState?.kind === "opening" ? h("p", { className: "tldr-banner", role: "status", "aria-live": "polite" }, settingsState.message) : null,
        settingsState?.kind === "error" ? h("p", { className: "tldr-banner tldr-danger", role: "alert" }, settingsState.message) : null,
        status.setupVisible ? h(SetupCard, { status, onChoose: choose, onAutomatic: useAutomatic, onLater: () => instance?.deferSetup(), onCheck: () => instance?.loadModels() }) : null,
        result && status.olderSettings && !working ? h("div", { className: "tldr-banner", role: "status" }, "Made with older settings. ", h("button", { type: "button", className: "tldr6-link", onClick: () => instance?.generate() }, "Regenerate")) : null,
        result && earlier.length && !working ? h("div", { className: "tldr-banner tldr6-earlier", role: "status" }, `${earlier.length} earlier ${earlier.length === 1 ? "question" : "questions"} still open in this chat \xB7 `, h("button", { type: "button", className: "tldr6-link", "aria-expanded": showEarlier, onClick: () => setShowEarlier((value) => !value) }, showEarlier ? "Hide" : "Show")) : null,
        result && earlier.length && showEarlier ? h("div", { className: "tldr6-earlierlist", role: "region", "aria-label": "Earlier questions" }, earlier.map((item, index) => h(DecisionCard, { key: item.fold, decision: { ...item, id: item.fold }, label: `E${index + 1}`, answers: earlierAnswers, onChange: (value) => {
          setCopyState(null);
          setEarlierAnswers(value);
        }, onDismissNow: () => {
          instance?.dismissEarlier(item.fold);
          setEarlierAnswers((value) => ({ ...value, selectedByQuestion: { ...value.selectedByQuestion, [item.fold]: void 0 }, notesByQuestion: { ...value.notesByQuestion, [item.fold]: "" } }));
        } }))) : null,
        result ? h(BriefBody, { document: result, settings }) : null,
        result ? h(DecisionsBody, { document: result, answers: status.answers, onChange: setAnswers, remind: settings.remindSkipped }) : null,
        !working && !result && (status.status === "error" || status.stale) ? h("div", { className: "tldr-actions" }, h(Button, { className: "tldr-primary", disabled: instance?.running, onClick: () => instance?.generate() }, "Try again")) : null,
        copyState?.kind === "success" ? h("div", { className: "tldr-banner tldr-success", role: "status" }, copyState.message) : null,
        copyState?.kind === "empty" ? h("div", { className: "tldr-banner" }, copyState.message) : null,
        copyState?.kind === "failure" ? h("div", { className: "tldr-banner tldr-danger" }, h("p", null, copyState.message), h("textarea", { className: "tldr-fallback", readOnly: true, value: answerText, "aria-label": "Your answers; select and copy manually", onFocus: (event) => event.currentTarget.select() }), h(Button, { onClick: openManual }, "Select text")) : null,
        result || working && instance?.running ? h(
          "footer",
          { className: "tldr6-foot" },
          working && instance?.running ? h(Button, { onClick: () => instance?.abandon() }, "Stop waiting") : null,
          result && useInsert ? h(Button, { className: "tldr-primary", disabled: !answerText, onClick: insert }, "Insert into chat") : null,
          result ? h(Button, { className: useInsert ? "tldr-secondary" : "tldr-primary", disabled: !answerText, onClick: () => copy() }, useInsert ? "Copy" : "Copy answers") : null,
          result ? h("span", { className: "tldr6-count" }, answerCount ? `${answerCount} ${answerCount === 1 ? "item" : "items"} will be included` : "Nothing selected yet") : null,
          h("span", { className: "tldr-spacer" }),
          result && hasDecisions ? h("button", { type: "button", className: "tldr6-link tldr6-count", onClick: exportHtml }, "Export") : null,
          h("span", { className: "tldr-tertiary" }, "AI summary \xB7 saved per reply")
        ) : null
      ) : null
    )) : null
  );
}
function readStoredSession(host2) {
  const value = host2?.state?.focusedStoredSessionId;
  const id = value && typeof value.get === "function" ? value.get() : value;
  return id ? String(id) : null;
}

// src/plugin.mjs
var plugin = {
  id: "tldr",
  name: "TL;DR",
  description: "One-click AI brief and decisions using the native TL;DR auxiliary model.",
  defaultEnabled: true,
  register(ctx) {
    const area = sdk.COMPOSER_AREAS?.actions || sdk.STATUSBAR_AREAS?.right;
    if (!area || !sdk.host) return;
    ctx.register({
      id: "entry",
      area,
      order: 70,
      render: () => h2(TldrEntry, { ctx, host: sdk.host, storage: ctx.storage, sdk })
    });
  }
};
var plugin_default = plugin;
export {
  plugin_default as default
};
