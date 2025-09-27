// src/confluence-checklist-manager.ts
// Node 18+ or Bun (global fetch). Depends on: cheerio
// npm/bun add cheerio

import * as cheerio from "cheerio";
import { createHash } from "crypto";

/** Shapes you provide to the library */
export type ChecklistItem = { id: string; text: string };
export type ChecklistSection = { heading?: string; items: ChecklistItem[] };
export type ChecklistSpec = {
  /** Optional H2 shown at the top *inside* the managed panel */
  title?: string;
  /** Title of the Confluence Panel where the checklist lives (used to scope edits). Defaults to "Checklist (managed)". */
  panelTitle?: string;
  sections: ChecklistSection[];
};

export type EnsurePageAndSyncParams = {
  /** Confluence space key to create/find pages in (e.g., "FHIR", "FMG") */
  spaceKey: string;
  /** Page title (e.g., "WG-ABC — Pre-Publication Checklist (R6)") */
  pageTitle: string;
  /** The checklist spec to render+sync */
  spec: ChecklistSpec;
  /** Optional parent page ID (to place under an ancestor). */
  parentId?: string | number;
  /** Labels to attach to the page (e.g., ["hl7","fhir","prepub","wg-abc"]) */
  labels?: string[];
  /** If true, keep a "Removed items (reference)" section for dropped IDs. Default: false. */
  includeRemovedSection?: boolean;
  /** If true, print what would be written but don't PUT. Default: false. */
  dryRun?: boolean;
  /** Content property key to store traceability metadata. Default: "hl7.checklistMeta". */
  propertyKey?: string;
  /** Extra metadata to include in the property value. */
  propertyExtra?: Record<string, unknown>;
};

export type SyncByIdParams = {
  pageId: string | number;
  spec: ChecklistSpec;
  includeRemovedSection?: boolean;
  dryRun?: boolean;
  propertyKey?: string;
  propertyExtra?: Record<string, unknown>;
};

export type WorkgroupPlan = {
  wgId: string;                  // "WG-ABC"
  pageTitle: string;             // per-WG page title
  spaceKey: string;              // e.g., "FMG"
  spec: ChecklistSpec;           // per-WG spec
  parentId?: string | number;    // optional ancestor
  labels?: string[];             // optional labels per page
  includeRemovedSection?: boolean;
  dryRun?: boolean;
  propertyKey?: string;
  propertyExtra?: Record<string, unknown>;
};

export type EnsureResult = {
  pageId: string;
  created: boolean;
  updated: boolean;
};

/** Construction options for the manager */
export type ConfluenceChecklistManagerOptions = {
  /** Base URL to your DC/Server site, e.g. "https://confluence.hl7.org" (no trailing slash) */
  baseUrl: string;
  /** Personal Access Token (PAT); used as Bearer */
  pat: string;
  /** Optional custom fetch (defaults to global fetch) */
  fetchImpl?: typeof fetch;
  /** Optional logger */
  logger?: (msg?: any, ...rest: any[]) => void;
  /** Custom User-Agent header if you prefer */
  userAgent?: string;
};

/** Internal types */
type PageMinimal = { id: string; title: string; type: string; space?: { key: string }; version?: { number: number } };
type PageGetResponse = PageMinimal & { body?: { storage?: { value?: string } } };

const DEFAULT_PANEL_TITLE = "Checklist (managed)";
const UA_DEFAULT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** High-level manager for DC/Server checklist projection & sync */
export class ConfluenceChecklistManager {
  private baseUrl: string;
  private pat: string;
  private fetch: typeof fetch;
  private log: (msg?: any, ...rest: any[]) => void;
  private userAgent: string;

  constructor(opts: ConfluenceChecklistManagerOptions) {
    if (!opts.baseUrl || !opts.pat) {
      throw new Error("ConfluenceChecklistManager: baseUrl and pat are required.");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.pat = opts.pat;
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetch) throw new Error("No fetch implementation available. Use Node 18+/Bun or pass fetchImpl.");
    this.log = opts.logger ?? (() => {});
    this.userAgent = opts.userAgent ?? UA_DEFAULT;
  }

  // ===========================
  // Public top-level operations
  // ===========================

