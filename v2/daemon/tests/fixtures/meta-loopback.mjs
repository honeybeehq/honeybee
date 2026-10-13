const target = process.env.HIVE_TEST_META_URL;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (target && url.startsWith("https://auth.meta.com/")) return realFetch(`${target.replace(/\/+$/, "")}${url.slice("https://auth.meta.com".length)}`, init);
  return realFetch(input, init);
};
