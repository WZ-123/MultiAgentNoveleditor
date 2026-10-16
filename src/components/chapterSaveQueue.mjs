// Serialize renderer text writes for one project/file. Each queued ordinary save
// uses the last successful write as its base, not its debounce-time snapshot.
export function createChapterSaveQueue() {
  const queues = new Map();
  return function enqueue(key, operation) {
    let queue = queues.get(key);
    if (!queue) {
      queue = { tail: Promise.resolve(), hasSaved: false, content: undefined };
      queues.set(key, queue);
    }
    const task = queue.tail.then(async () => {
      const result = await operation(queue.hasSaved ? queue.content : undefined);
      queue.content = result.content;
      queue.hasSaved = true;
      return result.snapshot;
    });
    // A failed write must neither poison the queue nor advance its baseline.
    const tail = task.catch(() => {});
    queue.tail = tail;
    tail.then(() => {
      if (queue.tail === tail) queues.delete(key);
    });
    return task;
  };
}
