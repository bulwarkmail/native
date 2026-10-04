// `punycode@2` ships no types, and the trailing-slash specifier (the npm
// package, not Node's built-in) is not covered by @types/node.
declare module 'punycode/' {
  const punycode: {
    toASCII(domain: string): string;
    toUnicode(domain: string): string;
  };
  export default punycode;
}
