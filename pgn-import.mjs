function stripMovetextAnnotations(text) {
  let output = "";
  let braceDepth = 0;
  let variationDepth = 0;
  let inLineComment = false;
  for (const character of text) {
    if (inLineComment) {
      if (character === "\n" || character === "\r") {
        inLineComment = false;
        output += " ";
      }
      continue;
    }
    if (braceDepth) {
      if (character === "{") braceDepth++;
      else if (character === "}") braceDepth--;
      continue;
    }
    if (character === ";") {
      inLineComment = true;
      continue;
    }
    if (character === "{") {
      braceDepth = 1;
      continue;
    }
    if (character === "(") {
      variationDepth++;
      continue;
    }
    if (character === ")") {
      if (!variationDepth) throw new Error("The PGN contains an unmatched variation marker.");
      variationDepth--;
      continue;
    }
    if (!variationDepth) output += character;
  }
  if (braceDepth) throw new Error("The PGN contains an unclosed comment.");
  if (variationDepth) throw new Error("The PGN contains an unclosed variation.");
  return output;
}

function unescapeTag(value) {
  return value.replace(/\\(["\\])/g, "$1");
}

export function parsePgn(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Choose a PGN file or paste a game first.");
  const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const headers = {};
  const lines = source.split("\n");
  let lineIndex = 0;
  for (; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    if (!line) {
      if (Object.keys(headers).length) {
        lineIndex++;
        break;
      }
      continue;
    }
    const match = /^\[([A-Za-z][A-Za-z0-9_]*)\s+"((?:\\.|[^"\\])*)"\]$/.exec(line);
    if (!match) break;
    headers[match[1]] = unescapeTag(match[2]);
  }
  const movetext = stripMovetextAnnotations(lines.slice(lineIndex).join("\n"));
  const moves = [];
  let result = "";
  for (let token of movetext.split(/\s+/).filter(Boolean)) {
    token = token.replace(/\$\d+/g, "");
    token = token.replace(/^\d+\.(?:\.\.)?/, "");
    if (!token || /^\d+\.+$/.test(token) || /^\$\d+$/.test(token)) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) {
      result = token;
      continue;
    }
    if (/^(e\.p\.|ep)$/i.test(token)) continue;
    if (result) throw new Error("The PGN contains moves after its game result.");
    moves.push(token.replace(/[!?]+$/, ""));
  }
  if (!moves.length) throw new Error("The PGN does not contain any moves.");
  return { headers, moves, result: result || headers.Result || "*" };
}
