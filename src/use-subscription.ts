import { useEffect, useRef } from 'react';
import {
  QueryFunction,
  QueryKey,
  useQuery,
  useQueryClient,
  UseQueryResult,
  PlaceholderDataFunction,
} from 'react-query';
import type { RetryValue } from 'react-query/types/core/retryer';
import { Observable, of, firstValueFrom } from 'rxjs';
import { catchError, finalize, share, tap, skip } from 'rxjs/operators';

import { storeSubscription, cleanupSubscription } from './subscription-storage';

export interface UseSubscriptionOptions<
  TSubscriptionFnData = unknown,
  TError = Error,
  TData = TSubscriptionFnData,
  TSubscriptionKey extends QueryKey = QueryKey
> {
  /**
   * Set this to `false` to disable automatic resubscribing when the subscription mounts or changes subscription keys.
   * To refetch the subscription, use the `refetch` method returned from the `useSubscription` instance.
   * Defaults to `true`.
   */
  enabled?: boolean;
  /**
   * If `false`, failed subscriptions will not retry by default.
   * If `true`, failed subscriptions will retry infinitely., failureCount: num
   * If set to an integer number, e.g. 3, failed subscriptions will retry until the failed subscription count meets that number.
   * If set to a function `(failureCount, error) => boolean` failed subscriptions will retry until the function returns false.
   */
  retry?: RetryValue<TError>;
  /**
   * If set to `false`, the subscription will not be retried on mount if it contains an error.
   * Defaults to `true`.
   */
  retryOnMount?: boolean;
  /**
   * This option can be used to transform or select a part of the data returned by the query function.
   */
  select?: (data: TSubscriptionFnData) => TData;
  /**
   * If set, this value will be used as the placeholder data for this particular query observer while the subscription is still in the `loading` data and no initialData has been provided.
   */
  placeholderData?:
    | TSubscriptionFnData
    | PlaceholderDataFunction<TSubscriptionFnData>;
}

export type UseSubscriptionResult<
  TData = unknown,
  TError = unknown
> = UseQueryResult<TData, TError>;

/**
 * React hook based on React Query for managing, caching and syncing observables in React.
 *
 * @example
 * ```ts
 * function ExampleSubscription() {
 *   const { data, isError, error, isLoading } = useSubscription(
 *     'test-key',
 *     () => stream$,
 *     {
 *       // options
 *     }
 *   );
 *
 *   if (isLoading) {
 *     return <>Loading...</>;
 *   }
 *   if (isError) {
 *     return (
 *       <div role="alert">
 *         {error?.message || 'Unknown error'}
 *       </div>
 *     );
 *   }
 *   return <>Data: {JSON.stringify(data)}</>;
 * }
 * ```
 */
export function useSubscription<
  TSubscriptionFnData = unknown,
  TError = Error,
  TData = TSubscriptionFnData,
  TSubscriptionKey extends QueryKey = QueryKey
>(
  subscriptionKey: TSubscriptionKey,
  subscriptionFn: () => Observable<TSubscriptionFnData>,
  options: UseSubscriptionOptions<
    TSubscriptionFnData,
    TError,
    TData,
    TSubscriptionKey
  > = {}
): UseSubscriptionResult<TData, TError> {
  const queryClient = useQueryClient();

  // We cannot assume that this fn runs for this component.
  // It might be a different observer associated to the same query key.
  // https://github.com/tannerlinsley/react-query/blob/16b7d290c70639b627d9ada32951d211eac3adc3/src/core/query.ts#L376
  // @todo: move from the component scope to queryCache
  const failRefetchWith = useRef<false | Error>(false);

  const queryFn: QueryFunction<TSubscriptionFnData, TSubscriptionKey> = ({
    queryKey,
  }) => {
    if (failRefetchWith.current) {
      throw failRefetchWith.current;
    }

    const stream$ = subscriptionFn().pipe(share());
    const result = firstValueFrom(stream$);

    // Fixes scenario when component unmounts before first emit.
    // If we do not invalidate the query, the hook will never re-subscribe,
    // as data are otherwise marked as fresh.
    // @todo: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any).cancel = () => {
      queryClient.invalidateQueries(queryKey);
    };

    // @todo: Skip subscription for SSR
    cleanupSubscription(queryClient, queryKey);

    const subscription = stream$
      .pipe(
        skip(1),
        tap((data) => {
          queryClient.setQueryData(queryKey, data);
        }),
        catchError((error) => {
          failRefetchWith.current = error;
          queryClient.setQueryData(queryKey, (data) => data, {
            // To make the retryOnMount work
            // @see: https://github.com/tannerlinsley/react-query/blob/9e414e8b4f3118b571cf83121881804c0b58a814/src/core/queryObserver.ts#L727
            updatedAt: 0,
          });
          return of(undefined);
        }),
        finalize(() => {
          queryClient.invalidateQueries(queryKey);
        })
      )
      .subscribe();

    // remember the current subscription
    // see `cleanup` fn for more info
    storeSubscription(queryClient, subscriptionKey, subscription);

    return result;
  };

  const queryResult = useQuery<
    TSubscriptionFnData,
    TError,
    TData,
    TSubscriptionKey
  >(subscriptionKey, queryFn, {
    retry: false,
    ...options,
    staleTime: Infinity,
    refetchInterval: undefined,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    onError: () => {
      // Once the error has been thrown, and a query result created (with error)
      // cleanup the `failRefetchWith`.
      failRefetchWith.current = undefined;
    },
  });

  useEffect(() => {
    return function cleanup() {
      // Fixes unsubscribe
      // We cannot assume that this fn runs for this component.
      // It might be a different observer associated to the same query key.
      // https://github.com/tannerlinsley/react-query/blob/16b7d290c70639b627d9ada32951d211eac3adc3/src/core/query.ts#L376

      const activeObserversCount = queryClient
        .getQueryCache()
        .find(subscriptionKey)
        ?.getObserversCount();

      if (activeObserversCount === 0) {
        cleanupSubscription(queryClient, subscriptionKey);
      }
    };
  }, [queryClient, subscriptionKey]);

  return queryResult;
}