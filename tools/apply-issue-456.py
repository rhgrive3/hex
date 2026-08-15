from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/report.js',
"""    if (callers.length) facts.push(fact('callers', { n: callers.length }));
    if (!callers.length) facts.push(fact('no-callers', null));
    const stats = program.statsOf(range.start, range.end);
""",
"""    if (callers.length) facts.push(fact('callers', { n: callers.length }));
    if (!callers.length && program.statsComplete === true) facts.push(fact('no-callers', null));
    const stats = program.statsOf(range.start, range.end);
""")

replace_once('js/report.js',
"""  if (program && !program.statsComplete) unknowns.push(unknown('stats-partial', null));
""",
"""  if (program && !program.statsComplete) {
    unknowns.push(unknown('stats-partial', null));
    unknowns.push(unknown('callers-partial', { reason: 'program-index-incomplete', observed: callers.length }));
  }
""")

replace_once('js/report.js',
"""  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });
  else nextSteps.push({ code: 'no-callers-hint', detail: null });
""",
"""  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });
  else if (program && program.statsComplete !== true) nextSteps.push({ code: 'check-callers-incomplete', detail: { reason: 'program-index-incomplete' } });
  else nextSteps.push({ code: 'no-callers-hint', detail: null });
""")

replace_once('package.json',
"""\"test\": \"node tests/issues-97-100-146-147.mjs""",
"""\"test\": \"node tests/issue-456-report-completeness.mjs && node tests/issues-97-100-146-147.mjs""")
