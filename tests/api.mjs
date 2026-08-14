import { apiInfo } from '../js/blocks.js';

let passed = 0;

function api(name, id, cat) {
  const got = apiInfo(name);
  if (!got) throw new Error(`${name}: expected ${id}/${cat}, got unknown`);
  if (got.id !== id || got.cat !== cat) {
    throw new Error(`${name}: got ${got.id}/${got.cat}, want ${id}/${cat}`);
  }
  passed++;
}

api('_dispatch_get_global_queue', 'concurrency', 'concurrency');
api('_dispatch_get_main_queue', 'concurrency', 'concurrency');
api('_CGRectGetWidth', 'geometry', 'ui');
api('_CGRectGetHeight', 'geometry', 'ui');
api('_CGRectGetMidX', 'geometry', 'ui');
api('_swift_initStaticObject', 'swift_runtime', 'runtime');
api('_swift_arrayDestroy', 'swift_runtime', 'runtime');
api('_swift_setDeallocating', 'swift_runtime', 'runtime');
api('_swift_unexpectedError', 'swift_runtime', 'runtime');
api('___error', 'errno', 'runtime');
api('_memchr', 'memchr', 'memory');
api('_dispatch_queue_create', 'concurrency', 'concurrency');
api('_mktime', 'time', 'time');
api('_swift_getSingletonMetadata', 'swift_runtime', 'runtime');
api('__swift_stdlib_reportUnimplementedInitializer', 'swift_stdlib_report', 'runtime');

process.stdout.write(`API classification: ${passed} regressions ok\n`);
