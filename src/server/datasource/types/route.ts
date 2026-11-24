/** The DataSource's route method shapes: input, output, stream (one method per route in src/contract/routes.ts). */
import type { RouteInput, RouteKey, RouteOutput } from '@/contract';

export type In<K extends RouteKey> = RouteInput<K>;
export type Out<K extends RouteKey> = Promise<RouteOutput<K>>;
export type Stream<K extends RouteKey> = AsyncIterable<RouteOutput<K>>;
export type WithSignal<T> = T & { signal: AbortSignal };
