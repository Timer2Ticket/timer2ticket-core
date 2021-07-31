module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  env: {
    browser: true,
    es6: true,
    jest: true,
    node: true,
  },
  plugins: [
    '@typescript-eslint',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules:
  {
    'no-undef': 'off',
  },
};