const SECRET_KEY = /^(authorization|cookie|set-cookie|x-token|model_gateway_token)$/iu;
const JWT = /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/u;
const MOBILE = /\b1\d{10}\b/u;

export function redactSecrets(value, key = "") {
  return redact(value, key, new WeakSet());
}

function redact(value, key, active) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string" && (JWT.test(value) || MOBILE.test(value))) return "[REDACTED]";
  if (!value || typeof value !== "object") return value;
  if (active.has(value)) return "[CIRCULAR]";
  active.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const entries = Object.keys(descriptors).filter(name => descriptors[name].enumerable).map(name => {
      const descriptor = descriptors[name];
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) return [name, "[UNREADABLE]"];
      return [name, redact(descriptor.value, name, active)];
    });
    return Array.isArray(value) ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  } catch {
    return "[UNREADABLE]";
  } finally {
    active.delete(value);
  }
}
