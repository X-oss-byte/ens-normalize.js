import {parse_cp, parse_cp_range, parse_cp_sequence, hex_cp} from './utils.js';
import {readFileSync} from 'node:fs';

export function parse_semicolon_file(file, impl = {}) {
	let scope = {
		root: {},
		row([src, cls]) {
			this.get_bucket(cls).push(src);
		},
		...impl,
		get_bucket(key) {
			if (!key) throw new Error(`empty bucket key`);
			let bucket = root[key];
			if (!bucket) bucket = root[key] = [];
			return bucket;
		} 
	};
	let {root, row, comment} = scope;
	for (let line of readFileSync(file, {encoding: 'utf8'}).split('\n')) {
		let rest;
		let pos = line.indexOf('#');
		if (pos >= 0) {
			rest = line.slice(pos + 1).trim();
			line = line.slice(0, pos).trim();
		}
		try {
			if (line) {
				row?.call(scope, line.split(';').map(s => s.trim()), rest);
			} else if (rest) {
				comment?.call(scope, rest);
			}
		} catch (err) {
			console.log(`Error parsing: ${file}`);
			console.log(line);
			throw err;
		}
	}
	return root;
}

export function parse_ucd(dir) {
	// https://www.unicode.org/reports/tr44/#UnicodeData.txt
	// 0000;<control>;Cc;0;BN;;;;;N;NULL;;;;
	// 0031;DIGIT ONE;Nd;0;EN;;1;1;1;N;;;;;
	// 00C0;LATIN CAPITAL LETTER A WITH GRAVE;Lu;0;L;0041 0300;;;;N;LATIN CAPITAL LETTER A GRAVE;;;00E0;
	return parse_semicolon_file(new URL('./UnicodeData.txt', dir), {		
		root: [],
		row(v) {
			if (v.length != 15) throw new Error(`missing columns`);
			let cp = parse_cp(v[0]);
			let info = {
				cp,
				name: v[1],
				old_name: v[10],
				gc: v[2],           // general category
				cc: parseInt(v[3]), // combining class
				bidi_class: v[4], 
				bidi_mirrored: v[9] === 'Y',
				iso_comment: v[11]
			};
			// "" | "<tag>" | "XXXX YYYY" | "<tag>XXXX YYYY"
			let temp = v[5];
			if (temp.startsWith('<')) {
				let pos = temp.indexOf('>');
				if (pos == -1) throw new Error('expected closing bracket');
				info.decomp_type = temp.slice(1, pos);
				temp = temp.slice(pos + 1).trim();
				if (temp) info.decomp = parse_cp_sequence(temp);
			} else if (temp) {
				info.decomp = parse_cp_sequence(temp);
			}
			temp = v[6];
			if (temp) info.dec = parseInt(temp);
			temp = v[7];
			if (temp) info.digit = parseInt(temp);
			temp = v[8];
			if (temp) info.numer = parseInt(temp);
			temp = v[12];
			if (temp) info.upper = parse_cp(temp);
			temp = v[13];
			if (temp) info.lower = parse_cp(temp);
			temp = v[14];
			if (temp) info.title = parse_cp(temp);
			this.root.push(info);
		}
	});
}

