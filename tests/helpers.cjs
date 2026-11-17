const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadTS(file, mocks = {}, extra = '', globals = {}) {
  const filename = path.resolve(__dirname, '..', file);
  const source = fs.readFileSync(filename, 'utf8') + extra;
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports, module,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      throw new Error(`Unexpected module in isolated test: ${id}`);
    },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    URL, URLSearchParams, Buffer, process, ...globals
  }, { filename });
  return module.exports;
}

module.exports = { loadTS };
