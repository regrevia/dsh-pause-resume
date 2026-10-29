/**
 * The audit config lives in a file so the npm script carries no quoted JSON: a POSIX shell keeps
 * `'{"no-undef":"error"}'` as one argument, cmd.exe does not, and the same command must run on both.
 */
const globals = {
  window: 'readonly', performance: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', sessionStorage: 'readonly', localStorage: 'readonly', fetch: 'readonly',
  Response: 'readonly', Request: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  AbortController: 'readonly', CustomEvent: 'readonly', Event: 'readonly', setTimeout: 'readonly',
  clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly',
  Buffer: 'readonly', process: 'readonly', console: 'readonly',
}

export default [{
  files: ['index.js', 'client.js', 'lib/*.js', 'acceptance/*.mjs'],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals },
  rules: {
    'no-undef': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  },
}]
