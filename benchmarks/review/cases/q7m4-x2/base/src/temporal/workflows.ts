import { hydrateContextActivity, type Context } from './activities.js';

export async function run(context: Context, load: (value: unknown) => Promise<unknown>) {
  const activityInput = structuredClone({ context });
  const hydrated = await hydrateContextActivity({ ...activityInput, load });
  Object.assign(context.artifacts, hydrated.artifacts);
  return context;
}
