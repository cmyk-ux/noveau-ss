// Comparação de dados simples (objetos, listas, Map, números, textos) e reaproveitamento.
//
// A sala monta o estado de novo a cada evento do LiveKit. Se cada evento criasse objetos novos, a
// tela inteira se redesenharia a cada "fulano começou a falar". Aqui o estado novo é comparado com
// o anterior e tudo o que não mudou volta a ser o MESMO objeto. Assim os signals e o Angular só
// mexem no que mudou de verdade (ex.: só a linha de quem começou a falar).

/** Igualdade profunda para dados simples (sem classes, sem funções). */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !same(v, b.get(k))) return false;
    return true;
  }
  if (Array.isArray(b) || b instanceof Map) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** O anterior, se for igual ao novo. */
export function keep<T>(prev: T, next: T): T {
  return same(prev, next) ? prev : next;
}

/**
 * Lista nova reaproveitando os itens iguais da anterior (pela chave). Se nada mudou, devolve a
 * própria lista anterior. Ninguém deve alterar as listas do estado (elas são compartilhadas).
 */
export function keepList<T>(prev: T[], next: T[], key: (t: T) => string): T[] {
  const old = new Map(prev.map((x) => [key(x), x]));
  let changed = prev.length !== next.length;
  const out = next.map((x, i) => {
    const o = old.get(key(x));
    const kept = o !== undefined && same(o, x) ? o : x;
    if (kept !== prev[i]) changed = true;
    return kept;
  });
  return changed ? out : prev;
}

/** Map novo reaproveitando os valores iguais do anterior. Se nada mudou, devolve o anterior. */
export function keepMap<K, V>(prev: Map<K, V>, next: Map<K, V>): Map<K, V> {
  let changed = prev.size !== next.size;
  const out = new Map<K, V>();
  for (const [k, v] of next) {
    const o = prev.get(k);
    const kept = o !== undefined && same(o, v) ? o : v;
    if (!prev.has(k) || kept !== o) changed = true;
    out.set(k, kept);
  }
  return changed ? out : prev;
}

/** Para `computed(..., { equal: sameItems })`: listas com os mesmos itens (mesmos objetos). */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
