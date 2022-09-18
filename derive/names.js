// dump out a list of characters with consistant formatting
// eg. `node names.js 23 2A 30..39`
// eg. `node names.js -- aɑ

import {UnicodeSpec} from './unicode-logic.js';
import {parse_cp_range, explode_cp} from './utils.js';

const spec = new UnicodeSpec(new URL('./data/15.0.0/', import.meta.url));

let args = process.argv.slice(2);
let cps;
let format;
switch (args[0]) {
	case 'md': // markdown (eg. draft.md)
	case 'js': // javascript (eg. rules/*.js)
		format = args.shift();
}
if (args[0] == '--') { // everything after is literal
	cps = explode_cp(args.slice(1).join(' '));
} else {
	cps = [...new Set(args.flatMap(parse_cp_range))].sort((a, b) => a - b);
}
for (let cp of cps) {
	switch (format) {
		case 'md': console.log(`* \`${spec.format(cp)}\``); continue;
		case 'js': {
			let s = spec.format(cp);
			let i = s.indexOf('(');
			console.log(`0x${s.slice(0, i-1)}, // ${s.slice(i)}`); 
			continue;
		}
		default: console.log(spec.format(cp));
	}
}