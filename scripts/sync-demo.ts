// scripts/sync-demo.ts
// Bun-friendly demo driver. Syncs 10 workgroups with a v1 spec, then you can re-run with --phase v2.
// Usage:
//   bun install
//   export CONFLUENCE_BASE_URL="https://confluence.hl7.org"
//   export CONFLUENCE_PAT="your_dc_pat"
//   export SPACE_KEY="FMG"
//   export PARENT_PAGE_ID="123456"        // ancestor page ID
//   bun run scripts/sync-demo.ts --phase v1
//   # later
//   bun run scripts/sync-demo.ts --phase v2
//
// Flags: --phase v1|v2  [--dry]
//
// Tip: Override the wg list with WG_LIST env: WG_LIST="WG-ABC,WG-DEF,..."
//
import { ConfluenceChecklistManager, ChecklistSpec } from "../src/confluence-checklist-manager";

const BASE_URL = process.env.CONFLUENCE_BASE_URL!;
const PAT = process.env.CONFLUENCE_PAT!;
const SPACE_KEY = process.env.SPACE_KEY || "FMG";
const PARENT_PAGE_ID = process.env.PARENT_PAGE_ID; // optional
const DRY = process.argv.includes("--dry");

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i+1] : undefined;
}
const phase = argAfter("--phase") ?? "v1"; // "v1" or "v2"

if (!BASE_URL || !PAT) {
  console.error("Set env: CONFLUENCE_BASE_URL and CONFLUENCE_PAT");
  process.exit(1);
}

const mgr = new ConfluenceChecklistManager({
  baseUrl: BASE_URL,
  pat: PAT,
  //userAgent: "HL7-FHIR-ChecklistSync/1.0",
  logger: (msg?: any, ...rest: any[]) => console.log(msg, ...rest),
});

// Default 10 WGs (override with WG_LIST env)
const defaultWGs = ["WG-ADM","WG-BAL","WG-CAR","WG-DER","WG-ENG","WG-FIN","WG-GOV","WG-HIS","WG-INT","WG-JSN"];
const WG_LIST = (process.env.WG_LIST ? process.env.WG_LIST.split(",").map(s => s.trim()).filter(Boolean) : defaultWGs);

function makeSpecV1(wg: string): ChecklistSpec {
  return {
    panelTitle: "HL7 FHIR Checklist (managed)",
    title: `FHIR R6 Pre‑Publication — ${wg}`,
    sections: [
      { heading: "Readiness", items: [
        { id: `${wg}:pkg-updated`, text: "Packages (IGs/modules) updated to R6 naming" },
        { id: `${wg}:wg-approval`, text: "Working Group approval recorded in minutes" }
      ]},
      { heading: "Testing", items: [
        { id: `${wg}:ci-green`, text: "CI pipeline green (validation passes)" },
        { id: `${wg}:examples-checked`, text: "Example instances updated" }
      ]}
    ]
  };
}

function makeSpecV2(wg: string): ChecklistSpec {
  // Reordered + added an item, to demonstrate preserving states and bodies
  return {
    panelTitle: "HL7 FHIR Checklist (managed)",
    title: `FHIR R6 Pre‑Publication — ${wg}`,
    sections: [
      { heading: "Approvals", items: [
        { id: `${wg}:wg-approval`, text: "Working Group approval recorded in minutes" }
      ]},
      { heading: "Readiness", items: [
        { id: `${wg}:pkg-updated`, text: "Packages (IGs/modules) updated to R6 naming" }
      ]},
      { heading: "Testing", items: [
        { id: `${wg}:ci-green`, text: "CI pipeline green (validation passes)" },
        { id: `${wg}:examples-checked`, text: "Example instances updated" },
        { id: `${wg}:tx-server`, text: "Terminology server preflight complete" }
      ]}
    ]
  };
}

async function run() {
  console.log(`Phase: ${phase} | Space: ${SPACE_KEY} | Parent: ${PARENT_PAGE_ID ?? "(none)"} | Dry: ${DRY}`);

  const plans = WG_LIST.map((wg) => ({
    wgId: wg,
    spaceKey: SPACE_KEY,
    pageTitle: `${wg} — Pre‑Publication Checklist (R6)`,
    parentId: PARENT_PAGE_ID,
    labels: ["hl7","fhir","prepub", wg.toLowerCase()],
    spec: phase === "v1" ? makeSpecV1(wg) : makeSpecV2(wg),
    includeRemovedSection: false,
    dryRun: DRY,
    propertyKey: "hl7.checklistMeta",
    propertyExtra: { workgroup: wg, release: "R6", phase }
  }));

  const results = await mgr.syncWorkgroups(plans);
  console.log("Results:");
  console.log(results);
}

run().catch(err => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
