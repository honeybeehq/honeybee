const target = process.env.L3A_OPENAI_STUB;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (target && url.startsWith("https://api.openai.com/")) return realFetch(url.replace("https://api.openai.com", target), init);
  return realFetch(input, init);
};
