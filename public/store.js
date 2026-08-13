/* Storage for VedryxTech Quotations.
 *
 * MongoDB is the system of record, reached through /api/documents. Local storage
 * is a mirror that keeps the app usable when the server or database is down —
 * and when index.html is opened straight from disk, where there is no API at all.
 *
 * Writes go to local storage first, so the UI never waits on the network, then to
 * the server. A write that fails is remembered and retried on the next successful
 * request, and a sync never discards a document the server has not seen. */
'use strict';

window.Store = (function () {
  const KEY = 'vedryxtech.quotations.v1';
  const LEGACY_KEY = 'vedryx.quotations.v1';   // pre-rename mirror
  const API = '/api/documents';

  let online = false;
  let lastError = null;
  const listeners = [];

  /* Documents whose database write failed, keyed by id. Retried on the next
     successful request; the local mirror holds the data meanwhile. */
  const pending = new Map();

  /* ------------------------------------------------------------ local mirror */

  function readLocal() {
    for (const key of [KEY, LEGACY_KEY]) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) {
          if (key === LEGACY_KEY) {
            localStorage.setItem(KEY, raw);      // migrate forward
            localStorage.removeItem(LEGACY_KEY);
          }
          return parsed;
        }
      } catch (err) {
        console.warn(`Could not read ${key}.`, err);
      }
    }
    return null;
  }

  function writeLocal(docs) {
    try {
      localStorage.setItem(KEY, JSON.stringify(docs));
    } catch (err) {
      console.warn('Could not write the local mirror.', err);
    }
  }

  /* -------------------------------------------------------------- API access */

  function notify() {
    const s = status();
    listeners.forEach((fn) => fn(s));
  }

  function setOnline(next, err) {
    const before = `${online}|${lastError}|${pending.size}`;
    online = next;
    lastError = err ? (err.message || String(err)) : null;
    if (`${online}|${lastError}|${pending.size}` !== before) notify();
  }

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || detail.error || `HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  /* Push everything that failed earlier. Silent on failure — it stays queued. */
  async function flushPending() {
    if (!pending.size) return false;
    const docs = [...pending.values()];
    try {
      await request('PUT', API, { documents: docs });
      docs.forEach((d) => pending.delete(d.id));
      notify();
      return true;
    } catch {
      return false;
    }
  }

  /* Reconcile with the server.
   *
   * Server state wins for any document both sides hold, but a document the server
   * has never seen is pushed up rather than dropped — otherwise a quotation saved
   * while the database was down would vanish on the next reload. Returns null when
   * unreachable, so the caller keeps what it already has. */
  async function syncFromServer(localDocs) {
    try {
      const { documents } = await request('GET', API);
      setOnline(true);

      const local = localDocs || readLocal() || [];
      const serverIds = new Set(documents.map((d) => d.id));
      const localOnly = local.filter((d) => d && d.id != null && !serverIds.has(d.id));

      if (localOnly.length) {
        try {
          await request('PUT', API, { documents: localOnly });
          localOnly.forEach((d) => pending.delete(d.id));
        } catch (err) {
          localOnly.forEach((d) => pending.set(d.id, d));
          setOnline(false, err);
        }
      }

      await flushPending();

      const merged = localOnly.length
        ? [...documents, ...localOnly].sort((a, b) => Number(a.id) - Number(b.id))
        : documents;

      writeLocal(merged);
      notify();
      return merged;
    } catch (err) {
      setOnline(false, err);
      return null;
    }
  }

  /* Persist one document. Local first so the UI is never blocked; resolves false
     when the database write did not land. */
  async function saveDoc(doc, allDocs) {
    if (allDocs) writeLocal(allDocs);
    try {
      await request('PUT', `${API}/${doc.id}`, doc);
      pending.delete(doc.id);
      setOnline(true);
      await flushPending();
      return true;
    } catch (err) {
      pending.set(doc.id, doc);
      setOnline(false, err);
      return false;
    }
  }

  async function deleteDoc(id, allDocs) {
    if (allDocs) writeLocal(allDocs);
    try {
      await request('DELETE', `${API}/${id}`);
      pending.delete(id);
      setOnline(true);
      return true;
    } catch (err) {
      setOnline(false, err);
      return false;
    }
  }

  function status() {
    return { online, error: lastError, pending: pending.size };
  }

  function onStatusChange(fn) {
    listeners.push(fn);
  }

  /* Retry whenever the browser regains connectivity or the tab is refocused. */
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => { flushPending(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && pending.size) flushPending();
    });
  }

  return {
    readLocal, writeLocal, syncFromServer, saveDoc, deleteDoc,
    flushPending, status, onStatusChange,
  };
})();
