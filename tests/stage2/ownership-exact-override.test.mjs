import assert from 'node:assert/strict';
import { phase10OwnershipViolation } from '../../tools/validation/phase10/ownership-check.mjs';
import { phase11OwnershipViolation } from '../../tools/validation/phase11/ownership-check.mjs';

const phase10Manifest = {
  allowedExact: ['js/managed/runtime-binding.js'],
  allowedPrefixes: ['js/runtime/'],
  forbiddenPrefixes: ['js/managed/'],
};
assert.equal(phase10OwnershipViolation('js/managed/runtime-binding.js', phase10Manifest), null);
assert.equal(phase10OwnershipViolation('js/managed/unowned.js', phase10Manifest), 'forbidden:js/managed/unowned.js');
assert.equal(phase10OwnershipViolation('random/file.js', phase10Manifest), 'unowned:random/file.js');

const phase11Manifest = {
  allowedExact: ['js/runtime/authority.js'],
  allowedPrefixes: ['js/managed/'],
  forbiddenPrefixes: ['js/runtime/'],
};
assert.equal(phase11OwnershipViolation('js/runtime/authority.js', phase11Manifest), null);
assert.equal(phase11OwnershipViolation('js/runtime/unowned.js', phase11Manifest), 'forbidden:js/runtime/unowned.js');
assert.equal(phase11OwnershipViolation('random/file.js', phase11Manifest), 'unowned:random/file.js');

console.log('[stage2] ownership exact-override precedence tests passed');
