'use strict';

/*
 * The audited worker implementation is preserved byte-for-byte in
 * worker-legacy.js. Hardened entry points are loaded afterwards so the message
 * protocol and unaffected fast paths remain unchanged.
 */
importScripts('./worker-legacy.js');
importScripts('./worker-fixes.js');
