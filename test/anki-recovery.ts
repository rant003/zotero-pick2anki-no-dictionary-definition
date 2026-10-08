import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { addWordCard } from "../src/modules/anki";
import { DEFAULT_SETTINGS } from "../src/modules/settings";
import { registerReaderHandlers } from "../src/modules/reader";
import { saveSettings } from "../src/modules/settings-store";

const prefs = new Map<string, unknown>();
const dom = new JSDOM("<!doctype html><html><body></body></html>");
type StoredNote = { id: number; fields: Record<string, string>; tags: string[] };
let notes: StoredNote[] = [];
let calls: string[] = [];
let mode = "normal";
let probes = 0;
let readFailures = 0;
let addCalls = 0;
let counter = 100;
let readerHandler: any;
const logs: string[] = [];
function response(result: unknown, error: string | null = null) {
  const text = JSON.stringify({ result, error });
  return { status: 200, responseText: text, response: text };
}
const zero = () => ({ status: 0, responseText: "", response: "" });
(globalThis as any).Zotero = {
  Prefs: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) },
  debug: (text: string) => logs.push(text),
  getMainWindow: () => ({ DOMParser: dom.window.DOMParser, crypto: globalThis.crypto, setTimeout, clearTimeout }),
  Reader: { registerEventListener: (_type: string, handler: any) => { readerHandler = handler; } },
  Items: { get: () => null }, URI: {},
  HTTP: { request: async (_method: string, _url: string, options: any) => {
    if (_method !== "POST") return { status: 404, responseText: "", response: "" };
    const { action, params } = JSON.parse(options.body);
    calls.push(action);
    if (action === "modelFieldNames") {
      if (readFailures-- > 0) return zero();
      return response(["Word", "Meaning", "Context"]);
    }
    if (action === "canAddNotes") return response([mode !== "duplicate"]);
    if (action === "addNote") {
      addCalls++;
      if (mode === "reject") return response(null, "model was not found");
      if (mode !== "not-sent") notes.push({ id: ++counter, fields: params.note.fields, tags: [...params.note.tags] });
      if (["lost", "unverifiable", "delayed", "cleanup-fail", "invalid-probe", "not-sent"].includes(mode)) return zero();
      if (mode === "throw") throw new Error("NS_ERROR_NET_RESET");
      if (mode === "malformed") return { status: 200, responseText: "not JSON", response: "not JSON" };
      if (mode === "invalid-id") return response(null);
      return response(counter);
    }
    if (action === "findNotes") {
      probes++;
      if (mode === "unverifiable") return zero();
      if (mode === "invalid-probe") return response({ unexpected: true });
      if (mode === "delayed" && probes === 1) return response([]);
      const tag = params.query.slice(4);
      return response(notes.filter((n) => n.tags.includes(tag)).map((n) => n.id));
    }
    if (action === "removeTags") {
      if (mode === "cleanup-fail") return zero();
      for (const note of notes) if (params.notes.includes(note.id)) note.tags = note.tags.filter((t) => t !== params.tags);
      return response(null);
    }
    throw new Error("Unexpected action: " + action);
  } },
};
const settings = { ...DEFAULT_SETTINGS, ankiEnabled: true, ankiDeck: "Recovery-test", ankiNoteType: "Test",
  ankiConnectUrl: "http://127.0.0.1:18765", ankiFieldMap: { word: "Word", def_all: "Meaning", context: "Context" },
  ankiTags: "my-tag", ankiDup: "add" as const, onlineDictSources: [] };
const input = (word: string) => ({ word, contextSentence: "Example with " + word + ".", translation: "翻译 <结果>" });
function reset(nextMode: string) { mode = nextMode; notes = []; calls = []; probes = 0; addCalls = 0; prefs.clear(); }
let checks = 0;
function passed(name: string) { checks++; console.log("PASS " + name); }

for (const failure of ["lost", "throw", "malformed", "invalid-id", "delayed"]) {
  reset(failure);
  const result = await addWordCard(settings, input("recovery-" + failure));
  assert.equal(result.ok, true);
  assert.equal(result.confirmed, true);
  assert.equal(addCalls, 1);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0].tags, ["my-tag"]);
  assert.match(notes[0].fields.Meaning, /翻译 &lt;结果&gt;/);
  passed("saved note recovered after " + failure + "; no second addNote; translation and tags preserved");
}

reset("normal"); readFailures = 1;
assert.equal((await addWordCard(settings, input("read-retry"))).added, true);
assert.equal(calls.filter((x) => x === "modelFieldNames").length, 2);
assert.equal(addCalls, 1);
passed("read-only failure retries without repeating the write");

