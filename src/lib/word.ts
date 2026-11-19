/** "1 ligne", "2 lignes": French count + noun, with an irregular plural when given. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
