// scripts/sync-demo.ts
// Bun-friendly demo driver. Reads workgroup checklist specs from files in a directory,
// and creates/updates child pages under a parent page, preserving checkbox states and assignees.
// Usage:
//   bun install
//   export CONFLUENCE_BASE_URL="https://confluence.hl7.org"
//   export CONFLUENCE_PAT="your_dc_pat"
//   export SPACE_KEY="FMG"
//   export PARENT_PAGE_ID="123456"        // ancestor page ID
//   bun run scripts/sync-demo.ts
//
// Flags: [--dry] [--workgroups-dir ./workgroups]
//
// The workgroups directory should contain files named after each workgroup (e.g., WG-ADM.json, WG-BAL.json)
// Each file should contain a ChecklistSpec in JSON format.
//
import { ConfluenceChecklistManager, ChecklistSpec } from "../src/confluence-checklist-manager";
import { readdirSync, readFileSync } from "fs";
import { join, basename, extname } from "path";

const BASE_URL = process.env.CONFLUENCE_BASE_URL!;
const PAT = process.env.CONFLUENCE_PAT!;
const SPACE_KEY = process.env.SPACE_KEY || "FMG";
const PARENT_PAGE_ID = process.env.PARENT_PAGE_ID; // required for this use case
const DRY = process.argv.includes("--dry");

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i+1] : undefined;
}
const WORKGROUPS_DIR = argAfter("--workgroups-dir") ?? "./workgroups";

if (!BASE_URL || !PAT) {
  console.error("Set env: CONFLUENCE_BASE_URL and CONFLUENCE_PAT");
  process.exit(1);
}

if (!PARENT_PAGE_ID) {
  console.error("Set env: PARENT_PAGE_ID (the parent page under which workgroup pages will be created)");
  process.exit(1);
}

const mgr = new ConfluenceChecklistManager({
  baseUrl: BASE_URL,
  pat: PAT,
  //userAgent: "HL7-FHIR-ChecklistSync/1.0",
  logger: (msg?: any, ...rest: any[]) => console.log(msg, ...rest),
});

/** Load workgroup spec from a JSON file */
function loadWorkgroupSpec(filePath: string): { wgId: string; spec: ChecklistSpec } {
  const content = readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);

  // Extract workgroup ID from filename (e.g., WG-ADM.json -> WG-ADM)
  const fileName = basename(filePath, extname(filePath));

  return {
    wgId: fileName,
    spec: data as ChecklistSpec
  };
}

/** Load all workgroup specs from the directory */
function loadAllWorkgroups(dirPath: string): Array<{ wgId: string; spec: ChecklistSpec }> {
  try {
    const files = readdirSync(dirPath)
      .filter(f => f.endsWith('.json'))
      .map(f => join(dirPath, f));

    if (files.length === 0) {
      console.warn(`No JSON files found in ${dirPath}`);
      return [];
    }

    return files.map(loadWorkgroupSpec);
  } catch (err: any) {
    console.error(`Error reading workgroups directory ${dirPath}: ${err.message}`);
    process.exit(1);
  }
}

async function run() {
  console.log(`Space: ${SPACE_KEY} | Parent: ${PARENT_PAGE_ID} | Workgroups Dir: ${WORKGROUPS_DIR} | Dry: ${DRY}`);

  // Load all workgroup specifications from files
  const workgroups = loadAllWorkgroups(WORKGROUPS_DIR);

  if (workgroups.length === 0) {
    console.error("No workgroup specification files found. Exiting.");
    process.exit(1);
  }

  console.log(`Loaded ${workgroups.length} workgroup(s): ${workgroups.map(w => w.wgId).join(", ")}`);

  // Build plans for each workgroup
  const plans = workgroups.map(({ wgId, spec }) => ({
    wgId: wgId,
    spaceKey: SPACE_KEY,
    pageTitle: spec.title || `${wgId} Checklist`,
    parentId: PARENT_PAGE_ID,
    labels: ["managed-checklist", wgId.toLowerCase()],
    spec: spec,
    includeRemovedSection: false,
    dryRun: DRY,
    propertyKey: "checklist.meta",
    propertyExtra: { workgroup: wgId, syncedAt: new Date().toISOString() }
  }));

  const results = await mgr.syncWorkgroups(plans);
  console.log("\nResults:");
  console.log(results);
}

run().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
