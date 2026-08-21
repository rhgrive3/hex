import assert from 'node:assert/strict';
import { createArtifactDescriptor } from '../../../js/core/artifacts/contracts.js';
import { createHexProject } from '../../../js/project/index.js';
import { createProjectIdentity, createBinaryIdentity, createEntityIdentity } from '../../../js/phase12/identity.js';

const project = createHexProject({ binaryHash: 'sha256:binary-a' });
const projectId = createProjectIdentity({ projectId: 'project-a', binaryId: 'binary-a' });
const binaryId = createBinaryIdentity({ projectId, contentHash: project.binary.hash, format: 'macho', architecture: 'arm64' });
const entityId = createEntityIdentity({ binaryId, kind: 'function', stableKey: '0x1000' });
assert.equal(projectId, 'hex-project:project-a:binary-a');
assert.equal(binaryId, 'hex-binary:hex-project:project-a:binary-a:sha256:binary-a:macho:arm64');
assert.equal(entityId, 'hex-entity:hex-binary:hex-project:project-a:binary-a:sha256:binary-a:macho:arm64:function:0x1000');

const descriptor = createArtifactDescriptor({
  binaryId,
  entityId,
  artifactKind: 'phase12.identity-test',
  producerId: 'phase12-test',
  producerVersion: '1',
  versions: { loader: '1', architectureSemantic: '1', abiSemantic: 'n/a', semanticSchema: '1' },
  relevance: { loader: true, architectureSemantic: true, abiSemantic: false, semanticSchema: true },
  keyExtras: { projectId, entityId },
});
assert.equal(descriptor.binaryId, binaryId);
assert.equal(descriptor.entityId, entityId);
console.log('[phase12] identity binding tests passed');
