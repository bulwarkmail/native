import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface PullRefresh {
  run: (load: () => Promise<unknown>) => void;
}

export function createPullRefresh(onChange: (pulling: boolean) => void): PullRefresh {
  let pending = 0;
  return {
    run(load) {
      pending += 1;
      if (pending === 1) onChange(true);
      const done = () => {
        pending -= 1;
        if (pending === 0) onChange(false);
      };
      let started: Promise<unknown>;
      try {
        started = Promise.resolve(load());
      } catch (err) {
        started = Promise.reject(err);
      }
      started.then(done, done);
    },
  };
}

export function usePullRefresh(load: () => Promise<unknown>): { refreshing: boolean; onRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pull = useMemo(() => createPullRefresh((pulling) => {
    if (mounted.current) setRefreshing(pulling);
  }), []);
  const loadRef = useRef(load);
  loadRef.current = load;
  const onRefresh = useCallback(() => pull.run(() => loadRef.current()), [pull]);
  return { refreshing, onRefresh };
}
