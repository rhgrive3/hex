/* Load the stable worker, then layer modern dyld chained-fixup recovery on top. */
'use strict';
importScripts('./worker.js');
importScripts('./chained.js');
