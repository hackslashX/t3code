import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly attemptCount: number;
}

export class OutboxRepositoryError extends Schema.TaggedErrorClass<OutboxRepositoryError>()(
  "OutboxRepositoryError",
  {
    reason: Schema.Literals(["claim_lost", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class OutboxRepository extends Context.Service<
  OutboxRepository,
  {
    readonly claimNext: (
      workerId: string,
    ) => Effect.Effect<Option.Option<ClaimedOutboxEvent>, OutboxRepositoryError>;
    readonly complete: (
      workerId: string,
      eventId: string,
    ) => Effect.Effect<void, OutboxRepositoryError>;
    readonly fail: (
      workerId: string,
      eventId: string,
      message: string,
    ) => Effect.Effect<void, OutboxRepositoryError>;
  }
>()("@t3tools/control-plane/OutboxRepository") {}

interface OutboxRow {
  readonly id: string | number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly attempt_count: number;
}

const persistenceError = (cause: unknown) =>
  Schema.is(OutboxRepositoryError)(cause)
    ? cause
    : new OutboxRepositoryError({ reason: "persistence_failed", cause });

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const claimNext: OutboxRepository["Service"]["claimNext"] = Effect.fn(
    "OutboxRepository.claimNext",
  )(function* (workerId) {
    const rows = yield* sql<OutboxRow>`
      WITH candidate AS (
        SELECT candidate_event.id
        FROM outbox_events AS candidate_event
        WHERE candidate_event.published_at IS NULL
          AND candidate_event.next_attempt_at <= now()
          AND (
            candidate_event.locked_at IS NULL OR
            candidate_event.locked_at < now() - interval '5 minutes'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM outbox_events AS earlier_event
            WHERE earlier_event.aggregate_type = candidate_event.aggregate_type
              AND earlier_event.aggregate_id = candidate_event.aggregate_id
              AND earlier_event.published_at IS NULL
              AND earlier_event.id < candidate_event.id
          )
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE outbox_events AS events
      SET locked_at = now(), locked_by = ${workerId},
          attempt_count = events.attempt_count + 1
      FROM candidate
      WHERE events.id = candidate.id
      RETURNING events.id, events.aggregate_type, events.aggregate_id,
                events.event_type, events.payload, events.attempt_count
    `.pipe(Effect.mapError(persistenceError));
    const row = rows[0];
    return row === undefined
      ? Option.none()
      : Option.some({
          id: String(row.id),
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          attemptCount: row.attempt_count,
        });
  });

  const complete: OutboxRepository["Service"]["complete"] = Effect.fn("OutboxRepository.complete")(
    function* (workerId, eventId) {
      const rows = yield* sql<{ readonly id: string | number }>`
      UPDATE outbox_events
      SET published_at = now(), locked_at = NULL, locked_by = NULL, last_error = NULL
      WHERE id = ${eventId} AND locked_by = ${workerId} AND published_at IS NULL
      RETURNING id
    `.pipe(Effect.mapError(persistenceError));
      if (rows.length !== 1) return yield* new OutboxRepositoryError({ reason: "claim_lost" });
    },
  );

  const fail: OutboxRepository["Service"]["fail"] = Effect.fn("OutboxRepository.fail")(
    function* (workerId, eventId, message) {
      const rows = yield* sql<{ readonly id: string | number }>`
        UPDATE outbox_events
        SET locked_at = NULL, locked_by = NULL,
            last_error = ${message.slice(0, 2000)},
            next_attempt_at = now() +
              (least(300, power(2, least(attempt_count, 8))) * interval '1 second')
        WHERE id = ${eventId} AND locked_by = ${workerId} AND published_at IS NULL
        RETURNING id
      `.pipe(Effect.mapError(persistenceError));
      if (rows.length !== 1) return yield* new OutboxRepositoryError({ reason: "claim_lost" });
    },
  );

  return OutboxRepository.of({ claimNext, complete, fail });
});

export const layer = Layer.effect(OutboxRepository, make);
