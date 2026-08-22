import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const REPORT_DIR = path.join(ROOT, 'reports/competitive');
const SCORECARD_PATH = path.join(REPORT_DIR, 'scorecard.json');
const MD_REPORT_PATH = path.join(REPORT_DIR, 'scorecard.md');

export function formatCompetitiveMarkdownReport(scorecard) {
  const lines = [];
  lines.push('# Hex Competitive Attack Program — Official Scorecard');
  lines.push('');
  lines.push(`- **Profile:** \`${scorecard.profileId}\``);
  lines.push(`- **Git Commit:** \`${scorecard.gitSha}\``);
  lines.push(`- **Tree SHA:** \`${scorecard.treeSha}\``);
  lines.push(`- **Runtime Class:** \`${scorecard.runtimeHardwareClass}\``);
  lines.push(`- **Generated At:** ${scorecard.generatedAt}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`- **Total Metrics:** ${scorecard.summary.totalMetrics}`);
  lines.push(`- **WINS:** ${scorecard.summary.wins}`);
  lines.push(`- **TIES:** ${scorecard.summary.ties}`);
  lines.push(`- **LOSSES:** ${scorecard.summary.losses}`);
  lines.push(`- **UNMEASURED:** ${scorecard.summary.unmeasured}`);
  lines.push('');
  lines.push('## Metric Details');
  lines.push('');
  lines.push('| Metric ID | Hex Value | Reference Tool | Ref Value | Comparison | Run Policy |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const entry of scorecard.entries) {
    const hexVal = typeof entry.hexValue === 'number' ? entry.hexValue.toFixed(4) : String(entry.hexValue);
    const refVal = typeof entry.referenceValue === 'number' ? entry.referenceValue.toFixed(4) : String(entry.referenceValue);
    lines.push(`| \`${entry.metricId}\` | ${hexVal} | ${entry.referenceTool} (${entry.referenceVersion}) | ${refVal} | **${entry.comparison}** | ${entry.runPolicy} |`);
  }

  lines.push('');
  return lines.join('\n');
}

export function generateCompetitiveMarkdownReport({ scorecard = null } = {}) {
  let card = scorecard;
  if (!card) {
    if (!fs.existsSync(SCORECARD_PATH)) throw new Error('scorecard-json-missing');
    card = JSON.parse(fs.readFileSync(SCORECARD_PATH, 'utf8'));
  }

  const markdown = formatCompetitiveMarkdownReport(card);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(MD_REPORT_PATH, `${markdown}\n`);
  return markdown;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const report = generateCompetitiveMarkdownReport();
    console.log('Competitive Markdown report generated:\n');
    console.log(report);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
