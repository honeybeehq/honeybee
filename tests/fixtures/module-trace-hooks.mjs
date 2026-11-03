import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (process.env.HIVE_MODULE_TRACE) appendFileSync(process.env.HIVE_MODULE_TRACE, `${resolved.url}\n`);
  return resolved;
}
