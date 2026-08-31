const SECRET_KEY = /^(authorization|cookie|set-cookie|x-token|model_gateway_token)$/iu;
const JWT = /\b[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}\b/u;
const MOBILE = /\b1\d{10}\b/u;

export function redactSecrets(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string" && (JWT.test(value) || MOBILE.test(value))) return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactSecrets(item, name)]));
  }
  return value;
}
