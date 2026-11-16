export interface Departures {
  depart: (key: string, action: Promise<unknown>, stillListed: () => boolean) => void;
  visible: <T>(rows: T[], keyOf: (row: T) => string) => T[];
  isDeparting: (key: string) => boolean;
  returned: (key: string) => boolean;
}

export function createDepartures(onChange: () => void): Departures {
  const leaving = new Map<string, number>();
  const back = new Set<string>();
  let seq = 0;
  return {
    depart(key, action, stillListed) {
      const mine = ++seq;
      leaving.set(key, mine);
      back.delete(key);
      onChange();
      const settle = () => {
        if (leaving.get(key) !== mine) return;
        leaving.delete(key);
        if (stillListed()) back.add(key);
        onChange();
      };
      action.then(settle, settle);
    },
    visible(rows, keyOf) {
      return leaving.size === 0 ? rows : rows.filter((row) => !leaving.has(keyOf(row)));
    },
    isDeparting: (key) => leaving.has(key),
    returned: (key) => back.has(key),
  };
}
