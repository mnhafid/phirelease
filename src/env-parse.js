// ponytail: hand-rolled .env parser instead of the dotenv dependency — a few
// lines covers KEY=VALUE with optional quotes and # comments, which is all we need.
// Pure function (text in, object out) so it's testable without touching the filesystem or process.env.
export function parseEnvContent(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    // Only strip a trailing "# comment" on an unquoted value — a quoted
    // value keeps '#' verbatim (e.g. a password containing one).
    value = quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
    result[key] = value;
  }
  return result;
}
