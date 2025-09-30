# Confluence Checklist Manager (DC/Server)

A tiny Bun/TypeScript toolkit + demo to **project and sync** externally-managed checklists into **Confluence Data Center/Server** pages, while:

- keeping checkboxes **working** (stable `<ac:task-id>` per task),
- preserving users' **edits/mentions** by reusing the entire `<ac:task-body>`,
- merging by a hidden **Anchor** ID so your structure can evolve safely,
- creating pages if missing, labeling them, and writing a small content property for traceability.

## Quick start (Bun)

```bash
bun install
cp .env.example .env
# Edit .env with your Confluence credentials
```

Set environment variables in `.env`:
```bash
CONFLUENCE_BASE_URL=https://confluence.example.com
CONFLUENCE_PAT=your_personal_access_token
SPACE_KEY=YOUR_SPACE
PARENT_PAGE_ID=123456  # The parent page ID under which workgroup pages will be created
```

**Initial sync with example workgroups:**
```bash
bun run scripts/sync-demo.ts --workgroups-dir examples/workgroups-initial-example
```

This creates child pages under `PARENT_PAGE_ID`, one per workgroup JSON file.

Let people check items, add `@mentions`, edit task text, etc.

**Sync updated checklists (preserves state!):**
```bash
bun run scripts/sync-demo.ts --workgroups-dir examples/workgroups-updated-example
```

The manager will:
- Preserve checkbox states (checked/unchecked)
- Keep all user edits and @mentions in task bodies
- Add new tasks/sections from updated specs
- Reorder existing tasks without losing state

Add `--dry` to preview requests without writing.

## Directory-based workflow

The demo script reads workgroup checklists from a directory of JSON files:

```
examples/
  workgroups-initial-example/
    Infrastructure.json
    Patient-Administration.json
    Vocabulary.json
    ...
  workgroups-updated-example/
    Infrastructure.json  # Updated version with new tasks
    Patient-Administration.json
    ...
```

Each JSON file contains a `ChecklistSpec`:
```json
{
  "panelTitle": "HL7 FHIR Checklist (managed)",
  "title": "FHIR R6 Pre‑Publication — Infrastructure",
  "sections": [
    {
      "heading": "Specification Pages",
      "items": [
        {
          "id": "Infrastructure:page:datatypes",
          "text": "datatypes.html - Review and approve for R6"
        }
      ]
    },
    {
      "heading": "Resources: Bundle",
      "items": [
        {
          "id": "Infrastructure:resource:Bundle:examples",
          "text": "Bundle - Examples validated"
        }
      ]
    }
  ]
}
```

The filename (minus `.json`) becomes the workgroup ID and is used in the page title.

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
