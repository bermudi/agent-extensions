const CSI = "\x1b[";
const SS3 = "\x1bO";

const namedKeys: Record<string, string> = {
  // Basics
  enter: "\r",
  return: "\r",
  tab: "\t",
  escape: "\x1b",
  esc: "\x1b",
  backspace: "\x7f",
  delete: `${CSI}3~`,
  space: " ",

  // Arrows (normal mode)
  up: `${CSI}A`,
  down: `${CSI}B`,
  right: `${CSI}C`,
  left: `${CSI}D`,

  // Arrows (application mode)
  "app-up": `${SS3}A`,
  "app-down": `${SS3}B`,
  "app-right": `${SS3}C`,
  "app-left": `${SS3}D`,

  // Navigation
  home: `${CSI}H`,
  end: `${CSI}F`,
  pageup: `${CSI}5~`,
  pagedown: `${CSI}6~`,
  insert: `${CSI}2~`,

  // Function keys
  f1: `${SS3}P`,
  f2: `${SS3}Q`,
  f3: `${SS3}R`,
  f4: `${SS3}S`,
  f5: `${CSI}15~`,
  f6: `${CSI}17~`,
  f7: `${CSI}18~`,
  f8: `${CSI}19~`,
  f9: `${CSI}20~`,
  f10: `${CSI}21~`,
  f11: `${CSI}23~`,
  f12: `${CSI}24~`,
};

const ctrlMap: Record<string, string> = {
  a: "\x01", b: "\x02", c: "\x03", d: "\x04", e: "\x05", f: "\x06",
  g: "\x07", h: "\x08", i: "\x09", j: "\x0a", k: "\x0b", l: "\x0c",
  m: "\x0d", n: "\x0e", o: "\x0f", p: "\x10", q: "\x11", r: "\x12",
  s: "\x13", t: "\x14", u: "\x15", v: "\x16", w: "\x17", x: "\x18",
  y: "\x19", z: "\x1a",
  "@": "\x00", "[": "\x1b", "\\": "\x1c", "]": "\x1d", "^": "\x1e", "_": "\x1f",
  "?": "\x7f",
  " ": "\x00",
};

export function resolveKey(key: string): string | null {
  const lower = key.toLowerCase().trim();

  // Direct named key
  if (namedKeys[lower]) return namedKeys[lower];

  // Single character (literal)
  if (lower.length === 1) return lower;

  // Modifier combos: ctrl-x, alt-x, shift-x
  const m = lower.match(/^(ctrl|alt|shift)-(.+)$/);
  if (m) {
    const mod = m[1]!;
    const rest = m[2]!;
    if (mod === "ctrl") {
      if (ctrlMap[rest]) return ctrlMap[rest];
      if (rest.length === 1) return String.fromCharCode(rest.charCodeAt(0) & 0x1f);
    }
    if (mod === "alt") {
      const resolved = resolveKey(rest);
      if (resolved) return "\x1b" + resolved;
    }
    if (mod === "shift") {
      // For named keys, shift often doesn't change the sequence;
      // for letters, just uppercase.
      if (rest.length === 1) return rest.toUpperCase();
      const resolved = resolveKey(rest);
      if (resolved) return resolved;
    }
  }

  // Control characters written as ^X
  const caret = lower.match(/\^([a-z\[\]\\\^_@?])$/);
  if (caret) {
    const ch = caret[1]!;
    if (ctrlMap[ch]) return ctrlMap[ch];
  }

  return null;
}
