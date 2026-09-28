// Compact line format for CLI requests and answers. JSON spends tokens on
// quotes, braces, repeated field names and escaping; this keeps the structure
// with sigils at the start of a line and nothing to escape.
//
// Request:
//   @spec                          state field; body is raw text up to the next @ or ? line
//   Add a --dry-run flag.
//   @artifact
//   diff --git ...
//   ?satisfies bool Does `artifact` satisfy `spec`?
//    + every requirement is met    indented criteria: + / - for a bool,
//    - a requirement is missing
//   ?kind choice What kind of change?
//    bug: fixes behaviour          name: description for a choice
//    other: none fit
//   ?quality score Overall quality
//    unusable | rework | ready     rungs, lowest first, split on | or one per line
//
// Without @ lines, everything before the first ? line is plain-text state.
// A line starting @@ or ?? is a literal line starting @ or ?.
//
// Answers, one line per question:
//   satisfies yes .91
//   kind bug .72 c=.55 | feature .20 other .08     c= is the answer's confidence
//   quality 2/2 .81 c=.74 | 1:.15 0:.04

const TYPES = { bool: 'boolean', boolean: 'boolean', choice: 'choice', score: 'score' };
const KEY = '[A-Za-z_][\\w.-]*';
const STATE_RE = new RegExp(`^@(${KEY})\\s*$`);
const QUESTION_RE = new RegExp(`^\\?(${KEY})\\s+(\\w+)\\s+(.+)$`);

function unescape(line) {
  return line.startsWith('@@') || line.startsWith('??') ? line.slice(1) : line;
}

function trimBlock(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b).join('\n');
}

function finishQuestion(q) {
  const { key, type, instructions, lines } = q;
  const out = { type, instructions };
  if (!lines.length) {
    if (type === 'choice') throw new Error(`?${key}: a choice needs options, one "name: description" per indented line`);
    if (type === 'score') throw new Error(`?${key}: a score needs rungs, indented, lowest first`);
    return out;
  }
  if (type === 'boolean') {
    const criteria = {};
    for (const l of lines) {
      const m = /^([+-])\s*(.+)$/.exec(l);
      if (!m) throw new Error(`?${key}: bool criteria lines start with + (true) or - (false): "${l}"`);
      const side = m[1] === '+' ? 'true' : 'false';
      if (criteria[side]) throw new Error(`?${key}: more than one ${m[1]} line`);
      criteria[side] = m[2].trim();
    }
    if (!criteria.true || !criteria.false) throw new Error(`?${key}: give both a + and a - line, or neither`);
    out.criteria = criteria;
  } else if (type === 'choice') {
    const criteria = {};
    for (const l of lines) {
      const m = new RegExp(`^(${KEY})\\s*(?::\\s*(.*))?$`).exec(l);
      if (!m) throw new Error(`?${key}: choice options are "name: description": "${l}"`);
      if (m[1] in criteria) throw new Error(`?${key}: duplicate option "${m[1]}"`);
      criteria[m[1]] = m[2]?.trim() || m[1];
    }
    out.criteria = criteria;
  } else {
    out.criteria = lines.flatMap((l) => l.split('|')).map((s) => s.trim()).filter(Boolean);
    if (out.criteria.length < 2) throw new Error(`?${key}: a score needs at least two rungs`);
  }
  return out;
}

/** Parse a compact request into { state, questions }. */
export function parseCompact(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fields = {};
  const preamble = [];
  const questions = {};
  let field = null;   // { key, lines } while reading a state field
  let question = null; // { key, type, instructions, lines } while reading criteria

  const closeField = () => {
    if (field) fields[field.key] = trimBlock(field.lines);
    field = null;
  };
  const closeQuestion = () => {
    if (question) questions[question.key] = finishQuestion(question);
    question = null;
  };

  lines.forEach((line, i) => {
    const s = STATE_RE.exec(line);
    if (s) {
      closeField(); closeQuestion();
      if (s[1] in fields) throw new Error(`Line ${i + 1}: state field @${s[1]} given twice`);
      field = { key: s[1], lines: [] };
      return;
    }
    if (line.startsWith('?') && !line.startsWith('??')) {
      const q = QUESTION_RE.exec(line);
      if (!q) throw new Error(`Line ${i + 1}: questions are "?key type instructions": "${line}"`);
      const type = TYPES[q[2]];
      if (!type) throw new Error(`Line ${i + 1}: unknown question type "${q[2]}" (bool, choice, score)`);
      closeField(); closeQuestion();
      if (q[1] in questions) throw new Error(`Line ${i + 1}: question ?${q[1]} given twice`);
      question = { key: q[1], type, instructions: q[3].trim(), lines: [] };
      return;
    }
    if (field) { field.lines.push(unescape(line)); return; }
    if (question) {
      if (!line.trim()) return;
      if (!/^\s/.test(line)) throw new Error(`Line ${i + 1}: criteria under ?${question.key} must be indented: "${line}"`);
      question.lines.push(line.trim());
      return;
    }
    preamble.push(unescape(line));
  });
  closeField(); closeQuestion();

  if (!Object.keys(questions).length) throw new Error('No questions: add at least one "?key type instructions" line.');
  const pre = trimBlock(preamble);
  const keys = Object.keys(fields);
  if (keys.length && pre) throw new Error('Text before the first @field: put it under its own @field, or drop the @ fields.');
  const state = keys.length ? fields : pre;
  if (state === '') throw new Error('No state given: add text or @fields before the questions.');
  return { state, questions };
}

/** Probability as a short string: .91, .9, .07, 1, 0. */
export function fmtP(p) {
  const s = Number(p).toFixed(2);
  if (s === '1.00') return '1';
  if (s === '0.00') return '0';
  return s.replace(/^0/, '').replace(/0$/, '');
}

function rest(entries, sep) {
  const others = entries.filter(([, p]) => p >= 0.005).sort((a, b) => b[1] - a[1]);
  return others.length ? ' | ' + others.map(([k, p]) => `${k}${sep}${fmtP(p)}`).join(' ') : '';
}

const conf = (a) => (a.confidence === undefined ? '' : ` c=${fmtP(a.confidence)}`);

/** Format answers as one line per question. */
export function formatCompact(answers) {
  return Object.entries(answers).map(([key, a]) => {
    if (a.type === 'boolean') return `${key} ${a.verdict ?? '-'} ${fmtP(a.probability)}`;
    const probs = Object.entries(a.probabilities || {});
    if (a.type === 'choice') {
      const p = a.probabilities?.[a.choice] ?? a.confidence;
      return `${key} ${a.choice} ${fmtP(p)}${conf(a)}${rest(probs.filter(([k]) => k !== a.choice), ' ')}`;
    }
    if (a.type === 'score') {
      const max = probs.length ? probs.length - 1 : '?';
      const p = a.probabilities?.[String(a.score)] ?? a.confidence;
      return `${key} ${a.score}/${max} ${fmtP(p)}${conf(a)}${rest(probs.filter(([k]) => k !== String(a.score)), ':')}`;
    }
    return `${key} ${JSON.stringify(a)}`;
  }).join('\n');
}
