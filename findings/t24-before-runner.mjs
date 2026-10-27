import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
await build({entryPoints:['v2/driver-hsr/src/runner-host-main.ts'],outfile:'dist/v2/t24-before-runner.js',bundle:true,platform:'node',format:'esm',plugins:[{name:'t24-before-source',setup(b){b.onLoad({filter:/(?:runner-host|gated-runner-host)\.ts$/},a=>({contents:execFileSync('git',['show','9d7a295668ffcb38d136dfa721686377ca114fc2:'+a.path.slice(process.cwd().length+1)],{encoding:'utf8'}),loader:'ts'}));}}]});
