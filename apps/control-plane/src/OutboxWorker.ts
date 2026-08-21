import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { dispatchNextOutboxEvent } from "./OutboxDispatcher.ts";

const drain = Effect.fn("OutboxWorker.drain")(function* (workerId: string) {
  while (yield* dispatchNextOutboxEvent(workerId)) {
    // Drain all currently available events before waiting for another signal.
  }
});

export const runOutboxWorker = Effect.fn("OutboxWorker.run")(function* (workerId: string) {
  const sql = yield* PgClient.PgClient;
  const wakeups = Stream.concat(
    Stream.succeed("startup"),
    sql.listen("t3_control_plane_outbox"),
  ).pipe(Stream.merge(Stream.tick("5 seconds").pipe(Stream.map(() => "retry"))));
  return yield* wakeups.pipe(Stream.runForEach(() => drain(workerId)));
});
