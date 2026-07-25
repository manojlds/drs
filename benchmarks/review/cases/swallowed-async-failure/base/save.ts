export async function save(run: () => Promise<void>): Promise<void> {
  await run();
}
