export function nativeNodeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) clean[key] = value;
  delete clean.ELECTRON_RUN_AS_NODE;
  delete clean.NODE_OPTIONS;
  return clean;
}

export function withoutInspectorArgs(args: readonly string[]): string[] {
  return args.filter(arg => !/^--inspect(?:-brk|-wait|-port|-publish-uid)?(?:=|$)/.test(arg) && !/^--debug(?:-brk|-port)?(?:=|$)/.test(arg));
}
