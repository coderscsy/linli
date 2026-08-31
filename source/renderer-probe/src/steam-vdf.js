const VDF_TOKEN = /"((?:\\.|[^"\\])*)"|([{}])/gu;

export function tokenizeVdf(text) {
  if (typeof text !== "string") throw new TypeError("Steam manifest 必须是文本");

  const tokens = [];
  let offset = 0;
  for (const match of text.matchAll(VDF_TOKEN)) {
    if (!/^\s*$/u.test(text.slice(offset, match.index))) {
      throw new Error("Steam manifest 含有不支持的语法");
    }
    tokens.push(match[2] ?? unescapeVdfString(match[1]));
    offset = match.index + match[0].length;
  }
  if (!/^\s*$/u.test(text.slice(offset))) throw new Error("Steam manifest 含有不支持的语法");
  return tokens;
}

function unescapeVdfString(value) {
  return value.replace(/\\(["\\])/gu, "$1");
}

export function parseVdf(text) {
  const tokens = tokenizeVdf(text);
  let position = 0;

  function parseObject(expectClose) {
    const object = Object.create(null);
    while (position < tokens.length) {
      if (tokens[position] === "}") {
        if (!expectClose) throw new Error("Steam manifest 出现多余的结束括号");
        position += 1;
        return object;
      }
      const key = tokens[position++];
      if (key === "{") throw new Error("Steam manifest 键无效");
      const value = tokens[position++];
      if (value === undefined || value === "}") throw new Error(`Steam manifest 键 ${key} 缺少值`);
      if (Object.hasOwn(object, key)) throw new Error(`Steam manifest 存在重复键: ${key}`);
      if (value === "{") object[key] = parseObject(true);
      else object[key] = value;
    }
    if (expectClose) throw new Error("Steam manifest 缺少结束括号");
    return object;
  }

  const root = parseObject(false);
  if (position !== tokens.length) throw new Error("Steam manifest 未完全解析");
  return root;
}

function requiredScalar(object, key) {
  if (!Object.hasOwn(object, key) || typeof object[key] !== "string") {
    throw new Error(`Steam manifest 缺少标量字段 ${key}`);
  }
  return object[key];
}

export function parseAppManifest(text) {
  const root = parseVdf(text);
  const app = root.AppState;
  if (!app || typeof app !== "object") throw new Error("Steam manifest 缺少 AppState");

  let depots = [];
  if (Object.hasOwn(app, "InstalledDepots")) {
    if (!app.InstalledDepots || typeof app.InstalledDepots !== "object") {
      throw new Error("Steam manifest 的 InstalledDepots 无效");
    }
    depots = Object.entries(app.InstalledDepots)
      .map(([depotId, value]) => {
        if (!value || typeof value !== "object") throw new Error(`Steam manifest depot ${depotId} 无效`);
        const manifestId = requiredScalar(value, "manifest");
        const sizeText = requiredScalar(value, "size");
        const size = Number(sizeText);
        if (!Number.isFinite(size)) throw new Error(`Steam manifest depot ${depotId} 的 size 无效`);
        return { depotId, manifestId, size };
      })
      .sort((left, right) => left.depotId.localeCompare(right.depotId));
  }

  return {
    appId: requiredScalar(app, "appid"),
    name: requiredScalar(app, "name"),
    installDir: requiredScalar(app, "installdir"),
    buildId: requiredScalar(app, "buildid"),
    depots,
  };
}
