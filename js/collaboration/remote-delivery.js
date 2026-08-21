import { ChangeLog } from './index.js';

function assertGate(gate) {
  if (!gate || typeof gate.validate !== 'function' || typeof gate.accept !== 'function') throw new TypeError('RemoteCollaborationGate required');
}

function cloneWorking(log) {
  const working = new ChangeLog({
    projectIdentity: log.projectIdentity,
    binaryIdentity: log.binaryIdentity,
    state: log.snapshot(),
    operations: [...log.operations.values()],
    allowRemote: log.allowRemote === true,
    authorizedAuthors: [...log.authorizedAuthors],
  });
  working.pending = new Map(log.pending);
  return working;
}

function drainReadyPending(log, results) {
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [operationId, operation] of [...log.pending.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!operation.causalParents.every((parent) => log.operations.has(parent))) continue;
      log.pending.delete(operationId);
      const result = log.applyOperation(operation);
      results.push(result);
      if (result.status === 'rejected') return result;
      // An operation may have all causal parents and still be intentionally
      // unresolved (for example a tombstone blocks resurrection). applyOperation
      // requeues that operation. Treating the delete/requeue cycle as progress
      // spins forever and grows unresolved diagnostics on every pass.
      if (result.status !== 'unresolved') progressed = true;
    }
  }
  return null;
}

export function applyRemoteEnvelopeQueued(log, gate, envelope) {
  if (!(log instanceof ChangeLog)) throw new TypeError('ChangeLog required');
  assertGate(gate);
  if (log.allowRemote !== true) return Object.freeze({ status: 'rejected', reason: 'changelog-remote-mode-disabled' });

  const checked = gate.validate(envelope);
  if (!checked.ok) return Object.freeze({ status: 'rejected', reason: checked.reason });

  const working = cloneWorking(log);
  const results = [];
  for (const operation of envelope.operations) {
    const result = working.applyOperation(operation);
    results.push(result);
    if (result.status === 'rejected') return Object.freeze({ status: 'rejected', reason: result.reason, operationId: operation.operationId });
  }
  const drainFailure = drainReadyPending(working, results);
  if (drainFailure?.status === 'rejected') return Object.freeze({ status: 'rejected', reason: drainFailure.reason });

  // Consume replay/sequence authority only after the batch can be represented
  // by the working ChangeLog. This prevents rejected state mutations from
  // burning an envelope identity.
  const accepted = gate.accept(envelope);
  if (accepted.status !== 'accepted') return accepted;
  log.state = working.state;
  log.operations = working.operations;
  log.pending = working.pending;

  const unresolvedOperationIds = [...log.pending.keys()].sort();
  return Object.freeze({
    status: unresolvedOperationIds.length ? 'accepted-with-pending-dependencies' : 'applied',
    envelopeId: envelope.envelopeId,
    results,
    unresolvedOperationIds,
    stateDigest: log.digest(),
  });
}
