// Attribution only: count completed-query work without changing classification.
import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){
 const result=nextLoad(url,context);
 if(!url.endsWith('/v2/daemon/tests/questionEgressCensus.ts'))return result;
 let source=String(result.source);
 const marker='  function contains(type: ts.Type, seen = new Set<ts.Type>()): boolean {';
 const classifier=source.includes('function containsRoot(')?'containsRoot':'contains';
 if(!source.includes(marker)||!source.includes(`${classifier}(checker.getTypeAtLocation(argument))`))throw Error('census count source drift');
 source=source.replace(marker,`  let __walks=0, __topWalks=0, __queries=0; const __roots=new Set();\n  function __probeRoot(type) { __queries++; __roots.add(type); return ${classifier}(type); }\n${marker}\n    __walks++; if (seen.size === 0) __topWalks++;`);
 source=source.replace(`${classifier}(checker.getTypeAtLocation(argument))`,'__probeRoot(checker.getTypeAtLocation(argument))');
 const end='  return {productionFiles: files.length, consumers, sends, mirrorReferences};';
 if(!source.includes(end))throw Error('census return source drift');
 source=source.replace(end,'  globalThis.__HB_CENSUS_COUNTS__ = {recursiveWalks:__walks, rootWalks:__topWalks, rootQueries:__queries, distinctRootTypes:__roots.size, excessRootWalks:__topWalks-__roots.size};\n'+end);
 return {...result,source};
}});
