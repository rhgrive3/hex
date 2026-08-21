import assert from "node:assert/strict";
import * as facade from "../js/panels.js";
import * as file from "../js/ui/panels/file.js";
import * as navigation from "../js/ui/panels/navigation.js";
import * as settings from "../js/ui/panels/settings.js";
import * as panelIndex from "../js/ui/panels/index.js";

console.log("Testing Panels compatibility surface...");

// 1. Export presence and identity
assert.equal(facade.showFileInfo, file.showFileInfo);
assert.equal(facade.showSections, file.showSections);
assert.equal(facade.showStructure, file.showStructure);
assert.equal(facade.showJump, navigation.showJump);
assert.equal(facade.showSearch, navigation.showSearch);
assert.equal(facade.showSettings, settings.showSettings);

assert.equal(panelIndex.showFileInfo, file.showFileInfo);
assert.equal(panelIndex.showSections, file.showSections);
assert.equal(panelIndex.showStructure, file.showStructure);
assert.equal(panelIndex.showJump, navigation.showJump);
assert.equal(panelIndex.showSearch, navigation.showSearch);
assert.equal(panelIndex.showSettings, settings.showSettings);

console.log("  ok 1 export presence and identity");

// 2. Existing surface inventory
const EXPECTED_PANEL_EXPORTS = Object.freeze([
  "RELIABILITY",
  "applySemantic",
  "instructionMenu",
  "reliabilityClass",
  "reliabilityWord",
  "showAccuracyNotes",
  "showAddressInfo",
  "showAppMap",
  "showBlockDetail",
  "showCallGraph",
  "showCandidateWhy",
  "showCandidates",
  "showChapter",
  "showClass",
  "showDataTable",
  "showDataTables",
  "showDetail",
  "showFeatures",
  "showField",
  "showFileInfo",
  "showFunctionReport",
  "showFunctionSummary",
  "showFunctions",
  "showGlossary",
  "showHelp",
  "showInvestigate",
  "showJump",
  "showLearn",
  "showOverview",
  "showPinned",
  "showSampleGuide",
  "showSearch",
  "showSections",
  "showSettings",
  "showStrings",
  "showStructure",
  "showSubsystem",
  "showTerm",
  "showValueFlow",
  "showWelcome",
  "showXrefs",
]);

assert.deepEqual(Object.keys(facade).sort(), [...EXPECTED_PANEL_EXPORTS]);
console.log("  ok 2 surface inventory exact match");

// 3. Module boundary smoke
assert.equal(typeof file.showFileInfo, "function");
assert.equal(typeof file.showSections, "function");
assert.equal(typeof file.showStructure, "function");
assert.equal(typeof navigation.showJump, "function");
assert.equal(typeof navigation.showSearch, "function");
assert.equal(typeof settings.showSettings, "function");
console.log("  ok 3 module boundary smoke");

console.log("All Panels compatibility surface tests PASS!");
