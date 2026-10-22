const child = require('node:child_process');
const original = child.execFileSync;
child.execFileSync = function(file, args, options) {
  return original.call(this, file, args, file === 'ps' ? { ...options, maxBuffer: 32 * 1024 * 1024 } : options);
};
require('node:module').syncBuiltinESMExports();
