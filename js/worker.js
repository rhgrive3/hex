'use strict';

/* Preserve the latest main worker implementation byte-for-byte in
 * worker-legacy.js, then override only audited compatibility entry points. */
importScripts('./worker-legacy.js');
importScripts('./worker-fixes.js');
importScripts('./worker-memory-fixes.js');