reset("unverifiable");
const pendingInput = input("pending-restart");
assert.equal((await addWordCard(settings, pendingInput)).pending, true);
assert.equal((await addWordCard(settings, pendingInput)).pending, true);
assert.equal(addCalls, 1);
assert.ok([...prefs.values()].some((v) => typeof v === "string" && v.includes("p2a-write-")));
mode = "normal";
// Load a fresh copy of the bundled core to emulate a plugin restart with only preferences preserved.
const fresh = await import(new URL("./anki-core.mjs?restart", import.meta.url).href);
const confirmed = await fresh.addWordCard({ ...settings, ankiDup: "skip" }, pendingInput);
assert.equal(confirmed.confirmed, true);
assert.equal(addCalls, 1);
assert.deepEqual(notes[0].tags, ["my-tag"]);
passed("unverifiable write stays pending; repeat clicks and plugin restart only verify the original submission");

reset("not-sent");
const absent = input("not-sent");
assert.equal((await addWordCard(settings, absent)).pending, true);
const verifiedAbsent = await addWordCard(settings, absent);
assert.equal(verifiedAbsent.pending, false);
assert.equal(verifiedAbsent.added, false);
assert.equal(addCalls, 1);
mode = "normal";
assert.equal((await addWordCard(settings, absent)).added, true);
assert.equal(addCalls, 2);
assert.equal(notes.length, 1);
passed("absence check does not send addNote; a further explicit retry can add the missing note");

reset("invalid-probe");
assert.equal((await addWordCard(settings, input("invalid-probe"))).pending, true);
assert.equal(addCalls, 1);
passed("malformed lookup result is never mistaken for confirmation");

reset("not-sent");
notes.push({ id: 99, fields: { Word: "preexisting" }, tags: ["my-tag"] });
assert.equal((await addWordCard(settings, input("preexisting"))).pending, true);
assert.equal(notes.length, 1);
assert.equal(addCalls, 1);
passed("an unrelated pre-existing card cannot be mistaken for this submission");

reset("reject");
const rejected = await addWordCard(settings, input("rejected"));
assert.equal(rejected.ok, false);
assert.match(rejected.message, /model was not found/);
assert.equal(calls.includes("findNotes"), false);
assert.equal(notes.length, 0);
passed("explicit Anki API error remains an error, with no automatic write retry");

reset("duplicate");
assert.equal((await addWordCard({ ...settings, ankiDup: "skip" }, input("duplicate"))).skipped, true);
assert.equal(addCalls, 0);
passed("existing duplicate-skip policy remains effective");

reset("normal");
const same = input("concurrent");
const concurrent = await Promise.all([addWordCard(settings, same), addWordCard(settings, same)]);
assert.ok(concurrent.every((r) => r.added));
assert.equal(addCalls, 1);
assert.equal((await addWordCard(settings, same)).added, true);
assert.equal(addCalls, 2);
passed("concurrent submissions coalesce; a later intentional add still follows allow-duplicate policy");

reset("cleanup-fail");
assert.equal((await addWordCard(settings, input("cleanup"))).added, true);
assert.equal(addCalls, 1);
passed("temporary-tag cleanup failure cannot turn an already saved note into a write failure");

async function waitFor(test: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error("UI state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function makePopup(word: string) {
  const doc = dom.window.document;
  doc.body.innerHTML = '<div class="selection-popup"><textarea class="zoteropdftranslate-popup-textarea">中文译文</textarea></div>';
  const host = doc.querySelector(".selection-popup")!;
  readerHandler({ doc, params: { annotation: { text: word } }, append: (node: HTMLElement) => host.appendChild(node) });
  return { button: [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("➕"))!,
    message: host.querySelector<HTMLElement>(".p2a-msg")! };
}
registerReaderHandlers();
reset("lost");
saveSettings({ ...settings, triggerMode: "ctrl" });
let popup = makePopup("jointly");
popup.button.click();
await waitFor(() => popup.button.textContent?.includes("✔") === true);
assert.equal(popup.button.disabled, true);
assert.match(popup.message.textContent!, /已核对/);
popup.button.click();
assert.equal(addCalls, 1);
assert.match(notes[0].fields.Meaning, /中文译文/);
passed("reader displays confirmed success and prevents another write from the completed popup");

reset("unverifiable");
saveSettings({ ...settings, triggerMode: "ctrl" });
popup = makePopup("retrieval");
popup.button.click();
await waitFor(() => popup.button.textContent?.includes("核对") === true && !popup.button.disabled);
assert.match(popup.message.textContent!, /待确认/);
mode = "normal";
popup.button.click();
await waitFor(() => popup.button.textContent?.includes("✔") === true);
assert.equal(addCalls, 1);
passed("reader offers verify-only button when outcome is unknown and recovers without re-adding");

assert.ok(logs.some((line) => line.includes("addNote") && line.includes("HTTP 0")));
passed("diagnostics include the exact failed Anki action");
console.log(`${checks} offline recovery checks passed; no real Anki collection was accessed.`);
dom.window.close();
