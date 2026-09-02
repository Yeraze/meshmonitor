import { describe, it, expect } from 'vitest';
import { tokenizeArgv, ArgvTokenizerError } from './argvTokenizer.js';

describe('tokenizeArgv', () => {
  it('returns [] for empty input', () => {
    expect(tokenizeArgv('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(tokenizeArgv('   ')).toEqual([]);
    expect(tokenizeArgv('\t\n \r')).toEqual([]);
  });

  it('splits plain whitespace-separated tokens', () => {
    expect(tokenizeArgv('foo bar baz')).toEqual(['foo', 'bar', 'baz']);
  });

  it('collapses runs of whitespace between tokens', () => {
    expect(tokenizeArgv('a    b\t\tc\n\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('trims leading and trailing whitespace', () => {
    expect(tokenizeArgv('   foo bar   ')).toEqual(['foo', 'bar']);
  });

  it('treats a double-quoted phrase as one arg with spaces preserved', () => {
    expect(tokenizeArgv('--text "hello world"')).toEqual(['--text', 'hello world']);
  });

  it('treats a single-quoted phrase as one arg with contents verbatim', () => {
    expect(tokenizeArgv("'a b' \"c d\" e f")).toEqual(['a b', 'c d', 'e', 'f']);
  });

  it('single quotes keep backslashes literal', () => {
    expect(tokenizeArgv("'hello\\ world'")).toEqual(['hello\\ world']);
  });

  it('honors a backslash-escaped space outside quotes', () => {
    expect(tokenizeArgv('hello\\ world')).toEqual(['hello world']);
  });

  it('honors \\" inside double quotes to embed a literal double-quote', () => {
    expect(tokenizeArgv('--path "with \\"quote\\""')).toEqual(['--path', 'with "quote"']);
  });

  it('honors \\\\ inside double quotes to embed a literal backslash', () => {
    expect(tokenizeArgv('"a\\\\b"')).toEqual(['a\\b']);
  });

  it('translates \\n and \\t inside double quotes', () => {
    expect(tokenizeArgv('"line1\\nline2"')).toEqual(['line1\nline2']);
    expect(tokenizeArgv('"col1\\tcol2"')).toEqual(['col1\tcol2']);
  });

  it('leaves an unknown \\x sequence inside double quotes as literal \\x', () => {
    expect(tokenizeArgv('"a\\zb"')).toEqual(['a\\zb']);
  });

  it('does not special-case =: --flag=value with spaces splits at the first space', () => {
    expect(tokenizeArgv('--flag=value with spaces')).toEqual([
      '--flag=value',
      'with',
      'spaces',
    ]);
  });

  it('adjacent quoted and unquoted pieces join into one token', () => {
    expect(tokenizeArgv('a"b c"d')).toEqual(['ab cd']);
    expect(tokenizeArgv("hello'world me'")).toEqual(['helloworld me']);
  });

  it('an empty double-quoted string yields one empty argument', () => {
    expect(tokenizeArgv('foo "" bar')).toEqual(['foo', '', 'bar']);
  });

  it('a trailing bare backslash is emitted as a literal backslash', () => {
    expect(tokenizeArgv('foo\\')).toEqual(['foo\\']);
  });

  it('throws on an unterminated double quote', () => {
    expect(() => tokenizeArgv('--text "hello')).toThrow(ArgvTokenizerError);
    expect(() => tokenizeArgv('--text "hello')).toThrow(/unterminated double quote/);
  });

  it('throws on an unterminated single quote', () => {
    expect(() => tokenizeArgv("--text 'hello")).toThrow(ArgvTokenizerError);
    expect(() => tokenizeArgv("--text 'hello")).toThrow(/unterminated single quote/);
  });

  it('does not expand shell constructs', () => {
    // $var, backticks, $() are all preserved verbatim; this is a splitter, not a shell.
    expect(tokenizeArgv('$FOO `pwd` $(date)')).toEqual(['$FOO', '`pwd`', '$(date)']);
  });
});
