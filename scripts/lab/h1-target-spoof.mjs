import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){const loaded=next(url,context);if(url.endsWith('/src/release/buildIdentity.ts')){const source=String(loaded.source);return {...loaded,source:source.replace('target: `${process.platform}-${process.arch}`','target: "h1-wrong-target"')};}return loaded;}});
