export function onServiceWorkerMessage(callback: () => void): () => void {
  const listener = (event: MessageEvent) => {
    if (event.data?.type === 'flush-outbox') callback();
  };
  navigator.serviceWorker?.addEventListener('message', listener);
  return () => navigator.serviceWorker?.removeEventListener('message', listener);
}