  /** Create (if missing) + sync a single page under a space/optional parent */
  async ensurePageAndSync(p: EnsurePageAndSyncParams): Promise<EnsureResult> {
    const {
      spaceKey,
      pageTitle,
      parentId,
      spec,
      labels = [],
      includeRemovedSection = false,
      dryRun = false,
      propertyKey = "hl7.checklistMeta",
      propertyExtra,
    } = p;

    // 1) find page
    let page = await this.findPageByTitle(spaceKey, pageTitle);

    // 2) if missing, create a new page with initial managed panel content
    let created = false;
    if (!page) {
      const initialStorage = this.buildManagedPanelStorage(spec, new Map(), includeRemovedSection, undefined /*prevIds*/);
      const createdPage = await this.createPage({
        spaceKey,
        title: pageTitle,
        storage: initialStorage,
        parentId,
        dryRun,
      });
      page = createdPage;
      created = true;

      // Attach labels if requested
      if (!dryRun && labels.length) {
        await this.addLabels(page.id, labels);
      }
    }

    // 3) sync (merge state + bodies, stable task-ids)
    const updated = await this.syncById({
      pageId: page.id,
      spec,
      includeRemovedSection,
      dryRun,
      propertyKey,
      propertyExtra,
    });

    return { pageId: String(page.id), created, updated };
  }

  /** Sync a known page ID */
  async syncById(p: SyncByIdParams): Promise<{ updated: boolean }> {
    const {
      pageId,
      spec,
      includeRemovedSection = false,
      dryRun = false,
      propertyKey = "hl7.checklistMeta",
      propertyExtra,
    } = p;

    // Read current page (storage + version)
    const page = await this.getPage(pageId);
    const storage = page.body?.storage?.value ?? "";
    const versionNum = page.version?.number ?? 1;
    const title = page.title;
    const type = page.type ?? "page";
    const spaceKey = page.space?.key;

    // Collect existing tasks (status, taskId, bodyXml) scoped to our panel
    const panelTitle = spec.panelTitle || DEFAULT_PANEL_TITLE;
    const existingMap = this.readExistingTasks(storage, panelTitle);

    // Merge + rebuild managed panel inner XML (preserve user-edited bodies, ids, and states)
    const prevAllTaskIds = this.collectAllTaskIdsOnPage(storage);
    const newStorage = this.setManagedPanel(
      storage,
      panelTitle,
      this.buildPanelInnerXml(spec, existingMap, prevAllTaskIds, includeRemovedSection)
    );

    // No-op if identical
    if (normalizeXml(storage) === normalizeXml(newStorage)) {
      this.log(`[confluence-checklist-manager] Page ${pageId}: no changes; skip update.`);
      return { updated: false };
    }

    // PUT with retry on version conflicts
    await this.putPageWithRetry(
      { id: pageId, title, type, spaceKey, newStorage, version: versionNum },
      dryRun
    );

    // Upsert a small content property for traceability
    const meta = {
      generator: "confluence-checklist-manager",
      updatedAt: new Date().toISOString(),
      specHash: sha256(JSON.stringify(spec)),
      ...(propertyExtra ?? {}),
    };
    if (!dryRun) {
      await this.upsertProperty(pageId, propertyKey, meta);
    }

    this.log(`[confluence-checklist-manager] Page ${pageId} updated.`);
    return { updated: true };
  }

  /** Sync a batch of workgroups. Returns a map of wgId -> result. */
  async syncWorkgroups(plans: WorkgroupPlan[]): Promise<Record<string, EnsureResult>> {
    const out: Record<string, EnsureResult> = {};
    for (const plan of plans) {
      try {
        out[plan.wgId] = await this.ensurePageAndSync({
          spaceKey: plan.spaceKey,
          pageTitle: plan.pageTitle,
          spec: plan.spec,
          parentId: plan.parentId,
          labels: plan.labels,
          includeRemovedSection: plan.includeRemovedSection,
          dryRun: plan.dryRun,
          propertyKey: plan.propertyKey,
          propertyExtra: plan.propertyExtra,
        });
      } catch (e: any) {
        this.log(`[confluence-checklist-manager] WG ${plan.wgId} failed: ${e?.message || e}`);
        out[plan.wgId] = { pageId: "", created: false, updated: false };
      }
    }
    return out;
  }

  // ===========================
  // HTTP / REST low-level
  // ===========================

