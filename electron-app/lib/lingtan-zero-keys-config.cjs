'use strict';

const fs = require('fs');
const path = require('path');

const LINGTAN_NO_KEYS_YAML_BANNER =
  '# Lingtan: this build has no bundled API keys. Open Settings in the app to add your key, then pick a model.\n';

/**
 * Demote only the **root** `model:` block's direct `provider:` line to `auto`
 * (leave nested blocks like `fallback_model:` untouched) and prepend a banner.
 * Idempotent when provider is already `auto` / `custom`.
 */
function neutralizeModelProviderWhenNoSecrets(yamlText) {
  if (typeof yamlText !== 'string' || !yamlText.trim()) {
    return yamlText;
  }
  const lines = yamlText.split(/\r?\n/);
  const out = [];
  let inRootModel = false;
  let modelChildIndent = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!inRootModel) {
      if (/^model:\s*($|#)/.test(trimmed) && indent === 0) {
        inRootModel = true;
        modelChildIndent = null;
        out.push(line);
        continue;
      }
      out.push(line);
      continue;
    }

    if (indent === 0 && trimmed && !trimmed.startsWith('#') && !/^model:\s*/.test(trimmed)) {
      inRootModel = false;
      modelChildIndent = null;
      out.push(line);
      continue;
    }

    if (modelChildIndent === null && trimmed && !trimmed.startsWith('#')) {
      modelChildIndent = indent;
    }

    if (
      modelChildIndent !== null &&
      indent === modelChildIndent &&
      /^provider:\s*/.test(trimmed)
    ) {
      const m = trimmed.match(/^provider:\s*(.+?)\s*(#.*)?$/);
      if (m) {
        const raw = m[1].trim().replace(/^["']|["']$/g, '');
        const vlow = raw.toLowerCase();
        if (
          vlow &&
          vlow !== 'auto' &&
          vlow !== 'custom' &&
          !vlow.startsWith('custom:')
        ) {
          const prefix = line.slice(0, indent);
          line = `${prefix}provider: auto  # Lingtan: was ${raw}; add API key in Settings`;
          out.push(line);
          continue;
        }
      }
    }

    out.push(line);
  }

  const body = out.join('\n');
  if (body.startsWith('# Lingtan: this build has no bundled API keys.')) {
    return body;
  }
  return LINGTAN_NO_KEYS_YAML_BANNER + body;
}

/**
 * One-time fix for profiles seeded before build-seed learned to neutralize:
 * 0 bundled keys + no `hermes-home/.env` + no `AZURE_FOUNDRY_API_KEY` in the
 * parent environment → rewrite pinned `model.provider` to `auto`.
 */
function maybePatchHermesHomeForZeroBundledKeys(hermesHome, secretCount) {
  if (secretCount !== 0 || !hermesHome) return false;
  const dotEnv = path.join(hermesHome, '.env');
  if (fs.existsSync(dotEnv) && fs.readFileSync(dotEnv, 'utf8').trim().length > 0) {
    return false;
  }
  if (String(process.env.AZURE_FOUNDRY_API_KEY || '').trim()) {
    return false;
  }
  const cfgPath = path.join(hermesHome, 'config.yaml');
  if (!fs.existsSync(cfgPath)) return false;
  const text = fs.readFileSync(cfgPath, 'utf8');
  const next = neutralizeModelProviderWhenNoSecrets(text);
  if (next === text) return false;
  try {
    fs.writeFileSync(cfgPath, next, 'utf8');
    console.warn(
      '[lingtan] Patched hermes-home/config.yaml (0 bundled keys): pinned model.provider → auto — add your API key in Settings',
    );
    return true;
  } catch (e) {
    console.warn('[lingtan] could not patch config.yaml:', e.message);
    return false;
  }
}

module.exports = {
  LINGTAN_NO_KEYS_YAML_BANNER,
  neutralizeModelProviderWhenNoSecrets,
  maybePatchHermesHomeForZeroBundledKeys,
};
