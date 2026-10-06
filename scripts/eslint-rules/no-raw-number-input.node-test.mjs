import test from 'node:test';
import { RuleTester } from 'eslint';
import { noRawNumberInput } from './no-raw-number-input.mjs';

test('flags raw number inputs and leaves everything else alone', () => {
  const ruleTester = new RuleTester({
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  });

  ruleTester.run('no-raw-number-input', noRawNumberInput, {
    valid: [
      '<NumberInput value={n} onChange={setN} min={0} />',
      '<input type="text" value={s} onChange={onChange} />',
      '<input type="range" min={0} max={10} value={n} onChange={onChange} />',
      '<input value={s} onChange={onChange} />',
      // A dynamic type cannot be judged statically.
      '<input type={kind} value={s} onChange={onChange} />',
      // Chart axes use the same attribute for something else.
      '<XAxis type="number" dataKey="timestamp" />',
    ],
    invalid: [
      {
        code: '<input type="number" value={n} onChange={e => setN(parseInt(e.target.value) || 60)} />',
        errors: [{ messageId: 'rawNumberInput' }],
      },
      {
        code: "<input type={'number'} value={n} onChange={onChange} />",
        errors: [{ messageId: 'rawNumberInput' }],
      },
      {
        code: '<input type={`number`} value={n} onChange={onChange} />',
        errors: [{ messageId: 'rawNumberInput' }],
      },
    ],
  });
});
