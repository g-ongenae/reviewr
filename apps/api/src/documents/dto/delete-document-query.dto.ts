import type { DeleteDocumentInput } from '@reviewr/shared';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';

/** Largest value of a PostgreSQL `integer`, the type of both counters: a larger one could never match. */
const integerMax: number = 2_147_483_647;

/**
 * A query parameter holding a counter: a string of digits becomes a number, anything else (a sign, a fraction, a
 * parameter sent twice) is left as it came, for `IsInt` to refuse.
 */
const toCounter = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;

/** Whether the client sent a precondition: one value is enough to require both. */
const hasPrecondition = (query: DeleteDocumentQueryDto): boolean =>
  query.revision !== undefined || query.draftVersion !== undefined;

/**
 * Query of `DELETE /documents/:id`: what the client last saw, both values or neither. Without them the document is
 * deleted as it is, as builds made before the precondition existed expect; with only one, the request is a 400.
 */
export class DeleteDocumentQueryDto implements Partial<DeleteDocumentInput> {
  /** Head revision last seen; 0 for a document without a revision yet. */
  @ValidateIf(hasPrecondition)
  @Transform(toCounter)
  @IsInt()
  @Min(0)
  @Max(integerMax)
  public revision?: number;

  /** `draftVersion` of the draft last seen. */
  @ValidateIf(hasPrecondition)
  @Transform(toCounter)
  @IsInt()
  @Min(1)
  @Max(integerMax)
  public draftVersion?: number;
}
