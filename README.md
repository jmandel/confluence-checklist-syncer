# Confluence Checklist Manager (DC/Server)

A tiny Bun/TypeScript toolkit + demo to **project and sync** externally-managed checklists into **Confluence Data Center/Server** pages, while:

- keeping checkboxes **working** (stable `<ac:task-id>` per task),
- preserving users’ **edits/mentions** by reusing the entire `<ac:task-body>`,
- merging by a hidden **Anchor** ID so your structure can evolve safely,
- creating pages if missing, labeling them, and writing a small content property for traceability.

## Quick start (Bun)

```bash
bun install
cp .env.example .env
# Edit .env to add token, set vals
# optional: WG_LIST to override the default 10 groups
# export WG_LIST="WG-ABC,WG-DEF,..."
```

**Initial publish (v1):**
```bash
bun run scripts/sync-demo.ts --phase v1
```

Let people check items, add `@mentions`, edit text.

**Evolve structure (v2):**
```bash
bun run scripts/sync-demo.ts --phase v2
```

Add `--dry` to preview requests without writing.

## Library API

See `src/confluence-checklist-manager.ts` for exported types and the `ConfluenceChecklistManager` class.

Key call patterns:
- `ensurePageAndSync({ spaceKey, pageTitle, parentId?, spec, labels? })`
- `syncById({ pageId, spec })`
- `syncWorkgroups(plans[])`

## Notes

- Auth: **Bearer PAT** (DC/Server) + “browser-y” headers (**User-Agent**, **Accept**).
- Body format: **Storage** format (`representation: "storage"`).
- Task IDs: reuses existing `<ac:task-id>` and allocates unique IDs for new items.
- Merge key: hidden **Anchor** macro inside each task body.
- Mentions: users can add `@mentions`; the first mention acts as the assignee in DC.
