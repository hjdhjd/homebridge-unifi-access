/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * docs-chrome.test.ts: That every documentation surface the chrome manifest stamps is a fresh render of that manifest.
 *
 * The manifest is the one statement of the masthead, the documentation index, the dashboard badges, the logo, and the settings page's footer, and the library
 * projects it into the README, every content document, the webUI, and the configuration schema. These rows re-render each region from the committed manifest and
 * compare it with the committed file, so a badge edited in place, a document added to the index but never stamped, a logo address changed on the page alone, a
 * footer link retyped in the schema, or a manifest edit nobody regenerated fails a commit rather than reaching a reader. The webUI's project list is the one
 * region left to the docs build: its source is fetched from the family's repository at stamp time, and a suite that reached the network to prove a document
 * would be proving the network.
 *
 * Which regions a document carries is the library's one answer to that question - the docs build plans its edits from it, and the content-documents row reads
 * the same plan - so the row checks both halves of it: an opted-in region matches its render, and an opted-out region's markers are absent, which is what keeps
 * a document the manifest excludes from passing here after a stray stamp.
 */
import { DEV_BADGES_BEGIN, DEV_BADGES_END, DOCUMENTATION_BEGIN, DOCUMENTATION_END, LOGO_BEGIN, LOGO_END, MASTHEAD_BEGIN, MASTHEAD_END, docChromeRegions,
  parseDocChromeManifest, renderDevBadges, renderDocIndex, renderLogo, renderMasthead, renderSchemaFooter, spliceJsonStringValue,
  spliceMarkedRegion } from "homebridge-plugin-utils";
import type { DocChromeManifest, DocEntry } from "homebridge-plugin-utils";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The manifest's path from the repository root, which is also the source name the validator reports a mis-shaped field against.
const MANIFEST = "docChrome.json";

// One stamped region: the marker pair it sits between and the content the manifest renders for it.
interface Region {

  begin: string;
  content: string;
  end: string;
}

/**
 * Read a committed file by its path from the repository root, relative to this suite so the rows run from any working directory.
 *
 * @param path - The path from the repository root.
 *
 * @returns The file's text.
 */
async function committed(path: string): Promise<string> {

  return readFile(new URL("../" + path, import.meta.url), "utf8");
}

/**
 * Read and validate the committed manifest through the library's own validator, so a mis-shaped manifest fails here with the field named rather than as a render
 * error further down.
 *
 * @returns The validated manifest.
 */
async function manifest(): Promise<DocChromeManifest> {

  return parseDocChromeManifest(JSON.parse(await committed(MANIFEST)), MANIFEST);
}

/**
 * Splice every rendered region into a document, exactly as the docs build does, so comparing the result with the committed text is one assertion per file.
 *
 * @param source  - The committed document.
 * @param regions - The regions the manifest renders into it.
 *
 * @returns The document with every region re-rendered.
 */
function stamped(source: string, regions: readonly Region[]): string {

  return regions.reduce((text, region) => spliceMarkedRegion(text, region.content, { beginMarker: region.begin, endMarker: region.end }), source);
}

test("the README carries the masthead, the documentation index, and the dashboard badges the manifest renders", async () => {

  const chrome = await manifest();
  const source = await committed("README.md");

  const regions: Region[] = [

    { begin: MASTHEAD_BEGIN, content: renderMasthead(chrome), end: MASTHEAD_END },
    { begin: DOCUMENTATION_BEGIN, content: renderDocIndex({ manifest: chrome, surface: "readme" }), end: DOCUMENTATION_END },
    { begin: DEV_BADGES_BEGIN, content: renderDevBadges(chrome), end: DEV_BADGES_END }
  ];

  assert.equal(stamped(source, regions), source, "the README's stamped regions match the manifest; regenerate them with prepare-chrome");
});

test("every content document carries the masthead and its own footer index", async () => {

  const chrome = await manifest();
  const documents = chrome.nav.flatMap(section => section.entries).filter((entry): entry is Extract<DocEntry, { kind: "doc" }> => entry.kind === "doc");

  assert.ok(documents.length > 0, "the manifest lists at least one document, or this row proves nothing");

  for(const entry of documents) {

    // Each document is read and compared in turn, so a failure names the document rather than a position in a list.
    // eslint-disable-next-line no-await-in-loop
    const source = await committed(entry.file);
    const plan = docChromeRegions(entry);
    const regions: Region[] = [];

    assert.equal(source.includes(MASTHEAD_BEGIN), plan.masthead, entry.file + " carries the masthead markers exactly when its plan says so");
    assert.equal(source.includes(DOCUMENTATION_BEGIN), plan.documentation, entry.file + " carries the documentation markers exactly when its plan says so");

    if(plan.masthead) {

      regions.push({ begin: MASTHEAD_BEGIN, content: renderMasthead(chrome), end: MASTHEAD_END });
    }

    if(plan.documentation) {

      regions.push({ begin: DOCUMENTATION_BEGIN, content: renderDocIndex({ currentFile: entry.file, manifest: chrome, surface: "doc-footer" }),
        end: DOCUMENTATION_END });
    }

    assert.equal(stamped(source, regions), source, entry.file + " matches the manifest's chrome; regenerate it with prepare-chrome");
  }
});

test("the webUI carries the documentation index and the logo the manifest renders", async () => {

  const chrome = await manifest();
  const source = await committed("homebridge-ui/public/index.html");

  const regions: Region[] = [

    { begin: DOCUMENTATION_BEGIN, content: renderDocIndex({ manifest: chrome, surface: "webui" }), end: DOCUMENTATION_END },
    { begin: LOGO_BEGIN, content: renderLogo(chrome), end: LOGO_END }
  ];

  assert.equal(stamped(source, regions), source, "the webUI's documentation index and logo match the manifest; regenerate them with prepare-chrome");
});

test("the configuration schema carries the footer sentence the manifest renders", async () => {

  const chrome = await manifest();
  const schema = chrome.surfaces?.schema;

  // Where the footer lives is the manifest's own declaration, so a manifest that stops declaring the schema as a surface fails here by name rather than leaving
  // the footer unstamped with nothing to say so: check mode passes an undeclared surface, because it has no target to compare.
  assert.ok(schema !== undefined, "the manifest declares the configuration schema as a stamped surface");

  const source = await committed(schema);

  assert.equal(spliceJsonStringValue(source, "footerDisplay", renderSchemaFooter(chrome)), source,
    "the schema's footer matches the manifest; regenerate it with prepare-chrome");
});