export class UnicodeSpec {
	constructor(dir) {
		this.dir = dir;
		this.version = JSON.parse(readFileSync(new URL('./version.json', dir)));
		this.chars = parse_ucd(dir);
		this.char_map = new Map(this.chars.map(x => [x.cp, x]));
	}
	get_name(cp) {
		let info = this.char_map.get(cp);
		if (info) {
			let {name, old_name} = info;
			if (name === '<control>' && old_name) {
				name = old_name;
			}
			return name;
		}
	}
	format(x, ...a) {
		let ret;
		if (typeof x === 'number') {
			ret = `${hex_cp(x)} (${String.fromCodePoint(x)}) ${this.get_name(x)}`;
		} else if (Array.isArray(x)) {
			if (x.length == 1) {
				ret = this.format(x[0]);
			} else {
				ret = '[' + x.map(hex_cp).join(' ') + ']';
			}
		} else {
			if (typeof x.cp === 'number')  {
				ret = this.format(x.cp);
			} else {
				ret = `${this.format(x.cps)} (${String.fromCodePoint(...x.cps)}) ${x.name}`;
			}
		}
		if (a.length) {
			ret = `${ret} => ${this.format(...a)}`;
		}		
		// 00..19 <control>
		// 7F     DEL
		// 202D   LTR OVERRIDE
		// 202E   RTL OVERRIDE
		return ret.replace(/[\x00-\x19\x7F\u202E\u202D]/gu, '?');
	}
	combining_ranks() {
		// return list of codepoints in order by increasing combining class
		// skips class 0
		let map = new Map();
		for (let info of this.chars) {
			let {cp, cc} = info;
			if (cc > 0) {
				let bucket = map.get(cc);
				if (!bucket) {
					bucket = [];
					map.set(cc, bucket);
				}
				bucket.push(cp);
			}
		}
		return [...map.entries()].sort((a, b) => a[0] - b[0]).map(x => x[1]);
	}
	general_category(prefix) {
		return this.chars.filter(x => x.gc.startsWith(prefix));
	}
	decompositions(compat = false) {
		// "Conversely, the presence of a formatting tag also indicates that the mapping is a compatibility mapping and not a canonical mapping."
		return this.chars.filter(x => x.decomp && (compat || !x.decomp_type)).map(x => [x.cp, x.decomp]);
	}
	nf_props() {
		// 037A        ; FC_NFKC                     ; 0020 03B9 # Lm GREEK YPOGEGRAMMENI
		// 11127       ; NFKC_QC                     ; M         # Mn CHAKMA VOWEL SIGN A
		// 1F73        ; Full_Composition_Exclusion              # L& GREEK SMALL LETTER EPSILON WITH OXIA
		// 00C0..00C5  ; Expands_On_NFD                          # L& [6] LATIN CAPITAL LETTER A WITH GRAVE..LATIN CAPITAL LETTER A WITH RING ABOVE
		return parse_semicolon_file(new URL('./DerivedNormalizationProps.txt', this.dir), {
			row([src, type, value]) {
				if (type.endsWith('_QC')) {
					let bucket = this.get_bucket(type);
					for (let cp of parse_cp_range(src)) {
						bucket.push([cp, value]);
					}
				} else if (type.startsWith('FC_')) {
					this.get_bucket(type).push([parse_cp(src), parse_cp_sequence(value)]);
				} else { 
					this.get_bucket(type).push(...parse_cp_range(src));
				}
			}
		});
	}
	composition_exclusions() {
		// 0958    #  DEVANAGARI LETTER QA
		return parse_semicolon_file(new URL('./CompositionExclusions.txt', this.dir), {
			root: [],
			row([src]) {
				this.root.push(parse_cp(src));
			}	
		});
	}
	emoji_zwjs() {
		// 1F468 200D 2764 FE0F 200D 1F468 ; RGI_Emoji_ZWJ_Sequence  ; couple with heart: man, man # E2.0   [1] (👨‍❤️‍👨)	
		return parse_semicolon_file(new URL('./emoji-zwj-sequences.txt', this.dir), {
			row([src, type, name], comment) {
				let cps = parse_cp_sequence(src);
				let version = parse_version_from_comment(comment);
				this.get_bucket(type).push({cps, type, name, version});
			}
		});
	}
	emoji_seqs() {
		//231A..231B    ; Basic_Emoji                  ; watch                              # E0.6   [2] (⌚..⌛)
		//25AB FE0F     ; Basic_Emoji                  ; white small square                 # E0.6   [1] (▫️)
		//0023 FE0F 20E3; Emoji_Keycap_Sequence        ; keycap: \x{23}                     # E0.6   [1] (#️⃣)
		//1F1E6 1F1E8   ; RGI_Emoji_Flag_Sequence      ; flag: Ascension Island             # E2.0   [1] (🇦🇨)
		//1F3F4 E0067 E0062 E0065 E006E E0067 E007F; RGI_Emoji_Tag_Sequence; flag: England  # E5.0   [1] (🏴󠁧󠁢󠁥󠁮󠁧󠁿)
		//261D 1F3FB    ; RGI_Emoji_Modifier_Sequence  ; index pointing up: light skin tone # E1.0   [1] (☝🏻)
		const self = this;
		return parse_semicolon_file(new URL('./emoji-sequences.txt', this.dir), {
			row([src, type, name], comment) {
				let version = parse_version_from_comment(comment);
				if (src.includes('..')) {
					let bucket = this.get_bucket(type);
					for (let cp of parse_cp_range(src)) {
						bucket.push({cps: [cp], type, name: self.get_name(cp), version});
					}
				} else {
					let cps = parse_cp_sequence(src);
					this.get_bucket(type).push({cps, type, name, version});
				}
			}
		});
	}
	emoji_data() {
		// 0023          ; Emoji                # E0.0   [1] (#️)       hash sign
		// 0030..0039    ; Emoji                # E0.0  [10] (0️..9️)    digit zero..digit nine
		// 261D          ; Emoji_Modifier_Base  # E0.6   [1] (☝️)       index pointing up
		// 0023          ; Emoji_Component      # E0.0   [1] (#️)       hash sign
		// 00A9          ; Extended_Pictographic# E0.6   [1] (©️)       copyright
		const self = this;
		return parse_semicolon_file(new URL('./emoji-data.txt', this.dir), {
			row([src, type], comment) {
				let version = parse_version_from_comment(comment);			
				for (let cp of parse_cp_range(src)) {
					this.get_bucket(type).push({cp, type, name: self.get_name(cp), version});
				}
			}
		});
	}
	idna_rules({version, use_STD3, valid_deviations}) {
		switch (version) {
			case 2003:
			case 2008: break;
			default: throw new TypeError(`unknown IDNA version: ${version}`);
		}
		let {
			valid, valid_NV8, valid_XV8,
			deviation_mapped, deviation_ignored,
			disallowed, disallowed_STD3_mapped, disallowed_STD3_valid,
			ignored, mapped, ...extra
		} = parse_semicolon_file(new URL('./IdnaMappingTable.txt', this.dir), {
			row([src, type, dst, status]) {
				if (!src) throw new Error('wtf src');
				if (type == 'deviation') type = dst ? 'deviation_mapped' : 'deviation_ignored';
				if (status) type = `${type}_${status}`; // NV8/XV8
				let bucket = this.get_bucket(type);
				if (type.includes('mapped')) {
					if (!dst) throw new Error('wtf dst');
					bucket.push([src, dst]);
				} else {
					bucket.push(src); 
				}
			}
		});
		if (Object.keys(extra).length > 0) {
			throw new Error(`unexpected IDNA keys: ${Object.keys(extra)}`);
		}
		if (!use_STD3) {
			// disallowed_STD3_valid: the status is disallowed if UseSTD3ASCIIRules=true (the normal case); 
			// implementations that allow UseSTD3ASCIIRules=false would treat the code point as valid.
			valid.push(...disallowed_STD3_valid);
			// disallowed_STD3_mapped: the status is disallowed if UseSTD3ASCIIRules=true (the normal case); 
			// implementations that allow UseSTD3ASCIIRules=false would treat the code point as mapped.
			mapped.push(...disallowed_STD3_mapped);
		}
		if (version == 2003) {
			// There are two values: NV8 and XV8. NV8 is only present if the status is valid 
			// but the character is excluded by IDNA2008 from all domain names for all versions of Unicode. 
			valid.push(...valid_NV8);
			// XV8 is present when the character is excluded by IDNA2008 for the current version of Unicode.
			valid.push(...valid_XV8);
		} 
		// IDNA2008 allows the joiner characters (ZWJ and ZWNJ) in labels. 
		// By contrast, these are removed by the mapping in IDNA2003.
		if (version == 2008 || valid_deviations) { 
			valid.push(...deviation_mapped.map(([x]) => x));
			valid.push(...deviation_ignored);
		} else {
			mapped.push(...deviation_mapped);
			ignored.push(...deviation_ignored);
		}
		valid = valid.flatMap(parse_cp_range);
		let valid_set = new Set(valid);
		ignored = ignored.flatMap(parse_cp_range);
		if (ignored.some(cp => valid_set.has(cp))) throw new Error(`Ignored is Valid!`);
		// we need to re-apply the rules to the mapped output
		// x:[char] => ys:[char, char, ...]
		mapped = mapped.flatMap(([src, dst]) => {
			let cps = parse_cp_sequence(dst);
			return cps.every(cp => valid_set.has(cp)) ? parse_cp_range(src).map(x => [x, cps]) : [];
		});
		return {valid, ignored, mapped};
	}
	nf_tests() {
		return parse_semicolon_file(new URL('./NormalizationTest.txt', this.dir), {
			row([src, nfc, nfd], comment) {
				if (src.startsWith('@')) {
					this.test = this.get_bucket(comment.trim());
				} else {
					let {test} = this;
					if (!test) throw new Error('expected test');
					test.push([src, nfd, nfc].map(s => String.fromCodePoint(...parse_cp_sequence(s))));
				}
			}	
		});
	}
}

function parse_version_from_comment(s) {
	let match = s.match(/^E(\d+.\d+)\b/);
	if (!match) throw new Error(`expected version: ${s}`);
	return match[1];
}