  private async api<T = any>(
    pathname: string,
    init: { method?: string; headers?: Record<string, string>; query?: Record<string, any>; body?: any } = {}
  ): Promise<{ data: T; status: number; headers: Headers }> {
    const url = new URL(`/rest/api${pathname}`, this.baseUrl);
    const { method = "GET", headers = {}, query = {}, body } = init;
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
    const isMutating = !["GET","HEAD","OPTIONS"].includes(method.toUpperCase());
    const baseOrigin = new URL(this.baseUrl).origin;
    const req = {
      method,
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
        ...(isMutating
        ? {
            "X-Atlassian-Token": "no-check",
            "Origin": baseOrigin,
            "Referer": `${baseOrigin}/`,
            }
        : {}),
        Authorization: `Bearer ${this.pat}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body,
    }

    this.log("DEBUG");
    this.log(url.href)
    this.log(JSON.stringify(req.headers, null, 2))
    this.log(body)

    const res = await this.fetch(url, req);
    //console.log(url, req)

    const text = await res.text();
    const ct = res.headers.get("content-type") || "";

    if (!res.ok) {
      // Surface WAF / HTML "Human Verification" case
      if (ct.includes("text/html") && /Human Verification/i.test(text)) {
        throw new Error(
          `WAF blocked request to ${url}. Ask admin to allowlist your IP or exempt /rest/api/* from JS challenge.`
        );
      }
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${method} ${url}\n${text}`);
    }

    let data: any = text;
    if (ct.includes("application/json")) {
      try {
        data = JSON.parse(text);
      } catch {}
    }
    return { data, status: res.status, headers: res.headers };
  }

  private async getPage(pageId: string | number): Promise<PageGetResponse> {
    const { data } = await this.api<PageGetResponse>(`/content/${pageId}`, {
      query: { expand: "body.storage,version,space" },
    });
    return data;
  }

  private async findPageByTitle(spaceKey: string, title: string): Promise<PageMinimal | null> {
    // Exact title match within space
    const { data } = await this.api<{ results: PageMinimal[] }>(`/content`, {
      query: { spaceKey, title, expand: "version" },
    });
    const page = (data.results || [])[0];
    return page ? { id: String(page.id), title: page.title, type: page.type, version: page.version } : null;
  }

  private async createPage(p: {
    spaceKey: string;
    title: string;
    storage: string;
    parentId?: string | number;
    dryRun?: boolean;
  }): Promise<PageMinimal> {
    const payload: any = {
      type: "page",
      title: p.title,
      space: { key: p.spaceKey },
      body: { storage: { value: p.storage, representation: "storage" } },
    };
    if (p.parentId) payload.ancestors = [{ id: String(p.parentId) }];

    if (p.dryRun) {
      this.log("[confluence-checklist-manager] [dry-run] CREATE PAGE", JSON.stringify(payload, null, 2));
      // Fake a page "id"
      return { id: "dry-run-id", title: p.title, type: "page", version: { number: 1 } };
    }

    const { data } = await this.api<PageMinimal>("/content", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    this.log(`[confluence-checklist-manager] Created page ${(data as any).id} "${p.title}" in ${p.spaceKey}.`);
    return { id: String((data as any).id), title: (data as any).title, type: (data as any).type, version: (data as any).version };
  }

  private async putPageWithRetry(
    p: { id: string | number; title: string; type?: string; spaceKey?: string; newStorage: string; version: number },
    dryRun: boolean,
    retries = 2
  ): Promise<void> {
    const payload: any = {
      id: String(p.id),
      type: p.type || "page",
      title: p.title,
      ...(p.spaceKey ? { space: { key: p.spaceKey } } : {}),
      version: { number: p.version + 1 },
      body: { storage: { value: p.newStorage, representation: "storage" } },
    };

    if (dryRun) {
      this.log("[confluence-checklist-manager] [dry-run] UPDATE PAGE", JSON.stringify(payload, null, 2));
      return;
    }

    try {
      await this.api(`/content/${p.id}`, { method: "PUT", body: JSON.stringify(payload) });
    } catch (e: any) {
      // Handle version conflict by reloading and retrying
      if (retries > 0 && /HTTP 409|version conflict/i.test(String(e?.message || e))) {
        this.log(`[confluence-checklist-manager] Version conflict on ${p.id}; refetching and retrying...`);
        const latest = await this.getPage(p.id);
        await this.putPageWithRetry(
          { ...p, version: latest.version?.number ?? p.version },
          dryRun,
          retries - 1
        );
        return;
      }
      throw e;
    }
  }

  private async upsertProperty(pageId: string | number, key: string, value: any): Promise<void> {
    let existing: any = null;
    try {
      const { data } = await this.api(`/content/${pageId}/property/${encodeURIComponent(key)}`);
      existing = data;
    } catch (_) {}
    if (existing?.version?.number) {
      const payload = { key, value, version: { number: existing.version.number + 1 } };
      await this.api(`/content/${pageId}/property/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      return;
    }
    await this.api(`/content/${pageId}/property`, {
      method: "POST",
      body: JSON.stringify({ key, value }),
    });
  }

  private async addLabels(pageId: string | number, labels: string[]): Promise<void> {
    // Fetch existing labels to avoid dup errors
    const existing = await this.api<{ results: { name: string }[] }>(`/content/${pageId}/label`, {
      query: { limit: 1000 },
    });
    const existingSet = new Set((existing.data.results || []).map((l) => l.name));
    const toAdd = labels.filter((l) => !existingSet.has(l)).map((name) => ({ prefix: "global", name }));

    if (!toAdd.length) return;
    await this.api(`/content/${pageId}/label`, {
      method: "POST",
      body: JSON.stringify(toAdd),
    });
  }

  // ===========================
  // Storage Format helpers
  // ===========================

  /** Build a full page body with just our managed panel (used on create) */
  private buildManagedPanelStorage(
    spec: ChecklistSpec,
    existingMap: Map<string, ExistingTask>,
    includeRemovedSection: boolean,
    prevAllTaskIds?: Set<string>
  ): string {
    const inner = this.buildPanelInnerXml(
      spec,
      existingMap,
      prevAllTaskIds ?? new Set(),
      includeRemovedSection
    );
    return `
<ac:structured-macro ac:name="panel">
  <ac:parameter ac:name="title">${escapeXml(spec.panelTitle || DEFAULT_PANEL_TITLE)}</ac:parameter>
  <ac:rich-text-body>
${inner}
  </ac:rich-text-body>
</ac:structured-macro>`.trim();
  }

  /** Replace or insert the managed panel in the current storage */
  private setManagedPanel(storageXml: string, panelTitle: string, innerXml: string): string {
    const $ = cheerio.load(storageXml, {
      xmlMode: true,
      decodeEntities: false,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    });

    let target: cheerio.Element | null = null;
    $('ac\\:structured-macro[ac\\:name="panel"]').each((_, el) => {
      const t = $(el).find('ac\\:parameter[ac\\:name="title"]').first().text().trim();
      if (t === panelTitle) { target = el; return false; }
    });

    if (target) {
      $(target).find('ac\\:rich-text-body').first().html(innerXml);
      return $.xml();
    }

    // Append a new panel at the end
    const newPanel = `
<ac:structured-macro ac:name="panel">
  <ac:parameter ac:name="title">${escapeXml(panelTitle)}</ac:parameter>
  <ac:rich-text-body>
${innerXml}
  </ac:rich-text-body>
</ac:structured-macro>`;
    return (storageXml ? storageXml + "\n" : "") + newPanel.trim() + "\n";
  }

  /** Existing task facts we retain */
  private readExistingTasks(storageXml: string, panelTitle: string): Map<string, ExistingTask> {
    const $ = cheerio.load(storageXml, {
      xmlMode: true,
      decodeEntities: false,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    });

    let target: cheerio.Element | null = null;
    $('ac\\:structured-macro[ac\\:name="panel"]').each((_, el) => {
      const t = $(el).find('ac\\:parameter[ac\\:name="title"]').first().text().trim();
      if (t === panelTitle) { target = el; return false; }
    });
    if (!target) return new Map();

    const map = new Map<string, ExistingTask>();
    $(target).find('ac\\:task').each((_, task) => {
      const $task = $(task);
      const status = $task.find('ac\\:task-status').first().text().trim() || "incomplete";
      const taskId = $task.find('ac\\:task-id').first().text().trim() || null;

      const $body = $task.find('ac\\:task-body').first();
      const bodyXml = $.xml($body); // full body (preserves user edits/mentions)

      // Our stable key is the hidden Anchor in the body
      let anchorId: string | null = null;
      $body.find('ac\\:structured-macro[ac\\:name="anchor"]').each((__, a) => {
        const val = $(a).find('ac\\:parameter[ac\\:name=""]').first().text().trim();
        if (val) anchorId = val;
      });

      if (anchorId) {
        map.set(anchorId, { status: (status as any), taskId, bodyXml });
      }
    });
    return map;
  }

  /** Build inner XML of the managed panel (preserve bodies & states; allocate/reuse task-ids) */
  private buildPanelInnerXml(
    spec: ChecklistSpec,
    existingMap: Map<string, ExistingTask>,
    allTaskIdsOnPage: Set<string>,
    includeRemovedSection: boolean
  ): string {
    const chunks: string[] = [];
    if (spec.title) chunks.push(`<h2>${escapeXml(spec.title)}</h2>`);

    // Build main sections from the new spec
    for (const section of spec.sections || []) {
      if (section.heading) chunks.push(`<h3>${escapeXml(section.heading)}</h3>`);
      chunks.push(`<ac:task-list>`);

      for (const item of section.items || []) {
        const anchorId = item.id;
        const prev = existingMap.get(anchorId);
        const status = (prev?.status === "complete" ? "complete" : "incomplete");
        const taskId = prev?.taskId || this.allocateTaskId(allTaskIdsOnPage);
        const bodyXml = prev?.bodyXml
          ? ensureAnchorInBodyXml(prev.bodyXml, anchorId)
          : buildNewTaskBodyXml(anchorId, item.text);

        chunks.push(
`<ac:task>
  <ac:task-id>${taskId}</ac:task-id>
  <ac:task-status>${status}</ac:task-status>
  ${bodyXml}
</ac:task>`);
      }

      chunks.push(`</ac:task-list>`);
    }

    if (includeRemovedSection) {
      // Any previous anchors not present now
      const nowIds = new Set<string>();
      for (const s of spec.sections || []) for (const it of s.items || []) nowIds.add(it.id);

      const removed = [...existingMap.keys()].filter((k) => !nowIds.has(k));
      if (removed.length) {
        chunks.push(`<h3>Removed items (kept for reference)</h3>`);
        chunks.push(`<ac:task-list>`);
        for (const anchorId of removed) {
          const prev = existingMap.get(anchorId)!;
          const taskId = prev.taskId || this.allocateTaskId(allTaskIdsOnPage);
          const bodyXml = ensureAnchorInBodyXml(prev.bodyXml, anchorId);
          const status = (prev.status === "complete" ? "complete" : "incomplete");
          chunks.push(
`<ac:task>
  <ac:task-id>${taskId}</ac:task-id>
  <ac:task-status>${status}</ac:task-status>
  ${bodyXml}
</ac:task>`);
        }
        chunks.push(`</ac:task-list>`);
      }
    }

    // Note: per run, all newly allocated IDs are inserted into allTaskIdsOnPage to avoid duplication
    return chunks.join("\n");
  }

  /** Collect *all* <ac:task-id> strings across the entire page to avoid duplicates */
  private collectAllTaskIdsOnPage(storageXml: string): Set<string> {
    const $ = cheerio.load(storageXml, {
      xmlMode: true,
      decodeEntities: false,
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    });
    const ids = new Set<string>();
    $('ac\\:task-id').each((_, el) => {
      const id = $(el).text().trim();
      if (id) ids.add(id);
    });
    return ids;
  }

  /** Generate a unique numeric-ish string not colliding with any existing <ac:task-id> on the page */
  private allocateTaskId(allTaskIdsOnPage: Set<string>): string {
    let next = Date.now(); // seed with epoch millis for uniqueness
    while (allTaskIdsOnPage.has(String(next))) next++;
    const id = String(next++);
    allTaskIdsOnPage.add(id);
    return id;
  }
}

// ===========================
// Helpers (pure)
// ===========================

type ExistingTask = {
  status: "complete" | "incomplete";
  taskId: string | null;
  bodyXml: string; // includes <ac:task-body> ... </ac:task-body>
};

function escapeXml(s = ""): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function anchorXml(stableId: string): string {
  return `<ac:structured-macro ac:name="anchor"><ac:parameter ac:name="">${escapeXml(
    stableId
  )}</ac:parameter></ac:structured-macro>`;
}

function buildNewTaskBodyXml(anchorId: string, text: string): string {
  return `<ac:task-body><p>${anchorXml(anchorId)} ${escapeXml(text)}</p></ac:task-body>`;
}

/** Ensure bodyXml contains our hidden anchor; if not, insert it at the start of the task body */
function ensureAnchorInBodyXml(bodyXml: string, anchorId: string): string {
  const $ = cheerio.load(bodyXml, {
    xmlMode: true,
    decodeEntities: false,
    lowerCaseTags: false,
    lowerCaseAttributeNames: false,
  });
  // Detect an existing anchor with the exact value
  const found = $('ac\\:structured-macro[ac\\:name="anchor"] > ac\\:parameter[ac\\:name=""]')
    .toArray()
    .some((el) => $(el).text().trim() === anchorId);

  if (found) return bodyXml;

  const body = $('ac\\:task-body').first();
  if (body.length) {
    body.prepend(`${anchorXml(anchorId)} `);
    // Return the entire <ac:task-body>...</ac:task-body> element
    return $.xml(body);
  }

  // Fallback: wrap existing content
  return `<ac:task-body>${anchorXml(anchorId)} ${bodyXml}</ac:task-body>`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Normalize XML for equality checks (whitespace/indent-insensitive) */
function normalizeXml(x: string): string {
  return x.replace(/\s+/g, " ").trim();
}
