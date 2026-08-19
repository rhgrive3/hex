'use strict';

/* Preserve the latest main worker implementation byte-for-byte in
 * worker-legacy.js, then override only audited entry points. */
importScripts('./worker-legacy.js');
importScripts('./worker-fixes.js');
importScripts('./worker-xref-memory-fix.js');
importScripts('./worker-analysis-function-evidence.js');
