/** Black-box verify of index.js apply() against a fake ctx.
 *  Fake register() enforces the COMPILED-shape rules the real registry
 *  enforces: output { schema, render } present, no author-DSL `required: true`
 *  markers left anywhere (`required` only as top-level arrays). In plain node
 *  the plugin takes its local-compile path (no host defineTool) — exactly the
 *  path under test here; in-host it uses the real defineTool. */
import { apply } from '../index.js';

const registered = { search: [], fetch: [], tools: [] };
const ctx = {
  logger: {
    warn: (...a) => console.log('[warn]', ...a),
    info: (...a) => console.log('[info]', ...a),
  },
  web: {
    registerSearchProvider: (p) => {
      if (!p?.id || typeof p.search !== 'function' || typeof p.available !== 'function') {
        throw new TypeError('bad search provider shape');
      }
      registered.search.push(p.id);
    },
    registerFetchProvider: (p) => {
      if (!p?.id || typeof p.fetch !== 'function' || typeof p.available !== 'function') {
        throw new TypeError('bad fetch provider shape');
      }
      registered.fetch.push(p.id);
    },
  },
  tools: {
    _defs: new Map(),
    get(name) { return this._defs.get(name); },
    register(def) {
      const output = def?.output;
      if (output === undefined || typeof output !== 'object' || typeof output.render !== 'function') {
        throw new TypeError(`tool "${def?.name}" must declare output { schema, render, presentationMeta? }`);
      }
      assertCompiled(def.parameters, 'parameters');
      assertCompiled(output.schema, 'output.schema');
      if (typeof def.execute !== 'function') throw new TypeError('execute must be a function');
      if (this._defs.has(def.name)) throw new Error(`tool "${def.name}" is already registered`);
      this._defs.set(def.name, def);
      registered.tools.push(def.name);
    },
  },
};

/** Compiled shapes: `required` appears only as top-level string arrays;
 *  `required: true` markers must be gone. */
function assertCompiled(node, path) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new TypeError(`${path} must be a schema object`);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'required') {
      if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
        throw new TypeError(`${path}.required must be an array of strings (uncompiled DSL marker?)`);
      }
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      for (const [pk, pv] of Object.entries(v)) assertCompiled(pv, `${path}.properties.${pk}`);
      continue;
    }
    if (k === 'items' && v && typeof v === 'object') {
      assertCompiled(v, `${path}.items`);
    }
  }
}

await apply(ctx, {});
console.log('registered:', JSON.stringify(registered));
if (!registered.tools.includes('scout_search') || !registered.tools.includes('scout_read')) {
  console.error('PLUGIN FAIL: tools missing');
  process.exit(1);
}
const searchDef = ctx.tools._defs.get('scout_search');
console.log('search parameters (compiled):', JSON.stringify(searchDef.parameters));
console.log('search output schema (compiled):', JSON.stringify(searchDef.output.schema));
const out = await searchDef.execute({ query: 'pomodoro technique', maxResults: 3 }, {});
console.log('--- scout_search output head ---');
console.log(String(out.text).slice(0, 400));
const readDef = ctx.tools._defs.get('scout_read');
const rout = await readDef.execute({ url: 'https://en.wikipedia.org/wiki/Pomodoro_Technique', maxChars: 600 }, {});
console.log('--- scout_read output head ---');
console.log(String(rout.text).slice(0, 250));
console.log('\nPLUGIN CHECK OK');
