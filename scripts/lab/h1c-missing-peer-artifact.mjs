import Module from 'node:module';
const load=Module._load;
Module._load=function(name,...args){if(typeof name==='string'&&name.endsWith('peercred.node'))throw Error('owned lab missing peer artifact');return load.call(this,name,...args);};
