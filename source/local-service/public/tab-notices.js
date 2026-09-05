export function createTabNotices({ storage, render }) {
  const storageKey = 'olivia.tab-notices.v1';
  let seen;
  try { seen = JSON.parse(storage?.getItem(storageKey) || '{}'); } catch { seen = {}; }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};
  const events = new Map();
  let active = 'settings';
  function acknowledge(key, event) {
    if (event.kind !== 'info' || seen[key] === event.id) return;
    seen[key] = event.id;
    try { storage?.setItem(storageKey, JSON.stringify(seen)); } catch { /* WebView storage may be unavailable. */ }
  }
  function publish(tab) {
    const visible = [...events.entries()].filter(([key, event]) => event.tab === tab
      && (event.kind === 'fault' || seen[key] !== event.id)).map(([, event]) => event);
    render(tab, { kind: visible.some(event => event.kind === 'fault') ? 'fault' : visible.length ? 'info' : null,
      messages: [...new Set(visible.map(event => event.message))] });
  }
  return {
    set(tab, source, event) {
      const key = `${tab}:${source}`;
      if (!event) events.delete(key);
      else {
        events.set(key, { ...event, tab });
        if (tab === active) acknowledge(key, event);
      }
      publish(tab);
    },
    visit(tab) {
      active = tab;
      for (const [key, event] of events) if (event.tab === tab) acknowledge(key, event);
      publish(tab);
    },
  };
}
