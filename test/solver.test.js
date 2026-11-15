// Unit tests for the pure parts (no browser, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnswer, parseJSONLoose, buildPrompt } from '../src/solver.js';
import { loadConfig, applyOverrides } from '../src/config.js';

const single = {
  kind: 'single',
  stem: 'Which city is the capital of China?',
  hint: 'Q1',
  options: [
    { key: 'A', text: 'Beijing' },
    { key: 'B', text: 'Shanghai' },
    { key: 'C', text: 'Guangzhou' },
  ],
  blanks: [],
  selects: [],
};

const multiple = {
  kind: 'multiple',
  stem: 'Pick the programming languages',
  options: [
    { key: 'A', text: 'Python' },
    { key: 'B', text: 'HTML' },
    { key: 'C', text: 'Java' },
    { key: 'D', text: 'JSON' },
  ],
  blanks: [],
  selects: [],
};

const judge = {
  kind: 'single',
  stem: 'The sun rises in the west.',
  options: [
    { key: 'A', text: 'True' },
    { key: 'B', text: 'False' },
  ],
  blanks: [],
  selects: [],
};

const blank = { kind: 'blank', stem: '2^10 =', options: [], blanks: [{ index: 0 }], selects: [] };
const select = { kind: 'select', stem: 'How many months?', options: [], blanks: [], selects: [{ index: 0 }] };

test('single choice: plain letter', () => {
  assert.deepEqual(normalizeAnswer(single, 'B').keys, ['B']);
});

test('single choice: lower case and decorations', () => {
  assert.deepEqual(normalizeAnswer(single, ' c ').keys, ['C']);
  assert.deepEqual(normalizeAnswer(single, '(A)').keys, ['A']);
});

test('single choice: answer given as option text', () => {
  assert.deepEqual(normalizeAnswer(single, 'Shanghai').keys, ['B']);
});

test('single choice: keeps only the first key', () => {
  assert.deepEqual(normalizeAnswer(single, ['A', 'C']).keys, ['A']);
});

test('multiple choice: array, comma list and glued letters', () => {
  assert.deepEqual(normalizeAnswer(multiple, ['A', 'C']).keys, ['A', 'C']);
  assert.deepEqual(normalizeAnswer(multiple, 'A,C').keys, ['A', 'C']);
  assert.deepEqual(normalizeAnswer(multiple, 'AC').keys, ['A', 'C']);
  assert.deepEqual(normalizeAnswer(multiple, 'A、C').keys, ['A', 'C']);
});

test('unknown letters are dropped', () => {
  assert.deepEqual(normalizeAnswer(single, 'Z').keys, []);
  assert.deepEqual(normalizeAnswer(multiple, ['A', 'Z']).keys, ['A']);
});

test('true/false words are matched as text, not as letters', () => {
  assert.deepEqual(normalizeAnswer(judge, 'False').keys, ['B']);
  assert.deepEqual(normalizeAnswer(judge, 'True').keys, ['A']);
  // "错" is not one of the English options, so nothing should be guessed
  assert.deepEqual(normalizeAnswer(judge, '错').keys, []);
});

test('chinese true/false options', () => {
  const judgeCn = {
    kind: 'single',
    stem: '太阳从西边升起。',
    options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }],
    blanks: [],
    selects: [],
  };
  assert.deepEqual(normalizeAnswer(judgeCn, '错').keys, ['B']);
  assert.deepEqual(normalizeAnswer(judgeCn, '对').keys, ['A']);
});

test('decorated letters still work', () => {
  assert.deepEqual(normalizeAnswer(single, '(A)').keys, ['A']);
  assert.deepEqual(normalizeAnswer(single, 'A.').keys, ['A']);
  assert.deepEqual(normalizeAnswer(single, '选B').keys, ['B']);
  assert.deepEqual(normalizeAnswer(single, '答案：C').keys, ['C']);
});

test('blank and select answers stay verbatim', () => {
  assert.equal(normalizeAnswer(blank, '1024').value, '1024');
  assert.equal(normalizeAnswer(blank, ['1024', 'and 512']).value, '1024 | and 512');
  assert.equal(normalizeAnswer(select, '12').value, '12');
});

test('parseJSONLoose handles fences and trailing commas', () => {
  assert.equal(parseJSONLoose('```json\n{"answer":"B"}\n```').answer, 'B');
  assert.equal(parseJSONLoose('{"answer":"B",}').answer, 'B');
  assert.equal(parseJSONLoose('no json here'), null);
});

test('buildPrompt includes options and question kind', () => {
  const prompt = buildPrompt(single);
  assert.match(prompt, /单选题/);
  assert.match(prompt, /A\. Beijing/);
});

test('applyOverrides does not mutate the base config', () => {
  const base = loadConfig('');
  const dry = applyOverrides(base, { dryRun: true, max: 5 });
  assert.equal(base.agent.dryRun, false);
  assert.equal(dry.agent.dryRun, true);
  assert.equal(dry.agent.maxQuestions, 5);
  assert.equal(dry.agent.nextStrategies.length, base.agent.nextStrategies.length);
});
