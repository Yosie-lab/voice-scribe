'use strict';

function methodBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return '';
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return '';
}

function hypothesis(text, isFinal) {
  const result = [{ transcript: text, confidence: 0 }];
  result.isFinal = isFinal;
  return result;
}

function countSpan(text, span) {
  const norm = (text || '').replace(/[。、！？!?\s\u3000]/g, '');
  const needle = (span || '').replace(/[。、！？!?\s\u3000]/g, '');
  let n = 0;
  let i = 0;
  while (needle && (i = norm.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

function paintOf(Transcriber, language, events) {
  const t = new Transcriber();
  t.language = language;
  t._isIOS = false;
  let finalText = '';
  let interimText = '';
  t.onResult = (final, interim) => {
    finalText = final;
    interimText = interim;
  };
  events.forEach((event) => t._ingestResult(event));
  return { finalText, interimText, shown: `${finalText || ''}${interimText || ''}`, t };
}

function micCalls(src) {
  return (src.match(/\.getUserMedia\s*\(/g) || []).length;
}

module.exports = {
  methodBody,
  hypothesis,
  countSpan,
  paintOf,
  micCalls
};
