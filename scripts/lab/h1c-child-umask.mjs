import {writeFileSync,mkdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.H1C_MASK_PROBE;
if(root){
 writeFileSync(join(root,'child-default-file'),'owned mask fixture');
 mkdirSync(join(root,'child-default-directory'));
 writeFileSync(join(root,'child-mask.json'),JSON.stringify({mask:process.umask(),file:statSync(join(root,'child-default-file')).mode&0o777,directory:statSync(join(root,'child-default-directory')).mode&0o777}));
}
await import('./h1c-fake-codex.mjs');
