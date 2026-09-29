import test from 'node:test';
import { RuleTester } from 'eslint';
import { stableI18nMock } from './stable-i18n-mock.mjs';

test('flags react-i18next mocks that build `t` inside useTranslation', () => {
  const ruleTester = new RuleTester({
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  });

  ruleTester.run('stable-i18n-mock', stableI18nMock, {
    valid: [
      // Shared helper.
      `vi.mock('react-i18next', async () => {
         const { createReactI18nextMock } = await import('../test/mockI18n');
         return createReactI18nextMock((key) => key);
       });`,
      // Hoisted constant, shorthand.
      `vi.mock('react-i18next', () => {
         const t = (key) => key;
         return { useTranslation: () => ({ t }) };
       });`,
      // Hoisted constant, named.
      "const stable = { t: (k) => k }; vi.mock('react-i18next', () => ({ useTranslation: () => stable }));",
      // Other modules are out of scope.
      "vi.mock('./foo', () => ({ useTranslation: () => ({ t: (k) => k }) }));",
    ],
    invalid: [
      {
        code: "vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key) => key }) }));",
        errors: [{ messageId: 'inlineT' }],
      },
      {
        code: `vi.mock('react-i18next', async (importOriginal) => ({
                 ...(await importOriginal()),
                 useTranslation: () => ({ t: function (key) { return key; } }),
               }));`,
        errors: [{ messageId: 'inlineT' }],
      },
      {
        code: `vi.doMock('react-i18next', () => {
                 return { useTranslation: () => { return { t: (k, d) => d ?? k }; } };
               });`,
        errors: [{ messageId: 'inlineT' }],
      },
    ],
  });
});
