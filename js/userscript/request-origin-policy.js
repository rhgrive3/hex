export const CHATGPT_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

export function isAllowedRequestOrigin(origin, workerOrigin) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  return origin === workerOrigin || CHATGPT_ORIGINS.has(origin);
}
