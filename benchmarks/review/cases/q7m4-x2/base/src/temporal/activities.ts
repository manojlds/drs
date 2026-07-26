export type Context = { artifacts: Record<string, unknown> };

export async function hydrateContextActivity(
  input: { context: Context; load: (value: unknown) => Promise<unknown> }
): Promise<Context> {
  const artifacts: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.context.artifacts)) {
    artifacts[key] = await input.load(value);
  }
  return { artifacts };
}
