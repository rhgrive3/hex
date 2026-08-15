import { DurableObject } from 'cloudflare:workers';
import worker from './worker.js';
import { AI_QUOTA, acquireQuotaState, releaseQuotaState } from './js/ai/quota.js';

const STATE_KEY = 'quota';

export class AIQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async acquire(input = {}) {
    const now = Date.now();
    const token = crypto.randomUUID();
    const previous = await this.ctx.storage.get(STATE_KEY);
    const { state, result } = acquireQuotaState(previous, {
      now,
      token,
      sessionId: input.sessionId,
    }, AI_QUOTA);
    await this.ctx.storage.put(STATE_KEY, state);
    return result;
  }

  async release(token) {
    const previous = await this.ctx.storage.get(STATE_KEY);
    const { state, released } = releaseQuotaState(previous, token, Date.now(), AI_QUOTA);
    await this.ctx.storage.put(STATE_KEY, state);
    return { released };
  }
}

export default worker;
