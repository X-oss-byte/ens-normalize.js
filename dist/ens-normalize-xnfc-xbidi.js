function decode_arithmetic(bytes) {
	let pos = 0;
	function u16() { return (bytes[pos++] << 8) | bytes[pos++]; }
	
	// decode the frequency table
	let symbol_count = u16();
	let total = 1;
	let acc = [0, 1]; // first symbol has frequency 1
	for (let i = 1; i < symbol_count; i++) {
		acc.push(total += u16());
	}

	// skip the sized-payload that the last 3 symbols index into
	let skip = u16();
	let pos_payload = pos;
	pos += skip;

	let read_width = 0;
	let read_buffer = 0; 
	function read_bit() {
		if (read_width == 0) {
			// this will read beyond end of buffer
			// but (undefined|0) => zero pad
			read_buffer = (read_buffer << 8) | bytes[pos++];
			read_width = 8;
		}
		return (read_buffer >> --read_width) & 1;
	}

	const N = 31;
	const FULL = 2**N;
	const HALF = FULL >>> 1;
	const QRTR = HALF >> 1;
	const MASK = FULL - 1;

	// fill register
	let register = 0;
	for (let i = 0; i < N; i++) register = (register << 1) | read_bit();

	let symbols = [];
	let low = 0;
	let range = FULL; // treat like a float
	while (true) {
		let value = Math.floor((((register - low + 1) * total) - 1) / range);
		let start = 0;
		let end = symbol_count;
		while (end - start > 1) { // binary search
			let mid = (start + end) >>> 1;
			if (value < acc[mid]) {
				end = mid;
			} else {
				start = mid;
			}
		}
		if (start == 0) break; // first symbol is end mark
		symbols.push(start);
		let a = low + Math.floor(range * acc[start]   / total);
		let b = low + Math.floor(range * acc[start+1] / total) - 1;
		while (((a ^ b) & HALF) == 0) {
			register = (register << 1) & MASK | read_bit();
			a = (a << 1) & MASK;
			b = (b << 1) & MASK | 1;
		}
		while (a & ~b & QRTR) {
			register = (register & HALF) | ((register << 1) & (MASK >>> 1)) | read_bit();
			a = (a << 1) ^ HALF;
			b = ((b ^ HALF) << 1) | HALF | 1;
		}
		low = a;
		range = 1 + b - a;
	}
	let offset = symbol_count - 4;
	return symbols.map(x => { // index into payload
		switch (x - offset) {
			case 3: return offset + 0x10100 + ((bytes[pos_payload++] << 16) | (bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 2: return offset + 0x100 + ((bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 1: return offset + bytes[pos_payload++];
			default: return x - 1;
		}
	});
}	

/*
export function read_payload(v) {
	let pos = 0;
	let r = () => v[pos++];
	r.more = () => pos < v.length;
	return r;
}
*/

// returns an iterator which returns the next symbol
function read_payload(v) {
	let pos = 0;
	return () => v[pos++];
}
function read_compressed_payload(s) {
	return read_payload(decode_arithmetic(Uint8Array.from(atob(s), c => c.charCodeAt(0))));
}

// eg. [0,1,2,3...] => [0,-1,1,-2,...]
function signed(i) { 
	return (i & 1) ? (~i >> 1) : (i >> 1);
}

function read_counts(n, next) {
	let v = Array(n);
	for (let i = 0; i < n; i++) v[i] = 1 + next();
	return v;
}

function read_ascending(n, next) {
	let v = Array(n);
	for (let i = 0, x = -1; i < n; i++) v[i] = x += 1 + next();
	return v;
}

function read_deltas(n, next) {
	let v = Array(n);
	for (let i = 0, x = 0; i < n; i++) v[i] = x += signed(next());
	return v;
}

function read_member_set(next) {
	let set = new Set(read_ascending(next(), next));
	let n = next();
	let vX = read_ascending(n, next);
	let vN = read_counts(n, next);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < vN[i]; j++) {
			set.add(vX[i] + j);
		}
	}
	return set;
}

// returns array of 
// [x, ys] => single replacement rule
// [x, ys, n, dx, dx] => linear map
function read_mapped_table(next) {
	let ret = [];
	while (true) {
		let w = next();
		if (w == 0) break;
		ret.push(read_linear_table(w, next));
	}
	while (true) {
		let w = next() - 1;
		if (w < 0) break;
		ret.push(read_replacement_table(w, next));
	}
	return ret.flat().sort((a, b) => a[0] - b[0]);
}

function read_zero_terminated_array(next) {
	let v = [];
	while (true) {
		let i = next();
		if (i == 0) break;
		v.push(i);
	}
	return v;
}

function read_transposed(n, w, next, lookup) {
	let m = Array(n).fill().map(() => []);
	for (let i = 0; i < w; i++) {
		read_deltas(n, next).forEach((x, j) => m[j].push(lookup ? lookup[x] : x));
	}
	return m;
}
 
function read_linear_table(w, next) {
	let dx = 1 + next();
	let dy = next();
	let vN = read_zero_terminated_array(next);
	let m = read_transposed(vN.length, 1+w, next);
	return m.map((v, i) => [v[0], v.slice(1), vN[i], dx, dy]);
}

function read_replacement_table(w, next) { 
	let n = 1 + next();
	let m = read_transposed(n, 1+w, next);
	return m.map(v => [v[0], v.slice(1)]);
}

// abc => {a:{b:{c:{'':1}}}}
function read_tree(next, read_lens, lookup) {
	let root = {};
	while (true) {
		let lens = read_lens(next); // should return array of positive integers
		if (lens.length == 0) break;
		let n = 1 + next();
		let nodes = Array(n).fill(root);
		for (let w of lens) {
			nodes = read_transposed(n, w, next, lookup).map((v, i) => {
				let parent = nodes[i];
				let key = String.fromCodePoint(...v);
				let child = parent[key];
				if (!child) child = parent[key] = {};
				return child;
			});
		}
		// mark nodes as terminating
		nodes.forEach(x => x[''] = 1);
	}
	return root;
}

function lookup_mapped(table, cp) {
	for (let [x, ys, n, dx, dy] of table) {
		let d = cp - x;
		if (d < 0) break;
		if (n > 0) {
			if (d < dx * n && d % dx == 0) {
				let r = d / dx;
				return ys.map(y => y + r * dy);
			} 
		} else if (d == 0) {
			return ys;
		}
	}
}

function hex_cp(cp) {
	return cp.toString(16).toUpperCase().padStart(2, '0');
}

// my suggested inline ascii-safe unicode escape
// this is ES6 \u{X} without the \u
function quote_cp(cp) {
	return `{${hex_cp(cp)}}`;
}

function escape_unicode(s) {
	// printable w/o:
	// 0x22 (double-quote)
	// 0x7B/0x7D (curly-brace, used for escaping)
	// 0x7F (delete)
	return s.replace(/[^\x20-\x21\x23-\x7A\x7C\x7E]/gu, x => quote_cp(x.codePointAt(0)));
}

function explode_cp(s) {
	if (typeof s != 'string') throw new TypeError(`expected string`);	
	return [...s].map(c => c.codePointAt(0));
}

// https://datatracker.ietf.org/doc/html/rfc3492
// adapted from https://github.com/mathiasbynens/punycode.js
// puny format: "xn--{ascii}-{0-9a-z}"
// this function receives normalized cps such that:
// * no uppercase 
// * no overflow (#section-6.4)

function puny_decode(cps) {
	let ret = [];
	let pos = cps.lastIndexOf(0x2D); // hyphen
	for (let i = 0; i < pos; i++) {
		let cp = cps[i];
		if (cp >= 0x80) throw new Error('expected ASCII');
		ret.push(cp);
	}
	pos++; // skip hyphen
	// #section-5
	const BASE = 36; 
	const T_MIN = 1;
	const T_MAX = 26;
	const SKEW = 38;
	const DAMP = 700;
	const MAX_DELTA = (BASE - T_MIN) * T_MAX >> 1;
	let i = 0, n = 128, bias = 72;
	while (pos < cps.length) {
		let prev = i;
		for (let w = 1, k = BASE; ; k += BASE) {
			if (pos >= cps.length) throw new Error(`invalid encoding`);
			let cp = cps[pos++];
			if (cp >= 0x30 && cp <= 0x39) { // 0-9
				cp -= 0x16; // 26 + (code - 0x30)
			} else if (cp >= 0x61 && cp <= 0x7A) { // a-z
				cp -= 0x61;
			} else {
				throw new Error(`invalid character ${cp}`);
			}
			i += cp * w;
			const t = k <= bias ? T_MIN : (k >= bias + T_MAX ? T_MAX : k - bias);
			if (cp < t) break;
			w *= BASE - t;
		}
		let len = ret.length + 1;
		let delta = prev == 0 ? (i / DAMP)|0 : (i - prev) >> 1;
		delta += (delta / len)|0;
		let k = 0;
		for (; delta > MAX_DELTA; k += BASE) {
			delta = (delta / (BASE - T_MIN))|0;
		}
		bias = (k + (BASE - T_MIN + 1) * delta / (delta + SKEW))|0;
		n += (i / len)|0;
		i %= len;
		ret.splice(i++, 0, n);
	}	
	return ret;
}

// this returns [[]] if empty
// {e:[],u:[]} => emoji
// {v:[]} => chars
function tokenized_idna(cps, emoji_parser, tokenizer) {
	let chars = [];
	let tokens = [];
	let labels = [tokens];
	function drain() { 
		if (chars.length > 0) {
			tokens.push({v: chars}); 
			chars = [];
		}
	}
	for (let i = 0; i < cps.length; i++) {
		if (emoji_parser) {
			let [len, e] = emoji_parser(cps, i);
			if (len > 0) {
				drain();
				tokens.push({e, u:cps.slice(i, i+len)}); // these are emoji tokens
				i += len - 1;
				continue;
			}
		} 
		let cp = cps[i];
		let token = tokenizer(cp);
		if (Array.isArray(token)) { // this is more characters
			chars.push(...token);
		} else {
			drain();
			if (token) { // this is a token
				tokens.push(token);
			} else { // this is a label separator
				tokens = []; // create a new label
				labels.push(tokens);
			}
		}
	}
	drain();
	return labels;
}

// returns an emoji parser
function emoji_parser_factory(r) {	
	const REGIONAL = read_member_set(r);	
	const KEYCAP_DROP = read_member_set(r);
	const KEYCAP_REQ = read_member_set(r);
	const STYLE_DROP = read_member_set(r);
	const STYLE_REQ = read_member_set(r);
	const STYLE_OPT = read_member_set(r);
	const MODIFIER = read_member_set(r);
	const MODIFIER_BASE = read_member_set(r);
	const TAG_SPEC = read_member_set(r); 

	// read whitelist for exact sequences
	const SEQ_ROOT = read_tree(r, x => Array(x()).fill(1));

	// read whitelist for zwj sequences (optional)
	const ZWJ_ANY = 1;
	const ZWJ_ROOT = r() ? read_tree(r, read_zero_terminated_array, [...STYLE_DROP, ...STYLE_OPT].sort((a, b) => a - b)) : ZWJ_ANY;

	const FE0F = 0xFE0F;
	const ZWJ = 0x200D;
	const KEYCAP_END = 0x20E3;
	const TAG_END = 0xE007F;

	function follow_zwj(parent, cps) {
		if (parent === ZWJ_ANY) return ZWJ_ANY; 
		let key = String.fromCodePoint(...cps.filter(cp => cp != FE0F));
		if (parent.hasOwnProperty(key)) return parent[key];		
	}

	function find_emoji_chr_mod_pre(cps, pos) {
		let cp = cps[pos];
		if (!cp) return;
		let cp2 = cps[pos+1]; 
		// emoji_modifier_sequence := emoji_modifier_base emoji_modifier
		if (MODIFIER_BASE.has(cp) && cp2 && MODIFIER.has(cp2)) {
			return [2, [cp, cp2]];
		}
		// emoji_modifier_base is a emoji_character 
		// emoji_presentation_sequence := emoji_character \x{FE0F}
		// but some emoji dont need presentation
		// and previously valid emoji are already registered
		// we call these emoji optional
		if (cp2 == FE0F) {
			// these drop FE0F
			if (STYLE_DROP.has(cp)) return [2, [cp]];
			// these keep FE0F
			if (STYLE_OPT.has(cp) || STYLE_REQ.has(cp)) return [2, [cp, FE0F]]; 
		}
		// emoji_character 
		if (STYLE_DROP.has(cp) || STYLE_OPT.has(cp)) {
			return [1, [cp]];	
		}
	}

	// note: this doesn't use any bound checks
	return function(cps, pos0) {
		let cp0 = cps[pos0];
		
		// check whitelist for a match
		let seq_key = String.fromCodePoint(cp0);
		if (SEQ_ROOT.hasOwnProperty(seq_key)) { // potential match
			let node = SEQ_ROOT[seq_key];
			let pos = pos0 + 1; // check remaining chars
			while (true) {
				let cp = cps[pos];
				if (!cp) break; // end of string
				let key = String.fromCodePoint(cp);
				if (!node.hasOwnProperty(key)) break; // no more possibilities
				node = node[key];
				pos++;
			}
			if (node.hasOwnProperty('')) { // this was a terminator
				return [pos - pos0, cps.slice(pos0, pos)];
			}
		}
		let cp1 = cps[pos0+1];

		// [ED-14] emoji flag sequence
		// https://www.unicode.org/reports/tr51/#def_emoji_flag_sequence
		// A sequence of two Regional Indicator characters, where the corresponding ASCII characters are valid region sequences as specified 
		if (REGIONAL.has(cp0) && REGIONAL.has(cp1)) {
			// emoji_flag_sequence := regional_indicator regional_indicator
			return [2, [cp0, cp1]];
		} 
		// [ED-14c] emoji keycap sequence
		// https://unicode.org/reports/tr51/#def_emoji_keycap_sequence
		// A sequence of the following form: 
		// emoji_keycap_sequence := [0-9#*] \x{FE0F 20E3}
		let keycap_og = KEYCAP_DROP.has(cp0);
		if (keycap_og && cp1 === KEYCAP_END) {
			return [2, [cp0, KEYCAP_END]];
		} else if ((keycap_og || KEYCAP_REQ.has(cp0)) && cp1 === FE0F && cps[pos0+2] === KEYCAP_END) {
			return [3, keycap_og ? [cp0, KEYCAP_END] : [cp0, FE0F, KEYCAP_END]];		
		}
		// [ED-15] emoji core sequence
		// emoji_core_sequence := emoji_keycap_sequence | emoji_flag_sequence | chr_mod_pre
		// chr_mod_pre = emoji_character | emoji_presentation_sequence | emoji_modifier_sequence
		// 
		// we've handed keycap and flag already
		let emoji0 = find_emoji_chr_mod_pre(cps, pos0); // chr_mod_pre?
		if (!emoji0) return [0]; // nope
		// [ED-17] emoji sequence
		// emoji_sequence := chr_mod_pre | emoji_zwj_sequence | emoji_tag_sequence 
		let [n0, v0] = emoji0;
		let pos1 = pos0 + n0;
		cp1 = cps[pos1]; // the character following the emoji
		if (cp1 === ZWJ) { // maybe...
			// [ED-16] emoji zwj sequence 
			// emoji_zwj_sequence := emoji_zwj_element ( \x{200d} emoji_zwj_element )+		
			// [ED-15a] emoji zwj element
			// emoji_zwj_element := emoji_character | emoji_presentation_sequence | emoji_modifier_sequence		
			let node = follow_zwj(ZWJ_ROOT, v0); 
			if (node) { // whitelist or disabled
				let queue = [];
				let pos = pos1;
				let pos_last;
				while (cps[pos++] === ZWJ) { // zwj?
					let emoji = find_emoji_chr_mod_pre(cps, pos); // zwj+emoji?
					if (!emoji) break;
					let [n, v] = emoji;
					node = follow_zwj(node, v); // traverse the tree
					if (!node) break;
					pos += n; 
					if (node === ZWJ_ANY) {
						v0.push(ZWJ, ...v);
						pos_last = pos;
					} else {
						queue.push(ZWJ, ...v); // save chars that dont form a complete sequence yet
						if (node.hasOwnProperty('')) { // this is a valid sequence
							v0.push(...queue); // drain queue
							queue.length = 0;
							pos_last = pos;
						}
					}
				}
				if (pos_last) {
					// if set, v0 correponds to the longest zwj sequence
					// that matches the whitelist
					return [pos_last - pos0, v0];
				}
			}
		}
		// [ED-14a] emoji tag sequence (ETS) 
		// https://www.unicode.org/reports/tr51/#def_emoji_tag_sequence
		// A sequence of the following form:
		//  emoji_tag_sequence := tag_base tag_spec tag_end
		//   tag_base := emoji_character 
		//             | emoji_modifier_sequence     => emoji_modifier_base emoji_modifier
		//             | emoji_presentation_sequence => emoji_character \x{FE0F}
		//   tag_spec := [\x{E0020}-\x{E007E}]+
		//   tag_end  := \x{E007F}		
		if (TAG_SPEC.has(cp1)) {
			let pos = pos1 + 1;
			while (TAG_SPEC.has(cps[pos])) pos++;
			if (cps[pos++] === TAG_END) {
				return [pos - pos0, v0.concat(cps.slice(pos1, 1 + pos - pos1))];
			}
		}
		return emoji0;
	};
}

// this is a polyfill for normalized forms
// it exists because the ES6 implementation fails many tests
// see: https://adraffy.github.io/ens-normalize.js/test/report-nf.html
// but lib-nf.js is approx 13KB as of 20211221

function norm(form, cps) {
	return explode_cp(String.fromCodePoint(...cps).normalize(form));
}

function nfc(cps) { return norm('NFC', cps); }

var r$1 = read_compressed_payload('ABIAAQB6AEAAOAAoACYAHwAiABgAFgAOAAsACwAMAY8AfgADApQhCD9xcXFxcXFxcW5hcbsGoY8Bf9URLHl4F4mAXgAn6F1DBPgbACv4ZqZU5nHucWhm/wCYRQRDAJcASQwtAe8FzAOHOfQyBvsC+GifBANGRZDdAC4CJSwCIi8GFTgCJSwmLyQpNix4JTpMcXV+rQEGGggji3raLA6mlfECCAxleXQSxKUjTyElAibgTiIC0gHv1AZQBLNgQ6JNVpJS9wlNAHRfAXiOWADp7D9QqYZpggAHGwscRNcB8gB0/yE9LHw3ZzYcITAjCk8BAlASEDEWAjEMCTgFzVsHDywSYVMEXgVBSgCFDAQFAckCphERETMDM2uMA88yLkEnJgYTLi6LB7kBPw0nVwsQ4gE7YHTHG0MAJpANNxIqJ15uH1IFEQDKAm4FfB2eATAAeIwtpywlOBhEJwRXng4sHLli4Q5IYl7584oYIwciAIlLCW1CAFQULjWxMQNQS/8RUSEBKAMWiQavLFEEUAT7AK0E1WULFc3RYR4GDAkRFRAxEhEDAQEABx8IASgjAAJR4QwFEpUiGzjHDw5ylPEUpACEAX4jBRwWExgAGwkSAkFoCRgIAA5XWI6qYXEEjBQARAEhDhAt2CcBFwASAEoTJBMCNQUSphsCAEEXDnKU8Q4OA70WBRQQHmoJLG5nEwoIDmNYjqphcQSGGgBJASASEDPYKA9QDyQSCgQMShMjAxQGAzUCcRkkAIsAuokwVSwLAmIGPhgnKACLCRkAEicBAQbgO8+xBTABBxcQJgAEQDf6MASDMBD0HwwoDAsu9wDA6hMtcgxWABIITU3k0SHxGPGp8QBhA+dvYj7xAEEFTY2l8Q8x0RWBKEEG8QtKx0dLASBJGLFQ8QBfWx4AFKXRDyrPFXMcIgEPEjzcS9Wn/KALJxnXU2YJOBWKOmP82gdIgmNcRsDi+p7FBLYbwm9Uzs1RfCbNpY30PNDOtZBhbqPBybOPeWa7oi+ySNuja7E79Fz+oJqkWRGdXLqRl46pfoUDu0uKXTiGuFf3GtJzAXtJmxI3V8am/mpQnjfi99U7ZkojTh6fKYexodlCUm8Nn5tkJXqdPwxaQiU29Pa8nQxhFccS0ZzA2p+XNo3r68FBGjQNasxwtQH/0ELiOQLNuyc0YqOxCPnfFsvASXVP7enrn5p48UHDGS6NU/kYR37WSJ7+CN+nV4NqWlRTc/nQOuWoDD2Cnkn26E21fE+79xMXG2voqdtyef5eUY6MOoAAPIvdUDW+i16JSxe2+srXAYVvzbE8SKhyxzjFf2rMlgMycfXR8nl6/xF97xDwBSNLExVnK4YUGbAMpgGeHD0vHVXsIK20HyDdJQ9a5Uhwta5o+Tw/HpthmalqVX7v90SgUzjZaEahH3JPOhT8k+LFPClF+c5gMeKg');

const VIRAMA = read_member_set(r$1);
const JOIN_T = read_member_set(r$1);
const JOIN_LD = read_member_set(r$1);
const JOIN_RD = read_member_set(r$1);
const SCRIPT_GREEK = read_member_set(r$1);
const SCRIPT_HEBREW = read_member_set(r$1);
const SCRIPT_HKH = read_member_set(r$1);

// cps is a list of codepoints
// could be empty
function validate_context(cps) {
	// apply relative checks
	for (let i = 0, e = cps.length - 1; i <= e; i++) {
		switch (cps[i]) {
			case 0x200C: { 
				// ZERO WIDTH NON-JOINER (ZWNJ)
				// ContextJ: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.1	
				// If Canonical_Combining_Class(Before(cp)) .eq.  Virama Then True;
				if (i > 0 && VIRAMA.has(cps[i - 1])) continue;
				// If RegExpMatch((Joining_Type:{L,D})(Joining_Type:T)*\u200C(Joining_Type:T)*(Joining_Type:{R,D})) Then True;
				if (i > 0 && i < e) { // there is room on either side
					let head = i - 1;
					while (head > 0 && JOIN_T.has(cps[head])) head--; // T*
					if (JOIN_LD.has(cps[head])) { // L or D
						let tail = i + 1;
						while (tail < e && JOIN_T.has(cps[tail])) tail++; // T*
						if (JOIN_RD.has(cps[tail])) { // R or D
							continue;
						}
					}
				}
				break;
			}
			case 0x200D: {
				// ZERO WIDTH JOINER (ZWJ)
				// ContextJ: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.2
				// If Canonical_Combining_Class(Before(cp)) .eq.  Virama Then True;
				if (i > 0 && VIRAMA.has(cps[i-1])) continue;
				break;
			}
			case 0x00B7: {
				// MIDDLE DOT
				// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.3
				// Between 'l' (U+006C) characters only, used to permit the Catalan
				// character ela geminada to be expressed.
				if (i > 0 && i < e && cps[i-1] == 0x6C && cps[i+1] == 0x6C) continue; 
				break;
			}
			case 0x0375: {
				// GREEK LOWER NUMERAL SIGN (KERAIA)
				// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.4
				// The script of the following character MUST be Greek.
				if (i < e && SCRIPT_GREEK.has(cps[i+1])) continue; 
				break;
			}
			case 0x05F3:
				// HEBREW PUNCTUATION GERESH
				// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.5
				// The script of the preceding character MUST be Hebrew.
			case 0x05F4: {
				// HEBREW PUNCTUATION GERSHAYIM
				// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.6		
				// The script of the preceding character MUST be Hebrew.
				if (i > 0 && SCRIPT_HEBREW.has(cps[i-1])) continue;
				break;
			}
			default: continue;
		}
		// the default behavior above is to continue if the context is valid
		// we only fall-through if no context was matched
		throw new Error(`No context for "${escape_unicode(String.fromCodePoint(cps[i]))}"`);
	}
	// apply global checks
	//
	// ARABIC-INDIC DIGITS
	// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.8
	// Can not be mixed with Extended Arabic-Indic Digits.
	// For All Characters: If cp .in. 06F0..06F9 Then False; End For;
	// EXTENDED ARABIC-INDIC DIGITS
	// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.9
	// Can not be mixed with Arabic-Indic Digits.
	// For All Characters: If cp .in. 0660..0669 Then False; End For
	if (cps.some(cp => cp >= 0x0660 && cp <= 0x0669) && cps.some(cp => cp >= 0x06F0 && cp <= 0x06F9)) {
		throw new Error(`Disallowed arabic-indic digit mixture`);
	}
	// KATAKANA MIDDLE DOT
	// ContextO: https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.7
	// The effect of this rule is to require at least one character in the label to be in one of those scripts.
	// For All Characters: If Script(cp) .in. {Hiragana, Katakana, Han} Then True; End For;
	if (cps.includes(0x30FB) && !cps.some(cp => SCRIPT_HKH.has(cp))) {
		throw new Error(`Disallowed katakana`);
	}
}

var r = read_compressed_payload('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');

// built: 2022-03-21T06:17:31.321Z
const STOP = read_member_set(r);
const VALID = read_member_set(r);
const IGNORED = read_member_set(r);
const MAPPED = read_mapped_table(r);
const COMBINING_MARKS = read_member_set(r);
const EMOJI_PARSER = r() && emoji_parser_factory(r); // this is optional

// emoji tokens are as-is
// text tokens are normalized
// note: it's safe to apply to entire 
// string but you'd have to retokenize
function flatten_tokens(tokens) {
	return tokens.flatMap(({e, v}) => e ?? nfc(v));
}

function label_error(cps, message) {
	return new Error(`Disallowed label "${escape_unicode(String.fromCodePoint(...cps))}": ${message}`);
}

// Primary API
// throws TypeError if not a string
// throws Error if not normalizable
// returns a string ready for namehash
function ens_normalize(name) { 
	// 
	// Original Specification: 
	// https://github.com/ethereum/EIPs/blob/master/EIPS/eip-137.md
	// "UTS46 with the options transitional=false and useSTD3AsciiRules=true."
	// * IDNA 2003 or 2008 = not-specified
	// * CheckHyphens = true
	// * CheckJoiners = true
	// * CheckBidi = not-specified
	// * ContextJ = not-specified
	// * ContextO = not-specified
	//
	// This Library:
	// * IDNA 2008 w/ an UTS-51 emoji parser
	// * Alternative stops are disallowed
	// * ContextJ = ContextO = true
	// * CheckBidi = yes (if xbidi = no)
	// see: build-tables.js
	//
	// https://www.unicode.org/reports/tr51/
	// https://unicode.org/reports/tr46/#Processing
	// https://unicode.org/reports/tr46/#Validity_Criteria
	// [Processing] 1.) Map
	// [Processing] 2.) Normalize: Normalize the domain_name string to Unicode Normalization Form C.
	// [Processing] 3.) Break: Break the string into labels at U+002E ( . ) FULL STOP.
	const HYPHEN = 0x2D; // HYPHEN MINUS
	let labels = tokenized_idna(explode_cp(name), EMOJI_PARSER, cp => {
		// ignored: Remove the code point from the string. This is equivalent to mapping the code point to an empty string.
		if (STOP.has(cp)) return;
		if (IGNORED.has(cp)) return [];
		// deviation: Leave the code point unchanged in the string.
		// valid: Leave the code point unchanged in the string.		
		if (VALID.has(cp)) return [cp];
		// mapped: Replace the code point in the string by the value for the mapping in Section 5, IDNA Mapping Table.
		let mapped = lookup_mapped(MAPPED, cp);
		if (mapped) return mapped;
		// disallowed: Leave the code point unchanged in the string, and record that there was an error.
		throw new Error(`Disallowed character "${escape_unicode(String.fromCodePoint(cp))}"`);
	}).map(tokens => {
		let cps = flatten_tokens(tokens);
		// [Processing] 4.) Convert/Validate
		if (cps.length >= 4 && cps[0] == 0x78 && cps[1] == 0x6E && cps[2] == HYPHEN && cps[3] == HYPHEN) { // "xn--"
			try {
				// Attempt to convert the rest of the label to Unicode according to Punycode [RFC3492].
				// If that conversion fails, record that there was an error, and continue with the next label.
				let cps_decoded = puny_decode(cps.slice(4));
				// With either Transitional or Nontransitional Processing, sources already in Punycode are validated without mapping. 
				// In particular, Punycode containing Deviation characters, such as href="xn--fu-hia.de" (for fuß.de) is not remapped. 
				// This provides a mechanism allowing explicit use of Deviation characters even during a transition period. 
				[tokens] = tokenized_idna(cps_decoded, EMOJI_PARSER, cp => VALID.has(cp) ? [cp] : []);
				let expected = flatten_tokens(tokens);
				if (cps_decoded.length != expected.length || !cps_decoded.every((x, i) => x == expected[i])) throw new Error('not normalized');
				// Otherwise replace the original label in the string by the results of the conversion. 
				cps = cps_decoded;
				// warning: this could be empty
				// warning: this could be "**--"
			} catch (err) {
				throw label_error(cps, `punycode: ${err.message}`);
			}
		}
		// flatten textual part of label into a single list of code-points
		let text = tokens.reduce((a, {v}) => {
			if (v) {
				a.push(...v);
			} else if (a.length > 0) { // emoji at the start of the label are deleted
				a.push(0xFE0F); // remaining emoji are replaced by FE0F (which is NSM) 
			}
			return a;
		}, []);
		if (cps.length > 0) {
			// [Validity] 1.) The label must be in Unicode Normalization Form NFC.
			// => satsified by nfc() via flatten_tokens()
			// [Validity] 2.) If CheckHyphens, the label must not contain a U+002D HYPHEN-MINUS character in both the third and fourth positions.
			// note: we check this here (rather than above) because puny can expand into "aa--bb"
			if (cps.length >= 4 && cps[2] == HYPHEN && cps[3] == HYPHEN) throw label_error(cps, `invalid label extension`);
			// [Validity] 3.) If CheckHyphens, the label must neither begin nor end with a U+002D HYPHEN-MINUS character.
			if (cps[0] == HYPHEN) throw label_error(cps, `leading hyphen`);
			if (cps[cps.length - 1] == HYPHEN) throw label_error(cps, `trailing hyphen`);		
			// [Validity] 4.) The label must not contain a U+002E ( . ) FULL STOP.
			// => satisfied by [Processing] 3.) Break
			// [Validity] 5.) The label must not begin with a combining mark, that is: General_Category=Mark.
			if (COMBINING_MARKS.has(cps[0])) throw label_error(cps, `leading combining mark`);
			// [Validity] 6.) For Nontransitional Processing, each value must be either valid or deviation.
			// => satisfied by tokenized_idna()
			// [Validity] 7.) If CheckJoiners, the label must satisify the ContextJ rules
			/*CONTEXT*/
			try {
				validate_context(text); // this also does ContextO
			} catch (err) {
				throw label_error(cps, err.message);
			}
			/*~CONTEXT*/
			// [Validity] 8.) see below
		}
		return {tokens, cps, text};
	});
	// [Validity] 8.) If CheckBidi, and if the domain name is a Bidi domain name, then the label 
	// must satisfy all six of the numbered conditions in [IDNA2008] RFC 5893, Section 2.
	
	return labels.map(x => String.fromCodePoint(...x.cps)).join('.');
}

// Secondary API
// throws TypeError if not a string
// turns a name into tokens: eg. "R💩affy.eth"
// this is much nicer than exposing the predicates
// [{m:[0x72], u:[0x52]},{e:[0x1F4A9],u:[0x1F4A9]},{t:[61,66,66]},{},{t:[65,74,68]}]
function ens_tokenize(name) {
	return tokenized_idna(explode_cp(name), EMOJI_PARSER, cp => {
		if (STOP.has(cp)) return {};
		if (VALID.has(cp)) return [cp]; // this gets merged into v
		if (IGNORED.has(cp)) return {i: cp};
		let mapped = lookup_mapped(MAPPED, cp);
		if (mapped) return {m: mapped, u: [cp]}; 
		return {d: cp};
	})[0];
}

export { ens_normalize, ens_tokenize };
