export type Record = { archived: boolean; name: string };

export function display(record: Record): string {
  return record.name;
}
