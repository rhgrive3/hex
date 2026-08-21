export function createSchedulerEventBuffer({ capacity = 128 } = {}) {
  const cap = Number(capacity);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 4096) {
    throw new RangeError("capacity must be an integer in [1, 4096]");
  }
  const items = [];
  let droppedCount = 0;
  return Object.freeze({
    onEvent(event) {
      if (items.length >= cap) {
        items.shift();
        droppedCount++;
      }
      const details = event.details
        ? (Object.isFrozen(event.details) ? event.details : Object.freeze({ ...event.details }))
        : Object.freeze({});
      const item = Object.freeze({ ...event, details });
      items.push(item);
    },
    snapshot() {
      return Object.freeze([...items]);
    },
    clear() {
      items.length = 0;
    },
    get size() {
      return items.length;
    },
    get dropped() {
      return droppedCount;
    },
  });
}
