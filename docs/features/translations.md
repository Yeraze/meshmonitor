# Translations

MeshMonitor supports multiple languages through community-contributed translations. We use [Weblate](https://weblate.org/), a web-based translation platform, to make it easy for anyone to contribute translations without needing to know how to code.

## Current Languages

MeshMonitor is currently available in:

| Language | Code | Status |
|----------|------|--------|
| English | `en` | Complete (source) |
| German | `de` | Community contributed |
| Spanish | `es` | Community contributed |
| French | `fr` | Community contributed |
| Russian | `ru` | Community contributed |

## How to Contribute Translations

### Getting Started with Weblate

1. **Visit the MeshMonitor Weblate project**:

   [https://hosted.weblate.org/engage/meshmonitor/](https://hosted.weblate.org/engage/meshmonitor/)

2. **Create a free account** (or sign in with GitHub, Google, etc.)

3. **Choose a language** to translate into

4. **Start translating!** - The web interface is intuitive and shows you the source English text alongside where you enter your translation

### Translation Workflow

The translation process is straightforward:

```
You translate on Weblate → Weblate creates a PR → We merge it → Your translation appears in the next release
```

1. **Translate strings** - Use the Weblate interface to translate individual text strings
2. **Automatic PR creation** - Weblate automatically creates pull requests with your translations
3. **Review & merge** - We review and merge translation PRs regularly
4. **Release** - Your translations are included in the next MeshMonitor release

### Adding a New Language

Want to translate MeshMonitor into a language that isn't listed yet?

1. Go to the [MeshMonitor Weblate project](https://hosted.weblate.org/engage/meshmonitor/)
2. Click **"Start new translation"**
3. Select your language from the list
4. Begin translating!

New languages are automatically added to MeshMonitor once they have enough translated strings to be useful.

## Translation Guidelines

To ensure high-quality translations:

### Do's
- **Keep it natural** - Translate meaning, not word-for-word
- **Be consistent** - Use the same terms throughout (e.g., always translate "node" the same way)
- **Consider context** - Some strings appear in buttons, tooltips, or error messages
- **Test your translations** - If possible, run MeshMonitor locally to see how your translations look

### Don'ts
- **Don't translate technical terms** that are commonly used in English (e.g., "Meshtastic", "MQTT", "API")
- **Don't translate placeholders** like `{{count}}` or `{{name}}` - these are replaced with actual values
- **Don't change formatting** such as `\n` for newlines

### String Placeholders

Many strings contain placeholders that get replaced with dynamic values:

```
"nodes.showing_count": "Showing {{count}} of {{total}} nodes"
```

Keep these placeholders exactly as they are, but feel free to reorder them to match natural sentence structure in your language.

## Changing Your Language in MeshMonitor

Once translations are available, users can change their language:

1. Go to **Settings** (gear icon)
2. Find the **Language** dropdown
3. Select your preferred language
4. The interface updates immediately

MeshMonitor also automatically detects your browser's language preference on first visit.

## For Developers

### Adding New Translatable Strings

When adding new UI text to MeshMonitor:

1. Add the English string to `public/locales/en.json`
2. Use the `useTranslation` hook in your React component:

```tsx
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t } = useTranslation();
  return <button>{t('common.save')}</button>;
}
```

3. Weblate will automatically detect the new string and make it available for translation

### String Key Naming Convention

Use dot-notation to organize strings by feature area:

- `nav.*` - Navigation items
- `common.*` - Shared UI elements (buttons, labels)
- `nodes.*` - Node-related strings
- `messages.*` - Message-related strings
- `settings.*` - Settings page strings
- `errors.*` - Error messages

## Questions or Issues?

- **Translation questions**: Ask in the Weblate comments or open a [GitHub issue](https://github.com/Yeraze/meshmonitor/issues)
- **Found a translation bug?**: Report it on [GitHub](https://github.com/Yeraze/meshmonitor/issues) or fix it directly on Weblate

---

[![Translation Status](https://hosted.weblate.org/widgets/meshmonitor/-/multi-auto.svg)](https://hosted.weblate.org/engage/meshmonitor/)

*Thank you to all our translators for helping make MeshMonitor accessible to users worldwide!*
