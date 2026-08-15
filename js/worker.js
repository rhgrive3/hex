'use strict';

/* Preserve the latest main worker implementation byte-for-byte in
 * worker-legacy.js, then override only the three audited entry points. */
importScripts('./worker-legacy.js');
importScripts('./worker-fixes.js');
