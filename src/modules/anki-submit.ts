import { config } from "../../package.json";
import { log, randomHex, setTimer } from "./env";

export class AnkiTransportError extends Error {}
export class AnkiApiError extends Error {}

export interface InvokeOptions { timeout?: number; retries?: number }
export type AnkiInvoker = <T>(action: string, params: unknown, url: string, opts?: InvokeOptions) => Promise<T>;
export interface AnkiNote {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  options: unknown;
  tags: string[];
}
export interface SubmissionResult { added: boolean; pending: boolean; confirmed?: boolean; message: string }
interface PendingWrite { tag: string }
const PREF = config.prefsPrefix + ".pendingAnkiWrites";
const pending = new Map<string, PendingWrite>();

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimer(resolve, ms); });
}

function readPending(key: string): PendingWrite | undefined {
  try {
    const raw = Zotero.Prefs.get(PREF);
    if (typeof raw === "string") {
      const records = JSON.parse(raw) as Record<string, PendingWrite>;
      const record = records[key];
      if (record && /^p2a-write-[a-z0-9-]+$/.test(record.tag)) return record;
    }
  } catch (e) { log("读取待核对写卡记录失败：" + String(e)); }
  return pending.get(key);
}

export function hasPendingSubmission(key: string): boolean { return !!readPending(key); }

function savePending(key: string, value?: PendingWrite): void {
  if (value) pending.set(key, value);
  else pending.delete(key);
  try {
    const raw = Zotero.Prefs.get(PREF);
    const records: Record<string, PendingWrite> = typeof raw === "string" ? JSON.parse(raw) : {};
    if (value) records[key] = value;
    else delete records[key];
    Zotero.Prefs.set(PREF, JSON.stringify(records));
  } catch (e) { log("保存待核对写卡记录失败：" + String(e)); }
}

async function findSubmission(record: PendingWrite, url: string, invoke: AnkiInvoker): Promise<number | null> {
  const ids = await invoke<number[]>("findNotes", { query: "tag:" + record.tag }, url,
    { timeout: 3000, retries: 1 });
  if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new AnkiTransportError("核对卡片时收到无效的笔记列表");
  }
  return ids[0] ?? null;
}

async function finishSubmission(key: string, record: PendingWrite, noteId: number, url: string, invoke: AnkiInvoker): Promise<void> {
  // The operation tag is temporary. Failure to remove it must not turn a saved note into an error.
  savePending(key);
  try { await invoke("removeTags", { notes: [noteId], tags: record.tag }, url, { timeout: 3000, retries: 0 }); }
  catch (e) { log("卡片已写入；清理核对标记失败：" + String(e)); }
}

/** Never automatically repeat addNote: a lost response does not mean the write failed. */
export async function submitAnkiNote(
  note: AnkiNote, url: string, key: string, invoke: AnkiInvoker,
  onProgress?: (stage: string) => void,
): Promise<SubmissionResult> {
  const previous = readPending(key);
  if (previous) {
    onProgress?.("核对…");
    try {
      const id = await findSubmission(previous, url, invoke);
      if (id !== null) {
        await finishSubmission(key, previous, id, url, invoke);
        return { added: true, pending: false, confirmed: true, message: "已核对：卡片已经写入 Anki" };
      }
      // This click only verifies the previous attempt. A further explicit click may start a new write.
      savePending(key);
      return { added: false, pending: false, message: "未查到上次提交的卡片。请在 Anki 核对；确认没有卡片后可再次点击重试" };
    } catch (e) {
      log("核对上次写卡结果失败：" + String(e));
      return { added: false, pending: true, message: "暂时无法核对上次写入结果。再次点击只核对结果，不会重复写入" };
    }
  }

  const record = { tag: "p2a-write-" + Date.now().toString(36) + "-" + randomHex(12) };
  savePending(key, record);
  try {
    const id = await invoke<number>("addNote", { note: { ...note, tags: [...note.tags, record.tag] } }, url,
      { retries: 0 });
    if (!Number.isSafeInteger(id) || id <= 0) throw new AnkiTransportError("新增卡片未返回有效的笔记编号");
    await finishSubmission(key, record, id, url, invoke);
    return { added: true, pending: false, message: "已写入 Anki" };
  } catch (e) {
    if (e instanceof AnkiApiError) {
      savePending(key);
      throw e;
    }
    log("新增卡片响应异常，开始核对结果：" + String(e));
    onProgress?.("核对…");
    // Read-only probes allow a delayed commit to become visible; no addNote is resent.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await delay(attempt * 250);
      try {
        const id = await findSubmission(record, url, invoke);
        if (id !== null) {
          await finishSubmission(key, record, id, url, invoke);
          return { added: true, pending: false, confirmed: true, message: "已核对：卡片已经写入 Anki" };
        }
      } catch (probeError) { log("核对本次写卡结果失败：" + String(probeError)); }
    }
    return { added: false, pending: true, message: "未收到写入确认。卡片可能已保存；再次点击将核对结果，不会重复写入" };
  }
}
